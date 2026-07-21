import { test } from "node:test";
import assert from "node:assert/strict";
import { CadenceParseError, nextPublishAt, parseCadence } from "../src/publishing/scheduler.ts";

test("parses daily cadence with timezone", () => {
  const c = parseCadence("daily 16:00 America/Los_Angeles");
  assert.deepEqual(c, { kind: "daily", hour: 16, minute: 0, timeZone: "America/Los_Angeles" });
});

test("parses weekly cadence and defaults timezone to UTC", () => {
  const c = parseCadence("weekly fri 10:30");
  assert.equal(c.kind, "weekly");
  assert.equal(c.weekday, 5);
  assert.equal(c.hour, 10);
  assert.equal(c.minute, 30);
  assert.equal(c.timeZone, "UTC");
});

test("rejects malformed cadences", () => {
  assert.throws(() => parseCadence("hourly 5"), CadenceParseError);
  assert.throws(() => parseCadence("daily 25:00"), CadenceParseError);
  assert.throws(() => parseCadence("weekly xyz 10:00"), CadenceParseError);
  assert.throws(() => parseCadence("daily 16:00 Mars/Phobos"), CadenceParseError);
});

test("nextPublishAt (daily, UTC) rolls to tomorrow when the time has passed", () => {
  const from = new Date("2026-07-21T18:00:00Z"); // 18:00 UTC
  const next = nextPublishAt("daily 16:00 UTC", from);
  assert.equal(next.toISOString(), "2026-07-22T16:00:00.000Z");
});

test("nextPublishAt (daily, UTC) picks today when the time is still ahead", () => {
  const from = new Date("2026-07-21T09:00:00Z");
  const next = nextPublishAt("daily 16:00 UTC", from);
  assert.equal(next.toISOString(), "2026-07-21T16:00:00.000Z");
});

test("nextPublishAt honors a timezone (16:00 America/Los_Angeles = 23:00Z in summer)", () => {
  const from = new Date("2026-07-21T12:00:00Z"); // PDT is UTC-7 in July
  const next = nextPublishAt("daily 16:00 America/Los_Angeles", from);
  assert.equal(next.toISOString(), "2026-07-21T23:00:00.000Z");
});

test("nextPublishAt (weekly) lands on the next matching weekday", () => {
  // 2026-07-21 is a Tuesday. Next Friday 10:00 UTC:
  const from = new Date("2026-07-21T00:00:00Z");
  const next = nextPublishAt("weekly fri 10:00 UTC", from);
  assert.equal(next.toISOString(), "2026-07-24T10:00:00.000Z");
});

test("nextPublishAt (weekly) rolls a week when today matches but the time passed", () => {
  // Friday 2026-07-24, 12:00 UTC — target Friday 10:00 already passed -> next Friday.
  const from = new Date("2026-07-24T12:00:00Z");
  const next = nextPublishAt("weekly fri 10:00 UTC", from);
  assert.equal(next.toISOString(), "2026-07-31T10:00:00.000Z");
});
