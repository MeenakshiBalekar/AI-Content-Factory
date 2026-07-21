import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CompletenessInspector,
  IdentityConsistencyInspector,
  MetadataInspector,
  SubtitleInspector,
  VoiceCoverageInspector,
  type StageContext,
} from "../src/quality/inspectors.ts";
import { QualityEngine } from "../src/quality/quality-engine.ts";
import { EpisodeOrchestrator } from "../src/orchestrator/orchestrator.ts";
import { JsonMemoryStore } from "../src/memory/json-memory-store.ts";
import { LocalProvider } from "../src/providers/local-provider.ts";
import { ProviderRegistry, type GeneratedAsset, type ImageProvider, type ImageRequest } from "../src/providers/provider.ts";
import { StoryPlanner } from "../src/orchestrator/story-planner.ts";
import { PromptComposer } from "../src/prompt/prompt-composer.ts";
import { sampleChannel } from "../src/examples/sample-channel.ts";
import { identityFragment } from "../src/prompt/identity.ts";
import { asChannelId, asCharacterId } from "../src/domain/ids.ts";
import type { EpisodeAsset } from "../src/domain/episode.ts";

const mem = sampleChannel();
const beats = new StoryPlanner(mem).beats(1);
const composer = new PromptComposer(mem);

const imageStage = { kind: "image", label: "Key frames per beat", capability: "image" } as const;
const ctxFor = (stage: StageContext["stage"]): StageContext => ({ stage, memory: mem, beats });

const goodImageAsset = (beatIndex: number): EpisodeAsset => {
  const beat = beats[beatIndex]!;
  const { prompt } = composer.imagePrompt(beat);
  return {
    kind: "image",
    label: `Keyframe beat ${beatIndex + 1}`,
    prompt,
    provider: "test",
    status: "succeeded",
    outputUri: "local://image/x.png",
    meta: { seed: 1, beat: beatIndex },
  };
};

test("completeness: media asset without outputUri is rejected", () => {
  const inspector = new CompletenessInspector();
  const asset: EpisodeAsset = { ...goodImageAsset(0) };
  const { outputUri: _drop, ...withoutUri } = asset;
  const findings = inspector.inspect([withoutUri as EpisodeAsset], ctxFor(imageStage));
  assert.deepEqual(findings.map((f) => f.code), ["missing-output"]);
});

test("identity: prompt containing every locked fragment passes", () => {
  const inspector = new IdentityConsistencyInspector();
  assert.deepEqual(inspector.inspect([goodImageAsset(0)], ctxFor(imageStage)), []);
});

test("identity: prompt missing a character's fragment is rejected (drift caught)", () => {
  const inspector = new IdentityConsistencyInspector();
  const milo = mem.characters[asCharacterId("milo")]!;
  const broken = {
    ...goodImageAsset(0),
    prompt: goodImageAsset(0).prompt.replace(identityFragment(milo), "a generic fox"),
  };
  const findings = inspector.inspect([broken], ctxFor(imageStage));
  assert.ok(findings.some((f) => f.code === "identity-missing" && f.severity === "reject"));
  assert.ok(findings[0]!.message.includes("Milo"));
});

test("identity: prompt missing the channel style is rejected", () => {
  const inspector = new IdentityConsistencyInspector();
  const broken = {
    ...goodImageAsset(0),
    prompt: goodImageAsset(0).prompt.replace(mem.channel.style.animationStyle, "any style"),
  };
  const findings = inspector.inspect([broken], ctxFor(imageStage));
  assert.ok(findings.some((f) => f.code === "style-missing"));
});

const subtitleStage = { kind: "subtitles", label: "Subtitles", capability: "none" } as const;
const srtAsset = (srt: string): EpisodeAsset => ({
  kind: "subtitles",
  label: "Subtitles (SRT)",
  prompt: srt,
  provider: "internal",
  status: "succeeded",
});

test("subtitles: valid SRT passes", () => {
  const inspector = new SubtitleInspector();
  const srt = "1\n00:00:00,000 --> 00:00:02,500\nLet's find out!\n\n2\n00:00:03,000 --> 00:00:05,500\nBuzz-tastic!";
  assert.deepEqual(inspector.inspect([srtAsset(srt)]), []);
});

test("subtitles: bad numbering, reversed timing, overlap, 3 lines are all rejected", () => {
  const inspector = new SubtitleInspector();
  const srt = [
    "1\n00:00:05,000 --> 00:00:02,000\nBackwards cue", // reversed
    "3\n00:00:01,000 --> 00:00:04,000\nBad number, overlaps\nline two\nline three", // numbering + overlap + 3 lines
  ].join("\n\n");
  const codes = inspector.inspect([srtAsset(srt)]).map((f) => f.code);
  for (const expected of ["srt-timing-order", "srt-numbering", "srt-too-many-lines"]) {
    assert.ok(codes.includes(expected), `missing ${expected} in ${codes.join(",")}`);
  }
});

