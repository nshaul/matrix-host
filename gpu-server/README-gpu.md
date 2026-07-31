# GPU streaming pipeline

Real generated frames, streamed to the browser. The browser is a viewport +
command channel; the GPU box renders. Same architecture as the commercial
interactive-avatar products.

```
[browser stream.html] ◀── video (WebRTC / WS) ── [GPU box: server.py + model]
                      ── {"cmd":"speak",…} ──▶
```

## Proven locally (no GPU needed)

```bash
node gpu-server/dev-server.mjs     # ffmpeg → MJPEG over ws://localhost:8789
pnpm dev                           # open /stream.html → Connect
```

Verified: 30 fps into the canvas, command round-trip on the same socket.
This is the exact client the GPU path uses — only the URL changes.

## Renting the GPU (owner step)

- **RunPod** (recommended, cheapest): deploy a pod from the PyTorch template,
  RTX 4090 (~$0.35–0.70/hr) for the talking-portrait tier. Expose port 8788.
- **AWS**: g6.xlarge (L4, ~$0.80/hr on-demand) with the Deep Learning AMI.
- The box only runs while streaming — a 3-hour show ≈ $1–3 on RunPod.

On the box:

```bash
git clone https://github.com/nshaul/matrix-host && cd matrix-host/gpu-server
cp ../public/footage/reference.mp4 .
pip install -r requirements.txt
python server.py                   # POST /offer on :8788
```

Then in `stream.html`, set the server field to `https://<pod-url>/offer` —
the client switches to WebRTC automatically for non-`ws://` URLs.

## Quality tiers (what the GPU actually buys)

| Tier | Model class | Quality | GPU | Notes |
| --- | --- | --- | --- | --- |
| Talking portrait | LivePortrait / MuseTalk | = your source art: cinematic, cartoon, or anime — the model animates, it doesn't invent | RTX 4090 / L4 | face, mouth, eyes, head at ~30fps; the first adapter to wire |
| Diffusion over rig | StreamDiffusion + ControlNet | full-body gestures re-painted photoreal/anime; some shimmer | 4090 / A100 | drives from the 3D VRM engine's output |
| Continuous video gen | CausVid-class autoregressive | true on-the-fly generation, 480–720p | H100 | frontier; identity drift over long runs |

The style axis (cinematic / cartoon / anime — all modern-grade, never 1998) is
carried by the SOURCE ART you feed the animator, one reference pack per host.

## Wiring a real model

`server.py`'s `Generator` interface is the seam: implement `frame()` (and
`command()` for speak) in a `LivePortraitGenerator` and pass it to
`GeneratedTrack`. The CPU test generator proves the transport meanwhile.
