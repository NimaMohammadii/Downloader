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

The Docker image and Container/Workflow bindings must be deployed with `npx wrangler deploy`. A source commit alone does not activate this feature. Each Container uses `standard-2` (1 vCPU, 6 GiB RAM, 12 GB disk). There are up to 20 concurrent instances (20 vCPU of account quota, shared with other applications). This is a maximum, not 20 permanently running instances. The account must have sufficient quota for deployment. Idle Containers are destroyed after five minutes; an independent one-shot timer inside the Python HTTP server also exits after five minutes without requests or pending work, so a leaked SDK request counter cannot keep an idle instance running indefinitely. HTTP processing, background preparation/recording, and prepared files waiting for upload remain protected. Cleanup does not restart a stopped Container. Larger provisioned resources increase running costs; Cloudflare Container and Workflow charges apply.

The existing Workflow now reserves a slot from `DOWNLOAD_POOL`, a small SQLite Durable Object that never starts a Container. It packs work onto 20 stable Container IDs, up to five active jobs each (100 admission slots). Reservations and release tokens survive Workflow replays; signed stop callbacks look up their own assignment and never allocate a new host. Cached deliveries reserve no slot. Admission fails immediately when all slots are reserved; there is no waiting queue, heartbeat or polling. Normal success/failure releases the reservation in Workflow cleanup; abandoned reservations expire after four hours and are pruned on the next admission, beyond the existing maximum job lifetime. Do not force-terminate Workflows as ordinary capacity management.

The Python server independently enforces the same five-job limit across metadata inspection, downloads and background captures, rejecting excess work immediately. Prepared files hold their slot until cleanup; stopping or cleaning up one job does not affect other jobs. Concurrent startup calls share one boot. Each Container owns one Telethon bot connection on a dedicated event loop; concurrent uploads share that connection without sharing file IDs, part buffers, checksums or destinations. The authorized StringSession is stored privately in that Container's existing Durable Object and restored on the next cold start, avoiding repeated bot authorization for every file or idle shutdown. Different Containers never share an authorization key. Session writes require a per-Container HMAC capability, and saved sessions are invalidated when the bot/API credentials change; there is no public session read endpoint or shared SQLite session file. Each extraction has private metadata/client files; a bounded, five-minute in-memory catalog cache can warm a later request for the same video without sharing writable files. File bytes, chat destinations, stop signatures and temporary directories remain per job. Five jobs share the host's CPU, RAM and disk: the 100-slot limit is not a speed guarantee or a guarantee that 100 maximum-size files fit at once.

Telegram `FLOOD_WAIT` is a server restriction, not a Container capacity failure. Short waits use Telethon's existing RPC retry mechanism; longer, definitive single-file rejections return a safe-to-resume marker to the existing YouTube Workflow. The Workflow releases its Container reservation, sleeps durably for Telegram's specified duration, then acquires capacity and retries that rejected job automatically. A repeated restriction repeats this process without an application retry-count cap. Waiting does not consume the 25-minute transfer budget or require an active Container; file preparation may run again after the wait, and this is not a persistent media queue. There is no polling. Unknown waits, ambiguous sends and HTTP failures are never replayed. Diagnostics unwrap `InvokeWithoutUpdatesRequest`/layer wrappers to identify the actual RPC without logging arguments, bot tokens or session strings. Application code cannot remove Telegram's account/method limits. Existing transfer, file-size and capacity budgets still apply.

Deploy Worker, the `v7` pool namespace migration, and the rebuilt image together with `npx wrangler deploy`; no additional secrets are required. The account needs enough quota for all 20 Standard-2 instances plus other applications. If the Container update fails, the Worker upload alone is not a successful rollout; check the actual application configuration before sending downloads.

`/health` reports `downloadFixVersion: "pool-five-v1"` to identify the Worker code. This marker does not verify that the Container image rollout completed or that the account has free capacity. The Container startup log also includes `pool-five-v1`; deploy both Worker and Container, then inspect the actual application with `npx wrangler containers list` and `npx wrangler containers info APPLICATION_ID` if capacity errors persist. These are read-only checks; do not delete the application or its Durable Object namespace to clear an error.

