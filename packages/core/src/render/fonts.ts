import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Font resolution for the render pipeline — the fix for the Windows "Fontconfig error: Cannot
 * load default config file" crash (ffmpeg exit 3221225477).
 *
 * FFmpeg's drawtext and the libass `subtitles` filter both initialize Fontconfig. On a stock
 * Windows FFmpeg build there is no default `fonts.conf`, so Fontconfig init fails and the
 * process aborts. We remove that dependency two ways, portably:
 *
 *   1. drawtext is always given an explicit `fontfile=`, so it never needs Fontconfig.
 *   2. For libass (which always inits Fontconfig), we generate a minimal, valid `fonts.conf`
 *      pointing at the resolved font's directory and set FONTCONFIG_FILE/FONTCONFIG_PATH in
 *      the ffmpeg child environment. libass then initializes cleanly on every OS.
 *
 * The font is chosen from ACF_FONT_FILE if set, else a per-OS system font. No personal path
 * is hardcoded.
 */

export interface FontContext {
  /** Absolute path to a usable font file, or undefined if none was found. */
  readonly fontFile: string | undefined;
  /** Directory containing the font (added to the generated fonts.conf and libass fontsdir). */
  readonly fontDir: string | undefined;
  /** Environment overrides to pass to the ffmpeg child (FONTCONFIG_FILE/PATH). */
  readonly env: Readonly<Record<string, string>>;
}

/** Common system font locations per OS, used only when ACF_FONT_FILE is not set. */
function systemFontCandidates(platform: NodeJS.Platform): string[] {
  if (platform === "win32") {
    const root = process.env["SystemRoot"] ?? "C:\\Windows";
    return [
      join(root, "Fonts", "segoeui.ttf"),
      join(root, "Fonts", "arial.ttf"),
      join(root, "Fonts", "tahoma.ttf"),
      join(root, "Fonts", "verdana.ttf"),
    ];
  }
  if (platform === "darwin") {
    return [
      "/System/Library/Fonts/Supplemental/Arial.ttf",
      "/Library/Fonts/Arial.ttf",
      "/System/Library/Fonts/Helvetica.ttc",
      "/System/Library/Fonts/SFNS.ttf",
      "/System/Library/Fonts/Supplemental/Verdana.ttf",
    ];
  }
  return [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
  ];
}

/** Resolve a usable font file: ACF_FONT_FILE (if it exists) first, then a per-OS fallback. */
export function resolveFontFile(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const configured = env["ACF_FONT_FILE"];
  if (configured && configured.trim()) {
    const p = configured.trim();
    if (existsSync(p)) return p;
    // A configured-but-missing font is a user error worth surfacing, not silently ignoring.
    throw new FontNotFoundError(p);
  }
  return systemFontCandidates(platform).find((p) => existsSync(p));
}

export class FontNotFoundError extends Error {
  constructor(path: string) {
    super(`ACF_FONT_FILE is set to "${path}" but that file does not exist.`);
    this.name = "FontNotFoundError";
  }
}

/** Convert a filesystem path into a form safe inside an FFmpeg filtergraph value: forward
 *  slashes (accepted on Windows) and an escaped drive colon. Used inside single quotes. */
export function ffFilterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:");
}

/**
 * Build the font context for a render: resolve a font and write a minimal fonts.conf so
 * libass initializes on any OS without the system Fontconfig. `workdir` holds the generated
 * config + cache. Safe to call even when no font is found (still writes a valid empty-ish
 * config so libass init does not abort).
 */
export async function buildFontContext(
  workdir: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<FontContext> {
  const fontFile = resolveFontFile(env, platform);
  const fontDir = fontFile ? dirname(fontFile) : undefined;

  const fcDir = join(workdir, "fontconfig");
  const cacheDir = join(fcDir, "cache");
  await mkdir(cacheDir, { recursive: true });

  const dirs = new Set<string>();
  if (fontDir) dirs.add(fontDir);
  // Include the OS-standard directory too, so libass can find fallbacks if present.
  for (const cand of systemFontCandidates(platform)) {
    if (existsSync(cand)) dirs.add(dirname(cand));
  }

  const xmlDirs = [...dirs].map((d) => `  <dir>${xmlEscape(d)}</dir>`).join("\n");
  const confPath = join(fcDir, "fonts.conf");
  const conf =
    `<?xml version="1.0"?>\n<fontconfig>\n${xmlDirs}\n  <cachedir>${xmlEscape(cacheDir)}</cachedir>\n` +
    `  <config></config>\n</fontconfig>\n`;
  await writeFile(confPath, conf, "utf8");

  return {
    fontFile,
    fontDir,
    env: { FONTCONFIG_FILE: confPath, FONTCONFIG_PATH: fcDir },
  };
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
