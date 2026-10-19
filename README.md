# Telegram Instagram Downloader

Telegram bot with Instagram delivery on Cloudflare Workers and full YouTube downloads in a Cloudflare Container.

Production endpoint:

`https://downloader.vexaagent.workers.dev`

## Architecture

Telegram -> Cloudflare Worker -> Instagram API/CDN -> Telegram

Stories, Highlights and ordinary Instagram posts keep their existing Worker path. YouTube and Instagram Live/replay jobs use the existing Workflow and Container running yt-dlp, FFmpeg and Telethon.

## YouTube in bot chat

Send a YouTube video or Shorts URL, then select 360p, 480p, 720p, 1080p or audio. Only available qualities are offered. The complete file is delivered as one message, up to 2,000,000,000 bytes; larger files are rejected with a request to choose a lower quality. Unavailable fragments abort the download instead of producing incomplete videos.

Set Worker secrets `API_ID` and `API_HASH` from my.telegram.org alongside `BOT_TOKEN`. The Worker passes them to the Container environment; no user login or session string is needed. Telethon authenticates as the existing bot and preserves its HTTP webhook. Up to eight upload parts are in flight with bounded memory; each completed slot immediately takes the next part without waiting for a whole batch. All parts must finish before a file is published. YouTube fragment downloads also use eight concurrent requests. These are transfer optimizations, not a fixed speed guarantee.

The Docker image and Container/Workflow bindings must be deployed with `npx wrangler deploy`. A source commit alone does not activate this feature. Each Container uses `standard-4` (4 vCPU, 12 GiB RAM, 20 GB disk), the largest predefined instance type. There are up to 2 concurrent instances (8 vCPU in total for account quota checks); idle Containers sleep after ten seconds. Active HTTP transfers and the existing background capture lease protect unfinished work. Larger provisioned resources increase running costs; Cloudflare Container and Workflow charges apply.

The YouTube runtime matches ai-configa: image `friedrichrehren/yt-dlp:2026.08.19`, Deno, and isolated `web_embedded` then `android_vr` clients. Metadata loads the normal YouTube webpage/configuration; the selected client is reused when downloading. No browser token-provider service or floating prerelease yt-dlp install is used in this path. YouTube can still require authentication or reject a server's network; matching the runtime does not guarantee that every public video is accessible.

## Pornhub in bot chat

Send a direct Pornhub video URL (`view_video.php?viewkey=...` or `/embed/...`) on `pornhub.com`, `pornhub.org` or `pornhub.net`, including mobile/language subdomains. The bot downloads immediately using yt-dlp, preferring the best available resolution up to 1080p, and sends one complete MP4 through the existing Telegram sender. No new secrets or bindings are required. Deploy both the Worker and rebuilt Container to enable it.

The 2,000,000,000-byte limit still applies. Failed fragments, unreadable video and incomplete duration checks prevent sending a partial file. Private/deleted videos and login, region or server-access restrictions can prevent downloads. Channel, search and playlist links are not supported.

## X, Pinterest, TikTok, SoundCloud and Aparat in bot chat

Send an individual public post/track link, including `twitter.com`/`x.com`, regional Pinterest domains and the short links `pin.it`, `vm.tiktok.com`, `vt.tiktok.com`, `tiktok.com/t/...` and `on.soundcloud.com`. Optional commands are `/x URL`, `/pinterest URL`, `/tiktok URL` `/soundcloud URL` and `/aparat URL` (`/twitter URL` is also accepted).

- **X:** videos and animated GIFs, delivered as MP4. Multiple videos retain their order; `/video/2` selects that exact video. Photo-only tweets, Spaces and broadcasts are outside this route.
- **Pinterest:** photo/video Pins, carousel Pins and media exposed in an individual story Pin. Photos are decoded to Telegram-compatible JPEG; videos are remuxed to streamable MP4. External embedded sites, boards and profiles are not followed.
- **TikTok:** individual videos and photo posts, including ordered slideshows. Audio/cover sidecars are disabled, so a photo post does not produce an extra music file. A video extraction failure gets one gallery extractor fallback.
- **SoundCloud:** individual accessible full tracks, delivered as tagged 192 kbps MP3. Preview/snipped formats are filtered out; known duration shortfalls are rejected. This does not unlock Go+, subscription-only or private tracks. Profiles, sets and search links are not accepted.

