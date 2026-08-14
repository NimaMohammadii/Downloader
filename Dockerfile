FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    DENO_INSTALL=/usr/local

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deno.land/install.sh | sh

RUN python -m pip install --no-cache-dir -U "yt-dlp[default]" requests

WORKDIR /app
COPY container/app.py /app/app.py

EXPOSE 8080
CMD ["python", "/app/app.py"]
