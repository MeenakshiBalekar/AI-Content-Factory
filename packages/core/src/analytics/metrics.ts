/**
 * Analytics metrics (Module 6). Metrics arrive from an ingest source — a JSON export, a
 * platform-studio CSV, or (future integration) the free-quota YouTube Analytics API once
 * OAuth credential management exists. Ingestion is source-agnostic: anything that can
 * produce EpisodeMetrics rows works, and no commercial AI API is involved.
 */

export interface EpisodeMetrics {
  readonly episodeNumber: number;
  readonly views: number;
  readonly impressions?: number;
  /** Click-through rate as a fraction (0.042 = 4.2%). */
  readonly ctr?: number;
  readonly avgViewDurationSec: number;
  readonly likes?: number;
  readonly comments?: number;
  readonly measuredAt: string; // ISO timestamp of the measurement
}

/** Returns problems with an ingest payload (empty = valid). */
export function validateMetrics(rows: unknown): string[] {
  if (!Array.isArray(rows)) return ["metrics payload must be an array"];
  const problems: string[] = [];
  rows.forEach((r, i) => {
    const row = r as Partial<EpisodeMetrics>;
    if (!Number.isInteger(row.episodeNumber) || (row.episodeNumber as number) < 1) {
      problems.push(`row ${i}: episodeNumber must be a positive integer`);
    }
    if (typeof row.views !== "number" || row.views < 0) {
      problems.push(`row ${i}: views must be a non-negative number`);
    }
    if (typeof row.avgViewDurationSec !== "number" || row.avgViewDurationSec < 0) {
      problems.push(`row ${i}: avgViewDurationSec must be a non-negative number`);
    }
    if (row.ctr !== undefined && (typeof row.ctr !== "number" || row.ctr < 0 || row.ctr > 1)) {
      problems.push(`row ${i}: ctr must be a fraction between 0 and 1`);
    }
    if (typeof row.measuredAt !== "string" || Number.isNaN(Date.parse(row.measuredAt))) {
      problems.push(`row ${i}: measuredAt must be an ISO timestamp`);
    }
  });
  return problems;
}

/** Merge new rows into existing metrics; a row for an already-measured episode replaces it. */
export function mergeMetrics(
  existing: readonly EpisodeMetrics[],
  incoming: readonly EpisodeMetrics[],
): EpisodeMetrics[] {
  const byEpisode = new Map<number, EpisodeMetrics>(existing.map((m) => [m.episodeNumber, m]));
  for (const row of incoming) byEpisode.set(row.episodeNumber, row);
  return [...byEpisode.values()].sort((a, b) => a.episodeNumber - b.episodeNumber);
}
