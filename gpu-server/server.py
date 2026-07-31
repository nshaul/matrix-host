"""
Matrix Host GPU streaming server (runs on the rented GPU box, not locally).

Architecture:
  browser  ── WebRTC offer (HTTP /offer) ──▶  this server
  browser  ◀── video track (generated frames) ── this server
  browser  ── data channel: {"cmd": "speak", "text": ...} ──▶ generator

The Generator interface is the seam: swap CPUTestGenerator for a real
model adapter (LivePortrait / MuseTalk) on the GPU box. The browser client
(stream.html) is transport-identical for every generator.

Run (GPU box):  pip install -r requirements.txt && python server.py
Docker:         see Dockerfile / README-gpu.md
"""

import asyncio
import fractions
import json
import time

import cv2
import numpy as np
from aiohttp import web
from aiortc import RTCPeerConnection, RTCSessionDescription, VideoStreamTrack
from av import VideoFrame

FPS = 24


class Generator:
    """One frame per call. Implementations own their model + state."""

    async def start(self) -> None: ...

    async def frame(self, t: float) -> np.ndarray:
        raise NotImplementedError

    async def command(self, message: dict) -> dict:
        return {"ok": False, "detail": "no command handling"}


class CPUTestGenerator(Generator):
    """Plumbing proof: pans over the reference footage. No GPU, no model."""

    def __init__(self, video_path: str = "reference.mp4") -> None:
        self.capture = cv2.VideoCapture(video_path)
        if not self.capture.isOpened():
            raise RuntimeError(f"cannot open {video_path}")

    async def frame(self, t: float) -> np.ndarray:
        ok, frame = self.capture.read()
        if not ok:
            self.capture.set(cv2.CAP_PROP_POS_FRAMES, 0)
            ok, frame = self.capture.read()
            if not ok:
                raise RuntimeError("reference footage unreadable")
        return frame

    async def command(self, message: dict) -> dict:
        return {"ok": True, "echo": message}


class LivePortraitGenerator(Generator):
    """
    GPU adapter slot: animate a portrait still with live audio-driven motion.
    Wire https://github.com/KwaiVGI/LivePortrait here: load the model in
    start(), retarget per-frame in frame(), route {"cmd":"speak"} audio in
    command(). Requires CUDA — intentionally unimplemented off-GPU.
    """

    async def start(self) -> None:
        raise NotImplementedError("LivePortrait adapter runs on the GPU box only")


class GeneratedTrack(VideoStreamTrack):
    def __init__(self, generator: Generator) -> None:
        super().__init__()
        self.generator = generator
        self.started = time.time()

    async def recv(self) -> VideoFrame:
        pts, time_base = await self.next_timestamp()
        frame_bgr = await self.generator.frame(time.time() - self.started)
        frame = VideoFrame.from_ndarray(frame_bgr, format="bgr24")
        frame.pts = pts
        frame.time_base = time_base
        return frame

    async def next_timestamp(self):
        if self.readyState != "live":
            raise RuntimeError("track ended")
        if not hasattr(self, "_ts"):
            self._ts = 0
        else:
            self._ts += int(90000 / FPS)
            await asyncio.sleep(max(0.0, self.started + self._ts / 90000 - time.time()))
        return self._ts, fractions.Fraction(1, 90000)


peers: set[RTCPeerConnection] = set()
generator = CPUTestGenerator()


async def offer(request: web.Request) -> web.Response:
    params = await request.json()
    peer = RTCPeerConnection()
    peers.add(peer)

    @peer.on("datachannel")
    def on_datachannel(channel):
        @channel.on("message")
        def on_message(message):
            async def handle():
                try:
                    reply = await generator.command(json.loads(message))
                except Exception as error:  # surface, never swallow
                    reply = {"ok": False, "detail": str(error)}
                channel.send(json.dumps(reply))

            asyncio.ensure_future(handle())

    @peer.on("connectionstatechange")
    async def on_state():
        if peer.connectionState in ("failed", "closed"):
            await peer.close()
            peers.discard(peer)

    peer.addTrack(GeneratedTrack(generator))
    await peer.setRemoteDescription(RTCSessionDescription(sdp=params["sdp"], type=params["type"]))
    answer = await peer.createAnswer()
    await peer.setLocalDescription(answer)
    return web.json_response(
        {"sdp": peer.localDescription.sdp, "type": peer.localDescription.type},
        headers={"Access-Control-Allow-Origin": "*"},
    )


async def on_shutdown(app: web.Application) -> None:
    await asyncio.gather(*(peer.close() for peer in peers))
    peers.clear()


app = web.Application()
app.router.add_post("/offer", offer)
app.router.add_options("/offer", lambda request: web.Response(headers={
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
}))
app.on_shutdown.append(on_shutdown)

if __name__ == "__main__":
    web.run_app(app, host="0.0.0.0", port=8788)
