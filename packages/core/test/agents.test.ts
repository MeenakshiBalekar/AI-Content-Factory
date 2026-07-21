import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseVerdict,
  type Agent,
  type AgentContext,
  type AgentMessage,
  type AgentRole,
} from "../src/agents/agent.ts";
import { CreativeCrew } from "../src/agents/crew.ts";
import { LlmAgent } from "../src/agents/llm-agent.ts";
import { buildCreativeCrew } from "../src/agents/crew-factory.ts";
import { EpisodeOrchestrator } from "../src/orchestrator/orchestrator.ts";
import { JsonMemoryStore } from "../src/memory/json-memory-store.ts";
import { LocalProvider } from "../src/providers/local-provider.ts";
import { ProviderRegistry, type TextProvider, type TextRequest } from "../src/providers/provider.ts";
import { sampleChannel } from "../src/examples/sample-channel.ts";
import { asChannelId } from "../src/domain/ids.ts";

/** A scripted agent that returns a fixed sequence of contents, one per call. */
class ScriptedAgent implements Agent {
  readonly role: AgentRole;
  #i = 0;
  readonly #scripts: readonly string[];
  readonly calls: AgentContext[] = [];

  constructor(role: AgentRole, scripts: readonly string[]) {
    this.role = role;
    this.#scripts = scripts;
  }

  async act(ctx: AgentContext): Promise<AgentMessage> {
    this.calls.push(ctx);
    const content = this.#scripts[Math.min(this.#i, this.#scripts.length - 1)]!;
    this.#i++;
    const msg: AgentMessage = { role: this.role, content };
    return this.role === "quality-reviewer" ? { ...msg, verdict: parseVerdict(content) } : msg;
  }
}

const baseCtx = {
  channelPremise: "cozy preschool adventures",
  audience: "kids 4-7",
  episodeNumber: 10,
  previousTitle: "Milo and the Bridge",
  provenHooks: ["What's THAT sound?"],
  brief: undefined,
};

test("parseVerdict: APPROVE approves, REVISE (or ambiguous) does not", () => {
  assert.equal(parseVerdict("Looks great. APPROVE"), "approve");
  assert.equal(parseVerdict("Fix the hook. REVISE"), "revise");
  assert.equal(parseVerdict("hmm, not sure"), "revise"); // fail-safe toward iteration
  assert.equal(parseVerdict("APPROVE but also REVISE"), "revise"); // conflicting -> revise
});

test("crew rejects mis-roled agents", () => {
  assert.throws(
    () =>
      new CreativeCrew({
        director: new ScriptedAgent("script-writer", ["x"]),
        writer: new ScriptedAgent("script-writer", ["x"]),
        reviewer: new ScriptedAgent("quality-reviewer", ["APPROVE"]),
      }),
    /expected a "creative-director"/,
  );
});

test("crew approves on the first round: director + writer + reviewer, 3 turns", async () => {
  const crew = new CreativeCrew({
    director: new ScriptedAgent("creative-director", ["THEME: a lost umbrella teaches sharing"]),
    writer: new ScriptedAgent("script-writer", ["LOGLINE: Milo shares his umbrella\nHOOK: Whose umbrella is THIS?"]),
    reviewer: new ScriptedAgent("quality-reviewer", ["Strong hook, on brand. APPROVE"]),
  });
  const brief = await crew.develop(baseCtx);

  assert.equal(brief.approved, true);
  assert.equal(brief.rounds, 1);
  assert.equal(brief.theme, "a lost umbrella teaches sharing");
  assert.equal(brief.logline, "Milo shares his umbrella");
  assert.equal(brief.hook, "Whose umbrella is THIS?");
  assert.deepEqual(brief.transcript.map((m) => m.role), [
    "creative-director",
    "script-writer",
    "quality-reviewer",
  ]);
});

test("crew runs the revise loop until approval and passes prior turns to the writer", async () => {
  const writer = new ScriptedAgent("script-writer", [
    "LOGLINE: weak idea\nHOOK: um, hello",
    "LOGLINE: Milo shares his umbrella\nHOOK: Whose umbrella is THIS?",
  ]);
  const crew = new CreativeCrew({
    director: new ScriptedAgent("creative-director", ["THEME: sharing"]),
    writer,
    reviewer: new ScriptedAgent("quality-reviewer", ["Hook is weak. REVISE", "Much better. APPROVE"]),
  });
  const brief = await crew.develop(baseCtx);

  assert.equal(brief.rounds, 2);
  assert.equal(brief.approved, true);
  assert.equal(brief.hook, "Whose umbrella is THIS?"); // the revised draft
  assert.equal(brief.transcript.length, 5); // director + (writer+reviewer)*2
  // The writer's 2nd turn saw the reviewer's REVISE note in history.
  const secondWriterCtx = writer.calls[1]!;
  assert.ok(secondWriterCtx.history.some((m) => m.role === "quality-reviewer" && /REVISE/.test(m.content)));
});

