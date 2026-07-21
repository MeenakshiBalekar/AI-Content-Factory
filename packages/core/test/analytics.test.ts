import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonMemoryStore } from "../src/memory/json-memory-store.ts";
import { LocalProvider } from "../src/providers/local-provider.ts";
import { ProviderRegistry } from "../src/providers/provider.ts";
import { EpisodeOrchestrator } from "../src/orchestrator/orchestrator.ts";
import { AnalyticsService } from "../src/analytics/analytics-service.ts";
import { computeInsights, applyLearnings } from "../src/analytics/insights.ts";
import { mergeMetrics, validateMetrics, type EpisodeMetrics } from "../src/analytics/metrics.ts";
import { ExportPublishTarget } from "../src/publishing/publish-target.ts";
import { PublishingService } from "../src/publishing/publishing-service.ts";
import { sampleChannel } from "../src/examples/sample-channel.ts";
import { asChannelId } from "../src/domain/ids.ts";

function localRegistry(): ProviderRegistry {
  const p = new LocalProvider();
  return new ProviderRegistry().registerText(p).registerImage(p).registerAudio(p).registerVideo(p);
}

async function withStore(fn: (store: JsonMemoryStore, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "acf-a6-"));
  try {
    const store = new JsonMemoryStore(join(dir, "mem"));
    await store.save(sampleChannel());
    await fn(store, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const CID = asChannelId("tiny-explorers");

test("validateMetrics rejects bad rows and accepts good ones", () => {
  assert.ok(validateMetrics("nope").length > 0);
  assert.deepEqual(
    validateMetrics([{ episodeNumber: 1, views: 100, avgViewDurationSec: 90, measuredAt: "2026-07-20T00:00:00Z" }]),
    [],
  );
  const bad = validateMetrics([{ episodeNumber: 0, views: -1, avgViewDurationSec: 5, ctr: 2, measuredAt: "x" }]);
  assert.ok(bad.length >= 4);
});

test("mergeMetrics replaces a prior measurement for the same episode", () => {
  const a: EpisodeMetrics[] = [{ episodeNumber: 1, views: 10, avgViewDurationSec: 50, measuredAt: "2026-01-01T00:00:00Z" }];
  const b: EpisodeMetrics[] = [{ episodeNumber: 1, views: 99, avgViewDurationSec: 80, measuredAt: "2026-02-01T00:00:00Z" }];
  const merged = mergeMetrics(a, b);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.views, 99);
});

test("computeInsights ranks by retention and picks best hooks from the winners", () => {
  const episodes = [
    { number: 1, title: "A", beats: [{ index: 0, summary: "hook-A", characterIds: [], environmentId: "e" as never, dialogue: [] }], assets: [], id: "a" as never, channelId: CID, logline: "", createdAt: "" },
    { number: 2, title: "B", beats: [{ index: 0, summary: "hook-B", characterIds: [], environmentId: "e" as never, dialogue: [] }], assets: [], id: "b" as never, channelId: CID, logline: "", createdAt: "" },
  ];
  const metrics: EpisodeMetrics[] = [
    { episodeNumber: 1, views: 100, avgViewDurationSec: 60, measuredAt: "2026-07-01T00:00:00Z" },
    { episodeNumber: 2, views: 100, avgViewDurationSec: 120, ctr: 0.08, measuredAt: "2026-07-01T00:00:00Z" },
  ];
  const insights = computeInsights(episodes, metrics, { topN: 1 });
  assert.equal(insights.sampled, 2);
  assert.equal(insights.avgViewDurationSec, 90);
  assert.deepEqual(insights.bestHooks, ["hook-B"]); // ep 2 has higher retention
  assert.equal(insights.top[0]!.episodeNumber, 2);
});

test("computeInsights ignores metrics for unknown episodes", () => {
  const insights = computeInsights([], [{ episodeNumber: 5, views: 1, avgViewDurationSec: 1, measuredAt: "2026-07-01T00:00:00Z" }]);
  assert.equal(insights.sampled, 0);
});

test("THE LEARNING LOOP: ingested metrics steer the NEXT episode's story prompt", async () => {
  await withStore(async (store) => {
    const orch = new EpisodeOrchestrator(store, localRegistry());
    // Produce two episodes so metrics have real episodes to bind to.
    await orch.createEpisode(CID, { number: 1 });
    await orch.createEpisode(CID, { number: 2 });
    const mem = await store.load(CID);
    const ep2Hook = mem!.episodes.find((e) => e.number === 2)!.beats[0]!.summary;

    // Ingest metrics that make episode 2 the retention winner.
    const analytics = new AnalyticsService(store);
    const res = await analytics.ingest(CID, [
      { episodeNumber: 1, views: 500, avgViewDurationSec: 40, measuredAt: "2026-07-19T00:00:00Z" },
      { episodeNumber: 2, views: 500, avgViewDurationSec: 150, measuredAt: "2026-07-19T00:00:00Z" },
    ]);
    assert.equal(res.applied, true);

    // Learnings were persisted into channel memory.
    const learned = await store.load(CID);
    assert.ok(learned!.channel.performance.bestHooks.includes(ep2Hook));
    assert.equal(learned!.channel.performance.avgViewDurationSec, 95);

    // Now create the NEXT episode and confirm the story prompt was informed by the learning.
    const ep3 = await orch.createEpisode(CID, { number: 3 });
    const story = ep3.assets.find((a) => a.kind === "story")!;
    assert.ok(story.prompt.includes("Proven high-retention hooks"), "story prompt cites learnings");
    assert.ok(story.prompt.includes(ep2Hook), "story prompt injects the winning hook");
    assert.equal(story.meta?.learnedHooks, learned!.channel.performance.bestHooks.length);
  });
});

test("applyLearnings is a no-op when there are no metrics", async () => {
  await withStore(async (store) => {
    const mem = (await store.load(CID))!;
    const same = applyLearnings(mem, computeInsights(mem.episodes, []));
    assert.deepEqual(same.channel.performance, mem.channel.performance);
  });
});

test("publishing writes an export package and records the publication in memory", async () => {
  await withStore(async (store, dir) => {
    const orch = new EpisodeOrchestrator(store, localRegistry());
    await orch.createEpisode(CID, { number: 7 });

    const exportsDir = join(dir, "exports");
    const svc = new PublishingService(store, new ExportPublishTarget(exportsDir));
    const record = await svc.publish(CID, 7);

    assert.equal(record.platform, "export");
    assert.ok(record.uri.startsWith("file://"));

    const manifestPath = join(fileURLToPath(record.uri), "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { episodeNumber: number; title: string };
    assert.equal(manifest.episodeNumber, 7);

    // The publication is recorded in channel memory.
    const mem = await store.load(CID);
    assert.equal(mem!.publications?.[7]?.length, 1);
    assert.equal(mem!.publications?.[7]?.[0]?.platform, "export");
  });
});

test("nextSlot returns the channel cadence's next fire time", async () => {
  await withStore(async (store) => {
    const svc = new PublishingService(store, new ExportPublishTarget("/tmp/never"));
    const next = await svc.nextSlot(CID, new Date("2026-07-21T12:00:00Z"));
    // sample channel cadence: "daily 16:00 America/Los_Angeles" -> 23:00Z (PDT)
    assert.equal(next.toISOString(), "2026-07-21T23:00:00.000Z");
  });
});
