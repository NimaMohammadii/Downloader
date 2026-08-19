import { getContainer } from "@cloudflare/containers";

type MiniAppEnv = {
  BOT_TOKEN: string;
  YOUTUBE_DOWNLOADER_CONTAINER: DurableObjectNamespace<any>;
};

type TelegramIdentity = {
  userId: number;
};

type MetadataResult = {
  ok: boolean;
  message?: string;
  title?: string;
  videoId?: string;
  qualities?: number[];
  audioAvailable?: boolean;
};

type PreparedResult = {
  ok: boolean;
  message?: string;
  fileId?: string;
  fileName?: string;
  mime?: string;
  size?: number;
};

const MINI_APP_PATH = "/mini-app";
const SESSION_RE = /^[A-Za-z0-9_-]{12,64}$/;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;
const FILE_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const DOWNLOAD_TTL_SECONDS = 15 * 60;
const INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60;
const encoder = new TextEncoder();

function bytesToHex(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacSha256(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data)));
}

async function validateTelegramInitData(initData: string, botToken: string): Promise<TelegramIdentity | null> {
  if (!initData || initData.length > 16_384) return null;

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash") || "";
  const authDate = Number(params.get("auth_date") || "0");
  if (!/^[a-f0-9]{64}$/i.test(receivedHash) || !Number.isSafeInteger(authDate) || authDate <= 0) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (authDate > now + 300 || now - authDate > INIT_DATA_MAX_AGE_SECONDS) return null;

  const entries = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = await hmacSha256(encoder.encode("WebAppData"), botToken);
  const expectedHash = bytesToHex(await hmacSha256(secret, dataCheckString));

  let valid = constantTimeEqual(expectedHash.toLowerCase(), receivedHash.toLowerCase());
  if (!valid && params.has("signature")) {
    const legacyCheck = entries
      .filter(([key]) => key !== "signature")
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    const legacyHash = bytesToHex(await hmacSha256(secret, legacyCheck));
    valid = constantTimeEqual(legacyHash.toLowerCase(), receivedHash.toLowerCase());
  }
  if (!valid) return null;

  try {
    const user = JSON.parse(params.get("user") || "{}") as { id?: unknown };
    const userId = Number(user.id);
    if (!Number.isSafeInteger(userId) || userId <= 0) return null;
    return { userId };
  } catch {
    return null;
  }
}

function miniContainerId(userId: number, sessionId: string): string {
  return `mini-${userId}-${sessionId}`;
}

function youtubeUrlFromInput(value: string): string | null {
  const matches = value.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  for (const raw of matches) {
    try {
      const parsed = new URL(raw.replace(/[),.!?\]}]+$/g, ""));
      const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
      const validHost =
        host === "youtu.be" ||
        host === "youtube.com" ||
        host.endsWith(".youtube.com") ||
        host === "youtube-nocookie.com" ||
        host.endsWith(".youtube-nocookie.com");
      if (validHost && (parsed.protocol === "https:" || parsed.protocol === "http:")) {
        return parsed.toString();
      }
    } catch {
      // Keep scanning pasted text.
    }
  }
  return null;
}

