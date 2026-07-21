#!/usr/bin/env -S node --experimental-strip-types
import { parseArgs } from "node:util";
import { EpisodeOrchestrator } from "./orchestrator/orchestrator.ts";
import { JsonMemoryStore } from "./memory/json-memory-store.ts";
import { SqliteMemoryStore } from "./memory/sqlite-memory-store.ts";
import type { MemoryStore } from "./memory/memory-store.ts";
import { buildProviderRegistry } from "./providers/factory.ts";
import { FileObjectStore } from "./storage/object-store.ts";
import { createApiServer, listen } from "./api/server.ts";
import { QualityEngine } from "./quality/quality-engine.ts";
import { BUILTIN_WORKFLOWS, resolveWorkflow } from "./workflow/builtin-workflows.ts";
import type { WorkflowDefinition } from "./workflow/workflow.ts";
import { AnalyticsService } from "./analytics/analytics-service.ts";
import type { EpisodeMetrics } from "./analytics/metrics.ts";
import { PublishingService } from "./publishing/publishing-service.ts";
import { ExportPublishTarget } from "./publishing/publish-target.ts";
import { sampleChannel } from "./examples/sample-channel.ts";
import { asChannelId } from "./domain/ids.ts";
import type { EpisodeAsset } from "./domain/episode.ts";
import { readFile } from "node:fs/promises";

/**
 * Reference CLI for the episode kernel. Providers are chosen from the environment: set
 * OPENAI_API_KEY / ELEVENLABS_API_KEY / ACF_VIDEO_* to use real models, otherwise each
 * capability falls back to the free offline LocalProvider. `--local` forces offline mode.
 * Storage defaults to per-channel JSON files; pass --sqlite <file> for the SQL store.
 *
 *   node src/cli.ts seed
 *   node src/cli.ts create tiny-explorers --brief "learning to share"   # real if keys set
 *   node src/cli.ts create tiny-explorers --local                       # always free/offline
 *   node src/cli.ts providers                                           # show what's wired
 *   node src/cli.ts serve --port 8787 --sqlite acf.db                   # REST API
 */

const DEFAULT_DIR = ".acf-memory";