These services reuse the existing event-driven media Workflow/Container and the same MTProto complete-file sender. No new API keys, bindings, buckets or application polling are added. Every item is resolved and cache misses are prepared before sending; up to 20 files and 2,000,000,000 bytes **combined output per request** are accepted. Requests have a 25-minute preparation budget after metadata resolution and a 25-minute send budget. Failed/ambiguous publishing stops a batch without automatic retries and reports the confirmed count; already-delivered files should be checked before repeating the request. Temporary files are removed during cleanup.

**Repeated video/audio requests:** fresh provider metadata and access checks still run, including Aparat download permissions and SoundCloud preview restrictions. A valid Telegram cache hit skips the media download, FFmpeg conversion and upload. Versioned cache keys bind the canonical post, exact item/index, audio/video mode, source asset identity and relevant metadata; rotating recognized CDN signing parameters do not invalidate an otherwise identical item. Cached output sizes keep the combined request limit, and the current requester gets a freshly signed audio button. Photos continue through ordinary preparation and are not cached. Older cache records without the new identity/size/audio information need one normal request to warm the new cache. Cache outages use the ordinary download path. If Telegram explicitly rejects a cached file ID, only that item is prepared from its freshly resolved metadata and uploaded within the remaining send budget. An ambiguous cached send stops without downloading or uploading a possible duplicate.

**Aparat:** send `https://www.aparat.com/v/VIDEO_ID` (embed links are normalized to the same video). The first-party HTTPS `video/show` API supplies the exact video ID, title, duration and MP4 renditions, avoiding the broken legacy embed extractor. The bot prefers an available rendition up to 1080p, verifies the complete file and sends MP4 through the same sender. Deleted videos, disabled downloads, absent renditions and off-platform CDN URLs are rejected. Profiles, playlists and live channels are not accepted.

**Audio from these videos:** a delivered X, TikTok, Pinterest or Aparat video with an audio stream offers **🎵 فقط صدا**. The signed callback binds the requesting user, chat, canonical source URL and exact media index; another user or a modified URL/index cannot activate it. The button is also attached on cached video deliveries. Send `/audio VIDEO_URL` directly to extract audio from the video's source; multi-video posts return each video audio in order, skipping photos. A button chooses only its own item. SoundCloud already returns MP3. Audio extraction creates tagged 192 kbps MP3s, validates duration, rejects silent videos/photos, and uses cache keys distinct from video output. No YouTube song search substitutes for the clip's actual audio. Existing Instagram `/audio` behavior is preserved.

The existing pinned yt-dlp/YouTube runtime is preserved. `gallery-dl==1.32.17` adds native Pinterest and TikTok gallery extraction in the same Container; rebuild/deploy both Worker and Container to activate it. Metadata output is bounded, individual source URLs are validated in Worker and Container, short-link redirects are checked before every hop, and direct media downloads are restricted to the relevant service's CDN hosts. Social yt-dlp calls honor the runtime OS certificate store with TLS verification enabled. Signed media URLs and provider responses are not logged.

Tests cover provider routing, exact large IDs, hostile redirects/hosts, real pinned extractor output for Pinterest/TikTok galleries, preview rejection, ordered/ambiguous uploads, and real FFmpeg JPEG/MP3/MP4 fixtures. Platform login, geographic/IP restrictions and upstream changes can still block a public link; production-IP extraction and Telegram delivery require a post-deployment check.

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

## Music search and Instagram audio