The existing `friedrichrehren/yt-dlp:2026.08.19` base supplies Deno and FFmpeg, while the application venv pins the official stable release `yt-dlp[default]==2026.10.21`, including the matching EJS solver. The first extraction uses upstream's maintained default client selection, including the new Samsung TV client; bounded embedded/Safari compatibility attempts follow only if needed. The formerly forced Android VR route requires GVS attestation for its direct formats and is no longer used. Normal webpage/session setup and TLS verification stay enabled. No browser token-provider service or floating runtime update is introduced.

The five-minute, per-video catalog cache now serves repeated quality requests, and downloads reuse the complete catalog only when both video ID and extraction policy match. A cached 403/410 or unavailable format invalidates that exact cache entry and performs one fresh extraction before the remaining client fallbacks. It never retries a Telegram publish. Explicit 429/session rate-limit responses stop immediate client retries; authentication checks, expired source links, missing formats and genuine restrictions have separate diagnostics. Mixed client failures are not presented as proof of an IP ban. Startup logs identify `policy=upstream-catalog-v2` and the loaded yt-dlp version. These changes reduce avoidable failures and requests; a real YouTube account/IP restriction still cannot be guaranteed away by application code, and no login cookies or proxy are automatically supplied.

## Pornhub in bot chat

Send a direct Pornhub video URL (`view_video.php?viewkey=...` or `/embed/...`) on `pornhub.com`, `pornhub.org` or `pornhub.net`, including mobile/language subdomains. The bot uses the official [yt-dlp 2026.10.21 extractor](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.21) anonymously, selects the best available resolution and sends one complete MP4 through the shared Telegram sender. No imported browser cookies, login session, custom extractor plugin or session tag is used. Old `PORNHUB_COOKIES` secrets are ignored and can be removed from Cloudflare settings. Deploy both the Worker and rebuilt Container.

The official extractor handles its own requests, including browser impersonation through the base image's curl-cffi dependency. No parallel download engine is bundled. Public videos must be accessible from the download server; a successful browser playback does not establish access from Cloudflare. Explicit login restrictions and ambiguous redirects are reported without promising that anonymous access will work for every video.

Temporary metadata HTTP 502/503/504 failures receive at most two retries within the original 90-second budget. Authentication, redirect and rate-limit failures do not trigger those retries; Telegram sends are never replayed by this logic.

The 2,000,000,000-byte sender limit still applies; removing the quality ceiling does not remove Telegram's file limit. Failed fragments abort downloads; the output must be nonempty, have a readable video stream and a finite positive duration. When source duration is available, the output must also pass the duration completeness check. Missing source duration alone does not reject otherwise valid media. Private/deleted videos and login, region or server-access restrictions can prevent downloads. Channel, search and playlist links are not supported.

The source catalog is extracted once and loaded for the download, preserving its media URLs and request headers. A rejected/expired CDN link (403/410) gets one fresh extraction before upload; 429, authentication failures and ambiguous Telegram publishes are not replayed. yt-dlp uses the OS certificate store with TLS verification enabled. Metadata, download, FFmpeg probes and upload share the existing 25-minute job budget; timeout stops downloader child processes too, leaving time to report the failure within the 30-minute Workflow step.

Status-message edits are best effort: a deleted status message or an edit failure cannot discard a ready video. Failures now return a stage (`metadata`, `download`, `validation` or `upload`), a specific source code or sanitized exception diagnostic, and Telegram RPC method/wait information when available. Worker logs label these jobs `pornhub download rejected`, rather than hiding every non-user-visible exception behind `youtube download rejected` / `SOURCE_REJECTED`. The old generic log cannot establish whether an affected job failed on a status edit, extraction or Telegram upload; use the new diagnostics after deploying **both** Worker and rebuilt Container. Tests include the status-edit regression, real pinned yt-dlp/FFprobe delivery against a local video fixture, selection above 1080p, source-link refresh, deadlines, redaction and no replay of ambiguous uploads.

## X, Pinterest, TikTok, SoundCloud and Aparat in bot chat

