# Architecture

Three tiers, one philosophy: the browser page is the product surface, every renderer behind it is swappable, and every seam is a small explicit contract.

```
TIER 1: 3D HOLOGRAM (local, free, 60fps)
  index.html
    └─ src/main.ts ── window.matrixHost
         └─ HologramHost (src/engine/HologramHost.ts)
              ├─ hologramMaterial.ts   shader on skinning/morph chunks
              ├─ rain.ts + glyphTexture.ts   scene layers
              ├─ gestures.ts           GestureController: wave/point/scold/yell,
              │                        head look, emotions, blink
              └─ lipsync.ts            LipSync: audio -> viseme weights

TIER 2: LIVING FOOTAGE (local, free, quality = the footage)
  footage.html
    └─ src/footage.ts ── window.footageHost ── SEGMENTS map (per-footage calibration)
         └─ FootageHost (src/engine/FootageHost.ts)
              one WebGL pass over a <video>: segment state machine,
              double-buffered idle crossfade, keyframed facial anchor tracks,
              per-viseme mouth warp, blink warp, luma key, glyph/rain/grade overlay

TIER 3: GPU STREAM (rented box, photoreal frames)
  stream.html
    └─ src/stream.ts   one client, two transports
         ├─ ws://…      dev: MJPEG over WebSocket (gpu-server/dev-server.mjs, :8789)
         └─ http(s)://…/offer   prod: WebRTC (gpu-server/server.py on the GPU box, :8788)
                                   └─ Generator seam ── cpu | musetalk | ditto
```

## Data flow: speech in the browser tiers

```
audio source (URL | Blob | MediaStream)
    └─ host.speak(source)
         └─ LipSync (WebAudio analyser: RMS energy + spectral centroid)
              └─ viseme weights {aa, ih, ou, ee, oh} per frame
                   └─ VRM expressionManager (tier 1) / mouth-warp shader (tier 2)
```

Two override paths on the same rail:

- `setVisemes(weights | null)` bypasses the analyser. This exists because system-voice TTS (`speechSynthesis`) produces no analysable audio stream; its driver feeds mouth weights directly. `null` returns control to the analyser.
- Gestures can demand the mouth too (yell); the loudest source wins per frame.

The voice system (`src/voice.ts`, `window.hostVoice`) sits in front of this rail: system voice drives `setVisemes`, Kokoro and ElevenLabs produce audio that goes through `speak()`. <!-- verify-at-integration: voice.ts lands this wave -->

## Data flow: GPU stream

```
browser (stream.html)                         GPU box (server.py)
  POST /offer {sdp, type}  ───────────────▶   aiohttp: RTCPeerConnection per client
  ◀───────────────  answer {sdp, type}
  ◀═══ video track: GeneratedTrack paced at FPS=24, one Generator.frame(t) per frame
  ◀═══ audio track: box-side Kokoro TTS      <!-- verify-at-integration: audio track lands this wave -->
  data channel "commands":
  {"cmd":"speak","text":…}  ──────────────▶   Generator.command(message)
  ◀──────────────  {"ok":true|false, …}       (errors surfaced in the reply, never swallowed)
```

The dev transport is the same client with a `ws://` URL: `dev-server.mjs` pipes `reference.mp4` through ffmpeg as MJPEG frames over WebSocket and echoes commands with `{ok:true}`. It proves the full browser side (canvas rendering, fps accounting, command round trip) on any machine with no GPU and no Python.

## The seam contracts

Three contracts carry the whole system. Keep them small; everything else may churn.

1. **`Generator`** (`gpu-server/server.py`): `start()`, `frame(t) -> ndarray`, `command(message: dict) -> dict`. One frame per call; implementations own their model and state. `CPUTestGenerator` proves the transport; real adapters (MuseTalk, Ditto) implement the same three methods. Selected via `GENERATOR=cpu|musetalk|ditto`. <!-- verify-at-integration: env switch lands this wave -->
2. **`/offer`**: plain HTTP POST of `{sdp, type}`, answered with `{sdp, type}`. Standard WebRTC offer/answer, CORS-open, no auth layer yet (the box is ephemeral and the URL unlisted; treat that as a known gap, not a feature).
3. **`{cmd: ...}` protocol**: JSON messages on the data channel (prod) or the WebSocket (dev). Today: `{"cmd":"speak","text":…}`. Replies are always `{ok: boolean, ...}` with error detail in the reply body. The browser side is `Connection.send(message)` in `src/stream.ts`, identical for both transports.

Inside the browser tiers the equivalent seam is the host object itself: `window.matrixHost` and `window.footageHost` are the complete public API, and the demo panels are just buttons wired to them.

## The source-art law

The animators in this system animate YOUR art. They do not invent quality, style, or identity:

- Tier 1's ceiling is the VRM you load. A better-sculpted avatar renders a better hologram; the shader is identical.
- Tier 2's ceiling is the footage's own pixels. The engine directs, warps, and overlays; it never generates. The committed `public/footage/reference.mp4` is a dev-only calibration asset; production means owner-generated clips (same character, one clip per motion), remapped in `SEGMENTS` in `src/footage.ts`.
- Tier 3's talking-head models animate the portrait or reference pack you feed them. Cinematic, cartoon, or anime comes from that reference pack, not from a style flag.

Corollary: upgrading the look of any tier is an art task first and a code task second, and a character moves between tiers by carrying its reference pack with it.
