import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpClient, ProviderError } from "../src/providers/http/http-client.ts";
import { OpenAITextProvider } from "../src/providers/openai-text-provider.ts";
import { OpenAIImageProvider } from "../src/providers/openai-image-provider.ts";
import { ElevenLabsAudioProvider } from "../src/providers/elevenlabs-audio-provider.ts";
import { AsyncVideoProvider } from "../src/providers/async-video-provider.ts";
import { FileObjectStore } from "../src/storage/object-store.ts";

/** Minimal request recorder + JSON body reader for the mock vendor servers. */
interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

interface Mock {
  base: string;
  calls: Recorded[];
  close: () => Promise<void>;
}

async function mockServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: string, calls: Recorded[]) => void,
): Promise<Mock> {
  const calls: Recorded[] = [];
  const server: Server = createServer(async (req, res) => {
    const body = await readBody(req);
    calls.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
    handler(req, res, body, calls);
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

async function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "acf-http-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("OpenAITextProvider sends auth + chat body and parses the completion", async () => {
  const mock = await mockServer((req, res, _body, calls) => {
    void calls;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "Once upon a time..." } }] }));
  });
  try {
    const provider = new OpenAITextProvider({ apiKey: "sk-test", baseUrl: mock.base, model: "gpt-4o-mini" });
    const out = await provider.generateText({ prompt: "write a story", system: "be kind" });
    assert.equal(out, "Once upon a time...");

    const call = mock.calls[0]!;
    assert.equal(call.method, "POST");
    assert.equal(call.url, "/v1/chat/completions");
    assert.equal(call.headers["authorization"], "Bearer sk-test");
    const sent = JSON.parse(call.body) as { model: string; messages: { role: string }[] };
    assert.equal(sent.model, "gpt-4o-mini");
    assert.deepEqual(sent.messages.map((m) => m.role), ["system", "user"]);
  } finally {
    await mock.close();
  }
});

test("OpenAIImageProvider decodes base64 and persists real bytes to the object store", async () => {
  await withTmp(async (dir) => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const mock = await mockServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ b64_json: pngBytes.toString("base64") }] }));
    });
    try {
      const provider = new OpenAIImageProvider(
        { apiKey: "sk", baseUrl: mock.base, model: "gpt-image-1" },
        new FileObjectStore(dir),
      );
      const asset = await provider.generateImage({ prompt: "Milo the fox", seed: 42, aspect: "16:9" });
      assert.equal(asset.provider, "openai-image");
      assert.ok(asset.outputUri.startsWith("file://"));
      const path = fileURLToPath(asset.outputUri);
      const written = await readFile(path);
      assert.deepEqual(new Uint8Array(written), new Uint8Array(pngBytes));
      // aspect 16:9 must request a landscape size
      const sent = JSON.parse(mock.calls[0]!.body) as { size: string };
      assert.equal(sent.size, "1536x1024");
    } finally {
      await mock.close();
    }
  });
});

test("ElevenLabsAudioProvider posts to the voice id and stores returned audio bytes", async () => {
  await withTmp(async (dir) => {
    const audio = Buffer.from("ID3fake-mp3-bytes");
    const mock = await mockServer((_req, res) => {
      res.setHeader("content-type", "audio/mpeg");
      res.end(audio);
    });
    try {
      const provider = new ElevenLabsAudioProvider(
        { apiKey: "el-key", baseUrl: mock.base, modelId: "eleven_multilingual_v2" },
        new FileObjectStore(dir),
      );
      const asset = await provider.generateAudio({
        text: "Let's find out!",
        voiceRef: "voice:warm-child-male-01",
        pitch: 3,
        speed: 1.05,
        emotion: "excited",
      });
      const written = await readFile(fileURLToPath(asset.outputUri));
      assert.deepEqual(new Uint8Array(written), new Uint8Array(audio));

      const call = mock.calls[0]!;
      assert.equal(call.url, "/v1/text-to-speech/voice%3Awarm-child-male-01");
      assert.equal(call.headers["xi-api-key"], "el-key");
    } finally {
      await mock.close();
    }
  });
});

test("AsyncVideoProvider submits a job then polls until it succeeds", async () => {
  let statusHits = 0;
  const mock = await mockServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/submit") {
      res.end(JSON.stringify({ id: "job-123" }));
    } else {
      statusHits++;
      const done = statusHits >= 2;
      res.end(
        JSON.stringify(
          done
            ? { status: "succeeded", url: "https://cdn.example/job-123.mp4" }
            : { status: "processing" },
        ),
      );
    }
  });
  try {
    const provider = new AsyncVideoProvider({
      apiKey: "vk",
      submitUrl: `${mock.base}/submit`,
      statusUrlTemplate: `${mock.base}/status/{id}`,
      model: "veo-3.1-fast",
      pollIntervalMs: 1,
      maxPollMs: 5000,
    });
    const asset = await provider.generateVideo({ prompt: "scene", seed: 7, aspect: "16:9", durationSec: 8 });
    assert.equal(asset.outputUri, "https://cdn.example/job-123.mp4");
    assert.equal(asset.meta?.jobId, "job-123");
    assert.ok(statusHits >= 2, "should have polled more than once");
    assert.equal(mock.calls[0]!.url, "/submit");
    assert.equal(mock.calls[1]!.url, "/status/job-123");
  } finally {
    await mock.close();
  }
});

test("AsyncVideoProvider surfaces a failed job as a non-retryable ProviderError", async () => {
  const mock = await mockServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      req.url === "/submit"
        ? JSON.stringify({ id: "j" })
        : JSON.stringify({ status: "failed", error: "content policy" }),
    );
  });
  try {
    const provider = new AsyncVideoProvider({
      apiKey: "vk",
      submitUrl: `${mock.base}/submit`,
      statusUrlTemplate: `${mock.base}/status/{id}`,
      model: "m",
      pollIntervalMs: 1,
      maxPollMs: 5000,
    });
    await assert.rejects(
      () => provider.generateVideo({ prompt: "x", seed: 1, aspect: "16:9", durationSec: 4 }),
      (e) => e instanceof ProviderError && e.retryable === false,
    );
  } finally {
    await mock.close();
  }
});

test("HttpClient retries transient 5xx then succeeds (backoff sleep injected)", async () => {
  let hits = 0;
  const mock = await mockServer((_req, res) => {
    hits++;
    if (hits < 3) {
      res.statusCode = 503;
      res.end("temporarily unavailable");
    } else {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    }
  });
  try {
    const client = new HttpClient({
      provider: "test",
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
      sleep: async () => {}, // don't actually wait
    });
    const out = await client.requestJson<{ ok: boolean }>({ method: "GET", url: `${mock.base}/x` });
    assert.equal(out.ok, true);
    assert.equal(hits, 3);
  } finally {
    await mock.close();
  }
});

test("HttpClient gives up on a 4xx as non-retryable", async () => {
  let hits = 0;
  const mock = await mockServer((_req, res) => {
    hits++;
    res.statusCode = 400;
    res.end("bad request");
  });
  try {
    const client = new HttpClient({ provider: "test", sleep: async () => {} });
    await assert.rejects(
      () => client.requestJson({ method: "GET", url: `${mock.base}/x` }),
      (e) => e instanceof ProviderError && e.status === 400 && e.retryable === false,
    );
    assert.equal(hits, 1, "must not retry a 400");
  } finally {
    await mock.close();
  }
});
