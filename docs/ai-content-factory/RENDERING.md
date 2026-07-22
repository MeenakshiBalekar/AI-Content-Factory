# Local Render Pipeline — producing a real MP4

This turns an episode's assets into an actual, playable `.mp4` on disk using **local FFmpeg
only — zero API calls, zero paid services.** It is honest about what is real: the container,
the encoding, the pan/zoom, transitions, subtitle burn-in, and audio mix are all genuinely
produced. The *visual/voice content* is either real local-AI output (if you run those
servers) or clearly-labelled procedural placeholders (if you don't) — never faked.

## TL;DR — get a video in 3 commands

```bash
# 0. one-time: install ffmpeg (see below) and the repo
cd packages/core

# 1. seed the sample channel and create episode 4 (offline, free)
node src/cli.ts seed --dir .acf-memory
node src/cli.ts create tiny-explorers --dir .acf-memory --number 4 --local

# 2. render a real MP4
node src/cli.ts render tiny-explorers 4 --dir .acf-memory --renders .acf-renders
```

Output path printed by the command, e.g.:

```
.acf-renders/tiny-explorers-ep4/episode.mp4      # H.264 + AAC, 1280x720, ~10s, plays anywhere
```

Play it: `open .acf-renders/tiny-explorers-ep4/episode.mp4` (macOS) / `xdg-open ...` (Linux)
/ double-click it (Windows).

## Or through the API (preview in a browser)

```bash
node src/cli.ts serve --port 8787 --sqlite acf.db          # start the API
# (seed + create once against the same --sqlite store)
curl -X POST http://127.0.0.1:8787/v1/channels/tiny-explorers/episodes/4/render
# then open the download URL in a browser to watch it:
#   http://127.0.0.1:8787/v1/channels/tiny-explorers/episodes/4/render/download
```

- `POST .../episodes/{n}/render` → renders, returns the result JSON (path, size, duration,
  streams, sources) + a `download` URL.
- `GET  .../episodes/{n}/render` → the render status/result (404 if not rendered yet).
- `GET  .../episodes/{n}/render/download` → streams the MP4 as `video/mp4` (plays inline).

## Installing FFmpeg (required)

```bash
# Debian/Ubuntu
sudo apt-get update && sudo apt-get install -y ffmpeg
# macOS
brew install ffmpeg
# Windows: https://www.gyan.dev/ffmpeg/builds/  (add to PATH)
```

If FFmpeg is missing, the render fails with a clear install message (CLI error / API `503`).
Override the binary locations with `ACF_FFMPEG_BIN` / `ACF_FFPROBE_BIN` if needed.

## What is genuinely implemented vs. what needs a local AI model

| Piece | Status |
| --- | --- |
| FFmpeg assembly → real playable H.264/AAC MP4 | ✅ **real, working now** |
| Ken Burns pan/zoom, xfade transitions, burned-in subtitles, voice+music mix | ✅ **real** |
| ffprobe validation (must have video + audio stream, non-empty) | ✅ **real** |
| CLI `render`, API render + download routes | ✅ **real** |
| **Scene images** | ✅ real files. **AI art requires** a local image server (below); otherwise real **procedural placeholder cards** (scene text on a brand-color background). |
| **Voice** | ✅ real audio. **Real speech requires** a local TTS server; otherwise real **silent tracks** sized to each line. |
| **Music** | Off by default. Uses `ACF_MUSIC_FILE` if you provide one; or set `ACF_MUSIC_TONE=1` for a real procedural tone bed. |

The render result always reports its sources (`imageSource`, `audioSource`, `musicSource`)
so you can see exactly what was AI-generated vs procedural — the platform never claims
placeholder content is AI output.

## Getting REAL AI frames + voice (still 100% local, still free of API fees)

Point the pipeline at self-hosted, open-source inference servers on your own GPU:

```bash
# Real images — a server exposing the OpenAI images API (LocalAI / SD-WebUI openai ext /
# a ComfyUI bridge) running FLUX.1 or SDXL:
export ACF_IMAGE_BASE_URL=http://127.0.0.1:8188
export ACF_IMAGE_MODEL=flux.1-schnell

# Real voice — a server exposing /v1/audio/speech (Kokoro-FastAPI / Speaches / LocalAI XTTS):
export ACF_AUDIO_BASE_URL=http://127.0.0.1:8000
export ACF_SPEECH_MODEL=kokoro

# Optional real music track you own:
export ACF_MUSIC_FILE=/path/to/bed.mp3

node src/cli.ts render tiny-explorers 4 --dir .acf-memory --renders .acf-renders
# now imageSource=ai-local, audioSource=ai-local in the result
```

If a base URL is set but the server is unreachable, the render **fails honestly** with
`LocalBackendUnavailableError` — it does not silently fall back to placeholders. (Unset the
URL to intentionally use placeholders.)

See [`SELF-HOSTED-STACK.md`](./SELF-HOSTED-STACK.md) for the model/server options and GPU
sizing. Note: those AI models cost GPU time + electricity — self-hosting removes per-call API
fees, not the cost of running the hardware.

### Draw Things on Apple Silicon (Mac) — the txt2img protocol

Draw Things (free Mac App Store app) runs Stable Diffusion on Metal and is the easiest real
image backend on an Apple Silicon Mac, especially with limited unified memory. Its HTTP API
speaks the **AUTOMATIC1111 `/sdapi/v1/txt2img`** protocol (not OpenAI images), so select it
with `ACF_IMAGE_API=automatic1111`.

1. Draw Things → **Settings → Advanced → API Server**: set **Protocol: HTTP**, **Port: 7860**,
   toggle **Server Online**. Load a model in the app (e.g. Stable Diffusion 1.5).
2. Point the platform at it:

```bash
export ACF_IMAGE_BASE_URL=http://127.0.0.1:7860
export ACF_IMAGE_API=automatic1111       # use the txt2img protocol (Draw Things / A1111 / SD.Next)
export ACF_IMAGE_STEPS=24                 # optional; SD 1.5 sampling steps
export ACF_IMAGE_MAX_EDGE=768             # optional; longest side, keep ~512–768 on 8 GB Macs

node src/cli.ts render tiny-explorers 5 --dir .acf-memory --renders .acf-renders
```

The model is whatever you loaded **in the Draw Things app** — the platform does not send a
checkpoint override. Sizes are auto-mapped to SD-friendly, /64 dimensions (16:9 → 768×448,
1:1 → 512×512) so generation stays fast and memory-safe. `ACF_IMAGE_NEGATIVE` overrides the
default negative prompt. The same adapter works with real AUTOMATIC1111, SD.Next, and Forge.

## Environment variables (summary)

| Var | Purpose | Default |
| --- | --- | --- |
| `ACF_IMAGE_BASE_URL` | Local image server. Unset → procedural cards. | (unset) |
| `ACF_IMAGE_API` | `openai` (`/v1/images/generations`) or `automatic1111` (`/sdapi/v1/txt2img`, Draw Things) | `openai` |
| `ACF_IMAGE_MODEL` | Image model name (ignored by Draw Things — set it in the app) | `flux.1-schnell` |
| `ACF_IMAGE_STEPS` | Sampling steps (automatic1111 path) | `24` |
| `ACF_IMAGE_MAX_EDGE` | Longest image side, /64 (automatic1111 path) | `768` |
| `ACF_IMAGE_NEGATIVE` | Negative prompt (automatic1111 path) | a sensible default |
| `ACF_AUDIO_BASE_URL` | Local TTS server (`/v1/audio/speech`). Unset → silent tracks. | (unset) |
| `ACF_SPEECH_MODEL` | TTS model/voice engine | `kokoro` |
| `ACF_MUSIC_FILE` | Path to a real music bed to mix in | (unset) |
| `ACF_MUSIC_TONE` | `1` → generate a procedural tone bed | (unset) |
| `ACF_FONT_FILE` | Font file for on-screen text + subtitles (see Windows note) | per-OS system font |
| `ACF_FFMPEG_BIN` / `ACF_FFPROBE_BIN` | Override FFmpeg binaries | `ffmpeg` / `ffprobe` |

## Real motion — image→video via a cloud model (Replicate)

By default the renderer animates stills (Ken Burns). To get **real per-shot motion** — the
character actually moving — wire a cloud image→video model. Each shot's keyframe (generated
locally for character consistency) is sent to the model with the shot's action as the motion
prompt; the returned clips are concatenated, a song is muxed, and subtitles burned in.

