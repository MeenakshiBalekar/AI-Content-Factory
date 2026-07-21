#!/usr/bin/env -S node --experimental-strip-types
import { parseArgs } from "node:util";
import { EpisodeOrchestrator } from "./orchestrator/orchestrator.ts";
import { JsonMemoryStore } from "./memory/json-memory-store.ts";
import { LocalProvider } from "./providers/local-provider.ts";
import { ProviderRegistry } from "./providers/provider.ts";
import { sampleChannel } from "./examples/sample-channel.ts";
import { asChannelId } from "./domain/ids.ts";
import type { EpisodeAsset } from "./domain/episode.ts";

/**
 * Reference CLI for the episode kernel. It wires the local provider into the registry so the
 * whole pipeline runs offline; swapping in real providers is a one-line change here.
 *
 *   node src/cli.ts seed
 *   node src/cli.ts create tiny-explorers --brief "learning to share"
 *   node src/cli.ts memory tiny-explorers
 */

const DEFAULT_DIR = ".acf-memory";

function buildRegistry(): ProviderRegistry {
  const local = new LocalProvider();
  return new ProviderRegistry()
    .registerText(local)
    .registerImage(local)
    .registerAudio(local)
    .registerVideo(local);
}

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
      brief: { type: "string" },
      number: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });

  const [command, arg] = positionals;
  const store = new JsonMemoryStore(values.dir as string);

  switch (command) {
    case "seed": {
      const mem = sampleChannel();
      await store.save(mem);
      console.log(`✓ Seeded channel "${mem.channel.name}" (${mem.channel.id}) into ${values.dir}/`);
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
      if (!arg) return usage("create <channelId> [--brief ...] [--number N]");
      const orchestrator = new EpisodeOrchestrator(store, buildRegistry());
      const episode = await orchestrator.createEpisode(
        asChannelId(arg),
        {
          ...(values.brief ? { brief: values.brief as string } : {}),
          ...(values.number ? { number: Number(values.number) } : {}),
        },
        (e) => {
          if (!values.json) {
            process.stdout.write(`  → ${e.stage.label}: ${e.assets.length} asset(s)\n`);
          }
        },
      );

      if (values.json) {
        console.log(JSON.stringify(episode, null, 2));
      } else {
        console.log(`\n✓ Episode ${episode.number}: "${episode.title}"`);
        console.log(`  ${episode.logline}`);
        console.log(`  ${episode.assets.length} assets:`, summarize(episode.assets));
        const thumb = episode.assets.find((a) => a.kind === "thumbnail");
        if (thumb?.outputUri) console.log(`  thumbnail: ${thumb.outputUri}`);
      }
      return 0;
    }

    default:
      return usage("seed | channels | memory <id> | create <id>");
  }
}

function usage(cmd: string): number {
  console.error(`usage: acf ${cmd}`);
  return 2;
}
function fail(msg: string): number {
  console.error(`error: ${msg}`);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
