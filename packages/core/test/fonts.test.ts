import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  resolveFontFile,
  buildFontContext,
  ffFilterPath,
  FontNotFoundError,
} from "../src/render/fonts.ts";

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "acf-fonts-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("resolveFontFile prefers ACF_FONT_FILE when it exists", async () => {
  await withDir(async (dir) => {
    const fontPath = join(dir, "myfont.ttf");
    await writeFile(fontPath, "not-a-real-font-but-a-real-file");
    assert.equal(resolveFontFile({ ACF_FONT_FILE: fontPath }), fontPath);
  });
});

test("resolveFontFile throws a clear error when ACF_FONT_FILE points at a missing file", () => {
  assert.throws(
    () => resolveFontFile({ ACF_FONT_FILE: "/no/such/font.ttf" }),
    FontNotFoundError,
  );
});

test("resolveFontFile falls back to per-OS candidates without throwing", () => {
  // win32 candidates won't exist on the test host -> undefined; must never throw.
  const r = resolveFontFile({}, "win32");
  assert.ok(r === undefined || typeof r === "string");
});

test("ffFilterPath makes a Windows path safe for an FFmpeg filtergraph", () => {
  assert.equal(ffFilterPath("C:\\Windows\\Fonts\\segoeui.ttf"), "C\\:/Windows/Fonts/segoeui.ttf");
  assert.equal(ffFilterPath("/usr/share/fonts/DejaVuSans.ttf"), "/usr/share/fonts/DejaVuSans.ttf");
});

test("buildFontContext writes a portable fonts.conf and returns FONTCONFIG env (win32 path)", async () => {
  await withDir(async (dir) => {
    const fontPath = join(dir, "segoeui.ttf");
    await writeFile(fontPath, "dummy");
    // Simulate Windows: explicit font file, no system Fontconfig.
    const ctx = await buildFontContext(dir, { ACF_FONT_FILE: fontPath }, "win32");

    assert.equal(ctx.fontFile, fontPath);
    assert.equal(ctx.fontDir, dirname(fontPath));
    assert.ok(ctx.env["FONTCONFIG_FILE"], "FONTCONFIG_FILE is set");
    assert.ok(existsSync(ctx.env["FONTCONFIG_FILE"]!), "fonts.conf was written");

    const conf = await readFile(ctx.env["FONTCONFIG_FILE"]!, "utf8");
    assert.match(conf, /<fontconfig>/);
    assert.ok(conf.includes(dirname(fontPath)), "font directory is listed in the config");
    assert.match(conf, /<cachedir>/);
  });
});

test("buildFontContext still produces a valid config when no font is found", async () => {
  await withDir(async (dir) => {
    // Unset ACF_FONT_FILE and use win32 (no system fonts on the host) -> no font, but the
    // generated config must still exist so libass init does not abort.
    const ctx = await buildFontContext(dir, {}, "win32");
    assert.equal(ctx.fontFile, undefined);
    assert.ok(existsSync(ctx.env["FONTCONFIG_FILE"]!));
  });
});