```bash
export ACF_VIDEO_PROVIDER=replicate
export REPLICATE_API_TOKEN=r8_your_token          # replicate.com -> API tokens
export ACF_VIDEO_MODEL=kwaivgi/kling-v1.6-standard # any image→video model on Replicate
export ACF_VIDEO_IMAGE_FIELD=start_image          # the model's start-image input field
export ACF_SONG_FILE=/path/to/song.mp3            # optional: master soundtrack

node src/cli.ts render <channelId> 1 --dir .acf-memory --renders .acf-renders
# render result reports motionSource: "video-model"
```

> ⚠️ **This is a paid cloud call** (~$0.10–0.50 per second of output). Nothing selects it
> unless `ACF_VIDEO_PROVIDER=replicate` + token + model are set; otherwise the render stays
> fully local (animated stills, `motionSource: "still"`). `ACF_VIDEO_EXTRA_INPUT` (JSON)
> passes model-specific params, e.g. `{"cfg_scale":0.5,"duration":5}`.

## Windows note — Fontconfig ("Cannot load default config file")

Stock Windows FFmpeg builds ship no default `fonts.conf`, so FFmpeg's `drawtext` and the
`subtitles` (libass) filter used to abort with `Fontconfig error: Cannot load default config
file` and exit code `3221225477`. The renderer now avoids that entirely and portably:

- `drawtext` is always given an explicit `fontfile=`, so it never touches Fontconfig.
- For the `subtitles` filter (libass always inits Fontconfig), the renderer generates a
  minimal, valid `fonts.conf` in the render workdir and sets `FONTCONFIG_FILE`/`FONTCONFIG_PATH`
  for the FFmpeg process, plus passes the font directory as `fontsdir`.

The font is taken from `ACF_FONT_FILE` if set, otherwise a per-OS system font (Segoe UI /
Arial on Windows, DejaVu / Liberation on Linux, Arial / Helvetica on macOS). No path is
hardcoded. On Windows you can be explicit:

```powershell
$env:ACF_FONT_FILE="C:\Windows\Fonts\segoeui.ttf"
node src/cli.ts render tiny-explorers 4 --dir .acf-memory --renders .acf-renders
```

If `ACF_FONT_FILE` is set but the file does not exist, the render fails fast with a clear
`FontNotFoundError` rather than crashing inside FFmpeg.
