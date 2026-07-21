import { runFfmpeg } from "./ffmpeg.ts";
import type { RenderPlan } from "./asset-resolver.ts";

/**
 * Assembles a RenderPlan into a single MP4 with FFmpeg, using the exact filtergraph proven by
 * hand: per-beat Ken Burns pan/zoom on the still, xfade transitions between beats, per-beat
 * audio concatenated, optional background-music mix, subtitles burned in, encoded H.264/AAC.
 * Pure local assembly — no network. Throws FfmpegError on failure.
 */
export class FFmpegRenderer {
  async render(plan: RenderPlan, outPath: string): Promise<void> {
    if (plan.beats.length === 0) throw new Error("render plan has no beats");
    const { width, height, fps, transitionSec: T } = plan;

    const inputs: string[] = [];
    // Image inputs first (looped for their beat duration), then one audio input per beat.
    for (const b of plan.beats) {
      inputs.push("-loop", "1", "-t", b.durationSec.toFixed(2), "-i", b.imagePath);
    }
    for (const b of plan.beats) inputs.push("-i", b.audioPath);
    const nBeats = plan.beats.length;
    let musicInputIndex = -1;
    if (plan.musicPath) {
      musicInputIndex = nBeats * 2;
      inputs.push("-i", plan.musicPath);
    }

    const filters: string[] = [];

    // Ken Burns per beat: fps first, then zoompan with d=1 (one output frame per input frame).
    const kb =
      `zoompan=z='min(zoom+0.0015,1.15)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}`;
    plan.beats.forEach((_, i) => {
      filters.push(
        `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${fps},${kb},format=yuv420p[v${i}]`,
      );
    });

    // xfade chain across beats. Track the running merged length to place each transition.
    let videoLabel: string;
    if (nBeats === 1) {
      videoLabel = "v0";
    } else {
      let prev = "v0";
      let mergedLen = plan.beats[0]!.durationSec;
      for (let i = 1; i < nBeats; i++) {
        const out = i === nBeats - 1 ? "vmerged" : `vx${i}`;
        const offset = Math.max(0, mergedLen - T);
        filters.push(
          `[${prev}][v${i}]xfade=transition=fade:duration=${T}:offset=${offset.toFixed(2)}[${out}]`,
        );
        mergedLen = mergedLen + plan.beats[i]!.durationSec - T;
        prev = out;
      }
      videoLabel = "vmerged";
    }

    // Burn subtitles if present. FFmpeg's subtitles filter needs a filesystem path; escape ':'.
    if (plan.srtPath) {
      const escaped = plan.srtPath.replace(/\\/g, "/").replace(/:/g, "\\:");
      filters.push(`[${videoLabel}]subtitles='${escaped}'[vout]`);
      videoLabel = "vout";
    }

    // Audio: concat all beat tracks in order → voice bed; optionally mix music under it.
    const audioLabels = plan.beats.map((_, i) => `[${nBeats + i}:a]`).join("");
    filters.push(`${audioLabels}concat=n=${nBeats}:v=0:a=1[voice]`);
    let audioLabel = "voice";
    if (musicInputIndex >= 0) {
      filters.push(`[${musicInputIndex}:a]volume=0.18[music]`);
      filters.push(`[voice][music]amix=inputs=2:duration=first:dropout_transition=2[aout]`);
      audioLabel = "aout";
    }

    const args = [
      "-y",
      "-loglevel", "error",
      ...inputs,
      "-filter_complex", filters.join(";"),
      "-map", `[${videoLabel}]`,
      "-map", `[${audioLabel}]`,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "160k",
      "-movflags", "+faststart", // web-playable (moov atom at front)
      "-shortest",
      outPath,
    ];
    await runFfmpeg(args, 600_000);
  }
}
