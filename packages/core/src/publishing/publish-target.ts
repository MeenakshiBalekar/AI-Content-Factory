import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Episode } from "../domain/episode.ts";
import type { ChannelMemory } from "../memory/memory-store.ts";

/**
 * Publishing engine (Module 6). A PublishTarget takes a finished episode and puts it
 * somewhere; the record of every publication is stored on the episode.
 *
 * Built now: ExportPublishTarget — produces a complete, platform-ready export package on
 * disk (manifest + metadata + subtitles), which is the real deliverable a human or an
 * upload worker pushes to any platform.
 *
 * FUTURE INTEGRATION (interface below is the contract): YouTubePublishTarget via the
 * YouTube Data API resumable upload. The API itself is free-quota, but requires an OAuth
 * client + channel tokens, so it lands as its own adapter when credentials management
 * (Module 8, Identity) exists. Same for TikTok/Instagram upload targets. No commercial
 * AI API is involved in any of this.
 */

export interface PublishRecord {
  readonly platform: string; // "export", later "youtube", "tiktok", …
  readonly uri: string; // where it went
  readonly at: string; // ISO timestamp
}

export interface PublishTarget {
  readonly platform: string;
  publish(episode: Episode, memory: ChannelMemory): Promise<PublishRecord>;
}

/** What lands on disk for an export publication. */
export interface ExportManifest {
  readonly channel: string;
  readonly episodeNumber: number;
  readonly title: string;
  readonly logline: string;
  readonly workflowId: string;
  readonly qualityPassed: boolean | null;
  readonly assets: readonly {
    readonly kind: string;
    readonly label: string;
    readonly outputUri: string | null;
  }[];
  readonly publishing: {
    readonly platforms: readonly string[];
    readonly cadence: string;
  };
  readonly exportedAt: string;
}

export class ExportPublishTarget implements PublishTarget {
  readonly platform = "export";
  readonly #root: string;
  readonly #now: () => Date;

  constructor(root: string, now: () => Date = () => new Date()) {
    this.#root = resolve(root);
    this.#now = now;
  }

  async publish(episode: Episode, memory: ChannelMemory): Promise<PublishRecord> {
    const dir = join(this.#root, `${memory.channel.id}-ep${episode.number}`);
    await mkdir(dir, { recursive: true });

    const manifest: ExportManifest = {
      channel: memory.channel.name,
      episodeNumber: episode.number,
      title: episode.title,
      logline: episode.logline,
      workflowId: episode.workflowId ?? "standard",
      qualityPassed: episode.quality?.passed ?? null,
      assets: episode.assets.map((a) => ({
        kind: a.kind,
        label: a.label,
        outputUri: a.outputUri ?? null,
      })),
      publishing: {
        platforms: memory.channel.schedule.platforms,
        cadence: memory.channel.schedule.cadence,
      },
      exportedAt: this.#now().toISOString(),
    };
    await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

    // Subtitles ship as a real .srt file next to the manifest.
    const srt = episode.assets.find((a) => a.kind === "subtitles");
    if (srt) await writeFile(join(dir, "subtitles.srt"), srt.prompt, "utf8");

    return { platform: this.platform, uri: `file://${dir}`, at: this.#now().toISOString() };
  }
}
