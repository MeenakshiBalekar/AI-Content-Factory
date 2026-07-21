import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonMemoryStore } from "../src/memory/json-memory-store.ts";
import { LocalProvider } from "../src/providers/local-provider.ts";
import { ProviderRegistry } from "../src/providers/provider.ts";
import { EpisodeOrchestrator } from "../src/orchestrator/orchestrator.ts";
import { DEFAULT_PRODUCTION_PLAN } from "../src/orchestrator/production-plan.ts";
import { sampleChannel } from "../src/examples/sample-channel.ts";
import { asChannelId } from "../src/domain/ids.ts";

function registry(): ProviderRegistry {
  const p = new LocalProvider();
  return new ProviderRegistry().registerText(p).registerImage(p).registerAudio(p).registerVideo(p);
}

async function withOrchestrator(
  fn: (o: EpisodeOrchestrator, store: JsonMemoryStore) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "acf-orch-"));
  try {
    const store = new JsonMemoryStore(dir);
    await store.save(sampleChannel());
    await fn(new EpisodeOrchestrator(store, registry()), store);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const CID = asChannelId("tiny-explorers");

test("createEpisode runs every stage and produces assets for each kind", async () => {
  await withOrchestrator(async (orch) => {
    const ep = await orch.createEpisode(CID);
    const kinds = new Set(ep.assets.map((a) => a.kind));
    for (const stage of DEFAULT_PRODUCTION_PLAN) {
      assert.ok(kinds.has(stage.kind), `missing assets for stage "${stage.kind}"`);
    }
    assert.ok(ep.assets.every((a) => a.status === "succeeded"), "all stages succeed");
  });
});

test("episode number auto-increments from memory (Create Episode N)", async () => {
  await withOrchestrator(async (orch) => {
    const first = await orch.createEpisode(CID);
    const second = await orch.createEpisode(CID);
    assert.equal(first.number, 1);
    assert.equal(second.number, 2);
  });
});

test("explicit number is honoured (Create Episode 248)", async () => {
  await withOrchestrator(async (orch) => {
    const ep = await orch.createEpisode(CID, { number: 248 });
    assert.equal(ep.number, 248);
    assert.match(ep.id, /ep-248$/);
  });
});

test("episode is persisted back into memory", async () => {
  await withOrchestrator(async (orch, store) => {
    await orch.createEpisode(CID);
    const mem = await store.load(CID);
    assert.equal(mem?.episodes.length, 1);
  });
});

test("second episode's logline references the first (memory carries forward)", async () => {
  await withOrchestrator(async (orch) => {
    const first = await orch.createEpisode(CID);
    const second = await orch.createEpisode(CID);
    assert.ok(second.logline.includes(first.title), "logline should recall previous episode");
  });
});

test("every image asset carries a stable identity seed and memory-injected prompt", async () => {
  await withOrchestrator(async (orch) => {
    const ep = await orch.createEpisode(CID);
    const images = ep.assets.filter((a) => a.kind === "image");
    assert.ok(images.length > 0);
    for (const img of images) {
      assert.ok(typeof img.meta?.seed === "number", "image records its seed");
      assert.ok(img.prompt.includes("Milo"), "prompt injects locked character identity");
      assert.ok(img.prompt.includes("Style:"), "prompt injects channel style");
    }
  });
});

test("deterministic pipeline: same memory + number yields identical asset URIs", async () => {
  await withOrchestrator(async (orch) => {
    const a = await orch.createEpisode(CID, { number: 500 });
    const b = await orch.createEpisode(CID, { number: 500 });
    const uris = (xs: typeof a.assets): string[] =>
      xs.filter((x) => x.outputUri).map((x) => x.outputUri!);
    assert.deepEqual(uris(a.assets), uris(b.assets));
  });
});
