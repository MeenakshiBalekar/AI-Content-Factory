import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonMemoryStore } from "../src/memory/json-memory-store.ts";
import { sampleChannel } from "../src/examples/sample-channel.ts";
import { UnknownChannelError } from "../src/memory/memory-store.ts";
import { asChannelId, asEpisodeId } from "../src/domain/ids.ts";
import type { Episode } from "../src/domain/episode.ts";

async function withStore(fn: (s: JsonMemoryStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "acf-mem-"));
  try {
    await fn(new JsonMemoryStore(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("save + load round-trips full channel memory", async () => {
  await withStore(async (store) => {
    const mem = sampleChannel();
    await store.save(mem);
    const loaded = await store.load(mem.channel.id);
    assert.deepEqual(loaded, mem);
  });
});

test("listChannels reflects saved channels", async () => {
  await withStore(async (store) => {
    assert.deepEqual(await store.listChannels(), []);
    await store.save(sampleChannel());
    assert.deepEqual(await store.listChannels(), [asChannelId("tiny-explorers")]);
  });
});

test("load returns undefined for unknown channel", async () => {
  await withStore(async (store) => {
    assert.equal(await store.load(asChannelId("nope")), undefined);
  });
});

test("appendEpisode persists and preserves order", async () => {
  await withStore(async (store) => {
    const mem = sampleChannel();
    await store.save(mem);
    const ep: Episode = {
      id: asEpisodeId("tiny-explorers-ep-1"),
      channelId: mem.channel.id,
      number: 1,
      title: "t",
      logline: "l",
      beats: [],
      assets: [],
      createdAt: new Date().toISOString(),
    };
    await store.appendEpisode(mem.channel.id, ep);
    const loaded = await store.load(mem.channel.id);
    assert.equal(loaded?.episodes.length, 1);
    assert.equal(loaded?.episodes[0]?.number, 1);
  });
});

test("appendEpisode on unknown channel throws UnknownChannelError", async () => {
  await withStore(async (store) => {
    await assert.rejects(
      () =>
        store.appendEpisode(asChannelId("ghost"), {
          id: asEpisodeId("x"),
          channelId: asChannelId("ghost"),
          number: 1,
          title: "t",
          logline: "l",
          beats: [],
          assets: [],
          createdAt: new Date().toISOString(),
        }),
      UnknownChannelError,
    );
  });
});
