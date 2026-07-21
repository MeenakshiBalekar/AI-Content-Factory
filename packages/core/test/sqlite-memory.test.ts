import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../src/memory/sqlite-memory-store.ts";
import { sampleChannel } from "../src/examples/sample-channel.ts";
import { UnknownChannelError } from "../src/memory/memory-store.ts";
import { asChannelId, asEpisodeId } from "../src/domain/ids.ts";
import type { Episode } from "../src/domain/episode.ts";

const makeEpisode = (n: number): Episode => ({
  id: asEpisodeId(`tiny-explorers-ep-${n}`),
  channelId: asChannelId("tiny-explorers"),
  number: n,
  title: `t${n}`,
  logline: "l",
  beats: [],
  assets: [],
  createdAt: new Date().toISOString(),
});

test("sqlite: save + load round-trips full channel memory (in-memory db)", async () => {
  const store = new SqliteMemoryStore(":memory:");
  const mem = sampleChannel();
  await store.save(mem);
  const loaded = await store.load(mem.channel.id);
  assert.deepEqual(loaded, mem);
  store.close();
});

test("sqlite: appendEpisode is an INSERT, ordered by number on load", async () => {
  const store = new SqliteMemoryStore(":memory:");
  await store.save(sampleChannel());
  await store.appendEpisode(asChannelId("tiny-explorers"), makeEpisode(2));
  await store.appendEpisode(asChannelId("tiny-explorers"), makeEpisode(1));
  const mem = await store.load(asChannelId("tiny-explorers"));
  assert.deepEqual(mem?.episodes.map((e) => e.number), [1, 2]);
  store.close();
});

test("sqlite: duplicate episode number for a channel is rejected (UNIQUE)", async () => {
  const store = new SqliteMemoryStore(":memory:");
  await store.save(sampleChannel());
  await store.appendEpisode(asChannelId("tiny-explorers"), makeEpisode(1));
  await assert.rejects(() =>
    store.appendEpisode(asChannelId("tiny-explorers"), {
      ...makeEpisode(1),
      id: asEpisodeId("different-id-same-number"),
    }),
  );
  store.close();
});

test("sqlite: appendEpisode on unknown channel throws UnknownChannelError", async () => {
  const store = new SqliteMemoryStore(":memory:");
  await assert.rejects(
    () => store.appendEpisode(asChannelId("ghost"), makeEpisode(1)),
    UnknownChannelError,
  );
  store.close();
});

test("sqlite: memory persists across store instances on the same file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acf-sql-"));
  const file = join(dir, "acf.db");
  try {
    const a = new SqliteMemoryStore(file);
    await a.save(sampleChannel());
    await a.appendEpisode(asChannelId("tiny-explorers"), makeEpisode(1));
    a.close();

    const b = new SqliteMemoryStore(file);
    const mem = await b.load(asChannelId("tiny-explorers"));
    assert.equal(mem?.channel.name, "Tiny Explorers");
    assert.equal(mem?.episodes.length, 1);
    assert.deepEqual(await b.listChannels(), [asChannelId("tiny-explorers")]);
    b.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
