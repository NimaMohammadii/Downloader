FROM node:22-bookworm-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PATH="/opt/venv/bin:$PATH"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       python3 python3-venv python3-pip ffmpeg git ca-certificates tini \
       build-essential pkg-config libcairo2-dev libpango1.0-dev libjpeg62-turbo-dev libgif-dev librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -U pip \
    && /opt/venv/bin/pip install --no-cache-dir -U "yt-dlp[default]" requests "bgutil-ytdlp-pot-provider==1.3.1"

RUN git clone --depth 1 --branch 1.3.1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil \
    && cd /opt/bgutil/server \
    && npm ci \
    && npx tsc

WORKDIR /app
COPY container/app.py /app/app.py
COPY container/start.sh /app/start.sh
RUN chmod +x /app/start.sh

EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/start.sh"]