Send an individual public post/track link, including `twitter.com`/`x.com`, regional Pinterest domains and the short links `pin.it`, `vm.tiktok.com`, `vt.tiktok.com`, `tiktok.com/t/...` and `on.soundcloud.com`. Optional commands are `/x URL`, `/pinterest URL`, `/tiktok URL` `/soundcloud URL` and `/aparat URL` (`/twitter URL` is also accepted).

- **X:** videos and animated GIFs, delivered as MP4. Multiple videos retain their order; `/video/2` selects that exact video. Photo-only tweets, Spaces and broadcasts are outside this route.
- **Pinterest:** photo/video Pins, carousel Pins and media exposed in an individual story Pin. Photos are decoded to Telegram-compatible JPEG; videos are remuxed to streamable MP4. External embedded sites, boards and profiles are not followed.

  The native extractor normally requests Pins without login. If a Pin opens in a logged-in browser but the server gets `NotFoundError`, that response does not prove deletion. Set the optional Worker secret `PINTEREST_COOKIES` to a complete Netscape cookies.txt export or Cookie-Editor JSON export (array or `{"cookies":[...]}`) from the Pinterest account that can view the Pin. It must contain an unexpired `_pinterest_sess`. Only Pinterest-domain cookies reach the existing extractor, through a private temporary file removed after metadata extraction; other providers keep their existing authentication. Deploy the updated Worker and Container once. Each new Pinterest job receives the current Worker secret directly; later secret changes or removal do not require restarting a running Container. The secret is not stored in Workflow job parameters. Logs expose only whether credentials were supplied/loaded, never their contents. Account access and server restrictions still apply; adding a secret is not a guarantee of access.
- **TikTok:** individual videos and photo posts, including ordered slideshows. Audio/cover sidecars are disabled, so a photo post does not produce an extra music file. A video extraction failure gets one gallery extractor fallback.
- **SoundCloud:** individual accessible full tracks, delivered as tagged 192 kbps MP3. Preview/snipped formats are filtered out; known duration shortfalls are rejected. This does not unlock Go+, subscription-only or private tracks. Profiles, sets and search links are not accepted.

These services reuse the existing event-driven media Workflow/Container and the same MTProto complete-file sender. No new API keys, bindings, buckets or application polling are added. Every item is resolved and cache misses are prepared before sending; up to 20 files and 2,000,000,000 bytes **combined output per request** are accepted. Requests have a 25-minute preparation budget after metadata resolution and a 25-minute send budget. Failed/ambiguous publishing stops a batch without automatic retries and reports the confirmed count; already-delivered files should be checked before repeating the request. Temporary files are removed during cleanup.

**Repeated video/audio requests:** fresh provider metadata and access checks still run, including Aparat download permissions and SoundCloud preview restrictions. A valid Telegram cache hit skips the media download, FFmpeg conversion and upload. Versioned cache keys bind the canonical post, exact item/index, audio/video mode, source asset identity and relevant metadata; rotating recognized CDN signing parameters do not invalidate an otherwise identical item. Cached output sizes keep the combined request limit, and the current requester gets a freshly signed audio button. Photos continue through ordinary preparation and are not cached. Older cache records without the new identity/size/audio information need one normal request to warm the new cache. Cache outages use the ordinary download path. If Telegram explicitly rejects a cached file ID, only that item is prepared from its freshly resolved metadata and uploaded within the remaining send budget. An ambiguous cached send stops without downloading or uploading a possible duplicate.

**Aparat:** send `https://www.aparat.com/v/VIDEO_ID` (embed links are normalized to the same video). The first-party HTTPS `video/show` API supplies the exact video ID, title, duration and MP4 renditions, avoiding the broken legacy embed extractor. The bot prefers an available rendition up to 1080p, verifies the complete file and sends MP4 through the same sender. Deleted videos, disabled downloads, absent renditions and off-platform CDN URLs are rejected. Profiles, playlists and live channels are not accepted.

**Audio from these videos:** a delivered X, TikTok, Pinterest or Aparat video with an audio stream offers **🎵 فقط صدا**. The signed callback binds the requesting user, chat, canonical source URL and exact media index; another user or a modified URL/index cannot activate it. The button is also attached on cached video deliveries. Send `/audio VIDEO_URL` directly to extract audio from the video's source; multi-video posts return each video audio in order, skipping photos. A button chooses only its own item. SoundCloud already returns MP3. Audio extraction creates tagged 192 kbps MP3s, validates duration, rejects silent videos/photos, and uses cache keys distinct from video output. No YouTube song search substitutes for the clip's actual audio. Existing Instagram `/audio` behavior is preserved.

