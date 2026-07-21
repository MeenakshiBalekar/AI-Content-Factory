import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContentDirector,
  decomposeDeterministically,
  splitIntoLines,
} from "../src/content/content-director.ts";
import { storyboardToPlan } from "../src/content/storyboard-adapter.ts";
import { ContentService } from "../src/content/content-service.ts";
import { validateStoryboard } from "../src/content/storyboard.ts";
import { JsonMemoryStore } from "../src/memory/json-memory-store.ts";
import { LocalProvider } from "../src/providers/local-provider.ts";
import { ProviderRegistry, type TextProvider } from "../src/providers/provider.ts";
import { PromptComposer } from "../src/prompt/prompt-composer.ts";

const RHYME = "I eat healthy, healthy, healthy. I eat my broccoli. I eat my carrot.";

function localRegistry(): ProviderRegistry {
  const p = new LocalProvider();
  return new ProviderRegistry().registerText(p).registerImage(p).registerAudio(p).registerVideo(p);
}

test("splitIntoLines breaks a rhyme into scene-sized lines", () => {
  const lines = splitIntoLines(RHYME);
  assert.equal(lines.length, 3);
  assert.match(lines[1]!, /broccoli/);
});

test("deterministic decomposition produces a generic, content-driven storyboard (no fixed cast)", () => {
  const sb = decomposeDeterministically(RHYME);
  assert.equal(validateStoryboard(sb).length, 0);
  assert.equal(sb.scenes.length, 3);
  assert.match(sb.scenes[1]!.lyrics, /broccoli/);
  assert.match(sb.scenes[1]!.environment, /kitchen/);
  assert.equal(sb.characters.length, 1);
  // The cast is generated from input, not a hardcoded reference character.
  assert.ok(!/tiny explorers/i.test(sb.title));
  assert.ok(sb.characters[0]!.description.length > 10);
});

test("environment is inferred from content keywords, generically", () => {
  assert.match(decomposeDeterministically("Time to brush my teeth.").scenes[0]!.environment, /bathroom/);
  assert.match(decomposeDeterministically("We plant a flower in the garden.").scenes[0]!.environment, /garden/);
  assert.match(decomposeDeterministically("Goodnight, time for bed.").scenes[0]!.environment, /bedroom/);
});

test("ContentDirector uses a text model's JSON when available", async () => {
  const model: TextProvider = {
    name: "fake",
    async generateText() {
      return `Here you go:\n{"title":"Counting Stars","style":"soft watercolor","aspectRatio":"16:9",` +
        `"characters":[{"name":"Ravi","description":"a small boy with a blue hat","voice":"gentle","palette":["#123456"]}],` +
        `"scenes":[{"lyrics":"one star","visual":"boy points at a star","action":"points up","environment":"night sky","characters":["Ravi"]}],` +
        `"song":{"mood":"calm lullaby"}}`;
    },
  };
  const sb = await new ContentDirector(model).direct("one star two star");
  assert.equal(sb.title, "Counting Stars");
  assert.equal(sb.characters[0]!.name, "Ravi");
  assert.equal(sb.scenes[0]!.environment, "night sky");
  assert.equal(sb.sourceText, "one star two star");
});

test("ContentDirector falls back to deterministic when the model returns non-JSON", async () => {
  const model: TextProvider = { name: "bad", async generateText() { return "sorry, I cannot do that"; } };
  const sb = await new ContentDirector(model).direct(RHYME);
  assert.equal(sb.scenes.length, 3); // deterministic path
});

test("storyboardToPlan builds a generic channel + beats; image prompts carry scene content, not Milo", () => {
  const sb = decomposeDeterministically(RHYME);
  const plan = storyboardToPlan(sb);
  assert.equal(plan.beats.length, 3);
  assert.equal(Object.keys(plan.memory.characters).length, 1);

  // The PromptComposer produces a content-driven image prompt from the generic cast.
  const composer = new PromptComposer(plan.memory);
  const prompt = composer.imagePrompt(plan.beats[1]!).prompt;
  assert.match(prompt, /broccoli/);
  assert.ok(!/milo/i.test(prompt), "no hardcoded reference character");
  // The generated character's free-form description flows through identity locking.
  assert.match(prompt, new RegExp(sb.characters[0]!.name));
});

async function withStore(fn: (s: JsonMemoryStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "acf-content-"));
  try {
    await fn(new JsonMemoryStore(join(dir, "mem")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("ContentService.createFromContent turns arbitrary text into a full episode", async () => {
  await withStore(async (store) => {
    const res = await new ContentService(store, localRegistry()).createFromContent(RHYME);
    assert.equal(res.storyboard.scenes.length, 3);
    assert.equal(res.episode.beats.length, 3);
    assert.equal(res.episode.number, 1);
    // Every scene produced a keyframe image + voice line + subtitles, generically.
    const kinds = new Set<string>(res.episode.assets.map((a) => a.kind));
    for (const k of ["image", "voice", "subtitles", "music"]) assert.ok(kinds.has(k), `has ${k}`);
    assert.equal(res.episode.quality?.passed, true);
    // Persisted under a slug of the content, not a fixed channel.
    const mem = await store.load(res.channelId);
    assert.equal(mem?.episodes.length, 1);
    assert.ok(!/tiny-explorers/.test(res.channelId));
  });
});

test("a completely different input yields a completely different storyboard", async () => {
  await withStore(async (store) => {
    const a = await new ContentService(store, localRegistry()).createFromContent("The wheels on the bus go round and round.");
    const b = await new ContentService(store, localRegistry()).createFromContent("Twinkle twinkle little star, how I wonder what you are.");
    assert.notEqual(a.channelId, b.channelId);
    assert.notEqual(a.storyboard.title, b.storyboard.title);
    assert.match(a.storyboard.scenes[0]!.lyrics, /wheels on the bus/i);
    assert.match(b.storyboard.scenes[0]!.lyrics, /twinkle/i);
  });
});