Send a song name and artist as plain text, or use `/music Adele Hello` (also `/song`). The bot searches up to five YouTube results, prefers a matching official audio/Topic result over unrequested covers/remixes, checks availability, downloads the audio through the existing client fallback, and sends one MP3 with title/artist metadata. The selected source URL appears in the caption. Specify the artist/version when a name is ambiguous; availability is not guaranteed.

Ordinary Instagram video posts/Reels and individual video Stories now offer a **🎵 فقط صدا** button. Use `/audio https://www.instagram.com/reel/SHORTCODE/` directly for a Reel/video post/TV, or a single video Story link. Carousel buttons select their own media item; the direct command accepts `?img_index=2` to select an item, otherwise it uses the first video. Photos and videos explicitly marked silent are rejected.

Instagram audio is delivered as M4A, music search as MP3. Both reuse the event-driven download job, FFmpeg validation and complete-file MTProto sender. No new secrets or bindings are needed. Ordinary Instagram URLs and YouTube quality selection retain their routes; non-command text without a URL is treated as a song search.

## Recognize music from an uploaded clip

Send a voice message, audio file, video, video note, or audio/video document in a private chat. In groups, reply to a file with `/shazam` or `/recognize`, or attach the file with that command as its caption. The bot identifies the song and artist, then uses the existing music search/download path to deliver a full MP3. Identification details remain visible if the full song cannot be downloaded.

Input clips are limited to 20 MB because this path uses Telegram Bot API `getFile`. Send a clear 10–30-second excerpt; files without audio, silence and clips shorter than 3 seconds are rejected. FFmpeg reads at most the first 36 seconds and produces up to three 12-second mono windows. Shazam receives audio fingerprints through ShazamIO, with one request per window and a 25-second timeout; processing stops on the first match or a service error. Uploaded clips and temporary samples are deleted after recognition. A Telegram upload is only downloaded from the fixed Telegram file host, with streaming size checks and redirects disabled.

ShazamIO reuses the existing Workflow/Container and bot credentials; no Shazam account, Apple login or new API secret is required. It is an unofficial client, so service availability and rate limits are not guaranteed. The Dockerfile pins upstream revision `f94faafdabff9cdec258f3ac024a6402989e9040` (ShazamIO 0.9.0, `shazamio-core==2.0.0`) for Python 3.14-compatible ABI3 wheels. The published 0.8.1 package pins an older core without Python 3.14 wheels. The base downloader image and yt-dlp version remain unchanged. Rebuild/deploy the Container image to install the dependency.

Tests cover private/group routing, bounded real FFmpeg samples, service failures, input cleanup and the shared complete-file sender. A live Shazam request from the development environment was blocked by DNS resolution; recognition and Telegram delivery from the production Container IP still need a live clip after deployment.

## Instagram song identification

Video posts/Reels and individual video Stories offer **🔎 پیداکردن آهنگ** alongside audio extraction. Use `/findmusic INSTAGRAM_URL` or `/shazam INSTAGRAM_URL` directly. Carousel buttons keep the selected item; `?img_index=2` selects the second item in a direct link. The connected Instagram session resolves the accessible video, FFmpeg samples at most 36 seconds from its CDN, and ShazamIO identifies the recording before the existing full-MP3 delivery path runs. Photos, silent clips, no-match and service failures remain explicit. No new login or API secret is required.

## YouTube playlists

Send a public `https://www.youtube.com/playlist?list=...` URL, or `/playlist URL`. Each request sends up to 20 tracks as separate MP3s in playlist order. Use `/playlist URL 21-40` for another range (maximum 20 items per request, indices 1–10000). A watch URL with `list=` keeps its single-video quality selector unless `/playlist` is explicit. Track URLs come from the playlist's exact video IDs, without a text search substitution.