test("voice coverage: fewer voice assets than dialogue lines is rejected", () => {
  const inspector = new VoiceCoverageInspector();
  const stage = { kind: "voice", label: "Voice lines per beat", capability: "audio" } as const;
  const expected = beats.reduce((n, b) => n + b.dialogue.length, 0);
  const one: EpisodeAsset = {
    kind: "voice", label: "Line: milo", prompt: "hi", provider: "t", status: "succeeded", outputUri: "x",
  };
  const findings = inspector.inspect([one], ctxFor(stage));
  assert.equal(findings[0]?.code, "voice-line-mismatch");
  assert.ok(findings[0]!.message.includes(String(expected)));
});

test("metadata: thumbnail prompt without the locked thumbnail style is rejected", () => {
  const inspector = new MetadataInspector();
  const stage = { kind: "thumbnail", label: "Thumbnail", capability: "image" } as const;
  const bare: EpisodeAsset = {
    kind: "thumbnail", label: "Thumbnail", prompt: "a nice thumbnail", provider: "t",
    status: "succeeded", outputUri: "x",
  };
  const findings = inspector.inspect([bare], ctxFor(stage));
  assert.equal(findings[0]?.code, "thumbnail-style-missing");
});

/** ImageProvider that produces a rejectable asset (no URI) on the first call, good after. */
class FlakyImageProvider implements ImageProvider {
  readonly name = "flaky-image";
  calls = 0;
  readonly #good = new LocalProvider();

  async generateImage(req: ImageRequest): Promise<GeneratedAsset> {
    this.calls++;
    if (this.calls <= 1) {
      return { outputUri: "", provider: this.name }; // empty URI -> CompletenessInspector rejects
    }
    return this.#good.generateImage(req);
  }
}

async function withStore(fn: (store: JsonMemoryStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "acf-q-"));
  try {
    const store = new JsonMemoryStore(dir);
    await store.save(sampleChannel());
    await fn(store);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("orchestrator regenerates a rejected stage and reports attempts (flaky provider)", async () => {
  await withStore(async (store) => {
    const local = new LocalProvider();
    const flaky = new FlakyImageProvider();
    const registry = new ProviderRegistry()
      .registerText(local).registerImage(flaky).registerAudio(local).registerVideo(local);
    const orch = new EpisodeOrchestrator(store, registry, undefined, {
      quality: new QualityEngine(),
      maxAttemptsPerStage: 3,
    });

    const ep = await orch.createEpisode(asChannelId("tiny-explorers"));
    assert.ok(ep.quality, "quality report attached");
    assert.equal(ep.quality!.passed, true, "episode passes after regeneration");

    const imageStageQ = ep.quality!.stages.find((s) => s.kind === "image")!;
    assert.equal(imageStageQ.attempts, 2, "image stage needed a second attempt");
    assert.equal(imageStageQ.passed, true);
    assert.equal(ep.quality!.totalRegenerations, 1);
    // 3 keyframes on the failed first attempt + 3 on the good second = 4+ provider calls
    assert.ok(flaky.calls >= 4);
  });
});

test("orchestrator without a quality engine attaches no report (behavior unchanged)", async () => {
  await withStore(async (store) => {
    const local = new LocalProvider();
    const registry = new ProviderRegistry()
      .registerText(local).registerImage(local).registerAudio(local).registerVideo(local);
    const orch = new EpisodeOrchestrator(store, registry);
    const ep = await orch.createEpisode(asChannelId("tiny-explorers"));
    assert.equal(ep.quality, undefined);
  });
});

test("clean local pipeline passes quality on the first attempt for every stage", async () => {
  await withStore(async (store) => {
    const local = new LocalProvider();
    const registry = new ProviderRegistry()
      .registerText(local).registerImage(local).registerAudio(local).registerVideo(local);
    const orch = new EpisodeOrchestrator(store, registry, undefined, { quality: new QualityEngine() });
    const ep = await orch.createEpisode(asChannelId("tiny-explorers"), { number: 248 });
    assert.equal(ep.quality!.passed, true);
    assert.equal(ep.quality!.totalRegenerations, 0);
    assert.ok(ep.quality!.stages.every((s) => s.attempts === 1));
    // The report is persisted with the episode.
    const loaded = await store.load(asChannelId("tiny-explorers"));
    assert.equal(loaded!.episodes[0]!.quality?.passed, true);
  });
});

test("a permanently-broken provider exhausts the attempt budget and is reported honestly", async () => {
  await withStore(async (store) => {
    const local = new LocalProvider();
    const alwaysBad: ImageProvider = {
      name: "always-bad",
      async generateImage() {
        return { outputUri: "", provider: "always-bad" };
      },
    };
    const registry = new ProviderRegistry()
      .registerText(local).registerImage(alwaysBad).registerAudio(local).registerVideo(local);
    const orch = new EpisodeOrchestrator(store, registry, undefined, {
      quality: new QualityEngine(),
      maxAttemptsPerStage: 2,
    });
    const ep = await orch.createEpisode(asChannelId("tiny-explorers"));
    assert.equal(ep.quality!.passed, false, "episode must NOT be reported as passing");
    const img = ep.quality!.stages.find((s) => s.kind === "image")!;
    assert.equal(img.attempts, 2, "budget exhausted");
    assert.equal(img.passed, false);
    assert.ok(img.findings.some((f) => f.code === "missing-output"));
  });
});
