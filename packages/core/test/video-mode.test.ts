import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReplicateVideoProvider } from "../src/providers/replicate-video-provider.ts";
import { buildVideoProvider } from "../src/render/local-backends.ts";
import { RenderService } from "../src/render/render-service.ts";
import { checkFfmpeg, runFfmpeg } from "../src/render/ffmpeg.ts";
import { ContentService } from "../src/content/content-service.ts";
import { JsonMemoryStore } from "../src/memory/json-memory-store.ts";
import { LocalProvider } from "../src/providers/local-provider.ts";
import { ProviderRegistry, type GeneratedAsset, type VideoProvider, type VideoRequest } from "../src/providers/provider.ts";

const HAS_FFMPEG = await checkFfmpeg();
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface Captured { url: string; method: string; auth: string | undefined; body: string }

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "acf-vid-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function localRegistry(): ProviderRegistry {
  const p = new LocalProvider();
  return new ProviderRegistry().registerText(p).registerImage(p).registerAudio(p).registerVideo(p);
}

test("buildVideoProvider returns undefined unless Replicate is fully configured", () => {
  assert.equal(buildVideoProvider({}), undefined);
  assert.equal(buildVideoProvider({ ACF_VIDEO_PROVIDER: "replicate" }), undefined); // no token/model
  const p = buildVideoProvider({ ACF_VIDEO_PROVIDER: "replicate", REPLICATE_API_TOKEN: "r8_x", ACF_VIDEO_MODEL: "kwaivgi/kling-v1.6-standard" });
  assert.ok(p && p.name === "replicate-video");
});

