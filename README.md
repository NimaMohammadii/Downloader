# Telegram Instagram Downloader

Telegram bot with Instagram delivery on Cloudflare Workers and full YouTube downloads in a Cloudflare Container.

Production endpoint:

`https://downloader.vexaagent.workers.dev`

## Architecture

Telegram -> Cloudflare Worker -> Instagram API/CDN -> Telegram

Stories, Highlights and ordinary Instagram posts keep their existing Worker path. YouTube and Instagram Live/replay jobs use the existing Workflow and Container running yt-dlp, FFmpeg and Telethon.

## YouTube in bot chat

Send a YouTube video or Shorts URL, then select 360p, 480p, 720p, 1080p or audio. Only available qualities are offered. The complete file is delivered as one message, up to 2,000,000,000 bytes; larger files are rejected with a request to choose a lower quality. Unavailable fragments abort the download instead of producing incomplete videos.

Set Worker secrets `API_ID` and `API_HASH` from my.telegram.org alongside `BOT_TOKEN`. The Worker passes them to the Container environment; no user login or session string is needed. Telethon authenticates as the existing bot and preserves its HTTP webhook. Eight upload parts are in flight at a time with bounded memory; YouTube fragment downloads also use eight concurrent requests. These are transfer optimizations, not a fixed speed guarantee.

The Docker image and Container/Workflow bindings must be deployed with `npx wrangler deploy`. A source commit alone does not activate this feature. There are up to 20 Container instances and they sleep after five minutes idle; Cloudflare Container and Workflow charges apply.

The YouTube runtime matches ai-configa: image `friedrichrehren/yt-dlp:2026.08.19`, Deno, and isolated `web_embedded` then `android_vr` clients. Metadata loads the normal YouTube webpage/configuration; the selected client is reused when downloading. No browser token-provider service or floating prerelease yt-dlp install is used in this path. YouTube can still require authentication or reject a server's network; matching the runtime does not guarantee that every public video is accessible.

## Supported Instagram links

- Instagram Reel
- Instagram video post
- Instagram carousel media
- Instagram Story
- Instagram Highlights
- Instagram Live recording
- Published Live replay

Public Reel/Post downloads are attempted without an Instagram session first. A valid Instagram session can improve reliability and is required for Stories when Instagram requires login.

## Instagram Live and replay in bot chat

- Send a native `https://www.instagram.com/username/live/BROADCAST_ID/` link, or `/live username` to record an accessible active broadcast.
- Recording begins when the bot confirms that capture has started. Press **توقف ضبط و ارسال** to finalize and receive the video. Only the requesting Telegram user in the original chat can use the signed stop button; it stops the bot's recording, not the Instagram broadcast.
- Each recording ends automatically after 2 hours or 1.9 GB. A stalled feed finalizes after 90 seconds without media progress, and the caption identifies an interrupted recording. Earlier portions of a broadcast are not guaranteed.
- For a published replay, send `/replay https://www.instagram.com/reel/SHORTCODE/` (also supports `/p/` and `/tv/`). TV links are recognized directly. `/replay username` checks any replay exposed in that user's post-live feed; if unavailable, send the published video's link.
- The existing `INSTAGRAM_SESSIONID`, `BOT_TOKEN`, `API_ID` and `API_HASH` secrets are reused. The connected Instagram account must be able to view the source. No new secret, Container namespace or Workflow binding is required.
- Capture runs in the Container; a signed completion event resumes the Workflow, without application status polling. Idle protection applies only to the recording's isolated Container. Live/replay upload reuses the existing complete-file MTProto sender (2,000,000,000-byte cap).
- Replay download failures, timeouts, size overflow and known duration shortfalls are rejected instead of sending a partial replay. Live captures stopped by the user or a limit are sent with an explanatory caption.
- Container rollouts/restarts interrupt an active recording; temporary media is not durable across a restart. The bot reports the interruption. Container/Workflow usage is billable while recording.
- Validation covers route/authentication, exact IDs, callback ownership, event delivery, lifecycle, and real FFmpeg stop/remux and DASH audio/video fixtures. A live Instagram broadcast with the production account still requires an end-to-end check.

## Telegram delivery

Ordinary Instagram media does not show a download-link button. The Worker resolves the Instagram media and creates a short-lived signed media proxy URL. Telegram fetches that URL and posts the actual video/photo into the chat.

For this Worker media-proxy path, Telegram's Bot API remote-URL limits apply: currently 20 MB for videos/other content and 5 MB for photos. The Worker tries lower Instagram renditions when a larger rendition exceeds that limit.

## Required Cloudflare secret

`BOT_TOKEN`

Never commit the bot token to the repository.

## Optional Instagram secrets

For Story/Highlight/Live/replay support and content that Instagram gates behind login, add these as Cloudflare Worker secrets/environment variables:

- `INSTAGRAM_SESSIONID` — main required Instagram session cookie
- `INSTAGRAM_CSRFTOKEN` — optional but recommended when available
- `INSTAGRAM_DS_USER_ID` — optional

Do not commit Instagram cookies to GitHub.

## Deploy

Cloudflare build/deploy command:

`npx wrangler deploy`

After deploy open:

`https://downloader.vexaagent.workers.dev/health`

Expected shape:

```json
{
  "ok": true,
  "service": "telegram-instagram-downloader",
  "mode": "cloudflare-only",
  "botConfigured": true,
  "instagramSessionConfigured": false
}
```

`instagramSessionConfigured` becomes `true` after `INSTAGRAM_SESSIONID` is added.

## Telegram webhook

Webhook URL remains unchanged:

`https://downloader.vexaagent.workers.dev/telegram/webhook`

Webhook verification value remains:

`dlr_7Tz91mQX4pK8vN2sR6cH5bJ3wF9yUaE1`

You do not need to set the webhook again just because the downloader changed from YouTube to Instagram.

Only download content when you have permission to do so and comply with the source platform's applicable terms.
