# Day 1: from zero to a talking GPU avatar

Owner checklist. One action per step, in order. Total cost for the day: a few dollars of GPU time. Technical detail lives in [`../gpu-server/README-gpu.md`](../gpu-server/README-gpu.md); this page is only the path.

## Phase A: prove the client locally (no GPU, no money)

1. Run `pnpm install` in the repo root (once).
2. Run `node gpu-server/dev-server.mjs`. It prints `ws://localhost:8789`.
   If it fails: ffmpeg must be on PATH (the dev streamer pipes `public/footage/reference.mp4` through it).
3. In a second terminal run `pnpm dev` and open `/stream.html`.
4. Click Connect (the server field already says `ws://localhost:8789`). You should see the reference footage playing and an fps counter.
   If not: check the first terminal for `[dev-server] client connected`; if absent, the page could not reach the socket.
5. Type something in the say box and Send. The status line should echo `server: {"ok":true,...}`. That is the command channel working end to end. The GPU path uses this exact client; only the URL changes.

## Phase B: rent the box

6. Create a RunPod account at runpod.io and add a payment method (minimum credit is fine; an RTX 4090 runs roughly $0.35 to $0.70/hr).
7. Deploy a pod from the PyTorch template with an RTX 4090.
8. In the pod's port settings, expose HTTP port 8788.
9. Open the pod's web terminal (or SSH in).

## Phase C: set up the server on the box

10. Clone this repo onto the pod and `cd` into `gpu-server/`.
11. Run the one-command bootstrap: `bash bootstrap.sh`.
    If bootstrap is not present on your checkout, the manual path is `pip install -r requirements.txt` plus copying `public/footage/reference.mp4` next to `server.py` for the CPU test generator.
12. License audit: read the bootstrap output. It prints every external repo and weight file it pulls. Confirm the list contains only Apache-2.0/MIT entries (Ditto, MuseTalk, Kokoro). If LivePortrait or InsightFace appears, stop; those are excluded for commercial use.
13. Pick the generator: `export GENERATOR=cpu` for the first smoke run, later `musetalk` or `ditto`.

## Phase D: gate before you stream

14. Run `python server.py --selftest`.It must exit clean.
    If it fails: the output names the failing stage (model load, weight file, CUDA). Fix that stage; do not proceed on a red selftest.
15. Start the server: `python server.py` (listens on `0.0.0.0:8788`, WebRTC offers at `POST /offer`).
16. Probe health from your laptop: `curl https://<pod-url>/health`.

## Phase E: connect and talk

17. On your laptop, open `/stream.html` (via `pnpm dev`), set the server field to `https://<pod-url>/offer`, click Connect. Any non-`ws://` URL makes the client negotiate WebRTC automatically.
    If the connect fails: confirm port 8788 is exposed (step 8) and the URL is the pod's public proxy URL, not the internal one.
18. Type a line in the say box and Send. The `{cmd:"speak", text}` command rides the WebRTC data channel; the box answers with generated talking-head frames and TTS audio (box-side Kokoro).
19. You now have the avatar talking in `stream.html`. For a show: add the page as an OBS Browser source like any other tier.

## Shutting down

20. Stop the pod when the show ends. The box only costs money while it runs; a 3 hour show is roughly $1 to $3 on RunPod.