function summarize(assets: readonly EpisodeAsset[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const a of assets) counts[a.kind] = (counts[a.kind] ?? 0) + 1;
  return counts;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      dir: { type: "string", default: DEFAULT_DIR },
      assets: { type: "string", default: ".acf-assets" },
      sqlite: { type: "string" },
      port: { type: "string", default: "8787" },
      brief: { type: "string" },
      number: { type: "string" },
      json: { type: "boolean", default: false },
      local: { type: "boolean", default: false },
      "no-quality": { type: "boolean", default: false },
      workflow: { type: "string" },
      metrics: { type: "string" },
      exports: { type: "string", default: ".acf-exports" },
    },
  });

  const [command, arg] = positionals;
  const store: MemoryStore = values.sqlite
    ? new SqliteMemoryStore(values.sqlite as string)
    : new JsonMemoryStore(values.dir as string);

  switch (command) {
    case "providers": {
      const { report } = buildProviderRegistry({ forceLocal: values.local as boolean });
      console.log("Provider wiring (self-hosted = our own inference servers; offline = free placeholder):");
      for (const [cap, name] of Object.entries(report)) {
        console.log(`  ${cap.padEnd(6)} → ${name}`);
      }
      return 0;
    }

    case "workflows": {
      console.log("Built-in workflows:");
      for (const w of BUILTIN_WORKFLOWS) {
        console.log(`  ${w.id.padEnd(10)} ${w.name} — ${w.description} (${w.stages.length} stages)`);
      }
      return 0;
    }

    case "metrics": {
      // Ingest performance metrics and run the learning loop.
      if (!arg) return usage("metrics <channelId> --metrics <file.json>");
      if (!values.metrics) return fail("provide --metrics <file.json> (array of EpisodeMetrics)");
      const rows = JSON.parse(await readFile(values.metrics as string, "utf8")) as EpisodeMetrics[];
      const { insights, applied } = await new AnalyticsService(store).ingest(asChannelId(arg), rows);
      if (values.json) { console.log(JSON.stringify(insights, null, 2)); return 0; }
      console.log(`✓ Ingested ${rows.length} metric row(s); learnings ${applied ? "applied" : "not applied (no matching episodes)"}.`);
      console.log(`  sampled ${insights.sampled} episode(s), avg view duration ${insights.avgViewDurationSec}s`);
      if (insights.bestHooks.length) console.log(`  best hooks: ${insights.bestHooks.map((h) => `"${h}"`).join(" | ")}`);
      for (const n of insights.notes) console.log(`  • ${n}`);
      return 0;
    }

    case "insights": {
      if (!arg) return usage("insights <channelId>");
      const insights = await new AnalyticsService(store).insights(asChannelId(arg));
      console.log(JSON.stringify(insights, null, 2));
      return 0;
    }

    case "publish": {
      if (!arg || !positionals[2]) return usage("publish <channelId> <episodeNumber>");
      const target = new ExportPublishTarget(values.exports as string);
      const record = await new PublishingService(store, target).publish(asChannelId(arg), Number(positionals[2]));
      console.log(`✓ Published episode ${positionals[2]} → ${record.uri}`);
      return 0;
    }

    case "schedule": {
      if (!arg) return usage("schedule <channelId>");
      const target = new ExportPublishTarget(values.exports as string);
      const next = await new PublishingService(store, target).nextSlot(asChannelId(arg));
      const mem = await store.load(asChannelId(arg));
      console.log(`cadence: ${mem?.channel.schedule.cadence}`);
      console.log(`next publish: ${next.toISOString()}`);
      return 0;
    }

    case "seed": {
      const mem = sampleChannel();
      await store.save(mem);
      const dest = values.sqlite ? `sqlite:${values.sqlite}` : `${values.dir}/`;
      console.log(`✓ Seeded channel "${mem.channel.name}" (${mem.channel.id}) into ${dest}`);
      console.log(`  ${Object.keys(mem.characters).length} characters, ${Object.keys(mem.voices).length} voices, ${Object.keys(mem.environments).length} environments.`);
      return 0;
    }

    case "channels": {
      const ids = await store.listChannels();
      console.log(ids.length ? ids.join("\n") : "(no channels — run: seed)");
      return 0;
    }

    case "memory": {
      if (!arg) return usage("memory <channelId>");
      const mem = await store.load(asChannelId(arg));
      if (!mem) return fail(`No memory for "${arg}". Run: seed`);
      console.log(JSON.stringify(mem, null, 2));
      return 0;
    }

    case "create": {
      if (!arg) return usage("create <channelId> [--brief ...] [--number N] [--workflow id] [--local]");
      let workflow: WorkflowDefinition | undefined;
      if (values.workflow) {
        const channelMem = await store.load(asChannelId(arg));
        workflow = resolveWorkflow(values.workflow as string, channelMem?.workflows);
        if (!workflow) {
          return fail(`unknown workflow "${values.workflow}". Run: workflows`);
        }
      }
      const { registry, report } = buildProviderRegistry({
        forceLocal: values.local as boolean,
        objectStore: new FileObjectStore(values.assets as string),
      });
      if (!values.json) {
        console.log(`providers: text=${report.text} image=${report.image} audio=${report.audio} video=${report.video}`);
      }
      const orchestrator = new EpisodeOrchestrator(
        store,
        registry,
        undefined,
        values["no-quality"] ? {} : { quality: new QualityEngine() },
      );
      const episode = await orchestrator.createEpisode(
        asChannelId(arg),
        {
          ...(values.brief ? { brief: values.brief as string } : {}),
          ...(values.number ? { number: Number(values.number) } : {}),
          ...(workflow ? { workflow } : {}),
        },
        (e) => {
          if (!values.json) {
            const retries = (e.attempts ?? 1) > 1 ? ` (attempts: ${e.attempts})` : "";
            const rejects = e.findings?.filter((f) => f.severity === "reject").length ?? 0;
            const flag = rejects > 0 ? ` ✗ ${rejects} reject(s)` : "";
            process.stdout.write(`  → ${e.stage.label}: ${e.assets.length} asset(s)${retries}${flag}\n`);
          }
        },
      );

      if (values.json) {
        console.log(JSON.stringify(episode, null, 2));
      } else {
        console.log(`\n✓ Episode ${episode.number}: "${episode.title}"`);
        console.log(`  ${episode.logline}`);
        console.log(`  ${episode.assets.length} assets:`, summarize(episode.assets));
        if (episode.quality) {
          const warns = episode.quality.stages.reduce(
            (n, s) => n + s.findings.filter((f) => f.severity === "warn").length,
            0,
          );
          console.log(
            `  quality: ${episode.quality.passed ? "PASSED" : "FAILED"}` +
              ` (${episode.quality.totalRegenerations} regeneration(s), ${warns} warning(s))`,
          );
        }
        const thumb = episode.assets.find((a) => a.kind === "thumbnail");
        if (thumb?.outputUri) console.log(`  thumbnail: ${thumb.outputUri}`);
      }
      return 0;
    }

    case "serve": {
      const { registry, report } = buildProviderRegistry({
        forceLocal: values.local as boolean,
        objectStore: new FileObjectStore(values.assets as string),
      });
      const server = createApiServer({ store, registry, providerReport: report });
      const port = await listen(server, Number(values.port));
      console.log(`✓ AI Content Factory API listening on http://127.0.0.1:${port}`);
      console.log(`  providers: text=${report.text} image=${report.image} audio=${report.audio} video=${report.video}`);
      console.log(`  try: curl http://127.0.0.1:${port}/v1/health`);
      return KEEP_RUNNING;
    }

    default:
      return usage(
        "seed | channels | providers | workflows | memory <id> | create <id> | " +
          "publish <id> <n> | metrics <id> | insights <id> | schedule <id> | serve",
      );
  }
}

/** Sentinel: the command started a long-lived server; don't exit the process. */
const KEEP_RUNNING = -1;

function usage(cmd: string): number {
  console.error(`usage: acf ${cmd}`);
  return 2;
}
function fail(msg: string): number {
  console.error(`error: ${msg}`);
  return 1;
}

main()
  .then((code) => {
    if (code !== KEEP_RUNNING) process.exit(code);
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
