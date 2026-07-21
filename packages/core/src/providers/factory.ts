import { ProviderRegistry, type Capability } from "./provider.ts";
import { LocalProvider } from "./local-provider.ts";
import { ChatCompletionsTextProvider } from "./chat-completions-text-provider.ts";
import { ImagesApiImageProvider } from "./images-api-image-provider.ts";
import { SpeechApiAudioProvider } from "./speech-api-audio-provider.ts";
import { ElevenLabsAudioProvider } from "./elevenlabs-audio-provider.ts";
import { AsyncVideoProvider } from "./async-video-provider.ts";
import { loadProvidersConfig, type ProvidersConfig } from "./http/config.ts";
import { FileObjectStore, type ObjectStore } from "../storage/object-store.ts";

/**
 * Which concrete provider ended up wired for each capability, tagged with its mode:
 *   "<name> [self-hosted]"  — our own inference servers (the intended deployment)
 *   "<name> [commercial]"   — legacy fallback through the same open protocol
 *   "local [offline]"       — free deterministic placeholder (dev/tests)
 */
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

const OFFLINE = "local [offline]";

/**
 * Assembles a ProviderRegistry — SELF-HOSTED FIRST. For each capability: the self-hosted
 * endpoint when configured, else a commercial fallback if one was explicitly provided, else
 * the offline LocalProvider so the pipeline always runs. The orchestrator is untouched by
 * any of this; ownership of the inference stack is purely a wiring decision here.
 */
export function buildProviderRegistry(opts: BuildOptions = {}): BuildResult {
  const cfg = opts.config ?? loadProvidersConfig();
  const store = opts.objectStore ?? new FileObjectStore(".acf-assets");
  const local = new LocalProvider();
  const registry = new ProviderRegistry();
  const report: Record<Capability, string> = {
    text: OFFLINE,
    image: OFFLINE,
    audio: OFFLINE,
    video: OFFLINE,
  };

  if (!opts.forceLocal && cfg.text) {
    const p = new ChatCompletionsTextProvider(cfg.text);
    registry.registerText(p);
    report.text = `${p.name} [${cfg.text.mode}]`;
  } else {
    registry.registerText(local);
  }

  if (!opts.forceLocal && cfg.image) {
    const p = new ImagesApiImageProvider(cfg.image, store);
    registry.registerImage(p);
    report.image = `${p.name} [${cfg.image.mode}]`;
  } else {
    registry.registerImage(local);
  }

  // Audio: self-hosted speech server always wins over the commercial legacy fallback.
  if (!opts.forceLocal && cfg.speech) {
    const p = new SpeechApiAudioProvider(cfg.speech, store);
    registry.registerAudio(p);
    report.audio = `${p.name} [${cfg.speech.mode}]`;
  } else if (!opts.forceLocal && cfg.elevenlabs) {
    const p = new ElevenLabsAudioProvider(cfg.elevenlabs, store);
    registry.registerAudio(p);
    report.audio = `${p.name} [commercial]`;
  } else {
    registry.registerAudio(local);
  }

  if (!opts.forceLocal && cfg.video) {
    const p = new AsyncVideoProvider(cfg.video);
    registry.registerVideo(p);
    report.video = `${p.name} [${cfg.video.mode}]`;
  } else {
    registry.registerVideo(local);
  }

  return { registry, report };
}
