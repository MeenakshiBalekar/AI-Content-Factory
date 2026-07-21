import { test } from "node:test";
import assert from "node:assert/strict";
import { identityFragment, identitySeed } from "../src/prompt/identity.ts";
import { sampleChannel } from "../src/examples/sample-channel.ts";
import { asCharacterId } from "../src/domain/ids.ts";

const mem = sampleChannel();
const milo = mem.characters[asCharacterId("milo")]!;

test("identity seed is deterministic across calls (locked forever)", () => {
  const a = identitySeed(mem.channel.id, milo);
  const b = identitySeed(mem.channel.id, milo);
  assert.equal(a, b);
  assert.ok(a > 0 && a < 2_147_483_647, "seed within provider range");
});

test("identity seed changes when immutable appearance changes", () => {
  const original = identitySeed(mem.channel.id, milo);
  const restyled = {
    ...milo,
    appearance: { ...milo.appearance, hair: "sleek silver fur" },
  };
  assert.notEqual(identitySeed(mem.channel.id, restyled), original);
});

test("identity seed is namespaced per channel", () => {
  const other = { ...mem.channel, id: mem.channel.id + "-2" as typeof mem.channel.id };
  assert.notEqual(
    identitySeed(other.id, milo),
    identitySeed(mem.channel.id, milo),
  );
});

test("identity fragment injects every locked appearance attribute", () => {
  const frag = identityFragment(milo);
  for (const needle of [
    milo.name,
    milo.appearance.species,
    milo.appearance.hair,
    milo.appearance.eyes,
    milo.appearance.outfit,
  ]) {
    assert.ok(frag.includes(needle), `fragment should mention "${needle}"`);
  }
});
