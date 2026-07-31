"""
Matrix Host GPU streaming server (runs on the rented GPU box, not locally).

Architecture:
  browser  -- WebRTC offer (HTTP POST /offer) -------------> this server
  browser  <-- video track (generated frames) -------------- this server
  browser  <-- audio track (TTS / client audio, 48 kHz) ---- this server
  browser  -- data channel 'commands': {"cmd": ...} -------> CommandRouter

Day-1 on a fresh box:
  git clone https://github.com/nshaul/matrix-host && cd matrix-host/gpu-server
  GENERATOR=musetalk bash bootstrap.sh      # idempotent; ends with the selftest
  GENERATOR=musetalk python server.py       # POST /offer on :8788

Environment (all optional):
  GENERATOR        cpu | musetalk | ditto        (default cpu)
  SOURCE           source art: image or short video (default reference.mp4)
  PORT             HTTP/WebRTC signalling port   (default 8788)
  TTS_VOICE        Kokoro voice id               (default af_heart)
  FPS              output frame rate             (default 24 cpu, 25 musetalk/ditto)
  MUSETALK_DIR     MuseTalk checkout             (default ./MuseTalk)
  DITTO_DIR        ditto-talkinghead checkout    (default ./ditto-talkinghead)
  DITTO_CFG_PKL    override the ditto cfg pickle (default <DITTO_DIR>/checkpoints/ditto_cfg/v0.4_hubert_cfg_pytorch.pkl)
  DITTO_DATA_ROOT  override the ditto weights dir (default <DITTO_DIR>/checkpoints/ditto_pytorch)
  CACHE_DIR        preprocessing cache root      (default ./cache)

Model licenses (why these adapters and no others):
  MuseTalk  https://github.com/TMElyralab/MuseTalk        MIT code; v1.5 weights
            (HF TMElyralab/MuseTalk) explicitly usable commercially.
  Ditto     https://github.com/antgroup/ditto-talkinghead  Apache-2.0 real-time
            diffusion talking head.
  Kokoro    hexgrad/Kokoro-82M (pip `kokoro`)               Apache-2.0 TTS.
  LivePortrait is deliberately ABSENT: MIT code, but it depends on InsightFace
  models licensed for NON-commercial use only. See the comment at the generator
  section below.

Self-contained by design: no repo-local imports. Syntax must parse under
python 3.7 (dev boxes) — `from __future__ import annotations`, no match/case,
no walrus. Runtime target on the box is python 3.10+.

Run `python server.py --selftest` to prove readiness before serving.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import fractions
import hashlib
import io
import json
import logging
import math
import os
import shutil
import sys
import threading
import time
import wave
from collections import deque

try:
    import numpy as np
    import cv2
    import av
    import aiohttp
    from aiohttp import web
    import aiortc
    from aiortc import RTCPeerConnection, RTCSessionDescription
    from aiortc.mediastreams import MediaStreamError, MediaStreamTrack, VideoStreamTrack
except ImportError as import_error:
    sys.stderr.write(
        "missing transport dependency: %s\n"
        "fix: pip install -r requirements.txt  (aiohttp, aiortc, av, numpy, opencv-python-headless)\n"
        % import_error
    )
    raise

log = logging.getLogger("gpu-server")

# --------------------------------------------------------------------------- #
# Constants                                                                   #
# --------------------------------------------------------------------------- #

VIDEO_CLOCK = 90000            # RTP video clock rate
AUDIO_SAMPLE_RATE = 48000      # WebRTC/Opus canonical playout rate
AUDIO_CHANNELS = 2
AUDIO_SAMPLES_PER_FRAME = 960  # 20 ms at 48 kHz
AUDIO_BYTES_PER_FRAME = AUDIO_SAMPLES_PER_FRAME * AUDIO_CHANNELS * 2  # s16
TTS_SAMPLE_RATE = 24000        # Kokoro's native output rate
MAX_SPEAK_SECONDS = 90         # explicit per-utterance cap — no silent frame-queue drops
DEFAULT_FPS = {"cpu": 24, "musetalk": 25, "ditto": 25}
GENERATOR_KINDS = ("cpu", "musetalk", "ditto")

SERVER_STARTED = time.time()

# Resolved ABSOLUTE at import time: the MuseTalk/Ditto adapters chdir into their
# repo checkouts (those repos resolve their own ./models paths against CWD), so
# every path of OURS must be pinned before that happens.
CACHE_ROOT = os.path.abspath(os.environ.get("CACHE_DIR") or "cache")

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
}

# --------------------------------------------------------------------------- #
# Config                                                                      #
# --------------------------------------------------------------------------- #


def resolve_config(argv=None):
    """CLI flags override env; env overrides defaults. Unknown GENERATOR = hard stop."""
    parser = argparse.ArgumentParser(
        description="Matrix Host GPU streaming server (WebRTC video+audio, model generators)"
    )
    parser.add_argument("--selftest", action="store_true",
                        help="run readiness checks (PASS/FAIL lines) and exit nonzero on failure")
    parser.add_argument("--generator", default=None, help="override GENERATOR env (cpu|musetalk|ditto)")
    parser.add_argument("--source", default=None, help="override SOURCE env (image or short video)")
    parser.add_argument("--port", type=int, default=None, help="override PORT env")
    args = parser.parse_args(argv)

    kind = (args.generator or os.environ.get("GENERATOR") or "cpu").strip().lower()
    if kind not in GENERATOR_KINDS:
        raise SystemExit("unknown GENERATOR %r — valid values: %s" % (kind, ", ".join(GENERATOR_KINDS)))
    fps_env = os.environ.get("FPS")
    ditto_dir = os.environ.get("DITTO_DIR") or "./ditto-talkinghead"
    return argparse.Namespace(
        selftest=args.selftest,
        kind=kind,
        source=args.source or os.environ.get("SOURCE") or "reference.mp4",
        port=args.port or int(os.environ.get("PORT") or "8788"),
        tts_voice=os.environ.get("TTS_VOICE") or "af_heart",
        fps=int(fps_env) if fps_env else DEFAULT_FPS[kind],
        musetalk_dir=os.environ.get("MUSETALK_DIR") or "./MuseTalk",
        ditto_dir=ditto_dir,
        ditto_cfg_pkl=os.environ.get("DITTO_CFG_PKL")
        or os.path.join(ditto_dir, "checkpoints", "ditto_cfg", "v0.4_hubert_cfg_pytorch.pkl"),
        ditto_data_root=os.environ.get("DITTO_DATA_ROOT")
        or os.path.join(ditto_dir, "checkpoints", "ditto_pytorch"),
    )


# --------------------------------------------------------------------------- #
# Small helpers                                                               #
# --------------------------------------------------------------------------- #


def _frames_of(result):
    """av.AudioResampler.resample returns a list on PyAV>=9, a frame (or None) before."""
    if result is None:
        return []
    if isinstance(result, (list, tuple)):
        return list(result)
    return [result]


def resample_to_playout(audio, sample_rate):
    """float32 mono [-1, 1] at any rate -> interleaved s16 STEREO bytes at 48 kHz.

    Uses av.AudioResampler (per spec) so the playout path exercises the exact
    resampler the WebRTC stack ships with.
    """
    mono = np.clip(np.asarray(audio, dtype=np.float32).reshape(1, -1), -1.0, 1.0)
    frame = av.AudioFrame.from_ndarray(mono, format="flt", layout="mono")
    frame.sample_rate = int(sample_rate)
    resampler = av.AudioResampler(format="s16", layout="stereo", rate=AUDIO_SAMPLE_RATE)
    out = bytearray()
    for piece in _frames_of(resampler.resample(frame)) + _frames_of(resampler.resample(None)):
        arr = piece.to_ndarray()  # packed s16 stereo -> shape (1, samples*channels) int16
        out.extend(arr[:, : piece.samples * AUDIO_CHANNELS].tobytes())
    return bytes(out)


def resample_mono(audio, from_rate, to_rate):
    """float32 mono -> float32 mono at to_rate (av.AudioResampler, flt/mono)."""
    flat = np.asarray(audio, dtype=np.float32).reshape(-1)
    if int(from_rate) == int(to_rate):
        return flat
    frame = av.AudioFrame.from_ndarray(np.clip(flat, -1.0, 1.0).reshape(1, -1), format="flt", layout="mono")
    frame.sample_rate = int(from_rate)
    resampler = av.AudioResampler(format="flt", layout="mono", rate=int(to_rate))
    pieces = []
    for piece in _frames_of(resampler.resample(frame)) + _frames_of(resampler.resample(None)):
        pieces.append(piece.to_ndarray().reshape(-1)[: piece.samples])
    if not pieces:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(pieces).astype(np.float32)


def decode_client_audio(audio_b64, mime=""):
    """base64 container audio (mp3/wav/ogg/... e.g. ElevenLabs output) -> (float32 mono, 24 kHz).

    av probes the container from the bytes; `mime` is advisory only and reported
    back in errors so a bad payload is diagnosable from the browser.
    """
    data = base64.b64decode(audio_b64)
    container = av.open(io.BytesIO(data))
    try:
        resampler = av.AudioResampler(format="flt", layout="mono", rate=TTS_SAMPLE_RATE)
        pieces = []
        for frame in container.decode(audio=0):
            for piece in _frames_of(resampler.resample(frame)):
                pieces.append(piece.to_ndarray().reshape(-1)[: piece.samples])
        for piece in _frames_of(resampler.resample(None)):
            pieces.append(piece.to_ndarray().reshape(-1)[: piece.samples])
    finally:
        container.close()
    if not pieces:
        raise ValueError("no audio decoded from audioB64 payload (mime=%r)" % mime)
    return np.concatenate(pieces).astype(np.float32), TTS_SAMPLE_RATE


def write_wav(path, audio, sample_rate):
    """float32 mono -> 16-bit PCM wav (stdlib only — model repos read audio from paths)."""
    pcm = (np.clip(np.asarray(audio, dtype=np.float32), -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(path, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(int(sample_rate))
        handle.writeframes(pcm.tobytes())


def load_source_frames(source, max_frames):
    """SOURCE (video or image) -> list of BGR frames, bounded by max_frames."""
    frames = []
    capture = cv2.VideoCapture(source)
    if capture.isOpened():
        while len(frames) < max_frames:
            ok, frame = capture.read()
            if not ok:
                break
            frames.append(frame)
        capture.release()
    if not frames:
        image = cv2.imread(source)  # VideoCapture reads some stills; imread covers the rest
        if image is not None:
            frames = [image]
    if not frames:
        raise RuntimeError("SOURCE unreadable as video or image: %s" % source)
    return frames


def _source_digest(source):
    """Cache key for a source file: path + size + mtime (content-change aware, cheap)."""
    stat = os.stat(source)
    raw = "%s|%s|%s" % (os.path.abspath(source), stat.st_size, int(stat.st_mtime))
    return hashlib.md5(raw.encode("utf-8")).hexdigest()[:16]


def gpu_name():
    """Device name if torch + CUDA are present, else None. Never raises."""
    try:
        import torch
    except ImportError:
        return None
    try:
        if torch.cuda.is_available():
            return torch.cuda.get_device_name(0)
    except Exception:
        return None
    return None


# --------------------------------------------------------------------------- #
# TTS — Kokoro (Apache-2.0)                                                   #
# --------------------------------------------------------------------------- #


class SpeechUnavailable(RuntimeError):
    """TTS is not usable on this box. Surfaced as a structured command reply —
    never crashes the stream."""


class SpeechPipeline:
    """Kokoro-82M text-to-speech: text -> (float32 mono numpy, 24000).

    Lazy-loaded: the model is only pulled into memory on the first speak, so the
    cpu transport tier boots instantly and boxes without the `kokoro` package
    still stream video + accept client-supplied audio.
    """

    SAMPLE_RATE = TTS_SAMPLE_RATE

    def __init__(self, voice):
        self.voice = voice
        self._pipeline = None
        self._lock = threading.Lock()

    def _ensure(self):
        with self._lock:
            if self._pipeline is None:
                try:
                    from kokoro import KPipeline
                except ImportError:
                    raise SpeechUnavailable(
                        "Kokoro TTS is not installed on this box. "
                        "fix: pip install kokoro soundfile && apt-get install -y espeak-ng "
                        "(espeak-ng is Kokoro's fallback for out-of-dictionary words). "
                        "speak with {audioB64} works without it."
                    )
                # Kokoro voice ids encode their language pack in the first letter:
                # af_/am_* -> 'a' (American English), bf_/bm_* -> 'b' (British), ...
                self._pipeline = KPipeline(lang_code=self.voice[:1] or "a")
            return self._pipeline

    def synthesize(self, text):
        """Blocking (run on a worker thread). Returns (float32 mono, 24000)."""
        pipeline = self._ensure()
        pieces = []
        # KPipeline yields Result objects that unpack as (graphemes, phonemes, audio);
        # audio is a torch FloatTensor (or numpy array) at 24 kHz.
        for _, _, audio in pipeline(text, voice=self.voice):
            if audio is None:
                continue
            if hasattr(audio, "detach"):
                audio = audio.detach().cpu().numpy()
            pieces.append(np.asarray(audio, dtype=np.float32).reshape(-1))
        if not pieces:
            raise SpeechUnavailable("Kokoro produced no audio for text %r (voice %r)" % (text, self.voice))
        return np.concatenate(pieces), self.SAMPLE_RATE


# --------------------------------------------------------------------------- #
# Audio bus + WebRTC tracks                                                   #
# --------------------------------------------------------------------------- #


class AudioBus:
    """Fan-out PCM bus. Speech audio goes in once (float32 mono, any rate) and is
    resampled to 48 kHz s16 stereo, then appended to every subscribed peer
    track's buffer. Thread-safe: generators push from worker threads while the
    event loop drains 20 ms frames."""

    def __init__(self):
        self._lock = threading.Lock()
        self._subscribers = []  # list of bytearray (one per SpeechAudioTrack)

    def subscribe(self):
        buffer = bytearray()
        with self._lock:
            self._subscribers.append(buffer)
        return buffer

    def unsubscribe(self, buffer):
        with self._lock:
            if buffer in self._subscribers:
                self._subscribers.remove(buffer)

    def push(self, audio, sample_rate):
        payload = resample_to_playout(audio, sample_rate)
        with self._lock:
            for buffer in self._subscribers:
                buffer.extend(payload)

    def read(self, buffer, nbytes):
        """Pop nbytes from the front of a subscriber buffer, silence-padded."""
        with self._lock:
            chunk = bytes(buffer[:nbytes])
            del buffer[:nbytes]
        if len(chunk) < nbytes:
            chunk += b"\x00" * (nbytes - len(chunk))
        return chunk

    def flush(self):
        with self._lock:
            for buffer in self._subscribers:
                del buffer[:]

    def buffered_seconds(self):
        with self._lock:
            if not self._subscribers:
                return 0.0
            longest = max(len(buffer) for buffer in self._subscribers)
        return longest / float(AUDIO_SAMPLE_RATE * AUDIO_CHANNELS * 2)


class SpeechAudioTrack(MediaStreamTrack):
    """aiortc audio track: 48 kHz s16 stereo, 20 ms frames, wall-clock paced.
    Emits silence while the bus is idle so the track never starves."""

    kind = "audio"

    def __init__(self, bus):
        super().__init__()
        self.bus = bus
        self.buffer = bus.subscribe()
        self._timestamp = 0
        self._start = None

    async def recv(self):
        if self.readyState != "live":
            raise MediaStreamError
        if self._start is None:
            self._start = time.time()
        else:
            self._timestamp += AUDIO_SAMPLES_PER_FRAME
            target = self._start + self._timestamp / float(AUDIO_SAMPLE_RATE)
            await asyncio.sleep(max(0.0, target - time.time()))
        payload = self.bus.read(self.buffer, AUDIO_BYTES_PER_FRAME)
        arr = np.frombuffer(payload, dtype=np.int16).reshape(1, -1)  # packed (1, samples*channels)
        frame = av.AudioFrame.from_ndarray(arr, format="s16", layout="stereo")
        frame.sample_rate = AUDIO_SAMPLE_RATE
        frame.pts = self._timestamp
        frame.time_base = fractions.Fraction(1, AUDIO_SAMPLE_RATE)
        return frame

    def stop(self):
        self.bus.unsubscribe(self.buffer)
        super().stop()


class GeneratedTrack(VideoStreamTrack):
    """aiortc video track fed by a Generator, paced at the generator's fps."""

    def __init__(self, generator):
        super().__init__()
        self.generator = generator
        self.started = time.time()
        self._ts = None

    async def recv(self):
        pts, time_base = await self.next_timestamp()
        frame_bgr = await self.generator.frame(time.time() - self.started)
        height, width = frame_bgr.shape[:2]
        if (height % 2) or (width % 2):
            # video encoders want even dimensions — crop a stray pixel, never scale
            frame_bgr = frame_bgr[: height - (height % 2), : width - (width % 2)]
        frame = av.VideoFrame.from_ndarray(np.ascontiguousarray(frame_bgr), format="bgr24")
        frame.pts = pts
        frame.time_base = time_base
        return frame

    async def next_timestamp(self):
        if self.readyState != "live":
            raise MediaStreamError("track ended")
        fps = self.generator.fps
        if self._ts is None:
            self._ts = 0
        else:
            self._ts += int(VIDEO_CLOCK / fps)
            await asyncio.sleep(max(0.0, self.started + self._ts / VIDEO_CLOCK - time.time()))
        return self._ts, fractions.Fraction(1, VIDEO_CLOCK)


