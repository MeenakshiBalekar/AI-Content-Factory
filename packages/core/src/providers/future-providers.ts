import type { GeneratedAsset } from "./provider.ts";

/**
 * FUTURE INTEGRATIONS — interfaces defined now, implementations pending.
 *
 * Per the platform's inference-ownership policy, every capability must be servable from
 * self-hosted open-source models. These capabilities have viable open-source models but no
 * settled serving protocol yet, so the interface is fixed here (the orchestrator and
 * workflow engine can already reference them) and the adapter lands when the serving stack
 * is chosen. NO commercial API will ever back these interfaces.
 *
 * Candidate open-source models per capability:
 *  - Music:          MusicGen (Meta, MIT weights), Stable Audio Open, YuE
 *  - Lip sync:       Wav2Lip, LatentSync, SadTalker (talking-head)
 *  - Transcription:  Whisper / faster-whisper (already fully open — adapter is
 *                    straightforward once forced-alignment requirements are settled)
 */

/** Dedicated music generation (today the pipeline routes music through AudioProvider). */
export interface MusicGenerationProvider {
  readonly name: string;
  generateMusic(req: {
    readonly prompt: string;
    readonly durationSec: number;
    readonly loopable: boolean;
  }): Promise<GeneratedAsset>;
}

/** Lip-syncs a rendered character video to a voice track. */
export interface LipSyncProvider {
  readonly name: string;
  lipSync(req: {
    readonly videoUri: string;
    readonly audioUri: string;
  }): Promise<GeneratedAsset>;
}

/** Word-level transcription/alignment for exact subtitle timing against real audio. */
export interface TranscriptionProvider {
  readonly name: string;
  transcribe(req: { readonly audioUri: string; readonly language: string }): Promise<{
    readonly words: readonly { readonly word: string; readonly startMs: number; readonly endMs: number }[];
  }>;
}
