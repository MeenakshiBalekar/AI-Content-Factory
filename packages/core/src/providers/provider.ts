/**
 * Provider abstraction. Every external model vendor (OpenAI, Anthropic, Genmax, ElevenLabs,
 * Runway, Suno, …) is an adapter behind one of these capability interfaces. The orchestrator
 * depends only on the interfaces, so the platform never depends on a single vendor and new
 * providers are plug-ins.
 */

export interface TextRequest {
  readonly prompt: string;
  readonly system?: string;
  readonly maxTokens?: number;
}
export interface ImageRequest {
  readonly prompt: string;
  readonly seed: number;
  readonly aspect: string;
}
export interface AudioRequest {
  readonly text: string;
  readonly voiceRef: string;
  readonly pitch: number;
  readonly speed: number;
  readonly emotion: string;
}
export interface VideoRequest {
  readonly prompt: string;
  readonly seed: number;
  readonly aspect: string;
  readonly durationSec: number;
  readonly imageUri?: string;
}

export interface GeneratedAsset {
  readonly outputUri: string;
  readonly provider: string;
  readonly meta?: Readonly<Record<string, string | number>>;
}

export interface TextProvider {
  readonly name: string;
  generateText(req: TextRequest): Promise<string>;
}
export interface ImageProvider {
  readonly name: string;
  generateImage(req: ImageRequest): Promise<GeneratedAsset>;
}
export interface AudioProvider {
  readonly name: string;
  generateAudio(req: AudioRequest): Promise<GeneratedAsset>;
}
export interface VideoProvider {
  readonly name: string;
  generateVideo(req: VideoRequest): Promise<GeneratedAsset>;
}

export type Capability = "text" | "image" | "audio" | "video";

/**
 * Resolves a capability to a concrete provider. A real deployment would consult routing
 * policy (cost, quality tier, quota, health) here — the Cost-Optimization AI module plugs
 * in at exactly this seam. For Module 1 it is a simple registry with a default per capability.
 */
export class ProviderRegistry {
  #text?: TextProvider;
  #image?: ImageProvider;
  #audio?: AudioProvider;
  #video?: VideoProvider;

  registerText(p: TextProvider): this {
    this.#text = p;
    return this;
  }
  registerImage(p: ImageProvider): this {
    this.#image = p;
    return this;
  }
  registerAudio(p: AudioProvider): this {
    this.#audio = p;
    return this;
  }
  registerVideo(p: VideoProvider): this {
    this.#video = p;
    return this;
  }

  text(): TextProvider {
    if (!this.#text) throw new Error("No text provider registered");
    return this.#text;
  }
  image(): ImageProvider {
    if (!this.#image) throw new Error("No image provider registered");
    return this.#image;
  }
  audio(): AudioProvider {
    if (!this.#audio) throw new Error("No audio provider registered");
    return this.#audio;
  }
  video(): VideoProvider {
    if (!this.#video) throw new Error("No video provider registered");
    return this.#video;
  }
}
