import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProviderRegistry } from "../src/providers/factory.ts";
import { loadProvidersConfig } from "../src/providers/http/config.ts";

test("with no config, every capability falls back to the free offline provider", () => {
  const { report } = buildProviderRegistry({ config: {} });
  assert.deepEqual(report, {
    text: "local [offline]",
    image: "local [offline]",
    audio: "local [offline]",
    video: "local [offline]",
  });
});

test("self-hosted endpoints wire keyless and are tagged [self-hosted]", () => {
  const { report } = buildProviderRegistry({
    config: {
      text: { baseUrl: "http://gpu-1:8000", model: "llama3.1:8b", mode: "self-hosted" },
      image: { baseUrl: "http://gpu-2:8080", model: "flux.1-schnell", mode: "self-hosted" },
      speech: { baseUrl: "http://gpu-3:8880", model: "kokoro", mode: "self-hosted" },
      video: {
        submitUrl: "http://render-queue:9000/jobs",
        statusUrlTemplate: "http://render-queue:9000/jobs/{id}",
        model: "ltx-video",
        pollIntervalMs: 1000,
        maxPollMs: 60000,
        mode: "self-hosted",
      },
    },
  });
  assert.deepEqual(report, {
    text: "chat-completions [self-hosted]",
    image: "images-api [self-hosted]",
    audio: "speech-api [self-hosted]",
    video: "async-video [self-hosted]",
  });
});

test("self-hosted speech wins over the commercial legacy fallback", () => {
  const { report } = buildProviderRegistry({
    config: {
      speech: { baseUrl: "http://gpu-3:8880", model: "kokoro", mode: "self-hosted" },
      elevenlabs: { apiKey: "k", baseUrl: "https://api.elevenlabs.io", modelId: "m" },
    },
  });
  assert.equal(report.audio, "speech-api [self-hosted]");
});

test("forceLocal overrides configured providers", () => {
  const { report } = buildProviderRegistry({
    forceLocal: true,
    config: { text: { baseUrl: "http://gpu-1:8000", model: "m", mode: "self-hosted" } },
  });
  assert.equal(report.text, "local [offline]");
});

test("env: ACF_*_BASE_URL yields keyless self-hosted config with open-model defaults", () => {
  const cfg = loadProvidersConfig({
    ACF_TEXT_BASE_URL: "http://localhost:11434",
    ACF_IMAGE_BASE_URL: "http://localhost:8080",
    ACF_SPEECH_BASE_URL: "http://localhost:8880",
  });
  assert.equal(cfg.text?.mode, "self-hosted");
  assert.equal(cfg.text?.apiKey, undefined);
  assert.equal(cfg.text?.model, "llama3.1:8b");
  assert.equal(cfg.image?.model, "flux.1-schnell");
  assert.equal(cfg.speech?.model, "kokoro");
});

test("env: self-hosted base URL beats a commercial key for the same capability", () => {
  const cfg = loadProvidersConfig({
    ACF_TEXT_BASE_URL: "http://localhost:11434",
    OPENAI_API_KEY: "sk-should-be-ignored-for-text",
  });
  assert.equal(cfg.text?.mode, "self-hosted");
  assert.equal(cfg.text?.baseUrl, "http://localhost:11434");
  // Image had no self-hosted URL, so the commercial fallback applies there (explicitly).
  assert.equal(cfg.image?.mode, "commercial");
});

test("env: video queue config is keyless self-hosted by default", () => {
  const cfg = loadProvidersConfig({
    ACF_VIDEO_SUBMIT_URL: "http://render:9000/jobs",
    ACF_VIDEO_STATUS_URL: "http://render:9000/jobs/{id}",
  });
  assert.equal(cfg.video?.mode, "self-hosted");
  assert.equal(cfg.video?.apiKey, undefined);
  assert.equal(cfg.video?.model, "ltx-video");
});
