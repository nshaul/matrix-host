#!/usr/bin/env bash
# =============================================================================
# matrix-host GPU box bootstrap — idempotent; re-run any time, it only fills gaps.
#
# Day-1 on a fresh box (RunPod PyTorch template or bare Ubuntu):
#   git clone https://github.com/nshaul/matrix-host && cd matrix-host/gpu-server
#   GENERATOR=musetalk bash bootstrap.sh     # ends with the readiness selftest
#   source .venv/bin/activate && GENERATOR=musetalk python server.py
#
# Env passthrough (all optional):
#   GENERATOR      cpu | musetalk | ditto   (default cpu — transport-only tier)
#   SOURCE         source art, image/video  (default reference.mp4; auto-copied
#                                            from ../public/footage when absent)
#   PORT           signalling port          (default 8788 — used in the launch line)
#   TTS_VOICE      Kokoro voice id          (default af_heart)
#   MUSETALK_DIR   MuseTalk checkout        (default ./MuseTalk)
#   DITTO_DIR      ditto-talkinghead checkout (default ./ditto-talkinghead)
#   SKIP_VENV=1    install into the current python env (Docker builds)
#   SKIP_SELFTEST=1  skip the final selftest (Docker build stage has no GPU)
#   HF_TOKEN       optional Hugging Face token — every repo used here is public
#
# External repos/weights this script touches (audit list):
#   github.com/TMElyralab/MuseTalk            (MIT code)
#   hf.co/TMElyralab/MuseTalk                 (musetalk v1.5 weights, commercial-ok)
#   hf.co/stabilityai/sd-vae-ft-mse           (VAE, fills gap if not in the above)
#   hf.co/openai/whisper-tiny                 (audio features)
#   hf.co/yzd-v/DWPose                        (dw-ll_ucoco_384.pth, face/pose prep)
#   download.pytorch.org resnet18-5c106cde.pth (face-parse backbone)
#   github.com/antgroup/ditto-talkinghead     (Apache-2.0 code)
#   hf.co/digital-human/ditto-talkinghead     (ditto checkpoints)
#   download.pytorch.org/whl/cu121            (torch wheels, only when missing)
# =============================================================================
set -euo pipefail

say() { printf '\n[bootstrap] %s\n' "$*"; }
die() { printf '\n[bootstrap] FATAL: %s\n' "$*" >&2; exit 1; }

cd "$(dirname "${BASH_SOURCE[0]}")"

GENERATOR="${GENERATOR:-cpu}"
SOURCE="${SOURCE:-reference.mp4}"
PORT="${PORT:-8788}"
MUSETALK_DIR="${MUSETALK_DIR:-./MuseTalk}"
DITTO_DIR="${DITTO_DIR:-./ditto-talkinghead}"

case "$GENERATOR" in
  cpu|musetalk|ditto) ;;
  *) die "unknown GENERATOR '$GENERATOR' — valid: cpu, musetalk, ditto" ;;
esac
say "generator tier: $GENERATOR"

# ---------------------------------------------------------------- apt deps ---
# git ffmpeg espeak-ng libgl1 libglib2.0-0: transport + TTS fallback + opencv.
if command -v apt-get >/dev/null 2>&1; then
  APT=""
  if [ "$(id -u)" -eq 0 ]; then
    APT="apt-get"
  elif command -v sudo >/dev/null 2>&1; then
    APT="sudo apt-get"
  fi
  if [ -n "$APT" ]; then
    say "installing apt packages (git ffmpeg espeak-ng libgl1 libglib2.0-0 python3-venv python3-pip)"
    $APT update -y
    DEBIAN_FRONTEND=noninteractive $APT install -y --no-install-recommends \
      git ffmpeg espeak-ng libgl1 libglib2.0-0 python3-venv python3-pip ca-certificates curl
  else
    say "not root and no sudo — skipping apt; ensure these exist: git ffmpeg espeak-ng libgl1 libglib2.0-0"
  fi
else
  say "no apt-get on this box — assuming git/ffmpeg/espeak-ng are already installed"
fi

# -------------------------------------------------------------------- venv ---
# --system-site-packages keeps the RunPod PyTorch template's torch visible
# inside the venv instead of reinstalling 2.5 GB of wheels.
if [ "${SKIP_VENV:-0}" != "1" ]; then
  if [ ! -d .venv ]; then
    say "creating .venv (python3 -m venv --system-site-packages)"
    python3 -m venv --system-site-packages .venv
  fi
  # shellcheck disable=SC1091
  source .venv/bin/activate
  say "venv active: $(command -v python)"
