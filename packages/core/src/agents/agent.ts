/**
 * Multi-agent orchestrator (Module 7). Specialized agents collaborate to develop an episode
 * before the production pipeline runs. Each agent is a thin, single-responsibility role; the
 * crew (crew.ts) sequences their turns into a critique → revise loop. Every agent runs on the
 * self-hosted text model — no capability here needs a commercial API.
 *
 * The abstraction is deliberately small so the collaboration protocol can be tested with
 * scripted agents, while production uses LlmAgent (llm-agent.ts) backed by a TextProvider.
 */

export type AgentRole =
  | "creative-director"
  | "script-writer"
  | "quality-reviewer";

/** A single utterance in the collaboration transcript. */
export interface AgentMessage {
  readonly role: AgentRole;
  readonly content: string;
  /** Reviewer verdict, parsed from content; only present on reviewer turns. */
  readonly verdict?: "approve" | "revise";
}

/** Everything an agent needs to take a turn. Pure data — no I/O. */
export interface AgentContext {
  readonly channelPremise: string;
  readonly audience: string;
  readonly episodeNumber: number;
  readonly previousTitle: string | undefined;
  /** Proven high-retention hooks from the learning loop (Module 6). */
  readonly provenHooks: readonly string[];
  /** Optional human nudge, e.g. "make it about sharing". */
  readonly brief: string | undefined;
  /** The conversation so far this round (director theme, prior drafts/critiques). */
  readonly history: readonly AgentMessage[];
}

export interface Agent {
  readonly role: AgentRole;
  act(ctx: AgentContext): Promise<AgentMessage>;
}

/** Parse a reviewer verdict from free text. Tolerant: defaults to "revise" if unclear,
 *  so an ambiguous review never falsely approves (fail-safe toward more iteration). */
export function parseVerdict(content: string): "approve" | "revise" {
  return /\bAPPROVE\b/i.test(content) && !/\bREVISE\b/i.test(content) ? "approve" : "revise";
}

/** Extract a labelled field ("LOGLINE: ...") from an agent's text, if present. */
export function extractField(content: string, label: string): string | undefined {
  const re = new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, "im");
  const m = re.exec(content);
  return m?.[1]?.trim();
}