The existing event-driven media job sends one track at a time and removes that track's temporary files before the next. Private/unavailable entries are skipped and reported by position. Stop with **⏹ توقف پلی‌لیست**; a download already in progress may take time to finish, and pending tracks are not sent after the stop is observed. The queue has a 90-minute budget between items, in addition to existing per-file timeouts. An ambiguous Telegram send stops the queue without retrying that item. The final message reports delivered/failed positions and offers an appropriate next range when needed. A Container rollout can interrupt an unfinished playlist; it does not resume automatically.

## Telegram file reuse

Successful video/audio uploads save a reusable Telegram `file_id` with bounded display metadata in the existing `ADMIN_STATS` Durable Object class, using a separate named instance per bot. No new binding, storage bucket or raw media archive is added. Entries expire after 30 days and the store keeps at most 10,000 keys. User/chat IDs and reply context are excluded from the cached payload.

Repeated YouTube quality selections, song-name searches and playlist tracks reuse the matching Telegram file without source download or file re-upload. Ordinary Instagram video posts/Stories also reuse Telegram IDs after their existing source-resolution checks; Instagram audio, published replay links and identified songs have per-requester keys. Public YouTube MP3s use a separate cache key from M4A and each video resolution. Live recordings are always new captures. A stale Telegram file ID is evicted and falls back to normal download; ambiguous delivery errors do not trigger a duplicate upload. Cache access uses an authenticated internal endpoint, and cache outages fall back to normal downloading. Existing metadata/Instagram access checks and cold starts on a cache miss can still take time.

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

Set a fresh random `WEBHOOK_SECRET` as a Cloudflare Worker secret (32–256 characters, using letters, digits, `_` or `-`). Then register **the same value** as Telegram's `setWebhook.secret_token`. The former verification value was committed publicly and must be rotated; it cannot authenticate a trusted Telegram sender.

For compatibility, installations without `WEBHOOK_SECRET` still accept the former value until rotation. Once `WEBHOOK_SECRET` is set, every active handler rejects that old value. Merely deploying this code does **not** complete rotation. `/health` reports `webhookSecretConfigured`; it cannot verify Telegram's remote setting.

With `BOT_TOKEN` and the same `WEBHOOK_SECRET` supplied privately in your local environment, run `npm run webhook:set` after deploying the Worker secret. The script registers the existing URL, keeps pending updates, times out after 20 seconds, and does not print credentials. Coordinate the two settings: deliveries using the old value will be rejected between changing the Worker secret and registering Telegram's new value. Do not store either credential in GitHub or command-line arguments.

## Repository audit checks

`src/app-main.ts` is the production entry point. Chat downloads use the existing Worker/Workflow/Container chain. The web and Mini App pages are served, but their `/web/*` and `/mini-app/*` backend routes are explicitly disabled with 503 responses; the older Mini App Python entry points are not copied into the production image. This audit does not enable those backends.

YouTube file jobs now share a 25-minute deadline across extraction, both client attempts, conversion and upload, leaving cleanup/reporting time within the 30-minute Workflow step. Timed-out downloader subprocess groups are terminated, including FFmpeg children. The single-video route canonicalizes watch/Shorts/live/embed links and rejects channel/profile/search pages before extraction; `--no-playlist` alone does not prevent channel scans. Playlist links retain their separate bounded route. A Telegram send interrupted at an ambiguous point is not automatically replayed; check the chat before requesting it again.

Instagram audio and song identification have separate deterministic job IDs, so either button can be used once on the same source message. Both retain authenticated completion/cache routes and reply to that source message. Cached Instagram audio/replays/identified songs require a fresh successful source access check; public song-query reuse remains fast.

Local checks: `npm run check`; `node --test tests/*.test.mjs`; and `python -m unittest discover -s tests -p 'test_*.py' -q` in an environment with the Dockerfile's Python dependencies and FFmpeg installed. Tests use local media fixtures and simulated provider/Telegram responses. They do not establish live production-IP extraction, Instagram session validity, Shazam availability or an actual Telegram delivery.

Only download content when you have permission to do so and comply with the source platform's applicable terms.
