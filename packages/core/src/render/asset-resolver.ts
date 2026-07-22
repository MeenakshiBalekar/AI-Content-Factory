import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Episode } from "../domain/episode.ts";
import type { CharacterId } from "../domain/ids.ts";
import type { ChannelMemory } from "../memory/memory-store.ts";
import { probeMedia } from "./ffmpeg.ts";
import { combineBeatAudio, renderSceneCard, renderSilentTrack, renderToneBed } from "./procedural-assets.ts";
import {
  LocalImageProvider,
  LocalSpeechProvider,
  localBackendConfig,
} from "./local-backends.ts";
import type { FontContext } from "./fonts.ts";
import type { VideoProvider } from "../providers/provider.ts";
import { HttpClient } from "../providers/http/http-client.ts";

/**
 * Resolves an episode's beats into REAL files on disk for the renderer. For each capability it
 * uses the configured self-hosted backend, or an honest procedural placeholder when none is
 * configured — and it records which, so the render result never overstates what was generated.
 */

export type ImageSource = "ai-local" | "procedural-placeholder";
export type AudioSource = "ai-local" | "procedural-silence";
export type MusicSource = "file" | "procedural-tone" | "none";
export type MotionSource = "video-model" | "still"; // real clips vs animated stills

export interface RenderBeat {
  readonly index: number;
  readonly imagePath: string;
  readonly audioPath: string; // one combined track, padded to durationSec
  readonly durationSec: number;
  /** A real animated clip for this shot (image→video). When present, the renderer uses the
   *  clip instead of animating the still — this is what makes the output a real video. */
  readonly videoPath?: string;
}

export interface RenderPlan {
  readonly beats: readonly RenderBeat[];
  readonly srtPath: string | undefined;
  readonly musicPath: string | undefined;
  readonly musicSource: MusicSource;
  readonly imageSource: ImageSource;
  readonly audioSource: AudioSource;
  readonly motionSource: MotionSource;
  /** A user-supplied song used as the master soundtrack (ACF_SONG_FILE). */
  readonly songPath: string | undefined;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly transitionSec: number;
}

const estimateDuration = (text: string): number =>
  Math.min(8, Math.max(1.5, text.length * 0.06));

function dimsForAspect(aspect: string): { width: number; height: number } {
  if (aspect === "9:16") return { width: 720, height: 1280 };
  if (aspect === "1:1") return { width: 1080, height: 1080 };
  return { width: 1280, height: 720 };
}

export class AssetResolver {
  readonly #memory: ChannelMemory;
  readonly #workdir: string;
  readonly #env: Record<string, string | undefined>;
  readonly #fonts: FontContext | undefined;
  readonly #videoProvider: VideoProvider | undefined;

  constructor(
    memory: ChannelMemory,
    workdir: string,
    env: Record<string, string | undefined> = process.env,
    fonts?: FontContext,
    videoProvider?: VideoProvider,
  ) {
    this.#videoProvider = videoProvider;
    this.#memory = memory;
    this.#workdir = workdir;
    this.#env = env;
    this.#fonts = fonts;
  }