The shared yt-dlp runtime is pinned as described above. `gallery-dl==1.32.17` adds native Pinterest and TikTok gallery extraction in the same Container; rebuild/deploy both Worker and Container to activate it. Metadata output is bounded, individual source URLs are validated in Worker and Container, short-link redirects are checked before every hop, and direct media downloads are restricted to the relevant service's CDN hosts. Social yt-dlp calls honor the runtime OS certificate store with TLS verification enabled. Signed media URLs and provider responses are not logged.

Tests cover provider routing, exact large IDs, hostile redirects/hosts, real pinned extractor output for Pinterest/TikTok galleries, preview rejection, ordered/ambiguous uploads, and real FFmpeg JPEG/MP3/MP4 fixtures. Platform login, geographic/IP restrictions and upstream changes can still block a public link; production-IP extraction and Telegram delivery require a post-deployment check.

## Supported Instagram links

Profile commands accept a username with or without `@`:

```text
/instastory username
/instapost username
اینستاگرام استوری username
اینستاگرام پست username
```

The Story command sends all currently accessible stories. The post command reads the profile timeline page by page using the logged-in web query from Instaloader 4.15.4 (`doc_id=28975909992013618`). Both use the existing Workflow and complete-file Instagram sender, one story/post at a time; albums retain their item order, overlapping profile pages are deduplicated, and durable checkpoints avoid repeating confirmed deliveries on replay. There is no application-level post-count cap. Account access, active-story availability, existing per-file limits and platform restrictions still apply. A security/rate rejection or an incomplete item stops the batch and reports confirmed partial progress. No extra session, service, Container binding or polling loop is added. Existing link requests keep their current routes.

- Instagram Reel
- Instagram video post
- Instagram carousel media
- Instagram Story
- Instagram Highlights
- Instagram Live recording
- Published Live replay

Reel/Post downloads use the configured Instagram session first. Without a session, they use anonymous access. A valid session is required for Stories when Instagram requires login.

Reel/Post videos above the 19 MB URL-delivery threshold (or with an unknown size) use the existing Instagram Container/Workflow and MTProto uploader, up to 2,000,000,000 bytes per video. Small posts retain direct Bot API URL delivery. A mixed carousel is handed off before sending any item, preserves its order and audio/music buttons, and streams one complete file at a time without transcoding. The current file is retained across a definitive Telegram FloodWait; confirmed earlier items are never replayed. Incomplete downloads and ambiguous sends stop the batch. This reuses the existing secrets and bindings; the Instagram session resolver and YouTube download/upload implementation are unchanged.

Post resolution uses the existing media-info APIs and the requested post's webpage. When the page contains only the app shell, its cookies/CSRF and optional LSD token are reused for one shortcode web-info GraphQL request (`doc_id=27128499623469141`, also used by Instaloader). This query can return public media even when mobile media-info requires login. No homepage bootstrap, embed request or other historical GraphQL chain is used. With a configured browser session, the session webpage/web-info and authenticated web media-info run before the existing mobile media-info fallback; a successful web lookup never sends those cookies as an Android API login. Anonymous mobile/page lookups remain fallbacks, so public throttling cannot prevent an available authenticated lookup. Explicitly rejected credentials are not reused; a public post can still resolve without them. Rate limits, feedback blocks and security challenges stop immediately, including JSON rejection bodies returned by webpage requests. Fresh state remains in the same request-local jar while anonymous cookies stay separate. IDs retain integer precision, page and GraphQL JSON are matched to that exact post, carousel order is preserved and video covers never replace missing video bytes. This ordering does not lift an Instagram account or server restriction.

