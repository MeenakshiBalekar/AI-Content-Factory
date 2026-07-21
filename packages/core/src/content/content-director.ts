import type { TextProvider } from "../providers/provider.ts";
import {
  validateStoryboard,
  type CharacterSpec,
  type Storyboard,
  type StoryboardScene,
} from "./storyboard.ts";

/**
 * The AI Content Director. Turns arbitrary user input (a rhyme, song, story, or sequence)
 * into a Storyboard: title, style, an invented cast, and a scene sequence with lyrics, visual,
 * action, and environment. Uses a self-hosted text model when one is configured; falls back to
 * a deterministic decomposition so the system works with no LLM at all (and so tests are
 * reproducible). Nothing here is specific to any character — everything is derived from input.
 */

export interface DirectOptions {
  readonly aspectRatio?: string;
  /** Force the deterministic path (skip the model). */
  readonly deterministic?: boolean;
}

const SYSTEM_PROMPT =
  "You are an AI Content Director for children's videos. Given a rhyme, song, story, or " +
  "sequence, break it into a storyboard. Invent a small, wholesome cast appropriate to the " +
  "content. Reply with ONLY compact JSON, no prose, matching exactly:\n" +
  '{"title":string,"style":string,"aspectRatio":string,' +
  '"characters":[{"name":string,"description":string,"voice":string,"palette":[string]}],' +
  '"scenes":[{"lyrics":string,"visual":string,"action":string,"environment":string,"characters":[string]}],' +
  '"song":{"mood":string}}';

export class ContentDirector {
  readonly #text: TextProvider | undefined;

  /** `text` is optional — without it (or when it errors/returns non-JSON) the deterministic
   *  decomposition is used. */
  constructor(text?: TextProvider) {
    this.#text = text;
  }

  async direct(input: string, opts: DirectOptions = {}): Promise<Storyboard> {
    const aspect = opts.aspectRatio ?? "16:9";
    if (!opts.deterministic && this.#text) {
      const viaModel = await this.#tryModel(input, aspect);
      if (viaModel) return viaModel;
    }
    return decomposeDeterministically(input, aspect);
  }

  async #tryModel(input: string, aspect: string): Promise<Storyboard | undefined> {
    let raw: string;
    try {
      raw = await this.#text!.generateText({
        system: SYSTEM_PROMPT,
        prompt: `Aspect ratio: ${aspect}\nContent:\n${input}`,
        maxTokens: 1200,
      });
    } catch {
      return undefined; // model unavailable -> deterministic fallback
    }
    const json = extractJson(raw);
    if (!json) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return undefined;
    }
    if (validateStoryboard(parsed).length > 0) return undefined;
    // Normalize (fill aspect, re-index scenes) so downstream is uniform.
    const sb = parsed as Storyboard;
    return {
      ...sb,
      aspectRatio: sb.aspectRatio || aspect,
      sourceText: input,
      scenes: sb.scenes.map((s, i) => ({ ...s, index: i })),
    };
  }
}

/** Pull the first balanced {...} object out of a model response. */
function extractJson(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Deterministic decomposition (no LLM required) — generic for any input.
// ---------------------------------------------------------------------------

/** Split input into scene-sized lines: by newlines first, else by sentence/clause. */
export function splitIntoLines(input: string): string[] {
  const byLine = input
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const source = byLine.length > 1 ? byLine : input.split(/(?<=[.!?])\s+|(?<=[.!?])$/);
  return source
    .flatMap((seg) => seg.split(/(?<=[.!?])\s+/))
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0)
    .slice(0, 24); // safety cap
}

/** A tiny, deterministic pool of neutral child names (picked by content hash, not fixed). */
const NAME_POOL = ["Suni", "Kai", "Lina", "Milo", "Ava", "Ravi", "Nia", "Theo"] as const;

function pickName(input: string): string {
  let h = 0;
  for (const ch of input) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return NAME_POOL[h % NAME_POOL.length]!;
}

/** Guess an environment from keywords in a line, defaulting to a bright generic room. */
function guessEnvironment(line: string): string {
  const l = line.toLowerCase();
  const map: [RegExp, string][] = [
    [/kitchen|eat|food|broccoli|carrot|cook|meal|fruit|veg/, "a bright, colorful kitchen"],
    [/garden|plant|flower|grow|tree|outside|park/, "a sunny garden"],
    [/sleep|bed|night|moon|star|dream/, "a cozy bedroom at night"],
    [/wash|bath|water|clean|teeth|brush/, "a cheerful bathroom"],
    [/school|learn|count|letter|number|read/, "a friendly classroom"],
    [/rain|sky|cloud|weather|sun/, "an open outdoor sky"],
    [/animal|dog|cat|farm|cow|duck/, "a happy little farm"],
  ];
  for (const [re, env] of map) if (re.test(l)) return env;
  return "a bright, playful room";
}

/** Turn a lyric line into a simple visual + action, generically. */
function sceneFromLine(line: string, index: number, character: string): StoryboardScene {
  const env = guessEnvironment(line);
  const clean = line.replace(/[.!?]+$/, "");
  return {
    index,
    lyrics: line,
    visual: `${character} in ${env}, illustrating "${clean}"`,
    action: `${character} cheerfully acts out "${clean}" with lively, bouncy movement to the beat`,
    environment: env,
    characters: [character],
  };
}

export function decomposeDeterministically(input: string, aspect = "16:9"): Storyboard {
  const lines = splitIntoLines(input);
  const safeLines = lines.length ? lines : ["A cheerful children's song"];
  const name = pickName(input);
  const character: CharacterSpec = {
    name,
    description:
      `a cheerful young child named ${name}, round friendly face, big expressive eyes, ` +
      `simple colorful everyday clothes, soft rounded 2D cartoon style`,
    voice: "bright, warm young child",
    palette: ["#FFB703", "#FB8500", "#8ECAE6", "#219EBC"],
  };
  const scenes = safeLines.map((line, i) => sceneFromLine(line, i, name));
  const title = titleize(safeLines[0] ?? "A Children's Song");
  return {
    title,
    style: "bright, friendly 2D cartoon, bold clean outlines, cheerful saturated colors, soft shading",
    aspectRatio: aspect,
    characters: [character],
    scenes,
    song: { mood: "upbeat, playful, sing-along children's song with a simple melody" },
    sourceText: input,
  };
}

function titleize(line: string): string {
  const words = line.replace(/[.!?]+$/, "").split(/\s+/).slice(0, 6).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