# --------------------------------------------------------------------------- #
# Generators — the model seam                                                 #
# --------------------------------------------------------------------------- #


class Generator:
    """One implementation per model family; the transport above never changes.

    Contract:
      start()          async, may take minutes (model load) — runs in a worker thread
      frame(t)         async, one BGR uint8 frame per call at self.fps
      speak(...)       BLOCKING, called on a worker thread: drive the mouth with
                       this audio AND push the matching playout audio to `bus`
                       so voice and lips leave together
      stop_speaking()  abort + drop queued speech frames
      close()          release model resources at shutdown
    """

    kind = "base"
    fps = 24
    model_ready = False
    load_error = None

    async def start(self):
        self.model_ready = True

    async def frame(self, t):
        raise NotImplementedError

    def speak(self, audio, sample_rate, bus):
        raise NotImplementedError

    def stop_speaking(self):
        pass

    def close(self):
        pass


class CPUTestGenerator(Generator):
    """Transport-proof tier: no GPU, no model — loops the source footage.

    speak() still routes REAL audio (Kokoro TTS or client-supplied) through the
    REAL WebRTC audio track, so this tier proves the full command -> TTS ->
    resample -> audio-track path on any box. The mouth will not match the voice
    — that is the model's job, and exactly what the musetalk/ditto tiers add.
    """

    kind = "cpu"

    def __init__(self, source, fps):
        self.fps = fps
        self.source = os.path.abspath(source)
        self.capture = None
        self.still = None
        capture = cv2.VideoCapture(self.source)
        if capture.isOpened():
            ok, _ = capture.read()
            if ok:
                capture.set(cv2.CAP_PROP_POS_FRAMES, 0)
                self.capture = capture
        if self.capture is None:
            still = cv2.imread(self.source)
            if still is None:
                raise RuntimeError(
                    "cannot open SOURCE %r as video or image — set SOURCE=/path/to/art "
                    "(bootstrap.sh copies ../public/footage/reference.mp4 next to server.py)" % self.source
                )
            self.still = still

    async def start(self):
        self.model_ready = True

    async def frame(self, t):
        if self.still is not None:
            return self.still
        ok, frame = self.capture.read()
        if not ok:
            self.capture.set(cv2.CAP_PROP_POS_FRAMES, 0)
            ok, frame = self.capture.read()
            if not ok:
                raise RuntimeError("source footage became unreadable mid-stream: %s" % self.source)
        return frame

    def speak(self, audio, sample_rate, bus):
        bus.push(audio, sample_rate)