else
  say "SKIP_VENV=1 — installing into the current environment: $(command -v python3 || true)"
fi
PYTHON="$(command -v python || command -v python3)" || die "no python on PATH"

# ------------------------------------------------------------------- torch ---
# Detect existing torch+CUDA (RunPod PyTorch template ships it) and skip the
# install; otherwise install the cu121 wheel when a GPU is present. On a
# GPU-less box we install nothing here — CPU torch arrives as a kokoro
# dependency if TTS is used.
TORCH_STATE="$("$PYTHON" - <<'PY'
try:
    import torch
    print("cuda" if torch.cuda.is_available() else "cpu")
except Exception:
    print("none")
PY
)"
"$PYTHON" -m pip install --upgrade pip >/dev/null
if [ "$TORCH_STATE" = "cuda" ]; then
  say "torch with CUDA already present — skipping torch install"
elif command -v nvidia-smi >/dev/null 2>&1; then
  say "GPU present but no CUDA torch — installing cu121 wheels (torch/torchvision/torchaudio)"
  "$PYTHON" -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121 \
    || die "torch cu121 install failed — check https://pytorch.org/get-started/locally/ for the current wheel matrix"
elif [ "$TORCH_STATE" = "cpu" ]; then
  say "torch present without CUDA and no GPU detected — leaving it (cpu tier / TTS still work)"
else
  say "no GPU detected and no torch — skipping explicit install (kokoro pulls CPU torch if TTS is used)"
fi

# ------------------------------------------------------------- python deps ---
say "installing transport deps (requirements.txt)"
"$PYTHON" -m pip install -r requirements.txt
say "installing model/TTS deps (requirements-gpu.txt)"
"$PYTHON" -m pip install -r requirements-gpu.txt

# ------------------------------------------------------------- HF download ---
# huggingface-cli download is resumable and idempotent — re-runs only fill gaps.
hf_dl() {
  repo="$1"; dest="$2"; shift 2
  say "downloading HF repo: $repo -> $dest"
  huggingface-cli download "$repo" --local-dir "$dest" "$@" \
    || die "download failed for HF repo '$repo' — it may have moved or been renamed. Find its new home and update bootstrap.sh; do NOT continue half-provisioned."
}

# ---------------------------------------------------- MuseTalk provisioning ---
if [ "$GENERATOR" = "musetalk" ]; then
  if [ ! -d "$MUSETALK_DIR/.git" ]; then
    say "cloning MuseTalk (MIT code; v1.5 weights cleared for commercial use)"
    git clone https://github.com/TMElyralab/MuseTalk "$MUSETALK_DIR" \
      || die "clone failed: https://github.com/TMElyralab/MuseTalk"
  else
    say "MuseTalk checkout already present: $MUSETALK_DIR"
  fi

  # MuseTalk's documented mm-stack install (their README): openmim resolves the
  # mmcv/mmdet/mmpose builds that match the installed torch.
  say "installing MuseTalk's mm-stack via openmim (mmengine, mmcv, mmdet, mmpose)"
  "$PYTHON" -m pip install --no-cache-dir -U openmim
  mim install mmengine        || die "mim install mmengine failed"
  mim install "mmcv==2.0.1"   || die "mim install mmcv==2.0.1 failed — mmcv builds against torch; see MuseTalk README for the torch/mmcv pairing"
  mim install "mmdet==3.1.0"  || die "mim install mmdet==3.1.0 failed"
  mim install "mmpose==1.1.0" || die "mim install mmpose==1.1.0 failed"

  MODELS_DIR="$MUSETALK_DIR/models"
  mkdir -p "$MODELS_DIR"
  if [ -f "$MODELS_DIR/musetalkV15/unet.pth" ]; then
    say "MuseTalk v1.5 unet already present — weight download will only fill gaps"
  fi

  # Prefer MuseTalk's own downloader when the repo ships one.
  MUSETALK_DL=""
  for candidate in download_weights.sh scripts/download_weights.sh; do
    if [ -f "$MUSETALK_DIR/$candidate" ]; then MUSETALK_DL="$candidate"; break; fi
  done
  if [ -n "$MUSETALK_DL" ]; then
    say "running MuseTalk's own weight downloader: $MUSETALK_DL"
    (cd "$MUSETALK_DIR" && bash "$MUSETALK_DL") \
      || die "MuseTalk's $MUSETALK_DL failed — a weight URL moved. Open the script, fix/download the failing item, re-run bootstrap. Do NOT continue half-provisioned."
  else
    say "no download script in the MuseTalk repo — provisioning weights directly (repo ids printed)"
    hf_dl "TMElyralab/MuseTalk" "$MODELS_DIR"
  fi

  # Fill any gaps the primary path left (older snapshots of the HF repo lacked
  # some sub-trees). Each gap names its canonical source.
  [ -f "$MODELS_DIR/sd-vae/config.json" ] \
    || hf_dl "stabilityai/sd-vae-ft-mse" "$MODELS_DIR/sd-vae"
  [ -f "$MODELS_DIR/whisper/config.json" ] \
    || hf_dl "openai/whisper-tiny" "$MODELS_DIR/whisper"
  [ -f "$MODELS_DIR/dwpose/dw-ll_ucoco_384.pth" ] \
    || hf_dl "yzd-v/DWPose" "$MODELS_DIR/dwpose"
  if [ ! -f "$MODELS_DIR/face-parse-bisent/resnet18-5c106cde.pth" ]; then
    say "downloading resnet18 backbone (download.pytorch.org)"
    mkdir -p "$MODELS_DIR/face-parse-bisent"
    curl -fL -o "$MODELS_DIR/face-parse-bisent/resnet18-5c106cde.pth" \
      https://download.pytorch.org/models/resnet18-5c106cde.pth \
      || die "resnet18-5c106cde.pth download failed (download.pytorch.org unreachable?)"
  fi
  [ -f "$MODELS_DIR/face-parse-bisent/79999_iter.pth" ] \
    || die "face-parse weight 79999_iter.pth is missing and the MuseTalk downloader did not provide it. It ships via the MuseTalk README's face-parsing link (Google Drive). Download it manually to $MODELS_DIR/face-parse-bisent/79999_iter.pth and re-run. Do NOT continue half-provisioned."