The shared post request transport follows at most two HTTPS canonical redirects to the same post on Instagram's web hosts, retaining response cookies within a 12-second request timeout. It never follows external, unrelated-post or account redirects. Explicit session-page login rejection, security challenges or consent requirements stop further account attempts. A redirect to the homepage or a generic account page is logged as a redirect, without asserting that verification/consent is required or preventing the remaining existing media-info attempts. API error JSON is classified even on HTTP 400/401/403; rate limits stop immediately. Logs contain stable codes and a bounded attempt list, excluding credentials, response bodies and redirect query strings. This does not renew an invalid session or complete account verification/consent: genuine account requirements must be completed in Instagram before the configured session can work. Account access and real-source delivery require a post-deployment check.

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

Send a song name and artist as plain text, or use `/music Adele Hello` (also `/song`). The bot lists up to five YouTube results with titles, channels/artists and available durations, ranked to prefer matching official audio/Topic results over unrequested covers/remixes. Choose a result to download that exact video as MP3 with title/artist metadata and its source URL in the caption. An unavailable selection fails explicitly instead of substituting another song. Buttons are signed, requester/chat-bound and expire after 24 hours. Search results are never replaced by a cached song; the container is released after listing results and is not held while waiting for a choice. Recognition from clips keeps its existing automatic full-song delivery.

Ordinary Instagram video posts/Reels and individual video Stories now offer a **🎵 فقط صدا** button. Use `/audio https://www.instagram.com/reel/SHORTCODE/` directly for a Reel/video post/TV, or a single video Story link. Carousel buttons select their own media item; the direct command accepts `?img_index=2` to select an item, otherwise it uses the first video. Photos and videos explicitly marked silent are rejected.

Instagram audio is delivered as M4A, selected music as MP3. Both reuse the event-driven download job, FFmpeg validation and complete-file MTProto sender. No new secrets or bindings are needed. Ordinary Instagram URLs and YouTube quality selection retain their routes; non-command text without a URL is treated as a song search.

Text replies across the Worker and container use a bounded presentation effect: private-chat sends preview the complete text with Telegram's native `sendMessageDraft`, then persist the original message and buttons. Unformatted edits use one short partial-text transition before the complete edit. Native rendering depends on the Telegram client; formatted edits, media captions, short messages and rapid updates keep normal delivery. Optional effects are limited to one per chat every three seconds within each process, respect preview `retry_after` responses and time out quickly; preview failure still proceeds to the original complete send/edit. There is no recurring animation or polling loop.

## Recognize music from an uploaded clip

Send a voice message, audio file, video, video note, or audio/video document in a private chat. In groups, reply to a file with `/shazam` or `/recognize`, or attach the file with that command as its caption. The bot identifies the song and artist, then uses the existing music search/download path to deliver a full MP3. Identification details remain visible if the full song cannot be downloaded.

Input clips are limited to 20 MB because this path uses Telegram Bot API `getFile`. Send a clear 10–30-second excerpt; files without audio, silence and clips shorter than 3 seconds are rejected. FFmpeg reads at most the first 36 seconds and produces up to three 12-second mono windows. Shazam receives audio fingerprints through ShazamIO, with one request per window and a 25-second timeout; processing stops on the first match or a service error. Uploaded clips and temporary samples are deleted after recognition. A Telegram upload is only downloaded from the fixed Telegram file host, with streaming size checks and redirects disabled.

ShazamIO reuses the existing Workflow/Container and bot credentials; no Shazam account, Apple login or new API secret is required. It is an unofficial client, so service availability and rate limits are not guaranteed. The Dockerfile pins upstream revision `f94faafdabff9cdec258f3ac024a6402989e9040` (ShazamIO 0.9.0, `shazamio-core==2.0.0`) for Python 3.14-compatible ABI3 wheels. The published 0.8.1 package pins an older core without Python 3.14 wheels. The base downloader image stays the same; the shared yt-dlp package is pinned separately above. Rebuild/deploy the Container image to install the dependency.

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

## Telegram admin panel

The configured admin can open `/admin` → «لیست کاربران». Users appear as paginated buttons; selecting one opens their profile, usage counts and paginated request history, with refresh and back buttons. Dates use Tehran time. Admin commands and callbacks remain restricted to `ADMIN_USER_ID`.

A visit begins with the first recorded interaction or an interaction after at least 30 minutes of inactivity. Returns are visits minus the first visit. Messages and callbacks count as interactions; `/start` is also counted separately. Authenticated Telegram `update_id` values deduplicate activity across delegated handlers and redeliveries for seven days. Link counts count messages containing supported links, separately from download requests and search queries.

