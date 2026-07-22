import { probeMedia, runFfmpeg } from "./ffmpeg.ts";
import { ffFilterPath, type FontContext } from "./fonts.ts";
import type { RenderPlan } from "./asset-resolver.ts";

/**
 * Assembles a RenderPlan into a single MP4 with FFmpeg. Two modes:
 *
 *  - **Video mode** (motionSource "video-model"): every beat has a real animated clip
 *    (image→video output). The clips are normalized, xfade-chained, subtitles burned in, and
 *    a user song (or the generated voice track) is muxed as the soundtrack. This is a real
 *    animated video, not a slideshow.
 *  - **Still mode** (fallback): each beat's still gets a Ken Burns pan/zoom, xfade between
 *    beats, per-beat audio concatenated, optional music mix. Used when no video model is wired.
 *
 * Pure local assembly — no network. The FontContext makes subtitle burn-in portable
 * (fontsdir + FONTCONFIG_FILE) so libass never depends on the system Fontconfig.
 */
export class FFmpegRenderer {
  async render(plan: RenderPlan, outPath: string, fonts?: FontContext): Promise<void> {
    if (plan.beats.length === 0) throw new Error("render plan has no beats");
    const hasClips = plan.motionSource === "video-model" && plan.beats.every((b) => b.videoPath);
    if (hasClips) return this.#renderClips(plan, outPath, fonts);
    return this.#renderStills(plan, outPath, fonts);
  }

  /** Real video: concatenate per-shot clips with transitions + song, burn subtitles. */
  async #renderClips(plan: RenderPlan, outPath: string, fonts?: FontContext): Promise<void> {
    const { width, height, fps, transitionSec: T } = plan;
    const n = plan.beats.length;

    // Probe each clip's true duration so xfade offsets line up with the actual footage.
    const durations: number[] = [];
    for (const b of plan.beats) durations.push(Math.max(0.5, (await probeMedia(b.videoPath!)).durationSec));

    const inputs: string[] = [];
    for (const b of plan.beats) inputs.push("-i", b.videoPath!);
    // Audio inputs: a user song takes precedence; otherwise the generated per-beat tracks.
    let songIndex = -1;
    if (plan.songPath) {
      songIndex = n;
      inputs.push("-i", plan.songPath);
    } else {
      for (const b of plan.beats) inputs.push("-i", b.audioPath);
    }

    const filters: string[] = [];
    plan.beats.forEach((_, i) => {
      filters.push(
        `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${fps},format=yuv420p[v${i}]`,
      );
    });

    let videoLabel: string;
    if (n === 1) {
      videoLabel = "v0";
    } else {
      let prev = "v0";
      let mergedLen = durations[0]!;
      for (let i = 1; i < n; i++) {
        const out = i === n - 1 ? "vmerged" : `vx${i}`;
        const offset = Math.max(0, mergedLen - T);
        filters.push(`[${prev}][v${i}]xfade=transition=fade:duration=${T}:offset=${offset.toFixed(2)}[${out}]`);
        mergedLen = mergedLen + durations[i]! - T;
        prev = out;
      }
      videoLabel = "vmerged";
    }

    videoLabel = this.#burnSubs(filters, videoLabel, plan, fonts);

    // Audio: the song (a raw input stream -> no brackets), or the concatenated per-beat
    // voice/silence tracks (a filtergraph output -> brackets).
    let audioMap: string;
    if (songIndex >= 0) {
      audioMap = `${songIndex}:a`;
    } else {
      const labels = plan.beats.map((_, i) => `[${n + i}:a]`).join("");
      filters.push(`${labels}concat=n=${n}:v=0:a=1[aout]`);
      audioMap = "[aout]";
    }

    await this.#encode(inputs, filters, `[${videoLabel}]`, audioMap, outPath, fonts);
  }

  /** Fallback: animate stills with Ken Burns + xfade (no video model configured). */
  async #renderStills(plan: RenderPlan, outPath: string, fonts?: FontContext): Promise<void> {
    const { width, height, fps, transitionSec: T } = plan;
    const nBeats = plan.beats.length;

    const inputs: string[] = [];
    for (const b of plan.beats) inputs.push("-loop", "1", "-t", b.durationSec.toFixed(2), "-i", b.imagePath);
    for (const b of plan.beats) inputs.push("-i", b.audioPath);
    let musicInputIndex = -1;
    if (plan.musicPath) {
      musicInputIndex = nBeats * 2;
      inputs.push("-i", plan.musicPath);
    }

    const filters: string[] = [];
    const kb = `zoompan=z='min(zoom+0.0015,1.15)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}`;
    plan.beats.forEach((_, i) => {
      filters.push(
        `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${fps},${kb},format=yuv420p[v${i}]`,
      );
    });

    let videoLabel: string;
    if (nBeats === 1) {
      videoLabel = "v0";
    } else {
      let prev = "v0";
      let mergedLen = plan.beats[0]!.durationSec;
      for (let i = 1; i < nBeats; i++) {
        const out = i === nBeats - 1 ? "vmerged" : `vx${i}`;
        const offset = Math.max(0, mergedLen - T);
        filters.push(`[${prev}][v${i}]xfade=transition=fade:duration=${T}:offset=${offset.toFixed(2)}[${out}]`);
        mergedLen = mergedLen + plan.beats[i]!.durationSec - T;
        prev = out;
      }
      videoLabel = "vmerged";
    }

    videoLabel = this.#burnSubs(filters, videoLabel, plan, fonts);

    const audioLabels = plan.beats.map((_, i) => `[${nBeats + i}:a]`).join("");
    filters.push(`${audioLabels}concat=n=${nBeats}:v=0:a=1[voice]`);
    let audioLabel = "voice";
    // A user song, if present, becomes the master track; else optional background music mix.
    if (plan.songPath) {
      const songIdx = musicInputIndex >= 0 ? nBeats * 2 + 1 : nBeats * 2;
      inputs.push("-i", plan.songPath);
      filters.push(`[${songIdx}:a]volume=0.9[song]`);
      filters.push(`[voice][song]amix=inputs=2:duration=first:dropout_transition=2[aout]`);
      audioLabel = "aout";
    } else if (musicInputIndex >= 0) {
      filters.push(`[${musicInputIndex}:a]volume=0.18[music]`);
      filters.push(`[voice][music]amix=inputs=2:duration=first:dropout_transition=2[aout]`);
      audioLabel = "aout";
    }

    await this.#encode(inputs, filters, `[${videoLabel}]`, `[${audioLabel}]`, outPath, fonts);
  }

  #burnSubs(filters: string[], videoLabel: string, plan: RenderPlan, fonts?: FontContext): string {
    if (!plan.srtPath) return videoLabel;
    const parts = [`filename='${ffFilterPath(plan.srtPath)}'`];
    if (fonts?.fontDir) parts.push(`fontsdir='${ffFilterPath(fonts.fontDir)}'`);
    filters.push(`[${videoLabel}]subtitles=${parts.join(":")}[vsub]`);
    return "vsub";
  }

  async #encode(
    inputs: readonly string[],
    filters: readonly string[],
    videoMap: string,
    audioMap: string,
    outPath: string,
    fonts?: FontContext,
  ): Promise<void> {
    const args = [
      "-y",
      "-loglevel", "error",
      ...inputs,
      "-filter_complex", filters.join(";"),
      "-map", videoMap,
      "-map", audioMap,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "160k",
      "-movflags", "+faststart",
      "-shortest",
      outPath,
    ];
    await runFfmpeg(args, 600_000, fonts?.env ? { ...fonts.env } : undefined);
  }
}