# LivePortraitGenerator was removed on purpose (2026-07-31): the LivePortrait code
# is MIT, but it depends on InsightFace models whose license is NON-commercial
# only — unusable for this product. The commercial-safe adapters are below:
# MuseTalk (MIT code, weights cleared for commercial use) and Ditto (Apache-2.0).


MUSETALK_WEIGHT_FILES = (
    # v1.5 weight tree, exactly as MuseTalk's README documents under <repo>/models/
    "models/musetalkV15/unet.pth",
    "models/musetalkV15/musetalk.json",
    "models/sd-vae/config.json",
    "models/whisper/config.json",
    "models/dwpose/dw-ll_ucoco_384.pth",
    "models/face-parse-bisent/79999_iter.pth",
    "models/face-parse-bisent/resnet18-5c106cde.pth",
)


def missing_musetalk_weights(musetalk_dir):
    return [rel for rel in MUSETALK_WEIGHT_FILES if not os.path.exists(os.path.join(musetalk_dir, rel))]


class MuseTalkGenerator(Generator):
    """MuseTalk v1.5 realtime adapter (MIT code; weights cleared for commercial use).

    Integration pattern follows scripts/realtime_inference.py in the MuseTalk
    repo (their Avatar class): models load once in start(), the SOURCE is
    preprocessed into per-frame (frame, bbox, VAE latent, blend mask) cycles
    cached on disk, idle loops the source frames, and speak() runs
    whisper-features -> unet mouth inpaint -> VAE decode -> blend, queueing
    frames in sync with the audio bus. 25 fps.
    """

    kind = "musetalk"

    # Defaults lifted from scripts/realtime_inference.py argparse (v15 path):
    BATCH_SIZE = 4          # their offline default is higher; small batch = lower first-frame latency
    BBOX_SHIFT = 0          # v15 ignores bbox_shift (v1.0 tuning knob)
    EXTRA_MARGIN = 10       # --extra_margin: widens the crop downward to keep the jaw inside
    PARSING_MODE = "jaw"    # --parsing_mode default for v15 blending
    LEFT_CHEEK_WIDTH = 90   # --left_cheek_width default
    RIGHT_CHEEK_WIDTH = 90  # --right_cheek_width default
    AUDIO_PAD_LEFT = 2      # --audio_padding_length_left default
    AUDIO_PAD_RIGHT = 2     # --audio_padding_length_right default
    # Bound preprocessing: 250 frames = 10 s of footage at 25 fps, held in RAM like
    # their Avatar does (budget ~6 MB/frame at 1080p — trim the SOURCE, not this).
    MAX_SOURCE_FRAMES = 250

    def __init__(self, source, musetalk_dir, fps):
        self.fps = fps
        self.source = os.path.abspath(source)
        self.musetalk_dir = os.path.abspath(musetalk_dir)
        self._speak_frames = deque()  # (next_cycle_index, frame_bgr) — deque ops are atomic
        self._idle_idx = 0
        self._abort = threading.Event()
        self._infer_lock = threading.Lock()  # one utterance renders at a time
        self._cycle = None

    async def start(self):
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self._start_blocking)

    def _start_blocking(self):
        if not os.path.isdir(self.musetalk_dir):
            raise RuntimeError(
                "MUSETALK_DIR not found: %s — run: GENERATOR=musetalk bash bootstrap.sh" % self.musetalk_dir
            )
        missing = missing_musetalk_weights(self.musetalk_dir)
        if missing:
            raise RuntimeError(
                "MuseTalk weights missing: %s — run: GENERATOR=musetalk bash bootstrap.sh"
                % ", ".join(missing)
            )
        if not os.path.exists(self.source):
            raise RuntimeError("SOURCE not found: %s" % self.source)

        sys.path.insert(0, self.musetalk_dir)
        # MuseTalk resolves ./models/** against the CWD (scripts/realtime_inference.py
        # is documented to run from the repo root) — mirror that. All of OUR paths
        # (source, cache) were made absolute before this line.
        os.chdir(self.musetalk_dir)

        import torch
        from transformers import WhisperModel
        from musetalk.utils.utils import load_all_model, datagen
        from musetalk.utils.preprocessing import get_landmark_and_bbox, coord_placeholder
        from musetalk.utils.blending import get_image_prepare_material, get_image_blending
        from musetalk.utils.face_parsing import FaceParsing
        from musetalk.utils.audio_processor import AudioProcessor

        self._torch = torch
        self._datagen = datagen
        self._get_landmark_and_bbox = get_landmark_and_bbox
        self._coord_placeholder = coord_placeholder
        self._prepare_material = get_image_prepare_material
        self._blend = get_image_blending

        self.device = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")
        models_dir = os.path.join(self.musetalk_dir, "models")

        # Model load + half-precision moves: verbatim pattern from
        # scripts/realtime_inference.py (v15 branch).
        vae, unet, pe = load_all_model(
            unet_model_path=os.path.join(models_dir, "musetalkV15", "unet.pth"),
            vae_type="sd-vae",
            unet_config=os.path.join(models_dir, "musetalkV15", "musetalk.json"),
            device=self.device,
        )
        self.pe = pe.half().to(self.device)
        vae.vae = vae.vae.half().to(self.device)
        unet.model = unet.model.half().to(self.device)
        self.vae = vae
        self.unet = unet
        self.weight_dtype = unet.model.dtype
        self.timesteps = torch.tensor([0], device=self.device)

        whisper_dir = os.path.join(models_dir, "whisper")
        self.audio_processor = AudioProcessor(feature_extractor_path=whisper_dir)
        whisper = WhisperModel.from_pretrained(whisper_dir)
        self.whisper = whisper.to(device=self.device, dtype=self.weight_dtype).eval()
        self.whisper.requires_grad_(False)

        # v15 FaceParsing takes the cheek widths (realtime_inference.py v15 branch;
        # v1.0 constructed it bare).
        self.face_parser = FaceParsing(
            left_cheek_width=self.LEFT_CHEEK_WIDTH, right_cheek_width=self.RIGHT_CHEEK_WIDTH
        )

        self._prepare_avatar()
        self.model_ready = True

    def _prepare_avatar(self):
        """SOURCE -> per-frame (frame, bbox, latent, mask) cycles, cached on disk so
        restarts skip landmarking + VAE encoding (the slow half of startup)."""
        torch = self._torch
        cache_dir = os.path.join(CACHE_ROOT, "musetalk", _source_digest(self.source))
        cache_file = os.path.join(cache_dir, "avatar.pt")
        if os.path.exists(cache_file):
            payload = torch.load(cache_file, map_location="cpu")
            frames = payload["frames"]
            coords = payload["coords"]
            latents = [latent.to(self.device) for latent in payload["latents"]]
            masks = payload["masks"]
            mask_boxes = payload["mask_boxes"]
            log.info("musetalk avatar cache hit: %s (%d frames)", cache_file, len(frames))
        else:
            frames_dir = os.path.join(cache_dir, "frames")
            os.makedirs(frames_dir, exist_ok=True)
            raw_frames = load_source_frames(self.source, self.MAX_SOURCE_FRAMES)
            image_paths = []
            for index, frame in enumerate(raw_frames):
                path = os.path.join(frames_dir, "%08d.png" % index)
                cv2.imwrite(path, frame)
                image_paths.append(path)
            # get_landmark_and_bbox wants image PATHS — their Avatar extracts the
            # video to a directory first, exactly as done here.
            coord_list, frame_list = self._get_landmark_and_bbox(image_paths, self.BBOX_SHIFT)
            frames = []
            coords = []
            latents = []
            masks = []
            mask_boxes = []
            for bbox, frame in zip(coord_list, frame_list):
                if bbox == self._coord_placeholder:
                    continue  # their sentinel: no face found in this frame
                x1, y1, x2, y2 = bbox
                y2 = min(y2 + self.EXTRA_MARGIN, frame.shape[0])  # v15: keep the jaw inside the crop
                crop = frame[y1:y2, x1:x2]
                if crop.size == 0:
                    continue
                resized = cv2.resize(crop, (256, 256), interpolation=cv2.INTER_LANCZOS4)
                latent = self.vae.get_latents_for_unet(resized)
                # v15 signature: get_image_prepare_material(frame, box, fp=FaceParsing, mode=...)
                mask, crop_box = self._prepare_material(
                    frame, [x1, y1, x2, y2], fp=self.face_parser, mode=self.PARSING_MODE
                )
                frames.append(frame)
                coords.append([x1, y1, x2, y2])
                latents.append(latent)
                masks.append(mask)
                mask_boxes.append(crop_box)
            if not frames:
                raise RuntimeError(
                    "no face detected in any frame of SOURCE %s — MuseTalk needs a clear, "
                    "mostly-frontal face; feed it different source art" % self.source
                )
            torch.save(
                {
                    "frames": frames,
                    "coords": coords,
                    "latents": [latent.cpu() for latent in latents],
                    "masks": masks,
                    "mask_boxes": mask_boxes,
                },
                cache_file,
            )
            log.info("musetalk avatar preprocessed + cached: %s (%d frames)", cache_file, len(frames))
        # Ping-pong cycles (forward + reversed), exactly like their Avatar: the
        # idle loop and the inpainted frames both walk this seamless cycle.
        self._cycle = {
            "frames": frames + frames[::-1],
            "coords": coords + coords[::-1],
            "latents": latents + latents[::-1],
            "masks": masks + masks[::-1],
            "mask_boxes": mask_boxes + mask_boxes[::-1],
        }

    async def frame(self, t):
        if self._speak_frames:
            next_index, frame = self._speak_frames.popleft()
            self._idle_idx = next_index  # idle resumes wherever speech left the cycle
            return frame
        cycle = self._cycle
        frame = cycle["frames"][self._idle_idx % len(cycle["frames"])]
        self._idle_idx += 1
        return frame

    def speak(self, audio, sample_rate, bus):
        """Blocking; runs on a worker thread. Follows Avatar.inference() in
        scripts/realtime_inference.py: whisper features -> per-frame chunks ->
        unet inpaint -> VAE decode -> blend into the source frame.

        Deliberate deviation from their script (commented): their realtime restarts
        every utterance at cycle index 0; we rotate the latent/frame cycles to the
        CURRENT idle index so the mouth is painted onto (nearly) the frame that is
        actually on screen. The first batch lands after ~one batch of inference,
        during which idle advances a few frames — that small jump is inherent to
        their per-utterance design too.
        """
        cycle = self._cycle
        if cycle is None:
            raise RuntimeError("musetalk generator not started")
        torch = self._torch
        with self._infer_lock:
            self._abort.clear()
            os.makedirs(CACHE_ROOT, exist_ok=True)
            wav_path = os.path.join(CACHE_ROOT, "speak-%d-%d.wav" % (os.getpid(), time.time_ns()))
            # AudioProcessor.get_audio_feature loads from a path (librosa @16k inside)
            # — hand it a wav at our native rate and let it resample.
            write_wav(wav_path, audio, sample_rate)
            try:
                whisper_features, librosa_length = self.audio_processor.get_audio_feature(
                    wav_path, weight_dtype=self.weight_dtype
                )
                whisper_chunks = self.audio_processor.get_whisper_chunk(
                    whisper_features,
                    self.device,
                    self.weight_dtype,
                    self.whisper,
                    librosa_length,
                    fps=self.fps,
                    audio_padding_length_left=self.AUDIO_PAD_LEFT,
                    audio_padding_length_right=self.AUDIO_PAD_RIGHT,
                )
            finally:
                try:
                    os.remove(wav_path)
                except OSError:
                    pass

            total = len(cycle["latents"])
            start = self._idle_idx % total
            latents_rot = cycle["latents"][start:] + cycle["latents"][:start]
            audio_sent = False
            position = 0
            with torch.no_grad():
                # datagen(whisper_chunks, latent_cycle, batch_size) — positional call on
                # purpose: kwarg names drifted between MuseTalk versions.
                for whisper_batch, latent_batch in self._datagen(whisper_chunks, latents_rot, self.BATCH_SIZE):
                    if self._abort.is_set():
                        break
                    audio_features = self.pe(whisper_batch.to(self.device))
                    latent_batch = latent_batch.to(device=self.device, dtype=self.unet.model.dtype)
                    pred_latents = self.unet.model(
                        latent_batch, self.timesteps, encoder_hidden_states=audio_features
                    ).sample
                    pred_latents = pred_latents.to(device=self.device, dtype=self.vae.vae.dtype)
                    # decode_latents returns uint8 BGR crops (their VAE helper flips
                    # channels for cv2 consumers).
                    recon = self.vae.decode_latents(pred_latents)
                    for res_frame in recon:
                        if self._abort.is_set():
                            break
                        pos = (start + position) % total
                        x1, y1, x2, y2 = cycle["coords"][pos]
                        resized = cv2.resize(np.asarray(res_frame).astype(np.uint8), (x2 - x1, y2 - y1))
                        combined = self._blend(
                            cycle["frames"][pos].copy(),
                            resized,
                            [x1, y1, x2, y2],
                            cycle["masks"][pos],
                            cycle["mask_boxes"][pos],
                        )
                        self._speak_frames.append(((pos + 1) % total, combined))
                        position += 1
                    if not audio_sent:
                        # Voice leaves only after the first frames are queued: lips and
                        # audio start together; on a 4090 inference outruns 25 fps so the
                        # frame queue stays ahead of the drain from then on.
                        bus.push(audio, sample_rate)
                        audio_sent = True
            if not audio_sent and not self._abort.is_set():
                # Ultra-short audio can produce zero whisper chunks — still play it.
                bus.push(audio, sample_rate)

    def stop_speaking(self):
        self._abort.set()
        self._speak_frames.clear()