test("crew stops at the round budget and ships the best draft (approved=false)", async () => {
  const crew = new CreativeCrew(
    {
      director: new ScriptedAgent("creative-director", ["THEME: sharing"]),
      writer: new ScriptedAgent("script-writer", ["LOGLINE: attempt\nHOOK: try this"]),
      reviewer: new ScriptedAgent("quality-reviewer", ["Still not there. REVISE"]),
    },
    { maxRounds: 2 },
  );
  const brief = await crew.develop(baseCtx);
  assert.equal(brief.approved, false);
  assert.equal(brief.rounds, 2);
  assert.equal(brief.hook, "try this"); // best available draft still returned
});

test("crew falls back gracefully when the writer omits LOGLINE/HOOK fields", async () => {
  const crew = new CreativeCrew({
    director: new ScriptedAgent("creative-director", ["a rainy day"]),
    writer: new ScriptedAgent("script-writer", ["Milo finds a puddle and learns patience."]),
    reviewer: new ScriptedAgent("quality-reviewer", ["APPROVE"]),
  });
  const brief = await crew.develop(baseCtx);
  assert.equal(brief.theme, "a rainy day");
  assert.equal(brief.logline, "Milo finds a puddle and learns patience.");
  // hook falls back to a proven hook when the writer gave none.
  assert.equal(brief.hook, "What's THAT sound?");
});

test("LlmAgent renders context + role prompt and marks the reviewer verdict", async () => {
  // A capturing text provider so we can inspect what the agent sent.
  let captured: TextRequest | undefined;
  const provider: TextProvider = {
    name: "capture",
    async generateText(req: TextRequest): Promise<string> {
      captured = req;
      return "Nice work. APPROVE";
    },
  };
  const reviewer = new LlmAgent("quality-reviewer", provider);
  const msg = await reviewer.act({ ...baseCtx, history: [{ role: "script-writer", content: "LOGLINE: x\nHOOK: y" }] });

  assert.equal(msg.verdict, "approve");
  assert.ok(captured!.system?.includes("Quality Reviewer"));
  assert.ok(captured!.prompt.includes("cozy preschool adventures"));
  assert.ok(captured!.prompt.includes("What's THAT sound?")); // proven hook rendered
  assert.ok(captured!.prompt.includes("[script-writer]")); // history rendered
});

test("LlmAgent crew runs end-to-end over the deterministic offline provider", async () => {
  const crew = buildCreativeCrew(new LocalProvider(), { maxRounds: 2 });
  const brief = await crew.develop(baseCtx);
  // Offline provider never emits APPROVE, so the crew exhausts the budget honestly.
  assert.equal(brief.approved, false);
  assert.equal(brief.rounds, 2);
  assert.equal(brief.transcript.length, 5);
  assert.ok(brief.logline.length > 0);
  assert.ok(brief.hook.length > 0);
});

async function withStore(fn: (store: JsonMemoryStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "acf-agents-"));
  try {
    const store = new JsonMemoryStore(dir);
    await store.save(sampleChannel());
    await fn(store);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("orchestrator with a crew records the brief and injects the crew hook into the story", async () => {
  await withStore(async (store) => {
    const local = new LocalProvider();
    const registry = new ProviderRegistry()
      .registerText(local).registerImage(local).registerAudio(local).registerVideo(local);
    const crew = new CreativeCrew({
      director: new ScriptedAgent("creative-director", ["THEME: a lost umbrella teaches sharing"]),
      writer: new ScriptedAgent("script-writer", ["LOGLINE: Milo shares his umbrella\nHOOK: Whose umbrella is THIS?"]),
      reviewer: new ScriptedAgent("quality-reviewer", ["On brand. APPROVE"]),
    });
    const orch = new EpisodeOrchestrator(store, registry, undefined, { crew });

    const ep = await orch.createEpisode(asChannelId("tiny-explorers"), { number: 20 });
    assert.ok(ep.creativeBrief, "brief attached to episode");
    assert.equal(ep.creativeBrief!.approved, true);
    assert.equal(ep.creativeBrief!.hook, "Whose umbrella is THIS?");
    assert.ok(ep.logline.includes("a lost umbrella teaches sharing"), "theme threaded into logline");

    const story = ep.assets.find((a) => a.kind === "story")!;
    assert.ok(story.prompt.includes("Whose umbrella is THIS?"), "crew hook injected into story prompt");

    // Brief is persisted with the episode.
    const mem = await store.load(asChannelId("tiny-explorers"));
    assert.equal(mem!.episodes[0]!.creativeBrief?.theme, "a lost umbrella teaches sharing");
  });
});

test("orchestrator without a crew attaches no brief (behavior unchanged)", async () => {
  await withStore(async (store) => {
    const local = new LocalProvider();
    const registry = new ProviderRegistry()
      .registerText(local).registerImage(local).registerAudio(local).registerVideo(local);
    const ep = await new EpisodeOrchestrator(store, registry).createEpisode(asChannelId("tiny-explorers"));
    assert.equal(ep.creativeBrief, undefined);
  });
});
