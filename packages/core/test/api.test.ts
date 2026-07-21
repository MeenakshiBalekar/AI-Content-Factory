import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApiServer, listen } from "../src/api/server.ts";
import { SqliteMemoryStore } from "../src/memory/sqlite-memory-store.ts";
import { InMemoryJobQueue } from "../src/jobs/job-queue.ts";
import { LocalProvider } from "../src/providers/local-provider.ts";
import { ProviderRegistry } from "../src/providers/provider.ts";
import { sampleChannel } from "../src/examples/sample-channel.ts";
import type { Episode } from "../src/domain/episode.ts";
import type { Job } from "../src/jobs/job-queue.ts";

interface TestApi {
  base: string;
  close: () => Promise<void>;
}

async function startApi(): Promise<TestApi> {
  const store = new SqliteMemoryStore(":memory:");
  await store.save(sampleChannel());
  const local = new LocalProvider();
  const registry = new ProviderRegistry()
    .registerText(local)
    .registerImage(local)
    .registerAudio(local)
    .registerVideo(local);
  const server: Server = createApiServer({
    store,
    registry,
    providerReport: { text: "local", image: "local", audio: "local", video: "local" },
    jobs: new InMemoryJobQueue<Episode>(),
  });
  const port = await listen(server, 0);
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => { store.close(); r(); })),
  };
}

async function getJson<T>(url: string): Promise<{ status: number; body: T }> {
  const res = await fetch(url);
  return { status: res.status, body: (await res.json()) as T };
}

test("GET /v1/health reports ok + provider wiring", async () => {
  const api = await startApi();
  try {
    const { status, body } = await getJson<{ ok: boolean; providers: { text: string } }>(
      `${api.base}/v1/health`,
    );
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.providers.text, "local");
  } finally {
    await api.close();
  }
});

test("GET /v1/channels lists ids; /v1/channels/{id} returns memory; 404 for unknown", async () => {
  const api = await startApi();
  try {
    const list = await getJson<{ channels: string[] }>(`${api.base}/v1/channels`);
    assert.deepEqual(list.body.channels, ["tiny-explorers"]);

    const mem = await getJson<{ channel: { name: string } }>(`${api.base}/v1/channels/tiny-explorers`);
    assert.equal(mem.status, 200);
    assert.equal(mem.body.channel.name, "Tiny Explorers");

    const missing = await getJson<{ error: { status: number } }>(`${api.base}/v1/channels/nope`);
    assert.equal(missing.status, 404);
  } finally {
    await api.close();
  }
});

test("POST /v1/channels/{id}/episodes returns 202 + jobId; job completes with the episode", async () => {
  const api = await startApi();
  try {
    const res = await fetch(`${api.base}/v1/channels/tiny-explorers/episodes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ number: 248, brief: "learning to share" }),
    });
    assert.equal(res.status, 202);
    const { jobId, poll } = (await res.json()) as { jobId: string; poll: string };
    assert.ok(jobId);
    assert.equal(poll, `/v1/jobs/${jobId}`);

    // Poll until the job settles (local providers are fast).
    let job: Job<Episode> | undefined;
    for (let i = 0; i < 100; i++) {
      const r = await getJson<Job<Episode>>(`${api.base}${poll}`);
      job = r.body;
      if (job.state === "succeeded" || job.state === "failed") break;
      await new Promise((r2) => setTimeout(r2, 20));
    }
    assert.equal(job?.state, "succeeded");
    assert.equal(job?.result?.number, 248);
    assert.ok(job!.events.length >= 10, "should emit a progress event per stage");
    assert.ok(job!.result!.assets.length > 0);

    // The episode is now visible via the episodes listing (persisted to sqlite).
    const eps = await getJson<{ episodes: { number: number }[] }>(
      `${api.base}/v1/channels/tiny-explorers/episodes`,
    );
    assert.deepEqual(eps.body.episodes.map((e) => e.number), [248]);
  } finally {
    await api.close();
  }
});

test("POST validates body: bad number -> 400; unknown channel -> 404; bad JSON -> 400", async () => {
  const api = await startApi();
  try {
    const bad = await fetch(`${api.base}/v1/channels/tiny-explorers/episodes`, {
      method: "POST",
      body: JSON.stringify({ number: -3 }),
    });
    assert.equal(bad.status, 400);

    const ghost = await fetch(`${api.base}/v1/channels/ghost/episodes`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(ghost.status, 404);

    const invalid = await fetch(`${api.base}/v1/channels/tiny-explorers/episodes`, {
      method: "POST",
      body: "not json {",
    });
    assert.equal(invalid.status, 400);
  } finally {
    await api.close();
  }
});

test("GET /v1/workflows lists built-ins; POST with workflow 'shorts' produces a vertical episode", async () => {
  const api = await startApi();
  try {
    const wfs = await getJson<{ workflows: { id: string }[] }>(`${api.base}/v1/workflows`);
    assert.equal(wfs.status, 200);
    assert.deepEqual(wfs.body.workflows.map((w) => w.id), ["standard", "shorts"]);

    const res = await fetch(`${api.base}/v1/channels/tiny-explorers/episodes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "shorts" }),
    });
    assert.equal(res.status, 202);
    const { poll } = (await res.json()) as { poll: string };

    let job: Job<Episode> | undefined;
    for (let i = 0; i < 100; i++) {
      job = (await getJson<Job<Episode>>(`${api.base}${poll}`)).body;
      if (job.state === "succeeded" || job.state === "failed") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(job?.state, "succeeded");
    assert.equal(job?.result?.workflowId, "shorts");
    assert.ok(!job!.result!.assets.some((a) => a.kind === "music"));

    const bad = await fetch(`${api.base}/v1/channels/tiny-explorers/episodes`, {
      method: "POST",
      body: JSON.stringify({ workflow: "does-not-exist" }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await api.close();
  }
});

test("GET /v1/jobs/{id} 404s for unknown job; unknown route 404s", async () => {
  const api = await startApi();
  try {
    const job = await getJson(`${api.base}/v1/jobs/does-not-exist`);
    assert.equal(job.status, 404);
    const route = await getJson(`${api.base}/v1/nothing`);
    assert.equal(route.status, 404);
  } finally {
    await api.close();
  }
});
