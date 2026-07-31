# Matrix Host vs HeyGen Interactive Avatar

Honest feature matrix. "Matrix Host" below means the whole system: the 3D tier and Living Footage tier (free, in-browser) plus the rented-GPU stream tier. HeyGen column reflects their Interactive Avatar product as of mid 2026; no invented numbers, their pricing and quality move.

| Capability | Matrix Host | HeyGen Interactive Avatar |
| --- | --- | --- |
| Runs in your own browser page | Yes, all three tiers are pages you host (`index.html`, `footage.html`, `stream.html`) | Embedded via their SDK/iframe; rendering happens on their cloud |
| Your own identity and art | Yes, fully. Any VRM you make (VRoid Studio), any footage you generate, any portrait you feed the GPU models. You keep the files | Your likeness trained on their platform; the trained avatar lives in their account system |
| Cartoon, anime, and cinematic styles | Yes. Style is carried by your source art; the animators (footage engine, MuseTalk/Ditto) animate your pixels in whatever style they are | Primarily photoreal-human focus; stylized options exist but the pipeline is built around realistic presenters |
| Own voice, free tier | Yes: system voice free and offline; Kokoro-82M neural TTS free, local, Apache-2.0 <!-- verify-at-integration: voice system lands this wave --> | Voice cloning exists but is a paid platform feature |
| ElevenLabs support | Yes, two ways: your key in the voice panel <!-- verify-at-integration --> or any server proxy handing audio to `speak()` (works today) | Yes, ElevenLabs integration is supported on their platform |
| Spoken command control ("wave", "look left") | Yes, VoiceCommands via the Web Speech API <!-- verify-at-integration --> | No spoken operator control; interaction is chat/LLM-driven conversation |
| OBS transparency (true alpha overlay) | Yes, both browser tiers render true alpha for browser-source overlay | Not a first-class output; their product targets embedded video sessions, not overlay compositing |
| Latency | 3D tier: local render, no network round trip. Footage tier: local. GPU tier: model inference plus WebRTC transit, depends on model and region | Network round trip to their cloud plus inference; generally tuned well, but you cannot host it closer than they do |
| Per-hour cost while live | 3D and footage tiers: $0. GPU tier: the rental, roughly $0.35 to $0.80/hr (RunPod 4090 or AWS L4), so about $1 to $3 per 3 hour show | Subscription plus metered interactive-session credits; per-minute pricing set by them and subject to change |
| Script / API control surface | Full: `window.matrixHost` and `window.footageHost` are plain JS objects, plus the `{cmd:...}` data channel to the GPU box. Nothing is off-limits | API and SDK exist and are decent, but bounded by what their platform exposes |
| Offline capable | Yes, the 3D tier (and system voice) run with no network at all | No, cloud service |
| Photoreal ceiling | Bounded by your source art and current open models. Talking-head (MuseTalk/Ditto) is strong for portrait framing; real-time photoreal full body is frontier and not shipped | Higher today for turnkey photoreal presenters; this is their core product and they train per-identity models for it |

## Where HeyGen wins today

- Turnkey photoreal identity training: upload footage, get a polished photoreal presenter with no ops work.
- Zero ops: no GPU rental, no server, no selftest gate, nothing to keep alive.
- Consistent conversational latency tuning at their scale.

## Where Matrix Host wins

- Cost: $0 for two tiers, single-digit dollars per show for the third.
- Ownership: your art files, your footage, your keys, your pages. Nothing lives in a vendor account.
- Control surface: every gesture, emotion, camera, viseme, and background is scriptable from the page; spoken commands on top.
- Styles: anime and cartoon are first-class because the system animates whatever art you feed it.
- No vendor lock: every model in the chain is Apache-2.0 or MIT, every seam (Generator interface, `/offer`, `{cmd:...}`) is yours.