test("ReplicateVideoProvider submits with Token auth + data-uri image, polls, returns the URL", async () => {
  await withDir(async (dir) => {
    const imgPath = join(dir, "keyframe.png");
    await writeFile(imgPath, PNG_1x1);

    const calls: Captured[] = [];
    const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks).toString("utf8");
      calls.push({ url: req.url ?? "", method: req.method ?? "", auth: req.headers["authorization"] as string | undefined, body });
      res.setHeader("content-type", "application/json");
      const base = `http://${req.headers.host}`;
      if (req.method === "POST") {
        res.end(JSON.stringify({ id: "pred1", status: "processing", urls: { get: `${base}/v1/predictions/pred1` } }));
      } else {
        // First GET still processing, then succeeded — exercises the poll loop.
        const hits = calls.filter((c) => c.method === "GET").length;
        res.end(JSON.stringify(hits >= 2
          ? { status: "succeeded", output: "https://cdn.example/clip.mp4" }
          : { status: "processing", urls: { get: `${base}/v1/predictions/pred1` } }));
      }
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    try {
      const provider = new ReplicateVideoProvider({
        token: "r8_secret",
        model: "kwaivgi/kling-v1.6-standard",
        baseUrl: `http://127.0.0.1:${port}`,
        imageField: "start_image",
        extraInput: { cfg_scale: 0.5 },
        pollIntervalMs: 1,
        maxPollMs: 5000,
      });
      const asset = await provider.generateVideo({
        prompt: "the fox stretches and yawns",
        seed: 7,
        aspect: "16:9",
        durationSec: 5,
        imageUri: `file://${imgPath}`,
      });
      assert.equal(asset.outputUri, "https://cdn.example/clip.mp4");

      const post = calls.find((c) => c.method === "POST")!;
      assert.equal(post.url, "/v1/models/kwaivgi/kling-v1.6-standard/predictions");
      assert.equal(post.auth, "Token r8_secret");
      const sent = JSON.parse(post.body) as { input: { prompt: string; start_image: string; cfg_scale: number } };
      assert.match(sent.input.prompt, /fox stretches/);
      assert.ok(sent.input.start_image.startsWith("data:image/png;base64,"), "keyframe sent as data URI");
      assert.equal(sent.input.cfg_scale, 0.5);
      assert.ok(calls.filter((c) => c.method === "GET").length >= 2, "polled until done");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

test("ReplicateVideoProvider surfaces a failed prediction as a non-retryable error", async () => {
  const server: Server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ void _; }
    res.setHeader("content-type", "application/json");
    const base = `http://${req.headers.host}`;
    res.end(JSON.stringify(req.method === "POST"
      ? { id: "p", status: "processing", urls: { get: `${base}/g` } }
      : { status: "failed", error: "NSFW content detected" }));
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  try {
    const provider = new ReplicateVideoProvider({
      token: "t", model: "owner/name", baseUrl: `http://127.0.0.1:${port}`,
      imageField: "image", extraInput: {}, pollIntervalMs: 1, maxPollMs: 5000,
    });
    await assert.rejects(() => provider.generateVideo({ prompt: "x", seed: 1, aspect: "16:9", durationSec: 5 }), /failed/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

/** A fake image→video model that returns REAL short clips (colored), so the render can be
 *  validated without a paid API. */
function fakeVideoProvider(dir: string): VideoProvider {
  let n = 0;
  let ready = false;
  return {
    name: "fake-video",
    async generateVideo(req: VideoRequest): Promise<GeneratedAsset> {
      if (!ready) {
        const { mkdir } = await import("node:fs/promises");
        await mkdir(dir, { recursive: true });
        ready = true;
      }
      const colors = ["0x2a9d8f", "0xe76f51", "0xe9c46a", "0x264653"];
      const out = join(dir, `clip${n}.mp4`);
      await runFfmpeg(["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${colors[n % 4]}:s=960x768:d=4`, "-pix_fmt", "yuv420p", out], 60_000);
      n++;
      return { outputUri: `file://${out}`, provider: "fake-video", meta: { seed: req.seed } };
    },
  };
}

test(
  "VIDEO MODE: render consumes real per-shot clips + a song -> animated video (not stills)",
  { skip: !HAS_FFMPEG },
  async () => {
    await withDir(async (dir) => {
      const song = join(dir, "song.m4a");
      await runFfmpeg(["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=330:d=15", "-c:a", "aac", song], 60_000);

      const store = new JsonMemoryStore(join(dir, "mem"));
      const res = await new ContentService(store, localRegistry()).createFromContent(
        "The fox wakes up and stretches. The fox runs through a meadow. The fox sees a butterfly and dances.",
      );

      const env = { ...process.env, ACF_SONG_FILE: song };
      const result = await new RenderService(store, join(dir, "out"), env, fakeVideoProvider(join(dir, "clips")))
        .render(res.channelId, 1);

      assert.equal(result.motionSource, "video-model", "real motion, not stills");
      assert.equal(result.hasVideo, true);
      assert.equal(result.hasAudio, true);
      assert.equal(result.videoCodec, "h264");
      assert.ok(result.durationSec > 8, "clips concatenated into a real duration");

      // The per-shot clips were downloaded into the render workdir.
      const assetsDir = join(dir, "out", `${res.channelId}-ep1`, "assets");
      for (let i = 0; i < 3; i++) assert.ok(existsSync(join(assetsDir, `beat${i}.mp4`)), `beat${i}.mp4 clip exists`);

      // Persisted motion source on the episode.
      const mem = await store.load(res.channelId);
      assert.equal(mem!.episodes[0]!.render?.motionSource, "video-model");
      void readFile; // keep import used across node versions
    });
  },
);

test("still mode is unaffected when no video provider is configured", { skip: !HAS_FFMPEG }, async () => {
  await withDir(async (dir) => {
    const store = new JsonMemoryStore(join(dir, "mem"));
    const res = await new ContentService(store, localRegistry()).createFromContent("Twinkle twinkle little star.");
    const result = await new RenderService(store, join(dir, "out"), { ...process.env }).render(res.channelId, 1);
    assert.equal(result.motionSource, "still");
    assert.equal(result.hasVideo, true);
  });
});
