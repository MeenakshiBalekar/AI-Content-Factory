import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertValidWorkflow,
  compileWorkflow,
  topologicalOrder,
  validateWorkflow,
  WorkflowValidationError,
  type WorkflowDefinition,
} from "../src/workflow/workflow.ts";
import {
  BUILTIN_WORKFLOWS,
  SHORTS_WORKFLOW,
  STANDARD_WORKFLOW,
  resolveWorkflow,
} from "../src/workflow/builtin-workflows.ts";
import { EpisodeOrchestrator } from "../src/orchestrator/orchestrator.ts";
import { JsonMemoryStore } from "../src/memory/json-memory-store.ts";
import { LocalProvider } from "../src/providers/local-provider.ts";
import { ProviderRegistry } from "../src/providers/provider.ts";
import { QualityEngine } from "../src/quality/quality-engine.ts";
import { sampleChannel } from "../src/examples/sample-channel.ts";
import { asChannelId } from "../src/domain/ids.ts";

const wf = (stages: WorkflowDefinition["stages"]): WorkflowDefinition => ({
  id: "t",
  name: "t",
  description: "",
  stages,
});

test("built-in workflows are valid", () => {
  for (const w of BUILTIN_WORKFLOWS) {
    assert.deepEqual(validateWorkflow(w), [], `${w.id} should be valid`);
  }
});

test("validation catches duplicate ids, unknown deps, unknown kinds, self-deps", () => {
  const problems = validateWorkflow(
    wf([
      { id: "a", kind: "story", label: "A", dependsOn: [] },
      { id: "a", kind: "script", label: "A2", dependsOn: [] },
      { id: "b", kind: "script", label: "B", dependsOn: ["ghost"] },
      { id: "c", kind: "nonsense" as never, label: "C", dependsOn: ["c"] },
    ]),
  );
  assert.ok(problems.some((p) => p.includes("duplicate stage id \"a\"")));
  assert.ok(problems.some((p) => p.includes("unknown stage \"ghost\"")));
  assert.ok(problems.some((p) => p.includes("unknown kind \"nonsense\"")));
  assert.ok(problems.some((p) => p.includes("depends on itself")));
});

test("validation detects dependency cycles", () => {
  const problems = validateWorkflow(
    wf([
      { id: "a", kind: "story", label: "A", dependsOn: ["c"] },
      { id: "b", kind: "script", label: "B", dependsOn: ["a"] },
      { id: "c", kind: "storyboard", label: "C", dependsOn: ["b"] },
    ]),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /cycle involving: a, b, c/);
  assert.throws(() => assertValidWorkflow(wf([
    { id: "a", kind: "story", label: "A", dependsOn: ["a"] },
  ])), WorkflowValidationError);
});

test("topological order respects dependencies and is deterministic", () => {
  const order = topologicalOrder(STANDARD_WORKFLOW).map((s) => s.id);
  const pos = (id: string): number => order.indexOf(id);
  for (const s of STANDARD_WORKFLOW.stages) {
    for (const dep of s.dependsOn) {
      assert.ok(pos(dep) < pos(s.id), `${dep} must run before ${s.id}`);
    }
  }
  // Deterministic: same input, same order, every time.
  assert.deepEqual(topologicalOrder(STANDARD_WORKFLOW).map((s) => s.id), order);
});

test("compileWorkflow maps kinds to the right capabilities and keeps params", () => {
  const stages = compileWorkflow(SHORTS_WORKFLOW);
  const video = stages.find((s) => s.kind === "video")!;
  assert.equal(video.capability, "video");
  assert.equal(video.params?.aspect, "9:16");
  assert.equal(video.params?.durationSec, 45);
  assert.ok(!stages.some((s) => s.kind === "music"), "shorts workflow has no music stage");
});

test("resolveWorkflow prefers channel-defined workflows over built-ins", () => {
  const custom: WorkflowDefinition = {
    ...STANDARD_WORKFLOW,
    id: "shorts",
    name: "Channel-custom shorts",
  };
  assert.equal(resolveWorkflow("shorts", { shorts: custom })?.name, "Channel-custom shorts");
  assert.equal(resolveWorkflow("shorts")?.name, "Vertical short");
  assert.equal(resolveWorkflow("nope"), undefined);
});

async function withStore(fn: (store: JsonMemoryStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "acf-wf-"));
  try {
    const store = new JsonMemoryStore(dir);
    await store.save(sampleChannel());
    await fn(store);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function localRegistry(): ProviderRegistry {
  const local = new LocalProvider();
  return new ProviderRegistry()
    .registerText(local).registerImage(local).registerAudio(local).registerVideo(local);
}

test("orchestrator executes the shorts workflow: 9:16 assets, no music, workflowId recorded", async () => {
  await withStore(async (store) => {
    const orch = new EpisodeOrchestrator(store, localRegistry(), undefined, {
      quality: new QualityEngine(),
    });
    const ep = await orch.createEpisode(asChannelId("tiny-explorers"), {
      workflow: SHORTS_WORKFLOW,
    });

    assert.equal(ep.workflowId, "shorts");
    assert.ok(!ep.assets.some((a) => a.kind === "music"), "no music assets");
    const visuals = ep.assets.filter((a) => a.kind === "image" || a.kind === "video");
    assert.ok(visuals.length > 0);
    for (const v of visuals) {
      assert.equal(v.meta?.aspect, "9:16", `${v.label} should be vertical`);
    }
    assert.equal(ep.quality?.passed, true, "shorts episode passes quality");
  });
});

test("default run records workflowId 'standard' and includes music", async () => {
  await withStore(async (store) => {
    const orch = new EpisodeOrchestrator(store, localRegistry());
    const ep = await orch.createEpisode(asChannelId("tiny-explorers"));
    assert.equal(ep.workflowId, "standard");
    assert.ok(ep.assets.some((a) => a.kind === "music"));
  });
});

test("an invalid workflow passed to the orchestrator throws before any generation", async () => {
  await withStore(async (store) => {
    const orch = new EpisodeOrchestrator(store, localRegistry());
    await assert.rejects(
      () =>
        orch.createEpisode(asChannelId("tiny-explorers"), {
          workflow: wf([{ id: "a", kind: "story", label: "A", dependsOn: ["a"] }]),
        }),
      WorkflowValidationError,
    );
    const mem = await store.load(asChannelId("tiny-explorers"));
    assert.equal(mem?.episodes.length, 0, "no episode persisted");
  });
});
