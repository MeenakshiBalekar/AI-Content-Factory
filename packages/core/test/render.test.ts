import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkFfmpeg,
  probeMedia,
  FfmpegNotInstalledError,
} from "../src/render/ffmpeg.ts";
import { LocalImageProvider, LocalBackendUnavailableError } from "../src/render/local-backends.ts";
import { RenderService } from "../src/render/render-service.ts";
import { resolveFontFile } from "../src/render/fonts.ts";
import { createApiServer, listen } from "../src/api/server.ts";
import { EpisodeOrchestrator } from "../src/orchestrator/orchestrator.ts";
import { JsonMemoryStore } from "../src/memory/json-memory-store.ts";
import { SqliteMemoryStore } from "../src/memory/sqlite-memory-store.ts";
import { LocalProvider } from "../src/providers/local-provider.ts";
import { ProviderRegistry } from "../src/providers/provider.ts";
import { sampleChannel } from "../src/examples/sample-channel.ts";
import { asChannelId } from "../src/domain/ids.ts";

// FFmpeg-dependent tests run only when ffmpeg is installed, so `npm test` stays green
// everywhere; CI installs ffmpeg so they run there.
const HAS_FFMPEG = await checkFfmpeg();

function localRegistry(): ProviderRegistry {
  const p = new LocalProvider();
  return new ProviderRegistry().registerText(p).registerImage(p).registerAudio(p).registerVideo(p);
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "acf-render-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("checkFfmpeg returns false for a non-existent binary (honest detection)", async () => {
  assert.equal(await checkFfmpeg("ffmpeg-definitely-not-installed-xyz"), false);
});

test("FfmpegNotInstalledError carries an actionable install message", () => {
  const e = new FfmpegNotInstalledError("ffmpeg");
  assert.match(e.message, /apt-get install -y ffmpeg/);
  assert.match(e.message, /brew install ffmpeg/);
});

test("probeMedia throws for a missing file", async () => {
  await assert.rejects(() => probeMedia("/no/such/file.mp4"));
});

test("probeMedia throws for a non-media (empty/garbage) file", async () => {
  await withDir(async (dir) => {
    const p = join(dir, "notmedia.mp4");
    await writeFile(p, "this is not a video");
    await assert.rejects(() => probeMedia(p));
  });
});

test("LocalImageProvider fails honestly when the backend is unreachable", async () => {
  await withDir(async (dir) => {
    // 127.0.0.1:9 (discard) refuses connections — a down local backend.
    const provider = new LocalImageProvider("http://127.0.0.1:9", "flux.1-schnell", join(dir, "img"));
    await assert.rejects(
      () => provider.generateToFile("a fox", 1, "16:9"),
      LocalBackendUnavailableError,
    );
  });
});

test(
  "RenderService produces a real, valid MP4 (video+audio) and persists it on the episode",
  { skip: !HAS_FFMPEG },
  async () => {
    await withDir(async (dir) => {
      const store = new JsonMemoryStore(join(dir, "mem"));
      await store.save(sampleChannel());
      await new EpisodeOrchestrator(store, localRegistry()).createEpisode(asChannelId("tiny-explorers"), { number: 4 });

      const result = await new RenderService(store, join(dir, "out")).render(asChannelId("tiny-explorers"), 4);

      assert.ok(existsSync(result.outputPath), "mp4 exists on disk");
      assert.ok(result.sizeBytes > 0, "mp4 is non-empty");
      assert.equal(result.hasVideo, true);
      assert.equal(result.hasAudio, true);
      assert.equal(result.videoCodec, "h264");
      assert.equal(result.audioCodec, "aac");
      assert.ok(result.durationSec > 3, "has a real duration");
      // No local AI backends configured in tests -> honest procedural sourcing.
      assert.equal(result.imageSource, "procedural-placeholder");
      assert.equal(result.audioSource, "procedural-silence");

      // Independent re-probe of the file on disk.
      const probe = await probeMedia(result.outputPath);
      assert.equal(probe.hasVideo, true);
      assert.equal(probe.hasAudio, true);

      // Persisted onto the episode.
      const mem = await store.load(asChannelId("tiny-explorers"));
      assert.equal(mem!.episodes[0]!.render?.hasVideo, true);
    });
  },
);

