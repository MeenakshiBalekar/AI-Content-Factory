import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Automatic1111ImageProvider,
  sdDimensions,
} from "../src/providers/automatic1111-image-provider.ts";
import { FileObjectStore } from "../src/storage/object-store.ts";
import { RenderService } from "../src/render/render-service.ts";
import { checkFfmpeg, runFfmpeg } from "../src/render/ffmpeg.ts";
import { EpisodeOrchestrator } from "../src/orchestrator/orchestrator.ts";
import { JsonMemoryStore } from "../src/memory/json-memory-store.ts";
import { LocalProvider } from "../src/providers/local-provider.ts";
import { ProviderRegistry } from "../src/providers/provider.ts";
import { sampleChannel } from "../src/examples/sample-channel.ts";
import { asChannelId } from "../src/domain/ids.ts";

const HAS_FFMPEG = await checkFfmpeg();
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface Captured {
  url: string;
  body: string;
}

/** Fake Draw Things / AUTOMATIC1111 HTTP API server (POST /sdapi/v1/txt2img). */
async function fakeSdapiServer(png: Buffer): Promise<{ base: string; calls: Captured[]; close: () => Promise<void> }> {
  const calls: Captured[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    calls.push({ url: req.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
    if (req.url === "/sdapi/v1/txt2img") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ images: [png.toString("base64")], parameters: {}, info: "{}" }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "acf-a1111-"));
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

test("sdDimensions maps aspects to SD-friendly, capped, /64 sizes", () => {
  assert.deepEqual(sdDimensions("16:9", 768), { width: 768, height: 448 });
  assert.deepEqual(sdDimensions("9:16", 768), { width: 448, height: 768 });
  assert.deepEqual(sdDimensions("1:1", 768), { width: 512, height: 512 });
  for (const a of ["16:9", "9:16", "4:3", "3:4", "1:1"]) {
    const { width, height } = sdDimensions(a, 768);
    assert.equal(width % 64, 0, `${a} width /64`);
    assert.equal(height % 64, 0, `${a} height /64`);
  }
});

test("Automatic1111ImageProvider posts txt2img with prompt/seed/size and stores the PNG bytes", async () => {
  await withDir(async (dir) => {
    const srv = await fakeSdapiServer(PNG_1x1);
    try {
      const provider = new Automatic1111ImageProvider(
        { baseUrl: srv.base, steps: 24, cfgScale: 7, negativePrompt: "blurry", maxEdge: 768 },
        new FileObjectStore(dir),
      );
      const asset = await provider.generateImage({
        prompt: "Milo the red fox cub and Bea the honeybee, storybook",
        seed: 123,
        aspect: "16:9",
      });
      const bytes = await readFile(fileURLToPath(asset.outputUri));
      assert.deepEqual(new Uint8Array(bytes), new Uint8Array(PNG_1x1));

      const call = srv.calls.find((c) => c.url === "/sdapi/v1/txt2img")!;
      const sent = JSON.parse(call.body) as Record<string, unknown>;
      assert.match(sent["prompt"] as string, /Milo/);
      assert.match(sent["prompt"] as string, /Bea/);
      assert.equal(sent["seed"], 123);
      assert.equal(sent["steps"], 24);
      assert.equal(sent["width"], 768);
      assert.equal(sent["height"], 448);
      assert.equal(sent["negative_prompt"], "blurry");

      // Draw Things 422s on unrecognized keys — the payload must contain ONLY supported keys.
      const allowed = new Set(["prompt", "negative_prompt", "steps", "cfg_scale", "width", "height", "seed"]);
      const sentKeys = Object.keys(sent);
      for (const k of sentKeys) assert.ok(allowed.has(k), `unexpected payload key "${k}"`);
      assert.ok(!("save_images" in sent), "save_images must not be sent");
      assert.ok(!("send_images" in sent), "send_images must not be sent");
      assert.ok(!("batch_size" in sent) && !("n_iter" in sent), "no batch_size/n_iter");
    } finally {
      await srv.close();
    }
  });
});

test("Automatic1111ImageProvider strips a data: URI prefix if present", async () => {
  await withDir(async (dir) => {
    const server: Server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ images: [`data:image/png;base64,${PNG_1x1.toString("base64")}`] }));
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    try {
      const provider = new Automatic1111ImageProvider(
        { baseUrl: `http://127.0.0.1:${port}`, steps: 10, cfgScale: 7, negativePrompt: "", maxEdge: 512 },
        new FileObjectStore(dir),
      );
      const asset = await provider.generateImage({ prompt: "x", seed: 1, aspect: "1:1" });
      const bytes = await readFile(fileURLToPath(asset.outputUri));
      assert.deepEqual(new Uint8Array(bytes), new Uint8Array(PNG_1x1));
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

test(
  "END-TO-END: ACF_IMAGE_API=automatic1111 renders with Draw Things images (Milo+Bea prompts, 3 beats)",
  { skip: !HAS_FFMPEG },
  async () => {
    await withDir(async (dir) => {
      // A realistically-sized PNG (a 1x1 would break ffmpeg zoompan).
      const realPng = join(dir, "gen.png");
      await runFfmpeg(["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=orange:s=768x448", "-frames:v", "1", realPng], 60_000);
      const png = await readFile(realPng);

      const srv = await fakeSdapiServer(png);
      try {
        const store = new JsonMemoryStore(join(dir, "mem"));
        await store.save(sampleChannel());
        await new EpisodeOrchestrator(store, localRegistry()).createEpisode(asChannelId("tiny-explorers"), { number: 5 });

        const env = {
          ...process.env,
          ACF_IMAGE_BASE_URL: srv.base,
          ACF_IMAGE_API: "automatic1111",
          ACF_IMAGE_STEPS: "12",
        };
        const result = await new RenderService(store, join(dir, "out"), env).render(asChannelId("tiny-explorers"), 5);

        assert.equal(result.imageSource, "ai-local");
        assert.equal(result.hasVideo, true);
        assert.equal(result.hasAudio, true);

        const assetsDir = join(dir, "out", "tiny-explorers-ep5", "assets");
        for (let i = 0; i < 3; i++) {
          const beatPng = join(assetsDir, `beat${i}.png`);
          assert.ok(existsSync(beatPng));
          assert.deepEqual(new Uint8Array(await readFile(beatPng)), new Uint8Array(png), `beat${i} uses the Draw Things image`);
        }

        const gen = srv.calls.filter((c) => c.url === "/sdapi/v1/txt2img");
        assert.equal(gen.length, 3, "one txt2img per beat");
        for (const call of gen) {
          const sent = JSON.parse(call.body) as { prompt: string; steps: number };
          assert.match(sent.prompt, /Milo/);
          assert.match(sent.prompt, /Bea/);
          assert.match(sent.prompt, /fluffy orange fur/);
          assert.match(sent.prompt, /keep exactly consistent/);
          assert.equal(sent.steps, 12);
        }
      } finally {
        await srv.close();
      }
    });
  },
);
