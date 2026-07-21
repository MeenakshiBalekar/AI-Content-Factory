import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryJobQueue } from "../src/jobs/job-queue.ts";

test("job runs asynchronously, records progress events, and succeeds", async () => {
  const q = new InMemoryJobQueue<string>();
  const id = q.submit(async (emit) => {
    emit({ at: new Date().toISOString(), label: "step 1" });
    emit({ at: new Date().toISOString(), label: "step 2", data: { n: 2 } });
    return "done";
  });

  // submit() returns before the task settles
  const early = q.get(id);
  assert.ok(early && (early.state === "queued" || early.state === "running"));

  const settled = await q.wait(id);
  assert.equal(settled.state, "succeeded");
  assert.equal(settled.result, "done");
  assert.deepEqual(settled.events.map((e) => e.label), ["step 1", "step 2"]);
  assert.equal(settled.events[1]?.data?.n, 2);
});

test("a throwing task settles as failed with the error message", async () => {
  const q = new InMemoryJobQueue<string>();
  const id = q.submit(async () => {
    throw new Error("provider exploded");
  });
  const settled = await q.wait(id);
  assert.equal(settled.state, "failed");
  assert.equal(settled.error, "provider exploded");
  assert.equal(settled.result, undefined);
});

test("get() returns undefined for unknown id; wait() rejects", async () => {
  const q = new InMemoryJobQueue<number>();
  assert.equal(q.get("nope"), undefined);
  await assert.rejects(() => q.wait("nope"), /Unknown job/);
});

test("snapshots are isolated from later mutation", async () => {
  const q = new InMemoryJobQueue<string>();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const id = q.submit(async (emit) => {
    emit({ at: "t0", label: "first" });
    await gate;
    emit({ at: "t1", label: "second" });
    return "ok";
  });

  // Wait until the first event is visible, snapshot, then let the job finish.
  for (let i = 0; i < 100 && (q.get(id)?.events.length ?? 0) < 1; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const snap = q.get(id)!;
  assert.equal(snap.events.length, 1);
  release();
  const settled = await q.wait(id);
  assert.equal(settled.events.length, 2);
  assert.equal(snap.events.length, 1, "earlier snapshot must not grow");
});