fi

# ------------------------------------------------------- Ditto provisioning ---
if [ "$GENERATOR" = "ditto" ]; then
  if [ ! -d "$DITTO_DIR/.git" ]; then
    say "cloning ditto-talkinghead (Apache-2.0)"
    git clone https://github.com/antgroup/ditto-talkinghead "$DITTO_DIR" \
      || die "clone failed: https://github.com/antgroup/ditto-talkinghead"
  else
    say "ditto checkout already present: $DITTO_DIR"
  fi
  hf_dl "digital-human/ditto-talkinghead" "$DITTO_DIR/checkpoints"
  [ -f "$DITTO_DIR/checkpoints/ditto_cfg/v0.4_hubert_cfg_pytorch.pkl" ] \
    || die "expected cfg checkpoints/ditto_cfg/v0.4_hubert_cfg_pytorch.pkl is missing after download — the HF repo digital-human/ditto-talkinghead reorganized. Inspect it, set DITTO_CFG_PKL/DITTO_DATA_ROOT accordingly, re-run. Do NOT continue half-provisioned."
  [ -d "$DITTO_DIR/checkpoints/ditto_pytorch" ] \
    || die "expected weights dir checkpoints/ditto_pytorch is missing after download — see message above."
fi

# ------------------------------------------------------------- source art ---
if [ ! -f "$SOURCE" ] && [ "$SOURCE" = "reference.mp4" ] && [ -f ../public/footage/reference.mp4 ]; then
  say "copying default source art from ../public/footage/reference.mp4"
  cp ../public/footage/reference.mp4 reference.mp4
fi
[ -f "$SOURCE" ] || say "WARNING: SOURCE '$SOURCE' not found — the selftest will fail its source check until you provide it"

# ---------------------------------------------------------------- selftest ---
if [ "${SKIP_SELFTEST:-0}" = "1" ]; then
  say "selftest skipped (SKIP_SELFTEST=1) — run it before serving: GENERATOR=$GENERATOR python server.py --selftest"
else
  say "running readiness selftest"
  GENERATOR="$GENERATOR" SOURCE="$SOURCE" PORT="$PORT" "$PYTHON" server.py --selftest
fi

say "READY. Launch:"
if [ "${SKIP_VENV:-0}" != "1" ]; then
  printf '  source .venv/bin/activate && GENERATOR=%s SOURCE=%s PORT=%s python server.py\n' "$GENERATOR" "$SOURCE" "$PORT"
else
  printf '  GENERATOR=%s SOURCE=%s PORT=%s python server.py\n' "$GENERATOR" "$SOURCE" "$PORT"
fi