async function readSmallJson(request: Request): Promise<Record<string, unknown> | null> {
  const length = Number(request.headers.get("content-length") || "0");
  if (length > 32_768) return null;
  try {
    const body = (await request.json()) as unknown;
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function signDownload(botToken: string, payload: string): Promise<string> {
  return bytesToHex(await hmacSha256(encoder.encode(botToken), payload));
}

function fileSignaturePayload(userId: number, sessionId: string, fileId: string, expires: number): string {
  return `${userId}|${sessionId}|${fileId}|${expires}`;
}

function absoluteDownloadUrl(
  request: Request,
  userId: number,
  sessionId: string,
  fileId: string,
  expires: number,
  signature: string,
): string {
  const url = new URL(`${MINI_APP_PATH}/file`, request.url);
  url.searchParams.set("u", String(userId));
  url.searchParams.set("s", sessionId);
  url.searchParams.set("f", fileId);
  url.searchParams.set("e", String(expires));
  url.searchParams.set("sig", signature);
  return url.toString();
}

async function handleMetadata(request: Request, env: MiniAppEnv): Promise<Response> {
  const body = await readSmallJson(request);
  if (!body) return json({ ok: false, message: "Invalid request." }, 400);

  const initData = String(body.initData || "");
  const sessionId = String(body.sessionId || "");
  const source = youtubeUrlFromInput(String(body.url || ""));
  const identity = await validateTelegramInitData(initData, env.BOT_TOKEN);

  if (!identity) return json({ ok: false, message: "Open this Mini App from Telegram." }, 401);
  if (!SESSION_RE.test(sessionId) || !source) {
    return json({ ok: false, message: "Paste a valid YouTube link." }, 400);
  }

  const container = getContainer(
    env.YOUTUBE_DOWNLOADER_CONTAINER,
    miniContainerId(identity.userId, sessionId),
  );
  const response = await container.fetch(
    new Request("http://container/metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: source }),
    }),
  );

  if (!response.ok) return json({ ok: false, message: "Could not read this video." }, 502);
  const metadata = (await response.json()) as MetadataResult;
  if (!metadata.ok || !metadata.videoId) {
    return json({ ok: false, message: metadata.message || "Could not read this video." }, 200);
  }

  const qualities = Array.isArray(metadata.qualities)
    ? metadata.qualities.filter((value) => [360, 480, 720, 1080].includes(Number(value)))
    : [];

  return json({
    ok: true,
    title: metadata.title || "YouTube video",
    videoId: metadata.videoId,
    qualities,
    audioAvailable: Boolean(metadata.audioAvailable),
  });
}

async function handlePrepare(request: Request, env: MiniAppEnv): Promise<Response> {
  const body = await readSmallJson(request);
  if (!body) return json({ ok: false, message: "Invalid request." }, 400);

  const initData = String(body.initData || "");
  const sessionId = String(body.sessionId || "");
  const videoId = String(body.videoId || "");
  const quality = body.quality == null ? null : Number(body.quality);
  const audioMode = body.audioMode == null ? null : String(body.audioMode);
  const identity = await validateTelegramInitData(initData, env.BOT_TOKEN);

  if (!identity) return json({ ok: false, message: "Open this Mini App from Telegram." }, 401);
  if (!SESSION_RE.test(sessionId) || !VIDEO_ID_RE.test(videoId)) {
    return json({ ok: false, message: "This download session is invalid." }, 400);
  }
  const validQuality = quality != null && [360, 480, 720, 1080].includes(quality);
  const validAudio = audioMode === "low" || audioMode === "hq";
  if (validQuality === validAudio) {
    return json({ ok: false, message: "Choose one download format." }, 400);
  }

  const fileId = crypto.randomUUID().replace(/-/g, "");
  const container = getContainer(
    env.YOUTUBE_DOWNLOADER_CONTAINER,
    miniContainerId(identity.userId, sessionId),
  );
  const response = await container.fetch(
    new Request("http://container/mini/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: `https://www.youtube.com/watch?v=${videoId}`,
        fileId,
        quality: validQuality ? quality : undefined,
        audioMode: validAudio ? audioMode : undefined,
      }),
    }),
  );

  if (!response.ok) return json({ ok: false, message: "Could not prepare this file." }, 502);
  const prepared = (await response.json()) as PreparedResult;
  if (!prepared.ok || !prepared.fileId || !prepared.fileName) {
    return json({ ok: false, message: prepared.message || "Could not prepare this file." }, 200);
  }

  const expires = Math.floor(Date.now() / 1000) + DOWNLOAD_TTL_SECONDS;
  const payload = fileSignaturePayload(identity.userId, sessionId, prepared.fileId, expires);
  const signature = await signDownload(env.BOT_TOKEN, payload);

  return json({
    ok: true,
    fileName: prepared.fileName,
    size: Number(prepared.size || 0),
    mime: prepared.mime || "application/octet-stream",
    downloadUrl: absoluteDownloadUrl(
      request,
      identity.userId,
      sessionId,
      prepared.fileId,
      expires,
      signature,
    ),
  });
}

