import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";

/**
 * FFmpeg/ffprobe integration for the local render pipeline. Binaries are discovered from the
 * environment (ACF_FFMPEG_BIN / ACF_FFPROBE_BIN, default "ffmpeg"/"ffprobe") so a self-hosted
 * deployment can point at a specific build. Nothing here calls a network service — this is the
 * fully-local assembly layer that turns generated assets into a real MP4 on disk.
 */

export const FFMPEG_BIN = process.env["ACF_FFMPEG_BIN"] ?? "ffmpeg";
export const FFPROBE_BIN = process.env["ACF_FFPROBE_BIN"] ?? "ffprobe";

export class FfmpegError extends Error {
  readonly stderr: string;
  constructor(message: string, stderr = "") {
    super(stderr ? `${message}\n${stderr.slice(-1500)}` : message);
    this.name = "FfmpegError";
    this.stderr = stderr;
  }
}

export class FfmpegNotInstalledError extends Error {
  constructor(bin: string) {
    super(
      `"${bin}" was not found. Install FFmpeg to render video:\n` +
        `  Debian/Ubuntu:  sudo apt-get install -y ffmpeg\n` +
        `  macOS (brew):   brew install ffmpeg\n` +
        `Or set ACF_FFMPEG_BIN / ACF_FFPROBE_BIN to an existing binary.`,
    );
    this.name = "FfmpegNotInstalledError";
  }
}

function run(bin: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "ENOENT") return reject(new FfmpegNotInstalledError(bin));
        return reject(new FfmpegError(`${bin} exited with ${e.code ?? "error"}`, String(stderr)));
      }
      resolve(String(stdout));
    });
  });
}

/** True if the ffmpeg binary is runnable. Used to gate rendering (and skip render tests). */
export async function checkFfmpeg(bin = FFMPEG_BIN): Promise<boolean> {
  try {
    await run(bin, ["-version"], 10_000);
    return true;
  } catch {
    return false;
  }
}

export async function checkFfprobe(bin = FFPROBE_BIN): Promise<boolean> {
  try {
    await run(bin, ["-version"], 10_000);
    return true;
  } catch {
    return false;
  }
}

/** Run ffmpeg with an explicit arg list (no shell), throwing FfmpegError on failure. */
export async function runFfmpeg(args: readonly string[], timeoutMs = 300_000): Promise<void> {
  await run(FFMPEG_BIN, args, timeoutMs);
}

export interface MediaProbe {
  readonly path: string;
  readonly sizeBytes: number;
  readonly durationSec: number;
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
  readonly videoCodec: string | undefined;
  readonly audioCodec: string | undefined;
}

interface FfprobeJson {
  readonly streams?: readonly { readonly codec_type?: string; readonly codec_name?: string }[];
  readonly format?: { readonly duration?: string };
}

/** Probe a media file with ffprobe. Throws if the file is missing/empty or ffprobe absent. */
export async function probeMedia(path: string): Promise<MediaProbe> {
  if (!existsSync(path)) throw new FfmpegError(`output file does not exist: ${path}`);
  const size = statSync(path).size;
  if (size === 0) throw new FfmpegError(`output file is empty: ${path}`);

  const stdout = await run(
    FFPROBE_BIN,
    ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-show_entries", "format=duration", "-of", "json", path],
    30_000,
  );
  const json = JSON.parse(stdout) as FfprobeJson;
  const streams = json.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  return {
    path,
    sizeBytes: size,
    durationSec: json.format?.duration ? Number(json.format.duration) : 0,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name,
  };
}
