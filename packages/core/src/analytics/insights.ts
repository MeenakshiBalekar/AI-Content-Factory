import type { Channel, ChannelPerformance } from "../domain/channel.ts";
import type { Episode } from "../domain/episode.ts";
import type { ChannelMemory } from "../memory/memory-store.ts";
import type { EpisodeMetrics } from "./metrics.ts";

/**
 * The learning loop (Module 6) — the flywheel the whole platform is built around:
 *
 *   publish → measure (metrics) → LEARN → write back into ChannelPerformance → the story
 *   planner reads that memory when making the next episode.
 *
 * `computeInsights` correlates metrics with the episodes that produced them, ranks by
 * retention (average view duration is the signal that most predicts channel growth), and
 * derives concrete, reusable signals. `applyLearnings` folds those into channel memory so
 * the next "Create Episode N" is measurably informed by what actually performed.
 */

export interface EpisodeInsight {
  readonly episodeNumber: number;
  readonly title: string;
  readonly hook: string; // the opening beat — the thing viewers decide on in 3 seconds
  readonly avgViewDurationSec: number;
  readonly ctr: number | undefined;
  readonly views: number;
}

export interface ChannelInsights {
  readonly sampled: number; // how many episodes had metrics
  readonly avgViewDurationSec: number; // mean across measured episodes
  readonly bestHooks: readonly string[]; // hooks from the top retention performers
  readonly top: readonly EpisodeInsight[];
  readonly notes: readonly string[]; // actionable recommendations
}

const hookOf = (ep: Episode): string => ep.beats[0]?.summary ?? ep.title;

/** Correlate metrics with episodes and rank by retention. Pure — easy to test. */
export function computeInsights(
  episodes: readonly Episode[],
  metrics: readonly EpisodeMetrics[],
  opts: { readonly topN?: number } = {},
): ChannelInsights {
  const topN = opts.topN ?? 3;
  const byNumber = new Map<number, Episode>(episodes.map((e) => [e.number, e]));

  const insights: EpisodeInsight[] = metrics
    .filter((m) => byNumber.has(m.episodeNumber))
    .map((m) => {
      const ep = byNumber.get(m.episodeNumber)!;
      return {
        episodeNumber: m.episodeNumber,
        title: ep.title,
        hook: hookOf(ep),
        avgViewDurationSec: m.avgViewDurationSec,
        ctr: m.ctr,
        views: m.views,
      };
    });

  if (insights.length === 0) {
    return { sampled: 0, avgViewDurationSec: 0, bestHooks: [], top: [], notes: ["no metrics for any known episode yet"] };
  }

  const avg =
    insights.reduce((s, i) => s + i.avgViewDurationSec, 0) / insights.length;

  const byRetention = [...insights].sort((a, b) => b.avgViewDurationSec - a.avgViewDurationSec);
  const top = byRetention.slice(0, topN);
  // De-duplicate hooks while preserving rank order.
  const bestHooks = [...new Set(top.map((t) => t.hook))];

  const notes: string[] = [];
  const best = byRetention[0]!;
  const worst = byRetention[byRetention.length - 1]!;
  notes.push(
    `Top retention: ep ${best.episodeNumber} "${best.title}" at ${best.avgViewDurationSec}s avg view duration.`,
  );
  if (byRetention.length > 1 && worst.avgViewDurationSec < avg * 0.8) {
    notes.push(
      `Weakest: ep ${worst.episodeNumber} at ${worst.avgViewDurationSec}s — below 80% of the mean; avoid its hook pattern.`,
    );
  }
  const withCtr = insights.filter((i) => i.ctr !== undefined);
  if (withCtr.length) {
    const bestCtr = withCtr.reduce((a, b) => ((b.ctr ?? 0) > (a.ctr ?? 0) ? b : a));
    notes.push(
      `Best CTR: ep ${bestCtr.episodeNumber} at ${((bestCtr.ctr ?? 0) * 100).toFixed(1)}% — its thumbnail/title framing works.`,
    );
  }

  return { sampled: insights.length, avgViewDurationSec: Math.round(avg), bestHooks, top, notes };
}

/** Fold insights into ChannelPerformance, returning updated memory (immutably). */
export function applyLearnings(memory: ChannelMemory, insights: ChannelInsights): ChannelMemory {
  if (insights.sampled === 0) return memory;
  const performance: ChannelPerformance = {
    bestHooks: insights.bestHooks,
    avgViewDurationSec: insights.avgViewDurationSec,
    notes: insights.notes,
  };
  const channel: Channel = { ...memory.channel, performance };
  return { ...memory, channel };
}
