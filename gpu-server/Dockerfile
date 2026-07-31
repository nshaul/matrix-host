# Matrix Host GPU streaming server.
# CPU plumbing image; for model adapters start FROM a CUDA base instead:
#   FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py .
COPY reference.mp4 .

EXPOSE 8788
CMD ["python", "server.py"]
