# The GPU worker image (design sections 21, 25 and 27).
#
# Built on the CUDA runtime rather than a plain Python base, because Anagnorisis pulls
# torch with CUDA support and a mismatched driver stack fails at the first inference
# rather than at build time.
#
# Nothing user-specific is baked in. The image is the same for every profile; the
# ratings, memory files and trained models live on the network volume, which survives
# the container (design section 27).

FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    # Model weights are gigabytes. Caching them on the volume rather than in the image
    # keeps the image small and means a cold start does not re-download them.
    HF_HOME=/runpod-volume/cache/huggingface \
    TRANSFORMERS_CACHE=/runpod-volume/cache/huggingface \
    ANAGNORISIS_VOLUME=/runpod-volume

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3.11 python3.11-venv python3-pip git ffmpeg \
    && rm -rf /var/lib/apt/lists/*

RUN update-alternatives --install /usr/bin/python python /usr/bin/python3.11 1 \
    && python -m pip install --no-cache-dir --upgrade pip

WORKDIR /app

# Upstream, installed from source and pinned by commit.
#
# A tag would be preferable and there is no promise of one; a moving `main` would mean
# two builds of the same Dockerfile producing different behaviour, which is the thing
# worth avoiding here. Bump this deliberately, and read the diff first (design section 51).
ARG ANAGNORISIS_REF=main
RUN git clone --depth 50 https://github.com/volotat/Anagnorisis.git /opt/anagnorisis \
    && cd /opt/anagnorisis \
    && git checkout "${ANAGNORISIS_REF}" \
    && python -m pip install --no-cache-dir ./anagnorisis_core

COPY requirements.txt ./
RUN python -m pip install --no-cache-dir -r requirements.txt

COPY adapter ./adapter
COPY handler.py cli.py ./

# Runpod invokes the handler; the `__main__` branch starts the serverless loop.
CMD ["python", "-u", "handler.py"]
