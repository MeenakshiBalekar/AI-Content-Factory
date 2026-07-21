import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProviderRegistry } from "../src/providers/factory.ts";
import { loadProvidersConfig } from "../src/providers/http/config.ts";

test("with no config, every capability falls back to the free local provider", () => {
  const { report } = buildProviderRegistry({ config: {} });
  assert.deepEqual(report, {
    text: "local",
    image: "local",
    audio: "local",
    video: "local",
  });
});

test("real providers are wired only for capabilities that have config", () => {
  const { report } = buildProviderRegistry({
    config: {
      text: { apiKey: "k", baseUrl: "https://x", model: "gpt-4o-mini" },
      audio: { apiKey: "k", baseUrl: "https://y", modelId: "eleven_multilingual_v2" },
    },
  });
  assert.equal(report.text, "openai-text");
  assert.equal(report.audio, "elevenlabs-audio");
  assert.equal(report.image, "local"); // no image config -> fallback
  assert.equal(report.video, "local");
});

test("forceLocal overrides configured providers", () => {
  const { report } = buildProviderRegistry({
    forceLocal: true,
    config: { text: { apiKey: "k", baseUrl: "https://x", model: "m" } },
  });
  assert.equal(report.text, "local");
});

test("loadProvidersConfig reads keys from an env bag and applies defaults", () => {
  const cfg = loadProvidersConfig({
    OPENAI_API_KEY: "sk-abc",
    ELEVENLABS_API_KEY: "el-abc",
  });
  assert.equal(cfg.text?.apiKey, "sk-abc");
  assert.equal(cfg.text?.model, "gpt-4o-mini");
  assert.equal(cfg.text?.baseUrl, "https://api.openai.com");
  assert.equal(cfg.image?.model, "gpt-image-1");
  assert.equal(cfg.audio?.modelId, "eleven_multilingual_v2");
  assert.equal(cfg.video, undefined); // needs ACF_VIDEO_* trio
});

test("loadProvidersConfig wires video only when the full trio is present", () => {
  const cfg = loadProvidersConfig({
    ACF_VIDEO_API_KEY: "vk",
    ACF_VIDEO_SUBMIT_URL: "https://v/submit",
    ACF_VIDEO_STATUS_URL: "https://v/status/{id}",
  });
  assert.equal(cfg.video?.apiKey, "vk");
  assert.equal(cfg.video?.model, "veo-3.1-fast");
});
