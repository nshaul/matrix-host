# Matrix Host GPU streaming server — CPU/transport-only image (GENERATOR=cpu).
# Model tiers (musetalk/ditto) build from ./Dockerfile.gpu instead.
# Place reference.mp4 next to this file before building (bootstrap.sh copies it
# from ../public/footage on a checkout).
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 ffmpeg espeak-ng && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py .
COPY reference.mp4 .

EXPOSE 8788
CMD ["python", "server.py"]
