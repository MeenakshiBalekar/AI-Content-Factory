import type { TextProvider } from "../providers/provider.ts";
import { LlmAgent } from "./llm-agent.ts";
import { CreativeCrew, type CrewOptions } from "./crew.ts";

/**
 * Builds a CreativeCrew whose three agents all run on the same self-hosted text provider.
 * This is the standard production wiring; tests substitute scripted agents to exercise the
 * protocol deterministically.
 */
export function buildCreativeCrew(text: TextProvider, opts: CrewOptions = {}): CreativeCrew {
  return new CreativeCrew(
    {
      director: new LlmAgent("creative-director", text),
      writer: new LlmAgent("script-writer", text),
      reviewer: new LlmAgent("quality-reviewer", text),
    },
    opts,
  );
}