History records the source, URL/query, available title, time, outcome, confirmed file count and failure explanation. YouTube inspection and its quality selection share one history entry. Successful delivery requires a successful Telegram send response; fetching the `/media` proxy alone no longer counts as delivery. Partial batches, song search results, pending requests and failures have separate labels. Requests without a final outcome after four hours show an unknown result rather than a guessed success or failure. A partially delivered playlist includes its confirmed file count and requested range.

### Download traffic and container usage (admin only)

`/admin` → **📊 مصرف، ترافیک و هزینه** shows confirmed file deliveries, known delivered bytes, cache deliveries, measured container RX/TX, cgroup CPU seconds, recorded container runtime and a gross USD cost estimate for all recorded usage, rolling 24 hours and rolling 7 days. Each user detail has the same report and retains the original list filter/back navigation. Existing lifetime download counters and history are preserved; unrecorded historical file sizes and resource usage cannot be reconstructed.

Measurements extend the existing AdminStatsStore, Container class and complete-file sender. Sample/delivery keys are persisted idempotently; concurrent jobs share measured resources by active-job count. Idle time and unidentified work belong only to global usage. CPU includes subprocesses via cgroup accounting. Network-interface counters include protocol/internal traffic and must not be treated as Cloudflare's billable egress. Missing measurements/unknown file sizes are labeled. Resource intervals crossing a reporting boundary are prorated; abrupt shutdown or a prolonged telemetry outage can lose the last measurements.

Runtime comes from persisted container lifecycle records, including idle time and currently open runs. Admin report refreshes sample only already-running instances through their existing port; they do not boot sleeping containers or renew idle timers. Reporting is event-driven with no polling; telemetry failures do not reject downloads or trigger another Telegram send.

The estimate uses the current `standard-2` configuration (6 GiB RAM, 12 GB disk), measured CPU and a region-dependent egress range. Rates were verified against [Cloudflare Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/) on 2026-10-20: $0.0000025/GiB-second RAM, $0.00000007/GB-second disk, $0.000020/vCPU-second, $0.025–$0.05/GB egress. Estimates are **before account-wide included usage**, and exclude the Workers plan, Workers requests, Durable Objects and logs; they are not invoices. Update the estimator if the instance type or rates change.

Deploy the Worker **and rebuilt container image together** with the existing `npm run deploy` command. No new binding, migration tag, external billing token or manually entered secret is needed. The current per-container HMAC capability secures telemetry; only the existing admin can view reports. Recording begins after deployment, not at the date of the previous download history.


The existing users, link totals and global success counter are preserved. New tables are created automatically in the existing SQLite Durable Object; no new binding or class migration is required. Visits and per-user download history start when this version runs and cannot reconstruct previously unrecorded activity. History is retained without automatic deletion; activity deduplication and the existing media cache keep their own expiry policies. Recording outages do not block downloads; missing final records remain visibly unresolved.

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

YouTube file jobs share a 25-minute deadline across extraction, bounded client attempts, conversion and upload, leaving cleanup/reporting time within the 30-minute Workflow step. Timed-out downloader subprocess groups are terminated, including FFmpeg children. The single-video route canonicalizes watch/Shorts/live/embed links and rejects channel/profile/search pages before extraction; `--no-playlist` alone does not prevent channel scans. Playlist links retain their separate bounded route. A Telegram send interrupted at an ambiguous point is not automatically replayed; check the chat before requesting it again.

Instagram audio and song identification have separate deterministic job IDs, so either button can be used once on the same source message. Both retain authenticated completion/cache routes and reply to that source message. Cached Instagram audio/replays/identified songs require a fresh successful source access check; public song-query reuse remains fast.

Local checks: `npm run check`; `node --test tests/*.test.mjs`; and `python -m unittest discover -s tests -p 'test_*.py' -q` in an environment with the Dockerfile's Python dependencies and FFmpeg installed. Tests use local media fixtures and simulated provider/Telegram responses. They do not establish live production-IP extraction, Instagram session validity, Shazam availability or an actual Telegram delivery.

Only download content when you have permission to do so and comply with the source platform's applicable terms.
