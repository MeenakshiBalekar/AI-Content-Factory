import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ImagesApiImageProvider } from "../src/providers/images-api-image-provider.ts";
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

// A real 1x1 PNG (red). Small but a genuine, decodable image — stands in for a diffusion
// server's output so the test needs no GPU.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_B64, "base64");

interface Captured {
  url: string;
  body: string;
}

/** A fake OpenAI-images-compatible local server (the shape LocalAI / SD-WebUI expose).
 *  Serves the provided PNG bytes (defaults to the 1x1 fixture for the byte-round-trip tests). */
async function fakeImageServer(mode: "b64" | "url", png: Buffer = PNG_BYTES): Promise<{
  base: string;
  calls: Captured[];
  close: () => Promise<void>;
}> {
  const calls: Captured[] = [];
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    calls.push({ url: req.url ?? "", body });

    if (req.url === "/v1/images/generations") {
      res.setHeader("content-type", "application/json");
      if (mode === "b64") {
        res.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
      } else {
        const host = req.headers.host;
        res.end(JSON.stringify({ data: [{ url: `http://${host}/img/out.png` }] }));
      }
      return;
    }
    if (req.url === "/img/out.png") {
      res.setHeader("content-type", "image/png");
      res.end(png);
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
  const dir = await mkdtemp(join(tmpdir(), "acf-img-"));
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

test("ImagesApiImageProvider sends the prompt + b64 request and stores the returned bytes", async () => {
  await withDir(async (dir) => {
    const srv = await fakeImageServer("b64");
    try {
      const provider = new ImagesApiImageProvider(
        { baseUrl: srv.base, model: "flux.1-schnell", mode: "self-hosted" },
        new FileObjectStore(dir),
      );
      const asset = await provider.generateImage({
        prompt: "Milo, a 6 year old red fox cub with fluffy orange fur. Bea, a honeybee.",
        seed: 7,
        aspect: "16:9",
      });
      const bytes = await readFile(fileURLToPath(asset.outputUri));
      assert.deepEqual(new Uint8Array(bytes), new Uint8Array(PNG_BYTES), "stored the server's real image bytes");

      const sent = JSON.parse(srv.calls[0]!.body) as { prompt: string; size: string; response_format: string };
      assert.match(sent.prompt, /Milo/);
      assert.match(sent.prompt, /Bea/);
      assert.equal(sent.size, "1536x1024"); // 16:9 landscape
      assert.equal(sent.response_format, "b64_json");
    } finally {
      await srv.close();
    }
  });
});

test("ImagesApiImageProvider downloads the image when the server returns a URL", async () => {
  await withDir(async (dir) => {
    const srv = await fakeImageServer("url");
    try {
      const provider = new ImagesApiImageProvider(
        { baseUrl: srv.base, model: "sdxl", mode: "self-hosted" },
        new FileObjectStore(dir),
      );
      const asset = await provider.generateImage({ prompt: "a fox", seed: 1, aspect: "1:1" });
      const bytes = await readFile(fileURLToPath(asset.outputUri));
      assert.deepEqual(new Uint8Array(bytes), new Uint8Array(PNG_BYTES));
      assert.ok(srv.calls.some((c) => c.url === "/img/out.png"), "downloaded the returned URL");
    } finally {
      await srv.close();
    }
  });
});

test(
  "END-TO-END: with ACF_IMAGE_BASE_URL set, the render uses AI images (not procedural), " +
    "sending Milo+Bea consistency prompts for all 3 beats",
  { skip: !HAS_FFMPEG },
  async () => {
    await withDir(async (dir) => {
      // A realistically-sized image, as a diffusion server would actually return (a 1x1
      // pixel would send FFmpeg's zoompan into a pathological loop — not a real scenario).
      const realPng = join(dir, "gen.png");
      await runFfmpeg(["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=teal:s=1024x576", "-frames:v", "1", realPng], 60_000);
      const pngBytes = await readFile(realPng);

      const srv = await fakeImageServer("b64", pngBytes);
      try {
        const store = new JsonMemoryStore(join(dir, "mem"));
        await store.save(sampleChannel());
        // Episode 5: the first render intended to use real character images.
        await new EpisodeOrchestrator(store, localRegistry()).createEpisode(asChannelId("tiny-explorers"), { number: 5 });

        const env = { ...process.env, ACF_IMAGE_BASE_URL: srv.base, ACF_IMAGE_MODEL: "flux.1-schnell" };
        const result = await new RenderService(store, join(dir, "out"), env).render(asChannelId("tiny-explorers"), 5);

        // The render sourced images from the local AI server, not procedural placeholders.
        assert.equal(result.imageSource, "ai-local");
        assert.equal(result.hasVideo, true);
        assert.equal(result.hasAudio, true);

        // Each of the 3 beats' still frames on disk equals the server's returned image bytes.
        const assetsDir = join(dir, "out", "tiny-explorers-ep5", "assets");
        for (let i = 0; i < 3; i++) {
          const beatPng = join(assetsDir, `beat${i}.png`);
          assert.ok(existsSync(beatPng), `beat${i}.png exists`);
          const bytes = await readFile(beatPng);
          assert.deepEqual(new Uint8Array(bytes), new Uint8Array(pngBytes), `beat${i} uses the AI image`);
        }

        // The server received one generation request per beat, each carrying the full
        // character-consistency prompt (Milo + Bea + the locked appearance fragment).
        const genCalls = srv.calls.filter((c) => c.url === "/v1/images/generations");
        assert.equal(genCalls.length, 3, "one image request per beat");
        for (const call of genCalls) {
          const sent = JSON.parse(call.body) as { prompt: string };
          assert.match(sent.prompt, /Milo/);
          assert.match(sent.prompt, /Bea/);
          assert.match(sent.prompt, /fluffy orange fur/); // locked identity fragment preserved
          assert.match(sent.prompt, /keep exactly consistent/); // composer's consistency directive
        }
      } finally {
        await srv.close();
      }
    });
  },
);
