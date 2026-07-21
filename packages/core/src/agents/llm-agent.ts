import type { TextProvider } from "../providers/provider.ts";
import { parseVerdict, type Agent, type AgentContext, type AgentMessage, type AgentRole } from "./agent.ts";
import { ROLE_SPECS } from "./roles.ts";

/**
 * An Agent backed by a TextProvider — i.e. a self-hosted LLM (vLLM/Ollama). Composes the
 * role's system prompt with the shared context and the round history into one request. This
 * is the only place agents touch inference, so swapping models is a provider change, and the
 * crew protocol stays model-agnostic.
 */
export class LlmAgent implements Agent {
  readonly role: AgentRole;
  readonly #provider: TextProvider;

  constructor(role: AgentRole, provider: TextProvider) {
    this.role = role;
    this.#provider = provider;
  }

  #renderContext(ctx: AgentContext): string {
    const lines = [
      `Channel: ${ctx.channelPremise}`,
      `Audience: ${ctx.audience}`,
      `Episode number: ${ctx.episodeNumber}`,
      `Previous episode: ${ctx.previousTitle ?? "none"}`,
    ];
    if (ctx.provenHooks.length) {
      lines.push(`Proven high-retention hooks: ${ctx.provenHooks.map((h) => `"${h}"`).join("; ")}`);
    }
    if (ctx.brief) lines.push(`Human brief: ${ctx.brief}`);
    if (ctx.history.length) {
      lines.push("Conversation so far:");
      for (const m of ctx.history) lines.push(`  [${m.role}] ${m.content}`);
    }
    return lines.join("\n");
  }

  async act(ctx: AgentContext): Promise<AgentMessage> {
    const spec = ROLE_SPECS[this.role];
    const content = await this.#provider.generateText({
      system: spec.system,
      prompt: this.#renderContext(ctx),
      maxTokens: 300,
    });
    const message: AgentMessage = { role: this.role, content: content.trim() };
    return this.role === "quality-reviewer"
      ? { ...message, verdict: parseVerdict(content) }
      : message;
  }
}
