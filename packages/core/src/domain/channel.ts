import type { ChannelId } from "./ids.ts";

/**
 * A Channel is the top-level memory container: the "bible" that every episode inherits.
 * It captures the persistent brand, style, format, and learned performance signals that
 * let "Create Episode N" run with almost no additional input.
 */
export interface ChannelStyle {
  readonly animationStyle: string; // "soft 3D Pixar-like, rounded shapes, pastel"
  readonly aspectRatio: string; // "16:9"
  readonly resolution: string; // "1080p", "4k"
  readonly colorGrade: string; // "warm, high-key, gentle contrast"
  readonly thumbnailStyle: string; // "big expressive face, 3-word caption, yellow accent"
  readonly subtitleStyle: string; // "bottom center, rounded white, 2 lines max"
}

export interface ChannelFormat {
  readonly targetDurationSec: number;
  readonly introUri?: string; // reusable intro asset
  readonly outroUri?: string; // reusable outro asset
  readonly backgroundMusicMood: string; // "gentle ukulele, playful"
  readonly hookPattern: string; // learned best-performing opening pattern
}

/** Performance signals fed back from the Analytics module (Module N); memory that the
 *  orchestrator can consult when planning hooks/pacing. Starts empty and grows. */
export interface ChannelPerformance {
  readonly bestHooks: readonly string[];
  readonly avgViewDurationSec: number;
  readonly notes: readonly string[];
}

export interface PublishingSchedule {
  readonly cadence: string; // "daily 16:00 America/Los_Angeles"
  readonly platforms: readonly string[]; // "youtube", "youtube-shorts", "tiktok"
}

export interface Channel {
  readonly id: ChannelId;
  readonly name: string;
  readonly premise: string; // one-paragraph channel bible
  readonly audience: string; // "kids 4-7 and parents"
  readonly language: string; // BCP-47
  readonly style: ChannelStyle;
  readonly format: ChannelFormat;
  readonly performance: ChannelPerformance;
  readonly schedule: PublishingSchedule;
  readonly createdAt: string;
}
