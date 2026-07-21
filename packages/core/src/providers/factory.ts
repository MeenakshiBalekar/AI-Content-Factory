import { ProviderRegistry, type Capability } from "./provider.ts";
import { LocalProvider } from "./local-provider.ts";
import { OpenAITextProvider } from "./openai-text-provider.ts";
import { OpenAIImageProvider } from "./openai-image-provider.ts";
import { ElevenLabsAudioProvider } from "./elevenlabs-audio-provider.ts";
import { AsyncVideoProvider } from "./async-video-provider.ts";
import { loadProvidersConfig, type ProvidersConfig } from "./http/config.ts";
import { FileObjectStore, type ObjectStore } from "../storage/object-store.ts";

/** Which concrete provider ended up wired for each capability — surfaced so the CLI/API can
 *  tell the user exactly what will (and won't) cost money on the next run. */
export interface ProviderReport {
  readonly text: string;
  readonly image: string;
  readonly audio: string;
  readonly video: string;
}

export interface BuildResult {
  readonly registry: ProviderRegistry;
  readonly report: ProviderReport;
}

export interface BuildOptions {
  readonly config?: ProvidersConfig;
  readonly objectStore?: ObjectStore;
  /** Force the offline provider for every capability regardless of config. */
  readonly forceLocal?: boolean;
}

/**
 * Assembles a ProviderRegistry. For each capability it uses the real adapter when its config
 * is present, otherwise the deterministic LocalProvider — so the pipeline always runs, and a
 * partially-configured deployment (e.g. real text + voice, local video) just works. This is
 * the single wiring seam Module 1 promised: the orchestrator is untouched.
 */
export function buildProviderRegistry(opts: BuildOptions = {}): BuildResult {
  const cfg = opts.config ?? loadProvidersConfig();
  const store = opts.objectStore ?? new FileObjectStore(".acf-assets");
  const local = new LocalProvider();
  const registry = new ProviderRegistry();
  const report: Record<Capability, string> = {
    text: local.name,
    image: local.name,
    audio: local.name,
    video: local.name,
  };

  if (!opts.forceLocal && cfg.text) {
    registry.registerText(new OpenAITextProvider(cfg.text));
    report.text = "openai-text";
  } else {
    registry.registerText(local);
  }

  if (!opts.forceLocal && cfg.image) {
    registry.registerImage(new OpenAIImageProvider(cfg.image, store));
    report.image = "openai-image";
  } else {
    registry.registerImage(local);
  }

  if (!opts.forceLocal && cfg.audio) {
    registry.registerAudio(new ElevenLabsAudioProvider(cfg.audio, store));
    report.audio = "elevenlabs-audio";
  } else {
    registry.registerAudio(local);
  }

  if (!opts.forceLocal && cfg.video) {
    registry.registerVideo(new AsyncVideoProvider(cfg.video));
    report.video = "async-video";
  } else {
    registry.registerVideo(local);
  }

  return { registry, report };
}
