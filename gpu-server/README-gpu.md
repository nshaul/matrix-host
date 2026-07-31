# GPU streaming server — runbook

Real generated avatar frames + voice, streamed to the browser over WebRTC.
The browser is a viewport + command channel; the GPU box renders everything.

```
[browser stream.html] <-- video track (generated frames) --- [GPU box: server.py]
                      <-- audio track (Kokoro TTS 48 kHz) --
                      --- POST /offer {sdp,type} ----------->
                      --- data channel 'commands' ---------->   {"cmd":"speak",...}
```

Day-1 on a rented box is exactly three commands:

```bash
git clone https://github.com/nshaul/matrix-host && cd matrix-host/gpu-server
GENERATOR=musetalk bash bootstrap.sh        # idempotent; ends with the selftest
source .venv/bin/activate && GENERATOR=musetalk python server.py
```

## Licenses (verified 2026-07-31 — free AND commercial-safe only)

| Component | Source | License | Commercial |
| --- | --- | --- | --- |
| MuseTalk | github.com/TMElyralab/MuseTalk + HF `TMElyralab/MuseTalk` | MIT code; v1.5 weights explicitly usable commercially | yes |
| Ditto | github.com/antgroup/ditto-talkinghead + HF `digital-human/ditto-talkinghead` | Apache-2.0 | yes |
| Kokoro TTS | hexgrad/Kokoro-82M (pip `kokoro`) | Apache-2.0 | yes |
| LivePortrait | — | MIT code but depends on InsightFace models (NON-commercial) | **excluded** |

LivePortrait's adapter was removed from `server.py` for that reason — do not
re-add it without replacing the InsightFace dependency.

## Quality tiers

| `GENERATOR` | What it is | Output | GPU | Use |
| --- | --- | --- | --- | --- |
| `cpu` | Transport test: loops the source footage; TTS audio is REAL | 24 fps + 48 kHz audio | none | prove E2E on any box first |
| `musetalk` | Talking portrait: whisper features drive mouth inpainting on your art | 25 fps | RTX 4090 / L4 | the workhorse tier |
| `ditto` | Real-time diffusion talking head | 25 fps, higher quality ceiling | RTX 4090+ | when portrait inpainting isn't enough |

**Source-art law:** the model animates YOUR art. Cinematic, cartoon, or anime
tiers come from the reference pack you feed `SOURCE` — the model moves the
face; it never invents the style. One reference pack per host persona.

## Cost

| Box | Rate | 3-hour show |
| --- | --- | --- |
| RunPod RTX 4090 | $0.35–0.70/hr | ≈ $1–3 |
| AWS g6.xlarge (L4) | ≈ $0.80/hr on-demand | ≈ $2.40 |

The box only needs to run while streaming.

## RunPod steps (exact)

1. Deploy a pod from the **PyTorch** template (torch + CUDA preinstalled;
   `bootstrap.sh` detects it and skips the torch download), RTX 4090.
2. In the pod's port settings, **expose HTTP port 8788** (this is the
   signalling + health port).
3. Open the pod's web terminal and run the three day-1 commands above with the
   env you want (see reference below).
4. Point `stream.html`'s server field at `https://<pod-id>-8788.proxy.runpod.net/offer`.

AWS instead: g6.xlarge with the Deep Learning AMI, security group open on
8788/tcp (plus UDP — see ICE below), same three commands.

## Environment reference

| Var | Default | Meaning |
| --- | --- | --- |
| `GENERATOR` | `cpu` | `cpu` \| `musetalk` \| `ditto` |
| `SOURCE` | `reference.mp4` | source art: image or short video (bootstrap copies `../public/footage/reference.mp4`) |
| `PORT` | `8788` | HTTP signalling port |
| `TTS_VOICE` | `af_heart` | Kokoro voice id (first letter picks the language pack) |
| `STREAM_TOKEN` | unset | Shared secret for `/offer`. When set, the client must use `https://pod/offer#<token>`; bad or missing token gets 401. Unset = open (dev only). |
| `FPS` | 24 cpu / 25 models | output frame rate |
| `MUSETALK_DIR` | `./MuseTalk` | MuseTalk checkout (bootstrap clones it) |
| `DITTO_DIR` | `./ditto-talkinghead` | Ditto checkout (bootstrap clones it) |
| `DITTO_CFG_PKL` | `<DITTO_DIR>/checkpoints/ditto_cfg/v0.4_hubert_cfg_pytorch.pkl` | swap for the TRT cfg if you install TensorRT |
| `DITTO_DATA_ROOT` | `<DITTO_DIR>/checkpoints/ditto_pytorch` | ditto weights dir |
| `CACHE_DIR` | `./cache` | avatar preprocessing cache (restarts are fast because of it) |
| bootstrap only: `SKIP_VENV`, `SKIP_SELFTEST`, `HF_TOKEN` | — | Docker builds / private HF mirrors |

