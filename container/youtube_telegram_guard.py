import json
from contextlib import ExitStack
from pathlib import Path
from typing import Any

import youtube_app as app
import youtube_video_guard as video_guard

TELEGRAM_ASPECT_TOLERANCE = 0.08
TELEGRAM_FILE_SIZE_TOLERANCE = 0.12


def _presentation_geometry(path: Path) -> tuple[int, int, int, float] | None:
    probed = video_guard.probe_video_aspect(path)
    if probed is None:
        return None

    coded_width, coded_height, display_ratio = probed
    duration = max(0, int(round(app.probe_duration(path))))

    coded_ratio = coded_width / coded_height
    if abs(coded_ratio - display_ratio) / display_ratio <= 0.02:
        return coded_width, coded_height, duration, display_ratio

    # Telegram's sendVideo width/height are presentation metadata. If the file
    # uses non-square pixels, send display dimensions instead of coded pixels.
    if display_ratio >= 1.0:
        display_height = coded_height
        display_width = max(1, int(round(display_height * display_ratio)))
    else:
        display_width = coded_width
        display_height = max(1, int(round(display_width / display_ratio)))
    return display_width, display_height, duration, display_ratio


def _telegram_video_matches(result: Any, expected_ratio: float, local_size: int) -> bool:
    if not isinstance(result, dict):
        return True
    video = result.get("video")
    if not isinstance(video, dict):
        return True

    try:
        width = int(video.get("width") or 0)
        height = int(video.get("height") or 0)
    except (TypeError, ValueError):
        width = height = 0

    if width > 0 and height > 0:
        returned_ratio = width / height
        if abs(returned_ratio - expected_ratio) / expected_ratio > TELEGRAM_ASPECT_TOLERANCE:
            print(
                "telegram returned wrong aspect: "
                f"expected={expected_ratio:.4f} got={width}x{height}",
                flush=True,
            )
            return False

    try:
        remote_size = int(video.get("file_size") or 0)
    except (TypeError, ValueError):
        remote_size = 0
    if local_size > 0 and remote_size > 0:
        relative_delta = abs(remote_size - local_size) / local_size
        if relative_delta > TELEGRAM_FILE_SIZE_TOLERANCE:
            print(
                "telegram returned materially different video size: "
                f"local={local_size} remote={remote_size}",
                flush=True,
            )
            return False

    return True


def _delete_sent_message(token: str, chat_id: int, result: Any) -> None:
    if not isinstance(result, dict):
        return
    try:
        message_id = int(result.get("message_id") or 0)
    except (TypeError, ValueError):
        message_id = 0
    if message_id <= 0:
        return
    try:
        app.telegram_call(
            token,
            "deleteMessage",
            json_payload={"chat_id": chat_id, "message_id": message_id},
            timeout=60,
        )
    except Exception as exc:
        print(f"failed to delete malformed telegram video: {exc}", flush=True)


def _send_document(
    token: str,
    chat_id: int,
    request_message_id: int,
    path: Path,
    caption: str,
    *,
    reply: bool,
) -> None:
    data: dict[str, Any] = {
        "chat_id": str(chat_id),
        "caption": caption[:1024],
    }
    if reply:
        data["reply_parameters"] = json.dumps({"message_id": request_message_id})

    with path.open("rb") as handle:
        app.telegram_call(
            token,
            "sendDocument",
            data=data,
            files={"document": (path.name, handle, "video/mp4")},
            timeout=1_800,
        )


def send_media_file(
    token: str,
    chat_id: int,
    request_message_id: int,
    path: Path,
    caption: str,
    *,
    reply: bool,
) -> None:
    geometry = _presentation_geometry(path)
    if geometry is None:
        print("could not probe telegram video geometry; using document fallback", flush=True)
        _send_document(token, chat_id, request_message_id, path, caption, reply=reply)
        return

    width, height, duration, expected_ratio = geometry
    local_size = path.stat().st_size
    data: dict[str, Any] = {
        "chat_id": str(chat_id),
        "caption": caption[:1024],
        "supports_streaming": "true",
        "width": str(width),
        "height": str(height),
    }
    if duration > 0:
        data["duration"] = str(duration)
    if reply:
        data["reply_parameters"] = json.dumps({"message_id": request_message_id})

    print(
        "sending telegram video with explicit geometry: "
        f"{width}x{height} duration={duration}s size={local_size}",
        flush=True,
    )

    try:
        with ExitStack() as stack:
            video_handle = stack.enter_context(path.open("rb"))
            result = app.telegram_call(
                token,
                "sendVideo",
                data=data,
                files={"video": (path.name, video_handle, "video/mp4")},
                timeout=1_800,
            )

        if _telegram_video_matches(result, expected_ratio, local_size):
            return

        _delete_sent_message(token, chat_id, result)
        _send_document(token, chat_id, request_message_id, path, caption, reply=reply)
        return
    except Exception as video_error:
        print(f"telegram sendVideo failed; using original document: {video_error}", flush=True)
        try:
            _send_document(token, chat_id, request_message_id, path, caption, reply=reply)
            return
        except Exception as document_error:
            raise RuntimeError(
                f"Telegram upload failed: {video_error}; document fallback: {document_error}"
            ) from document_error


def install() -> None:
    video_guard.install()
    app.send_media_file = send_media_file


if __name__ == "__main__":
    install()
    server = app.ThreadingHTTPServer(("0.0.0.0", app.PORT), app.Handler)
    print(
        f"youtube downloader listening on :{app.PORT} "
        "(aspect + telegram geometry guards enabled)",
        flush=True,
    )
    server.serve_forever()
