import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { MemoryStore } from "../memory/memory-store.ts";
import type { ProviderRegistry } from "../providers/provider.ts";
import type { ProviderReport } from "../providers/factory.ts";
import { EpisodeOrchestrator } from "../orchestrator/orchestrator.ts";
import { QualityEngine } from "../quality/quality-engine.ts";
import { BUILTIN_WORKFLOWS, resolveWorkflow } from "../workflow/builtin-workflows.ts";
import { validateWorkflow, type WorkflowDefinition } from "../workflow/workflow.ts";
import { InMemoryJobQueue, type JobQueue } from "../jobs/job-queue.ts";
import { AnalyticsService } from "../analytics/analytics-service.ts";
import type { EpisodeMetrics } from "../analytics/metrics.ts";
import { PublishingService } from "../publishing/publishing-service.ts";
import { ExportPublishTarget } from "../publishing/publish-target.ts";
import type { PublishTarget } from "../publishing/publish-target.ts";
import { CadenceParseError } from "../publishing/scheduler.ts";
import type { Episode } from "../domain/episode.ts";
import { asChannelId } from "../domain/ids.ts";
import { UnknownChannelError } from "../memory/memory-store.ts";

/**
 * The REST surface for the episode kernel (Module 3). Deliberately built on node:http with
 * no framework: the routes and contracts are the design artifact — porting them to Fastify
 * later is mechanical. Long-running episode creation follows the async-job pattern:
 *
 *   POST /v1/channels/{id}/episodes  -> 202 { jobId }        (returns immediately)
 *   GET  /v1/jobs/{jobId}            -> job state + progress events + episode when done
 *
 * Sync routes:
 *   GET  /v1/health                             -> { ok, providers }
 *   GET  /v1/workflows                          -> built-in workflow templates
 *   GET  /v1/channels                           -> channel ids
 *   GET  /v1/channels/{id}                       -> full channel memory
 *   GET  /v1/channels/{id}/episodes             -> episode summaries
 *   POST /v1/channels/{id}/episodes/{n}/publish  -> publish, returns a PublishRecord
 *   POST /v1/channels/{id}/metrics              -> ingest metrics + run the learning loop
 *   GET  /v1/channels/{id}/insights             -> current learned insights
 *   GET  /v1/channels/{id}/schedule             -> next publish slot from the cadence
 */

export interface ApiDeps {
  readonly store: MemoryStore;
  readonly registry: ProviderRegistry;
  readonly providerReport: ProviderReport;
  readonly jobs?: JobQueue<Episode>;
  /** Quality gating for episode creation; defaults to the standard engine. Pass null to disable. */
  readonly quality?: QualityEngine | null;
  /** Where episodes publish (Module 6); defaults to an on-disk export target. */
  readonly publishTarget?: PublishTarget;
}

interface CreateEpisodeBody {
  readonly brief?: string;
  readonly number?: number;
  /** Workflow id: a channel-defined workflow or a built-in ("standard", "shorts"). */
  readonly workflow?: string;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
  });
  res.end(json);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  send(res, status, { error: { status, message } });
}