class DittoFrameTap:
    """Stand-in for ditto's VideoWriterByImageIO. StreamSDK._writer_worker drains
    writer_queue and calls self.writer(frame, fmt="rgb"), then writer.close() on
    shutdown — same contract here, but frames land in our queue instead of an mp4."""

    def __init__(self, on_frame):
        self._on_frame = on_frame

    def __call__(self, frame_rgb, fmt="rgb"):
        self._on_frame(frame_rgb)

    def close(self):
        pass


class DittoGenerator(Generator):
    """Ditto (antgroup/ditto-talkinghead, Apache-2.0) streaming adapter — real-time
    diffusion talking head, higher quality ceiling than the inpainting tier.

    Uses their StreamSDK (stream_pipeline_online.py) with an intercepted frame
    writer: setup() binds the SOURCE, run_chunk() feeds 16 kHz audio windows, and
    generated frames surface through DittoFrameTap into our frame queue. Idle
    holds/loops the neutral source; defaults use the PyTorch backend checkpoints
    (the TensorRT engines need a TRT install — override DITTO_CFG_PKL to use them).
    """

    kind = "ditto"

    HUBERT_RATE = 16000       # their audio2motion stack is hubert-based, 16 kHz
    SAMPLES_PER_MOTION = 640  # 40 ms hop at 16 kHz — frame stride in their chunk splitter
    IDLE_MAX_FRAMES = 125     # 5 s of idle loop at 25 fps kept in RAM

    def __init__(self, source, ditto_dir, cfg_pkl, data_root, fps):
        self.fps = fps
        self.source = os.path.abspath(source)
        self.ditto_dir = os.path.abspath(ditto_dir)
        self.cfg_pkl = os.path.abspath(cfg_pkl)
        self.data_root = os.path.abspath(data_root)
        self._speak_frames = deque()
        self._idle_frames = None
        self._idle_idx = 0
        self._abort = threading.Event()
        self._infer_lock = threading.Lock()
        self.sdk = None

    async def start(self):
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self._start_blocking)

    def _start_blocking(self):
        for path, what in (
            (self.ditto_dir, "DITTO_DIR checkout"),
            (self.cfg_pkl, "ditto cfg pickle (DITTO_CFG_PKL)"),
            (self.data_root, "ditto weights dir (DITTO_DATA_ROOT)"),
        ):
            if not os.path.exists(path):
                raise RuntimeError(
                    "%s not found: %s — run: GENERATOR=ditto bash bootstrap.sh "
                    "(downloads HF digital-human/ditto-talkinghead)" % (what, path)
                )
        if not os.path.exists(self.source):
            raise RuntimeError("SOURCE not found: %s" % self.source)

        self._idle_frames = load_source_frames(self.source, self.IDLE_MAX_FRAMES)

        sys.path.insert(0, self.ditto_dir)
        # Their scripts run from the repo root; mirror that (our paths are absolute).
        os.chdir(self.ditto_dir)
        from stream_pipeline_online import StreamSDK  # repo-root module in ditto-talkinghead

        self.sdk = StreamSDK(self.cfg_pkl, self.data_root)
        os.makedirs(CACHE_ROOT, exist_ok=True)
        tap_sink = os.path.join(CACHE_ROOT, "ditto-tap.mp4")  # required arg; never written through the tap
        # inference.py routes --online_mode through setup kwargs (the TRT online cfg
        # pkl also flips it); passing it here covers the PyTorch cfg. If their setup
        # signature drops the kwarg, the selftest surfaces it on the box.
        self.sdk.setup(self.source, tap_sink, online_mode=True)
        # Intercept the writer AFTER setup so we replace the real VideoWriterByImageIO.
        self.sdk.writer = DittoFrameTap(self._on_frame)
        self.model_ready = True

    def _on_frame(self, frame_rgb):
        # Called from their writer worker thread; deque append is atomic.
        frame = np.asarray(frame_rgb)
        self._speak_frames.append(cv2.cvtColor(frame, cv2.COLOR_RGB2BGR))

    async def frame(self, t):
        if self._speak_frames:
            return self._speak_frames.popleft()
        frames = self._idle_frames
        frame = frames[self._idle_idx % len(frames)]
        self._idle_idx += 1
        return frame

    def speak(self, audio, sample_rate, bus):
        """Blocking; runs on a worker thread. Follows the online branch of
        inference.py in ditto-talkinghead: setup_Nd() sizes the run, then the
        audio is fed as overlapping 16 kHz windows via run_chunk()."""
        if self.sdk is None:
            raise RuntimeError("ditto generator not started")
        with self._infer_lock:
            self._abort.clear()
            audio16 = resample_mono(audio, sample_rate, self.HUBERT_RATE)
            num_frames = int(math.ceil(len(audio16) / float(self.HUBERT_RATE) * self.fps))
            # Their defaults: fade_in/fade_out -1 (disabled), empty ctrl_info.
            self.sdk.setup_Nd(N_d=num_frames, fade_in=-1, fade_out=-1, ctrl_info={})
            chunksize = tuple(getattr(self.sdk, "chunksize", (3, 5, 2)))  # (history, new, lookahead)
            padded = np.concatenate(
                [np.zeros((chunksize[0] * self.SAMPLES_PER_MOTION,), dtype=np.float32), audio16]
            )
            # Their exact window length: sum(chunksize) * 40 ms of samples + 80 = 6480 for (3,5,2).
            split_len = int(sum(chunksize) * 0.04 * self.HUBERT_RATE) + 80
            step = chunksize[1] * self.SAMPLES_PER_MOTION
            audio_sent = False
            for offset in range(0, len(padded), step):
                if self._abort.is_set():
                    break
                chunk = padded[offset:offset + split_len]
                if len(chunk) < split_len:
                    chunk = np.pad(chunk, (0, split_len - len(chunk)), mode="constant")
                self.sdk.run_chunk(chunk, chunksize)
                if not audio_sent:
                    # Audio leads by the pipeline's internal latency (frames surface a
                    # beat after run_chunk) — tens of ms on a 4090; acceptable for v1.
                    bus.push(audio, sample_rate)
                    audio_sent = True
            if not audio_sent and not self._abort.is_set():
                bus.push(audio, sample_rate)

    def stop_speaking(self):
        self._abort.set()
        self._speak_frames.clear()

    def close(self):
        if self.sdk is not None:
            try:
                self.sdk.close()  # joins their pipeline/writer threads
            except Exception as error:
                log.warning("ditto sdk close: %s", error)
            self.sdk = None


