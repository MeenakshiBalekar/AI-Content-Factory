import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Episode } from "../domain/episode.ts";
import type { ChannelId } from "../domain/ids.ts";
import {
  UnknownChannelError,
  type MemoryStore,
} from "../memory/memory-store.ts";
import { checkFfmpeg, FfmpegError, FfmpegNotInstalledError, probeMedia } from "./ffmpeg.ts";
import { AssetResolver } from "./asset-resolver.ts";
import { FFmpegRenderer } from "./ffmpeg-renderer.ts";

export type RenderResult = NonNullable<Episode["render"]>;

/**
 * Orchestrates a full local render: resolve an episode's assets to real files, assemble them
 * into an MP4 with FFmpeg, validate the output with ffprobe (must exist, be non-empty, and
 * carry both a video and an audio stream), then persist the result onto the episode. Every
 * failure is explicit — a missing FFmpeg, an unreachable backend, or an invalid output all
 * throw with a clear message rather than producing a fake success.
 */
export class RenderService {
  readonly #store: MemoryStore;
  readonly #root: string;
  readonly #env: Record<string, string | undefined>;

  constructor(store: MemoryStore, rendersRoot = ".acf-renders", env: Record<string, string | undefined> = process.env) {
    this.#store = store;
    this.#root = resolve(rendersRoot);
    this.#env = env;
  }

  async render(channelId: ChannelId, episodeNumber: number): Promise<RenderResult> {
    if (!(await checkFfmpeg())) throw new FfmpegNotInstalledError("ffmpeg");

    const memory = await this.#store.load(channelId);
    if (!memory) throw new UnknownChannelError(channelId);
    const episode = memory.episodes.find((e) => e.number === episodeNumber);
    if (!episode) throw new Error(`channel "${channelId}" has no episode ${episodeNumber}`);

    const workdir = join(this.#root, `${channelId}-ep${episodeNumber}`);
    await mkdir(workdir, { recursive: true });

    const plan = await new AssetResolver(memory, join(workdir, "assets"), this.#env).resolve(episode);
    const outPath = join(workdir, "episode.mp4");
    await new FFmpegRenderer().render(plan, outPath);

    // Validate the real output before claiming success.
    const probe = await probeMedia(outPath);
    if (!probe.hasVideo) throw new FfmpegError(`render produced no video stream: ${outPath}`);
    if (!probe.hasAudio) throw new FfmpegError(`render produced no audio stream: ${outPath}`);

    const result: RenderResult = {
      outputPath: outPath,
      sizeBytes: probe.sizeBytes,
      durationSec: probe.durationSec,
      hasVideo: probe.hasVideo,
      hasAudio: probe.hasAudio,
      videoCodec: probe.videoCodec,
      audioCodec: probe.audioCodec,
      width: plan.width,
      height: plan.height,
      imageSource: plan.imageSource,
      audioSource: plan.audioSource,
      musicSource: plan.musicSource,
      renderedAt: new Date().toISOString(),
    };

    // Persist the render onto the episode (upsert via the store).
    await this.#store.save({
      ...memory,
      episodes: memory.episodes.map((e) => (e.number === episodeNumber ? { ...e, render: result } : e)),
    });
    return result;
  }

  /** The recorded render for an episode, if any (for GET status). */
  async getRender(channelId: ChannelId, episodeNumber: number): Promise<RenderResult | undefined> {
    const memory = await this.#store.load(channelId);
    if (!memory) throw new UnknownChannelError(channelId);
    return memory.episodes.find((e) => e.number === episodeNumber)?.render;
  }
}