test(
  "RenderService renders with an explicit ACF_FONT_FILE (Windows-safe drawtext/subtitles path)",
  { skip: !HAS_FFMPEG },
  async () => {
    const font = resolveFontFile();
    // Only meaningful when the host actually has a resolvable font.
    if (!font) return;
    await withDir(async (dir) => {
      const store = new JsonMemoryStore(join(dir, "mem"));
      await store.save(sampleChannel());
      await new EpisodeOrchestrator(store, localRegistry()).createEpisode(asChannelId("tiny-explorers"), { number: 4 });

      // Passing the font via the service env exercises the explicit-fontfile + generated
      // Fontconfig code path (the fix for the Windows Fontconfig crash).
      const env = { ...process.env, ACF_FONT_FILE: font };
      const result = await new RenderService(store, join(dir, "out"), env).render(asChannelId("tiny-explorers"), 4);
      assert.equal(result.hasVideo, true);
      assert.equal(result.hasAudio, true);

      // The portable fonts.conf was generated in the render workdir.
      assert.ok(existsSync(join(dir, "out", "tiny-explorers-ep4", "fontconfig", "fonts.conf")));
    });
  },
);

test("RenderService errors clearly for an unknown episode", { skip: !HAS_FFMPEG }, async () => {
  await withDir(async (dir) => {
    const store = new JsonMemoryStore(join(dir, "mem"));
    await store.save(sampleChannel());
    await assert.rejects(
      () => new RenderService(store, join(dir, "out")).render(asChannelId("tiny-explorers"), 999),
      /has no episode 999/,
    );
  });
});

test(
  "API: POST render returns a real MP4 result and GET download streams video/mp4",
  { skip: !HAS_FFMPEG },
  async () => {
    await withDir(async (dir) => {
      const store = new SqliteMemoryStore(":memory:");
      await store.save(sampleChannel());
      await new EpisodeOrchestrator(store, localRegistry()).createEpisode(asChannelId("tiny-explorers"), { number: 4 });

      const server: Server = createApiServer({
        store,
        registry: localRegistry(),
        providerReport: { text: "local", image: "local", audio: "local", video: "local" },
        rendersRoot: join(dir, "renders"),
      });
      const port = await listen(server, 0);
      const base = `http://127.0.0.1:${port}`;
      try {
        const post = await fetch(`${base}/v1/channels/tiny-explorers/episodes/4/render`, { method: "POST" });
        assert.equal(post.status, 201);
        const body = (await post.json()) as { hasVideo: boolean; hasAudio: boolean; download: string };
        assert.equal(body.hasVideo, true);
        assert.equal(body.hasAudio, true);

        const status = await fetch(`${base}/v1/channels/tiny-explorers/episodes/4/render`);
        assert.equal(status.status, 200);

        const dl = await fetch(`${base}${body.download}`);
        assert.equal(dl.status, 200);
        assert.equal(dl.headers.get("content-type"), "video/mp4");
        const bytes = new Uint8Array(await dl.arrayBuffer());
        assert.ok(bytes.byteLength > 1000, "streamed a real file");

        // Unrendered episode -> 404 on GET.
        const missing = await fetch(`${base}/v1/channels/tiny-explorers/episodes/2/render`);
        assert.equal(missing.status, 404);
      } finally {
        await new Promise<void>((r) => server.close(() => { store.close(); r(); }));
      }
    });
  },
);

test("API render route validates the episode number", async () => {
  const store = new SqliteMemoryStore(":memory:");
  await store.save(sampleChannel());
  const server = createApiServer({
    store,
    registry: localRegistry(),
    providerReport: { text: "local", image: "local", audio: "local", video: "local" },
  });
  const port = await listen(server, 0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/channels/tiny-explorers/episodes/abc/render`);
    assert.equal(res.status, 400);
  } finally {
    await new Promise<void>((r) => server.close(() => { store.close(); r(); }));
  }
});