async function handleFile(request: Request, env: MiniAppEnv): Promise<Response> {
  const url = new URL(request.url);
  const userId = Number(url.searchParams.get("u") || "0");
  const sessionId = url.searchParams.get("s") || "";
  const fileId = url.searchParams.get("f") || "";
  const expires = Number(url.searchParams.get("e") || "0");
  const signature = url.searchParams.get("sig") || "";

  const now = Math.floor(Date.now() / 1000);
  if (
    !Number.isSafeInteger(userId) ||
    userId <= 0 ||
    !SESSION_RE.test(sessionId) ||
    !FILE_ID_RE.test(fileId) ||
    !Number.isSafeInteger(expires) ||
    expires < now ||
    expires > now + DOWNLOAD_TTL_SECONDS + 60 ||
    !/^[a-f0-9]{64}$/i.test(signature)
  ) {
    return new Response("Download link expired or invalid.", { status: 403 });
  }

  const expected = await signDownload(
    env.BOT_TOKEN,
    fileSignaturePayload(userId, sessionId, fileId, expires),
  );
  if (!constantTimeEqual(expected.toLowerCase(), signature.toLowerCase())) {
    return new Response("Download link expired or invalid.", { status: 403 });
  }

  const container = getContainer(
    env.YOUTUBE_DOWNLOADER_CONTAINER,
    miniContainerId(userId, sessionId),
  );
  const headers = new Headers();
  const range = request.headers.get("range");
  if (range) headers.set("range", range);

  const source = await container.fetch(
    new Request(`http://container/mini/file?fileId=${encodeURIComponent(fileId)}`, {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers,
    }),
  );
  if (!source.ok && source.status !== 206) {
    return new Response("File is no longer available. Prepare it again.", { status: 404 });
  }

  const outgoing = new Headers();
  for (const name of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "content-disposition",
  ]) {
    const value = source.headers.get(name);
    if (value) outgoing.set(name, value);
  }
  outgoing.set("cache-control", "private, no-store");
  outgoing.set("access-control-allow-origin", "https://web.telegram.org");
  outgoing.set("cross-origin-resource-policy", "cross-origin");
  outgoing.set("x-content-type-options", "nosniff");

  return new Response(request.method === "HEAD" ? null : source.body, {
    status: source.status,
    headers: outgoing,
  });
}

