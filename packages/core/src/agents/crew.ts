import {
  extractField,
  type Agent,
  type AgentContext,
  type AgentMessage,
  type AgentRole,
} from "./agent.ts";

/**
 * The CreativeCrew sequences agent turns into a real collaboration:
 *
 *   Creative Director proposes a THEME
 *   → Script Writer drafts LOGLINE + HOOK
 *   → Quality Reviewer approves or returns one note
 *   → (on REVISE) the writer revises with the note in context, up to a round budget
 *
 * The control flow is deterministic given the agents' outputs, so it is testable with
 * scripted agents; production wires LlmAgents over the self-hosted text model. The result is
 * a CreativeBrief the orchestrator feeds into the story stage, plus the full transcript for
 * auditability.
 */

export interface CreativeBrief {
  readonly theme: string;
  readonly logline: string;
  readonly hook: string;
  readonly rounds: number; // writer/reviewer iterations performed
  readonly approved: boolean; // reviewer approved within the budget
  readonly transcript: readonly AgentMessage[];
}

export interface CrewAgents {
  readonly director: Agent;
  readonly writer: Agent;
  readonly reviewer: Agent;
}

export interface CrewOptions {
  /** Max writer/reviewer revision rounds before shipping the best draft. Default 3. */
  readonly maxRounds?: number;
}

export class CreativeCrew {
  readonly #agents: CrewAgents;
  readonly #maxRounds: number;

  constructor(agents: CrewAgents, opts: CrewOptions = {}) {
    assertRole(agents.director, "creative-director");
    assertRole(agents.writer, "script-writer");
    assertRole(agents.reviewer, "quality-reviewer");
    this.#agents = agents;
    this.#maxRounds = Math.max(1, opts.maxRounds ?? 3);
  }

  async develop(base: Omit<AgentContext, "history">): Promise<CreativeBrief> {
    const transcript: AgentMessage[] = [];
    const ctx = (): AgentContext => ({ ...base, history: transcript });

    const directorMsg = await this.#agents.director.act(ctx());
    transcript.push(directorMsg);
    const theme = extractField(directorMsg.content, "THEME") ?? directorMsg.content;

    let rounds = 0;
    let approved = false;
    let lastDraft: AgentMessage | undefined;

    while (rounds < this.#maxRounds) {
      rounds++;
      const draft = await this.#agents.writer.act(ctx());
      transcript.push(draft);
      lastDraft = draft;

      const review = await this.#agents.reviewer.act(ctx());
      transcript.push(review);

      if (review.verdict === "approve") {
        approved = true;
        break;
      }
    }

    const { logline, hook } = deriveBrief(lastDraft, theme, base.provenHooks);
    return { theme, logline, hook, rounds, approved, transcript };
  }
}

function assertRole(agent: Agent, role: AgentRole): void {
  if (agent.role !== role) {
    throw new Error(`CreativeCrew expected a "${role}" agent but got "${agent.role}"`);
  }
}

/** Pull structured logline/hook from the writer's draft, with robust fallbacks so any text
 *  provider (including the deterministic offline one) yields a usable brief. */
function deriveBrief(
  draft: AgentMessage | undefined,
  theme: string,
  provenHooks: readonly string[],
): { logline: string; hook: string } {
  const content = draft?.content ?? theme;
  const logline = extractField(content, "LOGLINE") ?? firstSentence(content) ?? theme;
  const hook =
    extractField(content, "HOOK") ??
    provenHooks[0] ??
    firstSentence(logline) ??
    logline;
  return { logline, hook };
}

function firstSentence(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const m = /^[^.!?\n]+[.!?]?/.exec(trimmed);
  return m?.[0]?.trim();
}
