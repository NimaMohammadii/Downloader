# Keep the existing Deno/FFmpeg base; install the verified YouTube fixes below.
FROM docker.io/friedrichrehren/yt-dlp:2026.08.19

USER root
ENV PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PATH=/opt/venv/bin:$PATH

# Pin the Python 3.14-compatible ShazamIO revision; PyPI 0.8.1 pins an older CPython-only core.
RUN python3 -m venv --system-site-packages /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir \
      "yt-dlp[default,curl-cffi]==2026.10.21" "curl-cffi==0.16.0" \
      requests telethon==1.45.0 gallery-dl==1.32.17 \
    && /opt/venv/bin/pip install --no-cache-dir --only-binary=:all: cryptg==0.6.0 \
    && /opt/venv/bin/pip install --no-cache-dir \
      "https://github.com/shazamio/ShazamIO/archive/f94faafdabff9cdec258f3ac024a6402989e9040.zip" \
    && test "$(yt-dlp --version)" = "2026.10.21" \
    && deno --version \
    && ffmpeg -version >/dev/null \
    && /opt/venv/bin/python -c 'import requests, telethon, cryptg, shazamio, shazamio_core, gallery_dl, yt_dlp, yt_dlp_ejs; from yt_dlp.networking._curlcffi import CurlCFFIRH; assert CurlCFFIRH._SUPPORTED_IMPERSONATE_TARGET_MAP, "Browser impersonation unavailable"'

WORKDIR /app
COPY container/public_errors.json /app/public_errors.json
COPY container/youtube_app.py /app/youtube_app.py
COPY container/youtube_pipeline.py /app/youtube_pipeline.py
COPY container/pornhub.py /app/pornhub.py
COPY container/bandcamp.py /app/bandcamp.py
COPY container/reddit.py /app/reddit.py
COPY container/mini_pipeline.py /app/mini_pipeline.py
COPY container/mini_async_entry.py /app/mini_async_entry.py
COPY container/start.sh /app/start.sh
RUN chmod +x /app/start.sh

# The base image is a command-line downloader; run our HTTP server instead.
ENTRYPOINT []
EXPOSE 8080
CMD ["/app/start.sh"]