async function readJsonBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export function createApiServer(deps: ApiDeps): Server {
  const jobs = deps.jobs ?? new InMemoryJobQueue<Episode>();
  const quality = deps.quality === null ? undefined : deps.quality ?? new QualityEngine();
  const orchestrator = new EpisodeOrchestrator(
    deps.store,
    deps.registry,
    undefined,
    quality ? { quality } : {},
  );
  const analytics = new AnalyticsService(deps.store);
  const publishing = new PublishingService(
    deps.store,
    deps.publishTarget ?? new ExportPublishTarget(".acf-exports"),
  );

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean); // e.g. ["v1","channels","x","episodes"]
      const method = req.method ?? "GET";

      // GET /v1/health
      if (method === "GET" && url.pathname === "/v1/health") {
        return send(res, 200, { ok: true, providers: deps.providerReport });
      }

      // GET /v1/workflows — built-in workflow templates
      if (method === "GET" && url.pathname === "/v1/workflows") {
        return send(res, 200, {
          workflows: BUILTIN_WORKFLOWS.map((w) => ({
            id: w.id,
            name: w.name,
            description: w.description,
            stages: w.stages.length,
          })),
        });
      }

      // /v1/channels...
      if (parts[0] === "v1" && parts[1] === "channels") {
        // GET /v1/channels
        if (method === "GET" && parts.length === 2) {
          return send(res, 200, { channels: await deps.store.listChannels() });
        }

        const channelId = asChannelId(decodeURIComponent(parts[2] ?? ""));

        // GET /v1/channels/{id}
        if (method === "GET" && parts.length === 3) {
          const memory = await deps.store.load(channelId);
          if (!memory) return sendError(res, 404, `unknown channel "${channelId}"`);
          return send(res, 200, memory);
        }

        if (parts[3] === "episodes") {
          // GET /v1/channels/{id}/episodes — summaries, not full documents
          if (method === "GET" && parts.length === 4) {
            const memory = await deps.store.load(channelId);
            if (!memory) return sendError(res, 404, `unknown channel "${channelId}"`);
            return send(res, 200, {
              episodes: memory.episodes.map((e) => ({
                id: e.id,
                number: e.number,
                title: e.title,
                logline: e.logline,
                assetCount: e.assets.length,
                createdAt: e.createdAt,
              })),
            });
          }

          // POST /v1/channels/{id}/episodes — async job
          if (method === "POST" && parts.length === 4) {
            const memory = await deps.store.load(channelId);
            if (!memory) return sendError(res, 404, `unknown channel "${channelId}"`);

            const raw = (await readJsonBody(req)) as CreateEpisodeBody;
            if (raw.number !== undefined && (!Number.isInteger(raw.number) || raw.number < 1)) {
              return sendError(res, 400, "\"number\" must be a positive integer");
            }
            if (raw.brief !== undefined && typeof raw.brief !== "string") {
              return sendError(res, 400, "\"brief\" must be a string");
            }
            let workflow: WorkflowDefinition | undefined;
            if (raw.workflow !== undefined) {
              if (typeof raw.workflow !== "string") {
                return sendError(res, 400, "\"workflow\" must be a string id");
              }
              workflow = resolveWorkflow(raw.workflow, memory.workflows);
              if (!workflow) {
                return sendError(res, 400, `unknown workflow "${raw.workflow}"`);
              }
              const problems = validateWorkflow(workflow);
              if (problems.length) {
                return sendError(res, 400, `workflow "${raw.workflow}" is invalid: ${problems.join("; ")}`);
              }
            }

            const jobId = jobs.submit((emit) =>
              orchestrator.createEpisode(
                channelId,
                {
                  ...(raw.brief ? { brief: raw.brief } : {}),
                  ...(raw.number ? { number: raw.number } : {}),
                  ...(workflow ? { workflow } : {}),
                },
                (ev) =>
                  emit({
                    at: new Date().toISOString(),
                    label: ev.stage.label,
                    data: {
                      kind: ev.stage.kind,
                      assets: ev.assets.length,
                      ...(ev.attempts !== undefined ? { attempts: ev.attempts } : {}),
                      ...(ev.findings ? { rejects: ev.findings.filter((f) => f.severity === "reject").length } : {}),
                    },
                  }),
              ),
            );
            return send(res, 202, { jobId, poll: `/v1/jobs/${jobId}` });
          }

          // POST /v1/channels/{id}/episodes/{n}/publish
          if (method === "POST" && parts.length === 6 && parts[5] === "publish") {
            const n = Number(parts[4]);
            if (!Number.isInteger(n) || n < 1) return sendError(res, 400, "episode number must be a positive integer");
            const record = await publishing.publish(channelId, n);
            return send(res, 201, record);
          }
        }

        // POST /v1/channels/{id}/metrics — ingest performance data, run the learning loop
        if (parts[3] === "metrics" && method === "POST" && parts.length === 4) {
          const body = (await readJsonBody(req)) as { metrics?: unknown };
          const rows = Array.isArray(body) ? body : body.metrics;
          try {
            const { insights, applied } = await analytics.ingest(channelId, rows as EpisodeMetrics[]);
            return send(res, 200, { applied, insights });
          } catch (e) {
            if (e instanceof UnknownChannelError) throw e;
            return sendError(res, 400, e instanceof Error ? e.message : "invalid metrics");
          }
        }

        // GET /v1/channels/{id}/insights — current learned insights
        if (parts[3] === "insights" && method === "GET" && parts.length === 4) {
          return send(res, 200, await analytics.insights(channelId));
        }

        // GET /v1/channels/{id}/schedule — next publish slot from the channel cadence
        if (parts[3] === "schedule" && method === "GET" && parts.length === 4) {
          try {
            const next = await publishing.nextSlot(channelId);
            const memory = await deps.store.load(channelId);
            return send(res, 200, {
              cadence: memory?.channel.schedule.cadence,
              nextPublishAt: next.toISOString(),
            });
          } catch (e) {
            if (e instanceof CadenceParseError) return sendError(res, 400, e.message);
            throw e;
          }
        }
      }

      // GET /v1/jobs/{id}
      if (method === "GET" && parts[0] === "v1" && parts[1] === "jobs" && parts.length === 3) {
        const job = jobs.get(parts[2]!);
        if (!job) return sendError(res, 404, `unknown job "${parts[2]}"`);
        return send(res, 200, job);
      }

      return sendError(res, 404, `no route: ${method} ${url.pathname}`);
    } catch (err) {
      if (err instanceof UnknownChannelError) return sendError(res, 404, err.message);
      if (err instanceof SyntaxError) return sendError(res, 400, "invalid JSON body");
      sendError(res, 500, err instanceof Error ? err.message : "internal error");
    }
  });
}

/** Start listening; resolves with the bound port (0 = ephemeral, used in tests). */
export function listen(server: Server, port: number, host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : port);
    });
  });
}