  async resolve(episode: Episode): Promise<RenderPlan> {
    await mkdir(this.#workdir, { recursive: true });
    const cfg = localBackendConfig(this.#env);
    const aspect = this.#memory.channel.style.aspectRatio;
    const { width, height } = dimsForAspect(aspect);

    const imageProvider = cfg.imageBaseUrl
      ? new LocalImageProvider(cfg.imageBaseUrl, cfg.imageModel, join(this.#workdir, "img"), {
          api: cfg.imageApi,
          ...(cfg.imageSteps !== undefined ? { steps: cfg.imageSteps } : {}),
          ...(cfg.imageMaxEdge !== undefined ? { maxEdge: cfg.imageMaxEdge } : {}),
          ...(cfg.imageNegative !== undefined ? { negativePrompt: cfg.imageNegative } : {}),
        })
      : undefined;
    const speechProvider = cfg.audioBaseUrl
      ? new LocalSpeechProvider(cfg.audioBaseUrl, cfg.audioModel, join(this.#workdir, "aud"))
      : undefined;

    const beats: RenderBeat[] = [];
    let totalDuration = 0;

    for (const beat of episode.beats) {
      // --- image ---
      const imgAsset = episode.assets.find((a) => a.kind === "image" && a.meta?.["beat"] === beat.index);
      const imagePath = join(this.#workdir, `beat${beat.index}.png`);
      if (imageProvider && imgAsset) {
        const seed = typeof imgAsset.meta?.["seed"] === "number" ? imgAsset.meta["seed"] : beat.index;
        const generated = await imageProvider.generateToFile(imgAsset.prompt, seed, aspect);
        await copyTo(generated, imagePath);
      } else {
        await renderSceneCard({
          outPath: imagePath,
          title: this.#beatTitle(beat.index),
          subtitle: beat.summary,
          fontFile: this.#fonts?.fontFile,
          env: this.#fonts?.env ? { ...this.#fonts.env } : undefined,
          hexColor: this.#beatColor(beat.characterIds[0]),
          width,
          height,
        });
      }

      // --- audio: one file per line, then combined + padded into a single beat track ---
      const lineFiles: string[] = [];
      let spoken = 0;
      let lineIdx = 0;
      for (const line of beat.dialogue) {
        const linePath = join(this.#workdir, `beat${beat.index}_line${lineIdx}.m4a`);
        if (speechProvider) {
          const { voiceRef, speed } = this.#voiceFor(line.characterId);
          const generated = await speechProvider.generateToFile(line.line, voiceRef, speed, "neutral");
          await copyTo(generated, linePath);
        } else {
          await renderSilentTrack(linePath, estimateDuration(line.line));
        }
        spoken += (await probeMedia(linePath)).durationSec;
        lineFiles.push(linePath);
        lineIdx++;
      }
      if (lineFiles.length === 0) {
        const linePath = join(this.#workdir, `beat${beat.index}_line0.m4a`);
        await renderSilentTrack(linePath, 2.5);
        lineFiles.push(linePath);
        spoken = 2.5;
      }
      const beatDuration = Math.max(2.5, spoken + 0.4); // trailing gap, min hold
      const audioPath = join(this.#workdir, `beat${beat.index}.m4a`);
      await combineBeatAudio(lineFiles, audioPath, beatDuration);
      totalDuration += beatDuration;

      // --- motion: image→video per shot (the keyframe animates) ---
      let videoPath: string | undefined;
      if (this.#videoProvider) {
        const asset = await this.#videoProvider.generateVideo({
          prompt: beat.summary, // the shot's visual + action
          seed: typeof imgAsset?.meta?.["seed"] === "number" ? imgAsset.meta["seed"] : beat.index,
          aspect,
          durationSec: Math.round(beatDuration),
          imageUri: `file://${imagePath}`,
        });
        videoPath = join(this.#workdir, `beat${beat.index}.mp4`);
        await this.#fetchTo(asset.outputUri, videoPath);
      }

      beats.push({ index: beat.index, imagePath, audioPath, durationSec: beatDuration, ...(videoPath ? { videoPath } : {}) });
    }

    // --- subtitles ---
    let srtPath: string | undefined;
    const subs = episode.assets.find((a) => a.kind === "subtitles");
    if (subs) {
      srtPath = join(this.#workdir, "subtitles.srt");
      await writeFile(srtPath, subs.prompt, "utf8");
    }

    // --- music ---
    let musicPath: string | undefined;
    let musicSource: MusicSource = "none";
    if (cfg.musicFile && existsSync(cfg.musicFile)) {
      musicPath = cfg.musicFile;
      musicSource = "file";
    } else if (this.#env["ACF_MUSIC_TONE"] === "1") {
      musicPath = join(this.#workdir, "music.m4a");
      await renderToneBed(musicPath, totalDuration);
      musicSource = "procedural-tone";
    }

    // --- song: a user-supplied soundtrack that becomes the video's master audio ---
    const songFile = this.#env["ACF_SONG_FILE"];
    const songPath = songFile && existsSync(songFile) ? songFile : undefined;

    return {
      beats,
      srtPath,
      musicPath,
      musicSource,
      imageSource: imageProvider ? "ai-local" : "procedural-placeholder",
      audioSource: speechProvider ? "ai-local" : "procedural-silence",
      motionSource: this.#videoProvider ? "video-model" : "still",
      songPath,
      width,
      height,
      fps: 30,
      transitionSec: 0.5,
    };
  }

  /** Fetch a clip URL (http/https) or local file (file://) into `dest`. */
  async #fetchTo(uri: string, dest: string): Promise<void> {
    if (uri.startsWith("file://") || uri.startsWith("/")) {
      await copyTo(uri.startsWith("file://") ? uri.slice("file://".length) : uri, dest);
      return;
    }
    const bytes = await new HttpClient({ provider: "video-download", defaultTimeoutMs: 300_000 })
      .requestBytes({ method: "GET", url: uri, expect: "bytes", timeoutMs: 300_000 });
    await writeFile(dest, bytes);
  }

  #beatTitle(index: number): string {
    const names = Object.values(this.#memory.characters).map((c) => c.name);
    return `${this.#memory.channel.name} — Beat ${index + 1}${names.length ? ` — ${names.join(" & ")}` : ""}`;
  }

  #beatColor(characterId: CharacterId | undefined): string {
    if (characterId) {
      const hex = this.#memory.characters[characterId]?.appearance.palette[0];
      if (hex) return hex;
    }
    return "#2B2B48";
  }

  #voiceFor(characterId: CharacterId): { voiceRef: string; speed: number } {
    const c = this.#memory.characters[characterId];
    const voice = c ? this.#memory.voices[c.voiceId] : undefined;
    return { voiceRef: voice?.providerVoiceRef ?? "default", speed: voice?.speed ?? 1 };
  }
}

async function copyTo(src: string, dest: string): Promise<void> {
  const { copyFile } = await import("node:fs/promises");
  await copyFile(src, dest);
}
