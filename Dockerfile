# Match the yt-dlp + Deno + FFmpeg runtime used by ai-configa.
FROM docker.io/friedrichrehren/yt-dlp:2026.08.19

USER root
ENV PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PATH=/opt/venv/bin:$PATH

RUN python3 -m venv --system-site-packages /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir \
      requests telethon==1.45.0 \
    && /opt/venv/bin/pip install --no-cache-dir --only-binary=:all: cryptg==0.6.0 \
    && test "$(yt-dlp --version)" = "2026.08.19" \
    && deno --version \
    && ffmpeg -version >/dev/null \
    && /opt/venv/bin/python -c 'import requests, telethon, cryptg'

WORKDIR /app
COPY container/youtube_app.py /app/youtube_app.py
COPY container/youtube_pipeline.py /app/youtube_pipeline.py
COPY container/start.sh /app/start.sh
RUN chmod +x /app/start.sh

# The base image is a command-line downloader; run our HTTP server instead.
ENTRYPOINT []
EXPOSE 8080
CMD ["/app/start.sh"]