def build_generator(config):
    if config.kind == "cpu":
        return CPUTestGenerator(config.source, config.fps)
    if config.kind == "musetalk":
        return MuseTalkGenerator(config.source, config.musetalk_dir, config.fps)
    if config.kind == "ditto":
        return DittoGenerator(
            config.source, config.ditto_dir, config.ditto_cfg_pkl, config.ditto_data_root, config.fps
        )
    raise SystemExit("unknown GENERATOR %r — valid values: %s" % (config.kind, ", ".join(GENERATOR_KINDS)))


# --------------------------------------------------------------------------- #
# Command protocol (data channel 'commands')                                  #
# --------------------------------------------------------------------------- #


class CommandRouter:
    """Structured replies for every message; errors surfaced, never swallowed.

    {"cmd":"speak","text":...}            -> Kokoro TTS -> audio track + generator
    {"cmd":"speak","audioB64":...,"mime"} -> client audio (e.g. ElevenLabs) same path
    {"cmd":"stop"}                        -> abort speech, flush queued audio/frames
    {"cmd":"status"}                      -> generator/model/uptime/gpu snapshot
    """

    KNOWN = ("speak", "stop", "status")

    def __init__(self, generator, speech, bus):
        self.generator = generator
        self.speech = speech
        self.bus = bus

    async def handle(self, message):
        cmd = message.get("cmd")
        if cmd == "speak":
            return await self._speak(message)
        if cmd == "stop":
            return self._stop()
        if cmd == "status":
            return self._status()
        return {"ok": False, "error": "unknown cmd %r" % cmd, "known": list(self.KNOWN)}

    async def _speak(self, message):
        if not self.generator.model_ready:
            detail = self.generator.load_error or "still loading"
            return {"ok": False, "error": "generator not ready: %s — poll /health until model_ready" % detail}
        loop = asyncio.get_running_loop()
        audio_b64 = message.get("audioB64")
        text = message.get("text")
        if audio_b64:
            audio, rate = await loop.run_in_executor(
                None, decode_client_audio, audio_b64, message.get("mime") or ""
            )
            engine = "client-audio"
        elif text:
            audio, rate = await loop.run_in_executor(None, self.speech.synthesize, str(text))
            engine = "kokoro"
        else:
            return {"ok": False, "error": 'speak needs "text" or "audioB64"'}
        seconds = len(audio) / float(rate)
        if seconds > MAX_SPEAK_SECONDS:
            return {
                "ok": False,
                "error": "speak audio is %.1fs — cap is %ds per utterance (split the text)"
                % (seconds, MAX_SPEAK_SECONDS),
            }
        # Generator contract: drive the mouth AND push the playout audio to the bus
        # itself, so lips and voice leave together. Runs on a worker thread —
        # inference never blocks frame pacing.
        await loop.run_in_executor(None, self.generator.speak, audio, rate, self.bus)
        spoke = {"engine": engine, "seconds": round(seconds, 2), "samples": int(len(audio))}
        if text:
            spoke["text"] = str(text)
        return {"ok": True, "spoke": spoke}

    def _stop(self):
        self.generator.stop_speaking()
        self.bus.flush()
        return {"ok": True, "stopped": True}

    def _status(self):
        return {
            "ok": True,
            "generator": self.generator.kind,
            "model_ready": self.generator.model_ready,
            "load_error": self.generator.load_error,
            "uptime_s": round(time.time() - SERVER_STARTED, 1),
            "gpu": gpu_name(),
            "fps": self.generator.fps,
            "buffered_audio_s": round(self.bus.buffered_seconds(), 2),
        }


