# Matrix Host

A browser-native, real-time **Matrix-hologram digital host**: a rigged 3D avatar rendered
as a living green hologram — glyph code flowing across the skin, electric filament
veins, white-hot fresnel contours, depth-layered code rain and a city skyline —
running at 60 fps in a plain browser tab. Built to be a livestream host / digital
avatar / talking AI presence.

![wave](docs/wave.gif)

## What it does

- **Swappable subject** — ships with two rigged VRM avatars (girl: Alicia Solid,
  boy: VRoid sample). Drop ANY `.vrm` on the page (make your own for free in
  [VRoid Studio](https://vroid.com/en/studio) — girl, boy, or anything else) or a
  `.glb` mesh (logo mode: same hologram treatment, no rig).
- **It talks** — `host.speak(audioUrl | Blob | MediaStream)` runs any audio through
  a WebAudio analyser and drives the avatar's viseme morphs (a/i/u/e/o) in real
  time. Wire ElevenLabs by passing its audio straight in (see below). Mic input
  and a no-API-key procedural demo voice are built in.
- **It moves** — procedural gestures on the full humanoid rig: breathing, weight
  sway, blink clock, commanded head look (`setHeadLook(yaw, pitch)`) and a full
  **hand wave with per-finger ripple** (`wave()`). Alicia's twin-tails ride VRM
  spring bones, so hair follows every head turn.
- **Transparent mode** — one toggle removes the scene and renders the avatar over
  **true alpha** for OBS/streaming overlays (browser source → this page →
  transparent background on your Whatnot stream).
- **Record** — `host.record(seconds)` captures the canvas to a webm blob (the demo
  panel has a Record button that downloads it).

## Run

```bash
pnpm install
pnpm dev
```

## Drive it from code

The demo page exposes the engine as `window.matrixHost`:

```js
matrixHost.setHeadLook(30, -5)   // degrees yaw/pitch
matrixHost.wave()                // hand + finger wave
matrixHost.setBackground('transparent')  // OBS overlay mode
await matrixHost.speak('https://…/tts-audio.mp3')  // any audio URL
const webm = await matrixHost.record(8)  // Blob
```

### ElevenLabs

Fetch TTS server-side (keep the key off the client), hand the audio to the host:

```js
const response = await fetch('/api/tts?text=hello')   // your proxy → ElevenLabs
const blob = await response.blob()
await matrixHost.speak(blob)                          // mouth syncs automatically
```

## The look (src/engine/)

| File | What it owns |
| --- | --- |
| `hologramMaterial.ts` | ShaderMaterial on three's skinning/morph chunks: green luminance ramp, sculpting key light, fresnel rim, screen-space glyph columns, UV-space electro veins, backface interior glow. MToon outline passes are disabled (additively they double the surface). |
| `rain.ts` | Depth-layered glyph-rain planes (far dim / mid / front soft-bright), procedural skyline, ambient glow. |
| `glyphTexture.ts` | Shared katakana/symbol atlas + skyline canvas textures. |
| `gestures.ts` | Procedural rig animation: rest pose, breathing, head look, wave with finger ripple, blink. |
| `lipsync.ts` | Audio → smoothed viseme weights (RMS energy + spectral centroid heuristic). |
| `HologramHost.ts` | Scene, bloom composer, subject loading/swapping, orbit, record, the public API. |

Per-model calibration lives in `applyHologramToAvatar` (dark hair gets a luma lift,
eye whites get damped). Different VRMs may want different gains — they're one
constant each.

## Model credits

- `public/avatars/alicia.vrm` — **Alicia Solid** © DWANGO Co., Ltd., the official
  niconico 3D sample character (from the [vrm-c/UniVRM](https://github.com/vrm-c/UniVRM)
  test models). Check the model's own license terms before commercial use.
- `public/avatars/girl.vrm`, `public/avatars/boy.vrm` — VRoid Studio sample exports
  from [madjin/vrm-samples](https://github.com/madjin/vrm-samples).
- For production, generate your own avatar in VRoid Studio (free) and drop it in —
  then the subject is 100% yours.

## Stack

Three.js + @pixiv/three-vrm + Vite + TypeScript. No server, no API keys, no paid
anything. WebGL runs on any modern browser; the whole scene is one canvas.
