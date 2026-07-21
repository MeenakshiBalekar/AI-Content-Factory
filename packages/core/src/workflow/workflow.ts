import type { AssetKind } from "../domain/episode.ts";
import type { ProductionStage } from "../orchestrator/production-plan.ts";

/**
 * The Workflow Engine (Module 5): pipelines as data. A workflow is a DAG of typed stages
 * with explicit dependencies; the engine validates it (unknown kinds, missing/duplicate ids,
 * cycles) and produces a deterministic execution order for the orchestrator. This is the
 * model a drag-and-drop editor manipulates — the UI is a view over exactly these objects.
 */

/** Per-stage parameter overrides. Anything unset falls back to channel memory. */
export interface StageParams {
  /** Override the channel aspect ratio (e.g. "9:16" for Shorts). */
  readonly aspect?: string;
  /** Override the channel target duration for video stages, in seconds. */
  readonly durationSec?: number;
}

export interface WorkflowStage {
  /** Unique id within the workflow (referenced by dependsOn). */
  readonly id: string;
  readonly kind: AssetKind;
  readonly label: string;
  /** Stage ids that must complete before this stage runs. */
  readonly dependsOn: readonly string[];
  readonly params?: StageParams;
}

export interface WorkflowDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly stages: readonly WorkflowStage[];
}

/** Capability each asset kind needs — the single source of truth used by validation. */
export const CAPABILITY_FOR_KIND: Readonly<Record<AssetKind, ProductionStage["capability"]>> = {
  story: "text",
  script: "text",
  storyboard: "none",
  image: "image",
  voice: "audio",
  music: "audio",
  video: "video",
  subtitles: "none",
  thumbnail: "image",
  metadata: "text",
};

export class WorkflowValidationError extends Error {
  readonly problems: readonly string[];

  constructor(workflowId: string, problems: readonly string[]) {
    super(`Workflow "${workflowId}" is invalid:\n- ${problems.join("\n- ")}`);
    this.name = "WorkflowValidationError";
    this.problems = problems;
  }
}

/** Validates structure and returns the list of problems (empty = valid). */
export function validateWorkflow(wf: WorkflowDefinition): string[] {
  const problems: string[] = [];
  if (!wf.stages.length) problems.push("workflow has no stages");

  const ids = new Set<string>();
  for (const s of wf.stages) {
    if (ids.has(s.id)) problems.push(`duplicate stage id "${s.id}"`);
    ids.add(s.id);
    if (!(s.kind in CAPABILITY_FOR_KIND)) {
      problems.push(`stage "${s.id}" has unknown kind "${s.kind}"`);
    }
  }
  for (const s of wf.stages) {
    for (const dep of s.dependsOn) {
      if (!ids.has(dep)) problems.push(`stage "${s.id}" depends on unknown stage "${dep}"`);
      if (dep === s.id) problems.push(`stage "${s.id}" depends on itself`);
    }
  }

  // Cycle detection via Kahn's algorithm — anything left unprocessed sits on a cycle.
  if (problems.length === 0) {
    const order = topologicalOrder(wf);
    if (order.length !== wf.stages.length) {
      const ordered = new Set(order.map((s) => s.id));
      const cyclic = wf.stages.filter((s) => !ordered.has(s.id)).map((s) => s.id);
      problems.push(`dependency cycle involving: ${cyclic.join(", ")}`);
    }
  }
  return problems;
}

/** Throws WorkflowValidationError if invalid. */
export function assertValidWorkflow(wf: WorkflowDefinition): void {
  const problems = validateWorkflow(wf);
  if (problems.length) throw new WorkflowValidationError(wf.id, problems);
}

/**
 * Deterministic topological order (Kahn's algorithm; ready stages processed in definition
 * order so the same workflow always executes identically). Stages on a cycle are omitted —
 * validateWorkflow turns that into an error.
 */
export function topologicalOrder(wf: WorkflowDefinition): WorkflowStage[] {
  const remainingDeps = new Map<string, Set<string>>(
    wf.stages.map((s) => [s.id, new Set(s.dependsOn)]),
  );
  const done = new Set<string>();
  const order: WorkflowStage[] = [];

  for (;;) {
    const ready = wf.stages.filter(
      (s) => !done.has(s.id) && [...remainingDeps.get(s.id)!].every((d) => done.has(d)),
    );
    if (!ready.length) break;
    for (const s of ready) {
      order.push(s);
      done.add(s.id);
    }
  }
  return order;
}

/** Validates, orders, and converts a workflow into the orchestrator's stage list. */
export function compileWorkflow(wf: WorkflowDefinition): ProductionStage[] {
  assertValidWorkflow(wf);
  return topologicalOrder(wf).map((s) => ({
    kind: s.kind,
    label: s.label,
    capability: CAPABILITY_FOR_KIND[s.kind],
    ...(s.params ? { params: s.params } : {}),
  }));
}