# --------------------------------------------------------------------------- #
# HTTP + WebRTC app                                                           #
# --------------------------------------------------------------------------- #


def build_app(generator, bus, router):
    app = web.Application()
    peers = set()

    async def respond(channel, message):
        try:
            payload = json.loads(message)
            if not isinstance(payload, dict):
                raise ValueError("commands must be JSON objects")
            reply = await router.handle(payload)
        except Exception as error:
            log.exception("command failed")
            reply = {"ok": False, "error": str(error) or error.__class__.__name__}
        try:
            channel.send(json.dumps(reply))
        except Exception as error:
            log.warning("could not deliver reply (channel closed?): %s", error)

    async def offer(request):
        if not generator.model_ready:
            detail = generator.load_error or "still loading — poll /health until model_ready"
            return web.json_response(
                {"ok": False, "error": "generator not ready: %s" % detail},
                status=503,
                headers=CORS_HEADERS,
            )
        try:
            params = await request.json()
            sdp = params["sdp"]
            sdp_type = params["type"]
        except Exception as error:
            return web.json_response(
                {"ok": False, "error": "offer body must be JSON with sdp+type: %s" % error},
                status=400,
                headers=CORS_HEADERS,
            )
        # Shared-secret gate for publicly exposed pods: set STREAM_TOKEN on the box
        # and append #<token> to the /offer URL in stream.html. Unset = open (dev).
        expected_token = os.environ.get("STREAM_TOKEN", "")
        if expected_token and params.get("token") != expected_token:
            return web.json_response(
                {"ok": False, "error": "bad or missing token (server has STREAM_TOKEN set)"},
                status=401,
                headers=CORS_HEADERS,
            )
        peer = RTCPeerConnection()
        peers.add(peer)

        @peer.on("datachannel")
        def on_datachannel(channel):
            @channel.on("message")
            def on_message(message):
                asyncio.ensure_future(respond(channel, message))

        @peer.on("connectionstatechange")
        async def on_state():
            log.info("peer connection state: %s", peer.connectionState)
            if peer.connectionState in ("failed", "closed"):
                await peer.close()
                peers.discard(peer)

        # aiortc's canonical order (their webcam example): remote description first,
        # THEN addTrack — each track attaches to the transceiver the browser offered.
        # Video + audio for every peer; if the browser's offer carries no audio
        # m-line (recvonly audio transceiver not added client-side yet), the audio
        # track simply stays unnegotiated — video still flows, no error.
        await peer.setRemoteDescription(RTCSessionDescription(sdp=sdp, type=sdp_type))
        peer.addTrack(GeneratedTrack(generator))
        peer.addTrack(SpeechAudioTrack(bus))
        answer = await peer.createAnswer()
        await peer.setLocalDescription(answer)
        return web.json_response(
            {"sdp": peer.localDescription.sdp, "type": peer.localDescription.type},
            headers=CORS_HEADERS,
        )

    async def health(request):
        return web.json_response(
            {
                "ok": True,
                "generator": generator.kind,
                "model_ready": generator.model_ready,
                "load_error": generator.load_error,
                "uptime_s": round(time.time() - SERVER_STARTED, 1),
                "peers": len(peers),
            },
            headers=CORS_HEADERS,
        )

    async def preflight(request):
        return web.Response(headers=CORS_HEADERS)

    app.router.add_post("/offer", offer)
    app.router.add_options("/offer", preflight)
    app.router.add_get("/health", health)
    app.router.add_options("/health", preflight)

    async def on_startup(app):
        # Model load happens in the background: /health answers immediately with
        # model_ready:false, /offer answers 503 with the reason, and a load
        # failure is stamped onto generator.load_error — visible, never silent.
        async def load():
            try:
                await generator.start()
                log.info("generator %r ready (fps=%s)", generator.kind, generator.fps)
            except Exception as error:
                generator.load_error = "%s: %s" % (error.__class__.__name__, error)
                log.exception("generator failed to start — /offer will 503 with this reason")

        app["generator_load"] = asyncio.ensure_future(load())

    async def on_shutdown(app):
        task = app.get("generator_load")
        if task is not None:
            task.cancel()
        await asyncio.gather(*(peer.close() for peer in peers), return_exceptions=True)
        peers.clear()
        generator.close()

    app.on_startup.append(on_startup)
    app.on_shutdown.append(on_shutdown)
    return app