## Selftest — interpretation

```bash
GENERATOR=musetalk python server.py --selftest
```

Prints one `[PASS]`/`[FAIL]`/`[SKIP]` line per check, with a `fix:` hint on
every failure, and exits nonzero if anything failed. Checks: python >= 3.10,
ffmpeg, espeak-ng (advisory), transport imports, torch + CUDA (**skipped for
`cpu`** — the cpu tier must pass on a GPU-less box), source art readable, model
weights present at their expected paths, Kokoro synthesizes a sentence
(duration + samples reported; **SKIP** on the cpu tier when kokoro isn't
installed), the audio resample path produces 48 kHz s16 stereo, and one frame
generated end-to-end through the chosen generator (for model tiers this loads
the full stack — it IS the readiness proof).

`bootstrap.sh` ends by running it; `Dockerfile.gpu` containers run it at start
and refuse to serve if it fails.

## Command protocol (data channel `commands`)

| Send | Reply |
| --- | --- |
| `{"cmd":"speak","text":"..."}` | `{"ok":true,"spoke":{"engine":"kokoro","seconds":…,"samples":…,"text":…}}` |
| `{"cmd":"speak","audioB64":"...","mime":"audio/mpeg"}` | same with `"engine":"client-audio"` (e.g. ElevenLabs bytes) |
| `{"cmd":"stop"}` | `{"ok":true,"stopped":true}` — flushes queued speech + audio |
| `{"cmd":"status"}` | `{"ok":true,"generator":…,"model_ready":…,"uptime_s":…,"gpu":…}` |
| anything else | `{"ok":false,"error":…}` — errors are always structured, never a dropped socket |

`GET /health` returns `{ok, generator, model_ready, load_error, uptime_s, peers}`.

## Local dev (no GPU, no Python)

```bash
node gpu-server/dev-server.mjs     # ffmpeg -> MJPEG over ws://localhost:8789
pnpm dev                           # open /stream.html -> Connect
```

Same client, same command shapes (the dev streamer mirrors the reply format).
For non-`ws://` URLs the client switches to WebRTC automatically.

## Troubleshooting

- **CORS**: `/offer` and `/health` send `Access-Control-Allow-Origin: *` and
  answer preflight OPTIONS. If the browser reports CORS, you are usually
  looking at a proxy error page (pod down / wrong port), not this server.
- **ICE / firewall**: aiortc needs **UDP** for media, or a TURN relay. RunPod's
  HTTP proxy covers only the signalling POST — the media flows peer-to-peer
  over the pod's public UDP. If the pod has no public UDP (or the viewer's
  network blocks it), connection sticks at `checking`: run a TURN server or
  choose a pod/region with direct networking. AWS: open UDP in the security
  group (ephemeral range) alongside 8788/tcp.
- **RunPod TCP proxy caveat**: `https://<pod>-8788.proxy.runpod.net` terminates
  TLS for HTTP only. It is not a media path — a connected `/offer` with no video
  almost always means UDP never got through (see ICE above).
- **`/offer` answers 503**: the model is still loading (watch `/health` for
  `model_ready:true`) or failed to load (`load_error` says exactly why).
- **Speak replies `Kokoro TTS is not installed`**: `pip install kokoro soundfile`
  and `apt-get install -y espeak-ng`; the stream itself keeps running, and
  `audioB64` speak works regardless.
- **First `speak` after boot is slow**: Kokoro lazy-loads on first use;
  MuseTalk's avatar preprocessing runs once per SOURCE then caches under
  `CACHE_DIR`.

## Wiring a real model (the seam)

`server.py`'s `Generator` class is the whole contract: `start()` loads,
`frame(t)` yields BGR frames at `fps`, `speak(audio, rate, bus)` drives the
mouth AND pushes the same audio to the playout bus so lips and voice leave
together. `CPUTestGenerator`, `MuseTalkGenerator`, and `DittoGenerator` are the
three shipped implementations; the browser client is transport-identical for
all of them.
