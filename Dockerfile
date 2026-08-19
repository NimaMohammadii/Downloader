FROM node:22-bookworm-slim

LABEL vexa.youtube.image="audio-selection-v1"

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PATH=/opt/venv/bin:$PATH

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      ffmpeg \
      git \
      python3 \
      python3-pip \
      python3-venv \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -U pip \
    && /opt/venv/bin/pip install --no-cache-dir --pre -U \
      "yt-dlp[default,curl-cffi]" \
      requests \
      bgutil-ytdlp-pot-provider==1.3.1 \
    && mv /opt/venv/bin/yt-dlp /opt/venv/bin/yt-dlp-real

RUN git clone --depth 1 --branch 1.3.1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil \
    && cd /opt/bgutil/server \
    && npm ci \
    && npx tsc \
    && npm cache clean --force

WORKDIR /app
COPY container/youtube_app.py /app/youtube_app.py
COPY container/start.sh /app/start.sh
COPY container/yt-dlp-smart.sh /opt/venv/bin/yt-dlp
RUN chmod +x /app/start.sh /opt/venv/bin/yt-dlp

EXPOSE 8080
CMD ["/app/start.sh"]