# --------------------------------------------------------------------------- #
# Selftest                                                                    #
# --------------------------------------------------------------------------- #


class _Skip(Exception):
    """Raised by a check to report SKIP (not a failure) with a reason."""


def run_selftest(config):
    """Readiness gate: PASS/FAIL lines with remediation hints; exit nonzero on any
    FAIL. The cpu tier passes on a GPU-less box (torch checks are skipped)."""
    print(
        "matrix-host GPU server selftest — generator=%s source=%s voice=%s"
        % (config.kind, config.source, config.tts_voice)
    )
    state = {"failures": 0}

    def check(name, fn, hint=""):
        try:
            detail = fn()
        except _Skip as skip:
            print("[SKIP] %s — %s" % (name, skip))
        except Exception as error:
            state["failures"] += 1
            print("[FAIL] %s — %s" % (name, error))
            if hint:
                print("       fix: %s" % hint)
        else:
            suffix = " — %s" % detail if detail else ""
            print("[PASS] %s%s" % (name, suffix))

    def check_python():
        if sys.version_info < (3, 10):
            raise RuntimeError("running on python %s — the box needs >= 3.10" % sys.version.split()[0])
        return sys.version.split()[0]

    def check_ffmpeg():
        path = shutil.which("ffmpeg")
        if not path:
            raise RuntimeError("ffmpeg not on PATH")
        return path

    def check_espeak():
        if shutil.which("espeak-ng"):
            return "present"
        raise _Skip(
            "not on PATH — Kokoro uses espeak-ng as fallback for out-of-dictionary words; "
            "apt-get install -y espeak-ng"
        )

    def check_transport():
        return "av %s, aiortc %s, aiohttp %s, opencv %s, numpy %s" % (
            av.__version__,
            getattr(aiortc, "__version__", "?"),
            aiohttp.__version__,
            cv2.__version__,
            np.__version__,
        )

    def check_torch():
        if config.kind == "cpu":
            raise _Skip("cpu generator needs no GPU (torch checks skipped)")
        import torch

        if not torch.cuda.is_available():
            raise RuntimeError("torch %s imports but CUDA is unavailable" % torch.__version__)
        return "torch %s, %s" % (torch.__version__, torch.cuda.get_device_name(0))

    def check_source():
        frame = load_source_frames(config.source, 1)[0]
        height, width = frame.shape[:2]
        return "%dx%d (%s)" % (width, height, config.source)

    def check_weights():
        if config.kind == "cpu":
            raise _Skip("no model weights in the cpu tier")
        if config.kind == "musetalk":
            missing = missing_musetalk_weights(config.musetalk_dir)
            if missing:
                raise RuntimeError("missing under %s: %s" % (config.musetalk_dir, ", ".join(missing)))
            return "all %d expected files under %s/models" % (len(MUSETALK_WEIGHT_FILES), config.musetalk_dir)
        missing = [path for path in (config.ditto_cfg_pkl, config.ditto_data_root) if not os.path.exists(path)]
        if missing:
            raise RuntimeError("missing: %s" % ", ".join(missing))
        return "%s + %s" % (config.ditto_cfg_pkl, config.ditto_data_root)

    def check_tts():
        try:
            speech = SpeechPipeline(config.tts_voice)
            audio, rate = speech.synthesize("The transport is ready.")
        except SpeechUnavailable as error:
            if config.kind == "cpu":
                raise _Skip("%s (cpu tier passes without TTS)" % error)
            raise
        return "%.2fs, %d samples @ %d Hz, voice %s" % (len(audio) / float(rate), len(audio), rate, config.tts_voice)

    def check_audio_path():
        bus = AudioBus()
        buffer = bus.subscribe()
        tone = (0.5 * np.sin(2.0 * np.pi * 440.0 * np.arange(TTS_SAMPLE_RATE // 2) / TTS_SAMPLE_RATE)).astype(
            np.float32
        )
        bus.push(tone, TTS_SAMPLE_RATE)
        produced = len(buffer)
        payload = bus.read(buffer, AUDIO_BYTES_PER_FRAME)
        peak = int(np.abs(np.frombuffer(payload, dtype=np.int16)).max())
        if produced < AUDIO_BYTES_PER_FRAME:
            raise RuntimeError("resampler produced only %d bytes for 0.5s of tone" % produced)
        if peak < 1000:
            raise RuntimeError("first 20ms frame is near-silent (peak %d) — resample path is broken" % peak)
        return "0.5s tone -> %d bytes of 48 kHz s16 stereo, first-frame peak %d" % (produced, peak)

    def check_frame():
        generator = build_generator(config)

        async def probe():
            await generator.start()
            return await generator.frame(0.0)

        try:
            frame = asyncio.run(probe())
        finally:
            generator.close()
        if frame is None or getattr(frame, "ndim", 0) != 3 or frame.shape[2] != 3:
            raise RuntimeError("generator returned a non-BGR frame: %r" % (getattr(frame, "shape", frame),))
        return "%dx%d bgr24 from %s generator" % (frame.shape[1], frame.shape[0], config.kind)

    check("python >= 3.10", check_python, "install python3.10+ on the box (bootstrap.sh assumes it)")
    check("ffmpeg on PATH", check_ffmpeg, "apt-get install -y ffmpeg")
    check("espeak-ng on PATH", check_espeak)
    check("transport imports (av/aiortc/aiohttp/opencv/numpy)", check_transport,
          "pip install -r requirements.txt")
    check("torch + CUDA", check_torch,
          "bash bootstrap.sh installs the cu121 wheel; check nvidia-smi and that .venv is activated")
    check("source art readable", check_source,
          "set SOURCE=/path/to/art (image or short video); bootstrap.sh copies ../public/footage/reference.mp4")
    check("model weights present", check_weights,
          "GENERATOR=%s bash bootstrap.sh downloads the weight set (repo ids are printed as it runs)" % config.kind)
    check("TTS synthesizes one sentence", check_tts,
          "pip install kokoro soundfile && apt-get install -y espeak-ng")
    check("audio playout path (resample -> 48 kHz s16 stereo)", check_audio_path,
          "pip install --force-reinstall av")
    check("one frame generated end-to-end", check_frame,
          "read the error above — this is the full model-load + preprocess + frame path")

    if state["failures"]:
        print("\nSELFTEST FAIL — %d check(s) failed. Fix and re-run: python server.py --selftest" % state["failures"])
        return 1
    print("\nSELFTEST PASS — box is ready. Launch: GENERATOR=%s python server.py  (port %d)" % (config.kind, config.port))
    return 0


# --------------------------------------------------------------------------- #
# Entrypoint                                                                  #
# --------------------------------------------------------------------------- #


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    config = resolve_config()
    if config.selftest:
        sys.exit(run_selftest(config))
    generator = build_generator(config)
    bus = AudioBus()
    speech = SpeechPipeline(config.tts_voice)
    router = CommandRouter(generator, speech, bus)
    app = build_app(generator, bus, router)
    log.info(
        "matrix-host GPU server — generator=%s source=%s port=%d voice=%s fps=%d",
        config.kind, config.source, config.port, config.tts_voice, config.fps,
    )
    web.run_app(app, host="0.0.0.0", port=config.port)


if __name__ == "__main__":
    main()
