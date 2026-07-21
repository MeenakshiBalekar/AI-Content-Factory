import type { AssetKind } from "../domain/episode.ts";

/**
 * Quality reporting types (Module 4). Every generated stage is inspected; findings are
 * recorded whether or not they block, so the episode carries a full quality audit trail
 * alongside its prompt audit trail.
 */

/** "reject" findings trigger regeneration; "warn" findings are recorded but don't block. */
export type Severity = "reject" | "warn";

export interface Finding {
  readonly inspector: string;
  readonly severity: Severity;
  readonly code: string; // stable machine-readable id, e.g. "identity-missing"
  readonly message: string; // human explanation
  readonly assetLabel?: string; // which asset within the stage, when applicable
}

/** Quality outcome for one pipeline stage, including how many attempts it took. */
export interface StageQuality {
  readonly kind: AssetKind;
  readonly attempts: number;
  readonly findings: readonly Finding[]; // findings from the FINAL attempt
  readonly passed: boolean; // no "reject" findings remained on the final attempt
}

export interface QualityReport {
  readonly stages: readonly StageQuality[];
  readonly passed: boolean; // every stage passed
  readonly totalRegenerations: number; // sum of (attempts - 1)
}

export const hasRejects = (findings: readonly Finding[]): boolean =>
  findings.some((f) => f.severity === "reject");

export function buildReport(stages: readonly StageQuality[]): QualityReport {
  return {
    stages,
    passed: stages.every((s) => s.passed),
    totalRegenerations: stages.reduce((n, s) => n + (s.attempts - 1), 0),
  };
}
