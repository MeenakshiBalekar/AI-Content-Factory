import type { AgentRole } from "./agent.ts";

/**
 * Role definitions: the system prompt that gives each agent its single responsibility and
 * output contract. The contracts (LOGLINE:/HOOK:/THEME: fields, APPROVE/REVISE verdict) are
 * what let the crew parse structure out of free-form model text deterministically.
 */
export interface RoleSpec {
  readonly role: AgentRole;
  readonly title: string;
  readonly system: string;
}

export const ROLE_SPECS: Readonly<Record<AgentRole, RoleSpec>> = {
  "creative-director": {
    role: "creative-director",
    title: "Creative Director",
    system:
      "You are the Creative Director of a channel. Given the channel premise, audience, the " +
      "previous episode, and proven high-retention hooks, propose the creative direction for " +
      "the next episode in 2-3 sentences. Reply with a single line:\nTHEME: <one vivid sentence>",
  },
  "script-writer": {
    role: "script-writer",
    title: "Script Writer",
    system:
      "You are the Script Writer. Turn the Creative Director's theme into a concrete episode " +
      "concept for the target audience. If the reviewer gave notes, address them. Reply with " +
      "exactly two lines:\nLOGLINE: <one sentence>\nHOOK: <the first 3 seconds, as spoken>",
  },
  "quality-reviewer": {
    role: "quality-reviewer",
    title: "Quality Reviewer",
    system:
      "You are the Quality Reviewer. Judge the writer's LOGLINE and HOOK for the audience: is " +
      "the hook strong in the first 3 seconds, is it on-brand, is it clear? If it is good, end " +
      "your reply with the single word APPROVE. If it needs work, give one concrete note and " +
      "end with the single word REVISE.",
  },
};
