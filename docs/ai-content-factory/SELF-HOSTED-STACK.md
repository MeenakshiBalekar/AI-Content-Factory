# Self-Hosted Inference Stack

> **Policy: the platform never depends on commercial AI APIs.** Every capability is served
> by open-source models on our own GPU infrastructure. Long-term objective: own 100% of the
> inference stack. Commercial endpoints can still be *plugged in* through the same open
> protocols (useful for one-off quality comparisons), but nothing requires them.

## Honest cost note

Self-hosting eliminates **per-call API fees**. It does not eliminate cost: open-source
models run on GPUs, and GPUs are hardware + electricity (owned or rented). The economics
change from *variable per-generation* to *fixed infrastructure* — which is exactly what you
want at volume, but "free unlimited" is not a thing anyone can truthfully promise. Plan
capacity per capability (text is cheap; video is the GPU hog).

## The stack per capability

| Capability | Adapter (built) | Protocol | Serving stack | Open-source models |
| --- | --- | --- | --- | --- |
| Text | `ChatCompletionsTextProvider` | `/v1/chat/completions` (open standard) | **vLLM** (prod, batching) or **Ollama** (dev) | Llama 3.1/3.3, Qwen 2.5, Mistral, DeepSeek |
| Image | `ImagesApiImageProvider` | `/v1/images/generations` | **LocalAI**, SD-WebUI bridges, ComfyUI + adapter | FLUX.1 schnell (Apache-2.0) / dev, SDXL, SD 3.5 |
| Speech | `SpeechApiAudioProvider` | `/v1/audio/speech` | **Kokoro-FastAPI**, **Speaches**, LocalAI | Kokoro-82M (Apache-2.0), Coqui XTTS-v2 (voice cloning), Piper |
| Video | `AsyncVideoProvider` | submit → poll (our render queue) | **Our queue in front of ComfyUI workers** | LTX-Video, Wan 2.1 (Apache-2.0), HunyuanVideo, CogVideoX |
| Music | `MusicGenerationProvider` *(interface — future integration)* | TBD | MusicGen server / Stable Audio Open | MusicGen (MIT weights), Stable Audio Open, YuE |
| Lip sync | `LipSyncProvider` *(interface — future integration)* | TBD | batch worker | Wav2Lip, LatentSync, SadTalker |
| Transcription | `TranscriptionProvider` *(interface — future integration)* | TBD | faster-whisper server | Whisper (MIT) |

**Future integrations are interfaces today, on purpose**: the open-source models exist, but
their serving protocols haven't settled. The interface is fixed in
`providers/future-providers.ts` so the orchestrator and workflows can already reference the
capability; the adapter lands when we choose the server. No commercial API will ever back
these interfaces.

## Configuration (all keyless by default)

```bash
# Text — point at your own vLLM (:8000) or Ollama (:11434)
export ACF_TEXT_BASE_URL=http://gpu-1:11434
export ACF_TEXT_MODEL=llama3.1:8b

# Image — LocalAI or an SD-WebUI-compatible bridge running FLUX
export ACF_IMAGE_BASE_URL=http://gpu-2:8080
export ACF_IMAGE_MODEL=flux.1-schnell

# Speech — Kokoro-FastAPI / Speaches
export ACF_SPEECH_BASE_URL=http://gpu-3:8880
export ACF_SPEECH_MODEL=kokoro

# Video — our render queue (ComfyUI workers behind a submit/poll service)
export ACF_VIDEO_SUBMIT_URL=http://render-queue:9000/jobs
export ACF_VIDEO_STATUS_URL=http://render-queue:9000/jobs/{id}
export ACF_VIDEO_MODEL=ltx-video

node src/cli.ts providers
#  text   → chat-completions [self-hosted]
#  image  → images-api [self-hosted]
#  audio  → speech-api [self-hosted]
#  video  → async-video [self-hosted]
```

`ACF_*_API_KEY` variables exist for when your own servers sit behind auth — they are about
*your* infrastructure, not a vendor. Commercial fallbacks (`OPENAI_API_KEY`,
`ELEVENLABS_API_KEY`) remain wired behind the same interfaces as legacy escape hatches and
are **never** chosen over a configured self-hosted endpoint.

## Character consistency on open models — an advantage

Owning inference makes the Module 1 identity guarantees *stronger*:

- Diffusion **seeds are honored exactly** (we control the sampler), so `identitySeed` gives
  true reproducibility that hosted APIs often can't promise.
- Per-character **LoRAs / textual-inversion embeddings** (consistency level L3) require
  model-weight access — impossible against closed APIs, natural on our own SDXL/FLUX.
- XTTS-v2 **voice cloning from reference audio** means a channel's voices are model-files
  we own, not vendor voice-ids that can be deprecated.

## GPU sizing (starting points, not gospel)

| Workload | Minimum sensible | Comfortable |
| --- | --- | --- |
| Text (Llama 3.1 8B, quantized) | 1× 12 GB (RTX 3060) | 1× 24 GB (RTX 4090 / L4) |
| Image (FLUX.1 schnell) | 1× 16 GB | 1× 24 GB |
| Speech (Kokoro-82M) | CPU-viable | any small GPU |
| Video (LTX-Video / Wan 2.1) | 1× 24 GB | 2–4× 24–48 GB (the real budget item) |

One 24 GB consumer GPU can run text + image + speech for a single channel's daily episode.
Video is the capacity planning problem; batch overnight renders before buying more GPUs.
