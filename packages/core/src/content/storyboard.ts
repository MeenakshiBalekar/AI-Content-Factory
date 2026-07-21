/**
 * The Content Understanding layer (generic).
 *
 * A Storyboard is what the AI Content Director produces from ANY user input — a rhyme, song,
 * story, or sequence. It is entirely content-driven: the cast, environments, style, scenes,
 * actions, and song are all derived from the input, never hardcoded. This is the clean seam
 * between "what happens in the content" (this layer) and "how we turn it into media" (the
 * media layer, which consumes a Storyboard and knows nothing about any specific character).
 */

/** A character invented for THIS piece of content (not a fixed/reference character). */
export interface CharacterSpec {
  readonly name: string;
  /** Full visual description, injected verbatim into every scene image prompt for
   *  consistency (maps to CharacterAppearance.promptDescription). */
  readonly description: string;
  /** Voice hint, e.g. "bright young child", "warm narrator". */
  readonly voice: string;
  /** Dominant colors (optional). */
  readonly palette: readonly string[];
}

export interface StoryboardScene {
  readonly index: number;
  /** The exact line(s) of the input spoken/sung in this scene. */
  readonly lyrics: string;
  /** What we see, e.g. "Happy child dancing in a colorful kitchen". */
  readonly visual: string;
  /** What moves, e.g. "Picks up broccoli, takes a bite, smiles". */
  readonly action: string;
  /** Where it happens, e.g. "colorful kitchen". */
  readonly environment: string;
  /** Names of characters present (subset of the cast). */
  readonly characters: readonly string[];
}

export interface Storyboard {
  readonly title: string;
  /** Visual style for every scene, e.g. "bright 2D cartoon, bold clean outlines, cheerful". */
  readonly style: string;
  readonly aspectRatio: string;
  readonly characters: readonly CharacterSpec[];
  readonly scenes: readonly StoryboardScene[];
  /** Song/soundtrack hint. */
  readonly song: { readonly mood: string };
  /** The original user input, kept for provenance. */
  readonly sourceText: string;
}

/** Validate a storyboard's shape (used after parsing model output). Returns problems. */
export function validateStoryboard(sb: unknown): string[] {
  const problems: string[] = [];
  const s = sb as Partial<Storyboard>;
  if (!s || typeof s !== "object") return ["storyboard is not an object"];
  if (!s.title || typeof s.title !== "string") problems.push("missing title");
  if (!s.style || typeof s.style !== "string") problems.push("missing style");
  if (!Array.isArray(s.characters) || s.characters.length === 0) problems.push("no characters");
  if (!Array.isArray(s.scenes) || s.scenes.length === 0) problems.push("no scenes");
  for (const [i, sc] of (s.scenes ?? []).entries()) {
    if (!sc || typeof sc.lyrics !== "string" || typeof sc.visual !== "string") {
      problems.push(`scene ${i} missing lyrics/visual`);
    }
  }
  return problems;
}