const MINI_APP_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no">
  <meta name="theme-color" content="#050505">
  <title>Vexa Downloader</title>
  <script src="https://telegram.org/js/telegram-web-app.js?63"></script>
  <style>
    :root{color-scheme:dark;--bg:#050505;--panel:#0b0b0b;--panel2:#101010;--text:#f5f5f5;--muted:#8f8f8f;--line:#202020;--soft:#141414;--white:#fff;--black:#050505}
    *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
    html,body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text",Inter,system-ui,sans-serif;min-height:100%;overflow-x:hidden}
    body:before{content:"";position:fixed;inset:-30%;pointer-events:none;background:radial-gradient(circle at 50% 15%,rgba(255,255,255,.07),transparent 28%),radial-gradient(circle at 85% 70%,rgba(255,255,255,.03),transparent 25%);animation:drift 12s ease-in-out infinite alternate}
    .app{position:relative;max-width:720px;margin:0 auto;padding:max(24px,env(safe-area-inset-top)) 18px max(28px,env(safe-area-inset-bottom));min-height:100vh}
    .top{display:flex;align-items:center;justify-content:space-between;margin-bottom:54px;animation:rise .6s ease both}
    .brand{display:flex;align-items:center;gap:10px;font-size:14px;font-weight:700;letter-spacing:.22em}.mark{width:28px;height:28px;border:1px solid #2a2a2a;border-radius:50%;display:grid;place-items:center;background:#0a0a0a}.mark svg{width:13px;height:13px}
    .live{display:flex;align-items:center;gap:7px;color:#777;font-size:12px}.dot{width:6px;height:6px;border-radius:50%;background:#eee;box-shadow:0 0 0 5px rgba(255,255,255,.05);animation:pulse 2s ease infinite}
    h1{font-size:clamp(36px,10vw,64px);line-height:.94;letter-spacing:-.055em;margin:0 0 18px;font-weight:650;max-width:620px;animation:rise .65s .05s ease both}
    .sub{color:var(--muted);font-size:15px;line-height:1.6;max-width:500px;margin:0 0 34px;animation:rise .65s .1s ease both}
    .inputShell{display:flex;align-items:center;gap:10px;padding:8px;border:1px solid var(--line);background:rgba(10,10,10,.88);border-radius:22px;transition:border-color .25s,transform .25s,background .25s;animation:rise .65s .15s ease both;backdrop-filter:blur(16px)}
    .inputShell:focus-within{border-color:#444;background:#0d0d0d;transform:translateY(-1px)}
    .linkIcon{width:42px;height:42px;border-radius:15px;background:#111;display:grid;place-items:center;flex:0 0 auto;color:#aaa}.linkIcon svg{width:18px;height:18px}
    input{min-width:0;flex:1;background:transparent;color:#fff;border:0;outline:0;font:inherit;font-size:15px;padding:12px 0}input::placeholder{color:#555}
    button{font:inherit;border:0;cursor:pointer}.go{height:46px;border-radius:16px;padding:0 18px;background:#fff;color:#050505;font-weight:650;transition:transform .18s,opacity .18s}.go:active,.primary:active,.save:active{transform:scale(.975)}button:disabled{opacity:.35;cursor:default}
    .message{min-height:22px;margin:12px 4px 0;color:#777;font-size:13px;transition:color .2s}.message.error{color:#e4e4e4}
    .result{margin-top:26px;border:1px solid var(--line);border-radius:26px;background:rgba(10,10,10,.9);overflow:hidden;opacity:0;transform:translateY(14px) scale(.99);pointer-events:none;transition:opacity .35s,transform .35s;backdrop-filter:blur(20px)}.result.show{opacity:1;transform:none;pointer-events:auto}
    .videoHead{padding:22px 22px 18px;border-bottom:1px solid var(--line)}.eyebrow{color:#686868;font-size:11px;letter-spacing:.14em;text-transform:uppercase;margin-bottom:10px}.title{font-size:18px;line-height:1.35;font-weight:580;letter-spacing:-.02em;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .section{padding:20px 22px}.label{font-size:12px;color:#777;margin-bottom:12px}.formats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.format{position:relative;text-align:left;padding:15px 15px 14px;border:1px solid #222;border-radius:17px;background:#0d0d0d;color:#d7d7d7;transition:border-color .2s,background .2s,transform .2s}.format span{display:block}.format .name{font-size:14px;font-weight:580}.format .desc{font-size:11px;color:#666;margin-top:4px}.format.selected{border-color:#eee;background:#f3f3f3;color:#090909;transform:translateY(-1px)}.format.selected .desc{color:#555}
    .primary,.save{width:100%;height:54px;border-radius:18px;background:#fff;color:#050505;font-weight:680;margin-top:18px;transition:transform .18s,opacity .18s}.save{margin-top:12px}
    .progress{display:none;margin-top:26px;border:1px solid var(--line);border-radius:26px;padding:24px;background:#090909}.progress.show{display:block;animation:rise .35s ease both}.progressTop{display:flex;align-items:center;gap:15px}.orb{position:relative;width:42px;height:42px;border-radius:50%;border:1px solid #262626;flex:0 0 auto}.orb:before{content:"";position:absolute;inset:5px;border-radius:50%;border:2px solid transparent;border-top-color:#fff;animation:spin 1s linear infinite}.progressTitle{font-size:15px;font-weight:600}.progressSub{font-size:12px;color:#666;margin-top:4px}.rail{height:2px;background:#171717;margin-top:20px;overflow:hidden;border-radius:99px}.rail:after{content:"";display:block;width:36%;height:100%;background:#eee;animation:scan 1.3s ease-in-out infinite}
    .ready{display:none;margin-top:26px;border:1px solid #2a2a2a;border-radius:26px;padding:22px;background:#0b0b0b}.ready.show{display:block;animation:rise .35s ease both}.readyRow{display:flex;align-items:center;justify-content:space-between;gap:16px}.readyIcon{width:44px;height:44px;border-radius:50%;background:#fff;color:#050505;display:grid;place-items:center;flex:0 0 auto}.readyIcon svg{width:20px;height:20px}.readyText{min-width:0;flex:1}.readyTitle{font-size:15px;font-weight:620}.readyMeta{font-size:12px;color:#666;margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .foot{margin-top:38px;padding:0 4px;color:#444;font-size:11px;display:flex;justify-content:space-between;gap:12px;animation:rise .7s .2s ease both}
    @keyframes rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}@keyframes pulse{50%{opacity:.35;transform:scale(.85)}}@keyframes spin{to{transform:rotate(360deg)}}@keyframes scan{0%{transform:translateX(-120%)}100%{transform:translateX(380%)}}@keyframes drift{to{transform:translate3d(2%,-2%,0) scale(1.04)}}
    @media(max-width:420px){.app{padding-left:14px;padding-right:14px}.top{margin-bottom:44px}.inputShell{border-radius:20px}.go{padding:0 15px}.videoHead,.section{padding-left:18px;padding-right:18px}}
    @media(prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important}}
  </style>
</head>
<body>
  <main class="app">
    <header class="top">
      <div class="brand"><span class="mark"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 5.5 12 18l6-12.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>VEXA</div>
      <div class="live"><span class="dot"></span>Downloader</div>
    </header>

    <h1>Paste.<br>Pick. Save.</h1>
    <p class="sub">Drop a YouTube link, choose the quality you want, then save the original file directly to your device.</p>

    <div class="inputShell">
      <div class="linkIcon"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9.5 14.5 14.5 9.5M7.2 16.8l-1.4 1.4a3.54 3.54 0 0 1-5-5l3.4-3.4a3.54 3.54 0 0 1 5 0M16.8 7.2l1.4-1.4a3.54 3.54 0 1 1 5 5l-3.4 3.4a3.54 3.54 0 0 1-5 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></div>
      <input id="url" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste YouTube link">
      <button id="analyze" class="go" type="button">Analyze</button>
    </div>
    <div id="message" class="message" aria-live="polite"></div>

    <section id="result" class="result" aria-live="polite">
      <div class="videoHead"><div class="eyebrow">YouTube</div><div id="videoTitle" class="title"></div></div>
      <div class="section"><div class="label">Choose format</div><div id="formats" class="formats"></div><button id="prepare" class="primary" type="button" disabled>Prepare download</button></div>
    </section>

    <section id="progress" class="progress" aria-live="polite">
      <div class="progressTop"><div class="orb"></div><div><div id="progressTitle" class="progressTitle">Preparing your file</div><div id="progressSub" class="progressSub">Keeping the selected quality intact.</div></div></div><div class="rail"></div>
    </section>

    <section id="ready" class="ready" aria-live="polite">
      <div class="readyRow"><div class="readyIcon"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div><div class="readyText"><div class="readyTitle">Ready to save</div><div id="readyMeta" class="readyMeta"></div></div></div>
      <button id="save" class="save" type="button">Save to Files</button>
    </section>

    <footer class="foot"><span>Direct download</span><span>No Telegram file-size limit</span></footer>
  </main>

  <script>
    (function(){
      var tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
      var urlInput = document.getElementById('url');
      var analyze = document.getElementById('analyze');
      var message = document.getElementById('message');
      var result = document.getElementById('result');
      var videoTitle = document.getElementById('videoTitle');
      var formats = document.getElementById('formats');
      var prepare = document.getElementById('prepare');
      var progress = document.getElementById('progress');
      var progressTitle = document.getElementById('progressTitle');
      var progressSub = document.getElementById('progressSub');
      var ready = document.getElementById('ready');
      var readyMeta = document.getElementById('readyMeta');
      var save = document.getElementById('save');
      var sessionId = makeSessionId();
      var current = null;
      var selected = null;
      var prepared = null;

      function makeSessionId(){
        if(window.crypto && crypto.randomUUID){return crypto.randomUUID().replace(/-/g,'');}
        return String(Date.now()) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      }
      function initData(){return tg && tg.initData ? tg.initData : '';}
      function setMessage(text,isError){message.textContent=text||'';message.classList.toggle('error',!!isError);}
      function haptic(kind){try{if(tg&&tg.HapticFeedback){if(kind==='success'||kind==='error'){tg.HapticFeedback.notificationOccurred(kind);}else{tg.HapticFeedback.selectionChanged();}}}catch(e){}}
      function formatSize(bytes){if(!bytes||bytes<1)return 'File ready';var units=['B','KB','MB','GB'];var i=Math.min(Math.floor(Math.log(bytes)/Math.log(1024)),3);var value=bytes/Math.pow(1024,i);return (value>=100||i===0?Math.round(value):value.toFixed(1))+' '+units[i];}
      function resetPrepared(){prepared=null;ready.classList.remove('show');}
      function choose(value,button){selected=value;Array.prototype.forEach.call(formats.querySelectorAll('.format'),function(item){item.classList.remove('selected');});button.classList.add('selected');prepare.disabled=false;resetPrepared();haptic('select');}
      function addFormat(name,desc,value){var button=document.createElement('button');button.type='button';button.className='format';var n=document.createElement('span');n.className='name';n.textContent=name;var d=document.createElement('span');d.className='desc';d.textContent=desc;button.appendChild(n);button.appendChild(d);button.addEventListener('click',function(){choose(value,button);});formats.appendChild(button);return button;}
      function renderFormats(data){formats.textContent='';selected=null;prepare.disabled=true;var preferred=null;(data.qualities||[]).forEach(function(q){var desc=q===360?'Small file':q===480?'Balanced':q===720?'Recommended':'Full HD';var b=addFormat(q+'p',desc,{quality:q});if(q===720)preferred=b;});if(data.audioAvailable){addFormat('Audio Lite','Smaller M4A',{audioMode:'low'});addFormat('Audio HQ','Best M4A',{audioMode:'hq'});}if(!preferred){preferred=formats.querySelector('.format');}if(preferred){preferred.click();}}
      async function api(path,body){var response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});var data=await response.json().catch(function(){return {ok:false,message:'Unexpected server response.'};});if(!response.ok&&response.status!==401){data.ok=false;}return data;}
      async function analyzeLink(){var value=urlInput.value.trim();if(!value){setMessage('Paste a YouTube link first.',true);return;}if(!initData()){setMessage('Open this page from the Vexa bot in Telegram.',true);return;}analyze.disabled=true;prepare.disabled=true;result.classList.remove('show');progress.classList.remove('show');ready.classList.remove('show');setMessage('Reading video…',false);try{var data=await api('/mini-app/api/metadata',{initData:initData(),sessionId:sessionId,url:value});if(!data.ok){throw new Error(data.message||'Could not read this video.');}current=data;videoTitle.textContent=data.title||'YouTube video';renderFormats(data);result.classList.add('show');setMessage('Choose a format below.',false);haptic('success');}catch(err){setMessage(err&&err.message?err.message:'Could not read this video.',true);haptic('error');}finally{analyze.disabled=false;}}
      async function prepareFile(){if(!current||!selected)return;prepare.disabled=true;analyze.disabled=true;ready.classList.remove('show');progress.classList.add('show');progressTitle.textContent='Preparing your file';progressSub.textContent='Downloading and packaging the selected format…';setMessage('',false);try{var body={initData:initData(),sessionId:sessionId,videoId:current.videoId};if(selected.quality){body.quality=selected.quality;}else{body.audioMode=selected.audioMode;}var data=await api('/mini-app/api/prepare',body);if(!data.ok){throw new Error(data.message||'Could not prepare this file.');}prepared=data;progress.classList.remove('show');readyMeta.textContent=formatSize(data.size)+' · '+data.fileName;ready.classList.add('show');setMessage('Your file is ready.',false);haptic('success');}catch(err){progress.classList.remove('show');setMessage(err&&err.message?err.message:'Could not prepare this file.',true);haptic('error');}finally{prepare.disabled=false;analyze.disabled=false;}}
      function saveFile(){if(!prepared||!prepared.downloadUrl)return;haptic('select');if(tg&&typeof tg.downloadFile==='function'){tg.downloadFile({url:prepared.downloadUrl,file_name:prepared.fileName},function(accepted){if(accepted){setMessage('Download requested. Save it when Telegram prompts you.',false);haptic('success');}});return;}if(tg&&typeof tg.openLink==='function'){tg.openLink(prepared.downloadUrl);setMessage('Opened the download in your browser.',false);return;}var a=document.createElement('a');a.href=prepared.downloadUrl;a.download=prepared.fileName||'Vexa-download';document.body.appendChild(a);a.click();a.remove();}

      analyze.addEventListener('click',analyzeLink);prepare.addEventListener('click',prepareFile);save.addEventListener('click',saveFile);urlInput.addEventListener('keydown',function(event){if(event.key==='Enter'){event.preventDefault();analyzeLink();}});urlInput.addEventListener('input',function(){resetPrepared();});
      if(tg){try{tg.ready();tg.expand();if(tg.setHeaderColor)tg.setHeaderColor('#050505');if(tg.setBackgroundColor)tg.setBackgroundColor('#050505');if(tg.setBottomBarColor)tg.setBottomBarColor('#050505');}catch(e){}}else{setMessage('Open this page from the Vexa bot in Telegram.',true);}
    })();
  </script>
</body>
</html>`;

function htmlResponse(): Response {
  return new Response(MINI_APP_HTML, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

export async function handleMiniAppRequest(request: Request, env: MiniAppEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === MINI_APP_PATH || url.pathname === `${MINI_APP_PATH}/`) {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    return request.method === "HEAD" ? new Response(null, { headers: htmlResponse().headers }) : htmlResponse();
  }
  if (url.pathname === `${MINI_APP_PATH}/api/metadata` && request.method === "POST") {
    return handleMetadata(request, env);
  }
  if (url.pathname === `${MINI_APP_PATH}/api/prepare` && request.method === "POST") {
    return handlePrepare(request, env);
  }
  if (url.pathname === `${MINI_APP_PATH}/file` && (request.method === "GET" || request.method === "HEAD")) {
    return handleFile(request, env);
  }
  if (url.pathname.startsWith(`${MINI_APP_PATH}/`)) {
    return new Response("Not found", { status: 404 });
  }
  return null;
}
