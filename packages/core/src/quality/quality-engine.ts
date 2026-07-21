import type { EpisodeAsset } from "../domain/episode.ts";
import { defaultInspectors, type Inspector, type StageContext } from "./inspectors.ts";
import { hasRejects, type Finding } from "./report.ts";

/**
 * The Quality Engine (Module 4): runs every applicable inspector over a stage's output and
 * aggregates findings. The orchestrator consults it after each stage and regenerates when
 * any "reject" finding is present (up to its attempt budget). Inspectors are pluggable —
 * vision-model checks (blur, framing, lip-sync) register here in Module 4.1 without any
 * engine or orchestrator changes.
 */
export class QualityEngine {
  readonly #inspectors: readonly Inspector[];

  constructor(inspectors: readonly Inspector[] = defaultInspectors()) {
    this.#inspectors = inspectors;
  }

  inspectStage(assets: readonly EpisodeAsset[], ctx: StageContext): Finding[] {
    const findings: Finding[] = [];
    for (const inspector of this.#inspectors) {
      if (!inspector.appliesTo(ctx.stage.kind)) continue;
      findings.push(...inspector.inspect(assets, ctx));
    }
    return findings;
  }

  shouldRegenerate(findings: readonly Finding[]): boolean {
    return hasRejects(findings);
  }
}
