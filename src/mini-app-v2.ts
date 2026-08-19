import { getContainer } from "@cloudflare/containers";

type MiniAppEnv = {
  BOT_TOKEN: string;
  YOUTUBE_DOWNLOADER_CONTAINER: DurableObjectNamespace<any>;
};

type TelegramIdentity = { userId: number };
type MetadataResult = {
  ok: boolean;
  message?: string;
  title?: string;
  videoId?: string;
  qualities?: number[];
  audioAvailable?: boolean;
};
type JobResult = {
  ok: boolean;
  state?: "preparing" | "ready" | "error";
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
const DOWNLOAD_TTL_SECONDS = 2 * 60 * 60;
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
  if (!/^[a-f0-9]{64}$/i.test(receivedHash) || !Number.isSafeInteger(authDate) || authDate <= 0) return null;

  const now = Math.floor(Date.now() / 1000);
  if (authDate > now + 300 || now - authDate > INIT_DATA_MAX_AGE_SECONDS) return null;

  const entries = [...params.entries()]
    .filter(([key]) => key !== "hash" && key !== "signature")
    .sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = await hmacSha256(encoder.encode("WebAppData"), botToken);
  const expectedHash = bytesToHex(await hmacSha256(secret, dataCheckString));
  if (!constantTimeEqual(expectedHash.toLowerCase(), receivedHash.toLowerCase())) return null;

  try {
    const user = JSON.parse(params.get("user") || "{}") as { id?: unknown };
    const userId = Number(user.id);
    return Number.isSafeInteger(userId) && userId > 0 ? { userId } : null;
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
      if (validHost && (parsed.protocol === "https:" || parsed.protocol === "http:")) return parsed.toString();
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
    const value = (await request.json()) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

async function signDownload(botToken: string, payload: string): Promise<string> {
  return bytesToHex(await hmacSha256(encoder.encode(botToken), payload));
}

function signaturePayload(userId: number, sessionId: string, fileId: string, expires: number): string {
  return `${userId}|${sessionId}|${fileId}|${expires}`;
}

function downloadUrl(request: Request, userId: number, sessionId: string, fileId: string, expires: number, sig: string): string {
  const url = new URL(`${MINI_APP_PATH}/file`, request.url);
  url.searchParams.set("u", String(userId));
  url.searchParams.set("s", sessionId);
  url.searchParams.set("f", fileId);
  url.searchParams.set("e", String(expires));
  url.searchParams.set("sig", sig);
  return url.toString();
}

async function authenticate(body: Record<string, unknown>, env: MiniAppEnv): Promise<{ identity: TelegramIdentity; sessionId: string } | null> {
  const initData = String(body.initData || "");
  const sessionId = String(body.sessionId || "");
  const identity = await validateTelegramInitData(initData, env.BOT_TOKEN);
  if (!identity || !SESSION_RE.test(sessionId)) return null;
  return { identity, sessionId };
}

async function handleMetadata(request: Request, env: MiniAppEnv): Promise<Response> {
  const body = await readSmallJson(request);
  if (!body) return json({ ok: false, message: "Invalid request." }, 400);
  const auth = await authenticate(body, env);
  if (!auth) return json({ ok: false, message: "Open this Mini App from Telegram." }, 401);
  const source = youtubeUrlFromInput(String(body.url || ""));
  if (!source) return json({ ok: false, message: "Paste a valid YouTube link." }, 400);

  const container = getContainer(
    env.YOUTUBE_DOWNLOADER_CONTAINER,
    miniContainerId(auth.identity.userId, auth.sessionId),
  );
  const response = await container.fetch(new Request("http://container/metadata", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: source }),
  }));
  if (!response.ok) return json({ ok: false, message: "Could not read this video." }, 502);
  const metadata = (await response.json()) as MetadataResult;
  if (!metadata.ok || !metadata.videoId) return json({ ok: false, message: metadata.message || "Could not read this video." });

  return json({
    ok: true,
    title: metadata.title || "YouTube video",
    videoId: metadata.videoId,
    qualities: Array.isArray(metadata.qualities)
      ? metadata.qualities.filter((q) => [360, 480, 720, 1080].includes(Number(q)))
      : [],
    audioAvailable: Boolean(metadata.audioAvailable),
  });
}

async function handleStart(request: Request, env: MiniAppEnv): Promise<Response> {
  const body = await readSmallJson(request);
  if (!body) return json({ ok: false, message: "Invalid request." }, 400);
  const auth = await authenticate(body, env);
  if (!auth) return json({ ok: false, message: "Open this Mini App from Telegram." }, 401);

  const videoId = String(body.videoId || "");
  const quality = body.quality == null ? null : Number(body.quality);
  const audioMode = body.audioMode == null ? null : String(body.audioMode);
  if (!VIDEO_ID_RE.test(videoId)) return json({ ok: false, message: "This download session is invalid." }, 400);
  const validQuality = quality != null && [360, 480, 720, 1080].includes(quality);
  const validAudio = audioMode === "low" || audioMode === "hq";
  if (validQuality === validAudio) return json({ ok: false, message: "Choose one download format." }, 400);

  const fileId = crypto.randomUUID().replace(/-/g, "");
  const container = getContainer(
    env.YOUTUBE_DOWNLOADER_CONTAINER,
    miniContainerId(auth.identity.userId, auth.sessionId),
  );
  const response = await container.fetch(new Request("http://container/mini/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: `https://www.youtube.com/watch?v=${videoId}`,
      fileId,
      quality: validQuality ? quality : undefined,
      audioMode: validAudio ? audioMode : undefined,
    }),
  }));
  const result = (await response.json().catch(() => ({ ok: false, message: "Could not start this download." }))) as JobResult;
  if (!response.ok && response.status !== 202) return json({ ok: false, message: result.message || "Could not start this download." }, response.status === 409 ? 409 : 502);
  return json({ ok: true, state: "preparing", jobId: fileId });
}

async function handleStatus(request: Request, env: MiniAppEnv): Promise<Response> {
  const body = await readSmallJson(request);
  if (!body) return json({ ok: false, message: "Invalid request." }, 400);
  const auth = await authenticate(body, env);
  if (!auth) return json({ ok: false, message: "Open this Mini App from Telegram." }, 401);
  const jobId = String(body.jobId || "");
  if (!FILE_ID_RE.test(jobId)) return json({ ok: false, message: "Invalid download job." }, 400);

  const container = getContainer(
    env.YOUTUBE_DOWNLOADER_CONTAINER,
    miniContainerId(auth.identity.userId, auth.sessionId),
  );
  const response = await container.fetch(`http://container/mini/status?fileId=${encodeURIComponent(jobId)}`);
  const result = (await response.json().catch(() => ({ ok: false, state: "error", message: "Could not check this download." }))) as JobResult;
  if (!response.ok && response.status !== 404) return json({ ok: false, state: "error", message: result.message || "Could not check this download." }, 502);
  if (!result.ok || result.state === "error") return json({ ok: false, state: "error", message: result.message || "Could not prepare this file." });
  if (result.state !== "ready" || !result.fileId || !result.fileName) return json({ ok: true, state: "preparing" });

  const expires = Math.floor(Date.now() / 1000) + DOWNLOAD_TTL_SECONDS;
  const payload = signaturePayload(auth.identity.userId, auth.sessionId, result.fileId, expires);
  const sig = await signDownload(env.BOT_TOKEN, payload);
  return json({
    ok: true,
    state: "ready",
    fileName: result.fileName,
    size: Number(result.size || 0),
    mime: result.mime || "application/octet-stream",
    downloadUrl: downloadUrl(request, auth.identity.userId, auth.sessionId, result.fileId, expires, sig),
  });
}

async function handleFile(request: Request, env: MiniAppEnv): Promise<Response> {
  const url = new URL(request.url);
  const userId = Number(url.searchParams.get("u") || "0");
  const sessionId = url.searchParams.get("s") || "";
  const fileId = url.searchParams.get("f") || "";
  const expires = Number(url.searchParams.get("e") || "0");
  const sig = url.searchParams.get("sig") || "";
  const now = Math.floor(Date.now() / 1000);
  if (
    !Number.isSafeInteger(userId) || userId <= 0 || !SESSION_RE.test(sessionId) || !FILE_ID_RE.test(fileId) ||
    !Number.isSafeInteger(expires) || expires < now || expires > now + DOWNLOAD_TTL_SECONDS + 60 || !/^[a-f0-9]{64}$/i.test(sig)
  ) return new Response("Download link expired or invalid.", { status: 403 });

  const expected = await signDownload(env.BOT_TOKEN, signaturePayload(userId, sessionId, fileId, expires));
  if (!constantTimeEqual(expected.toLowerCase(), sig.toLowerCase())) return new Response("Download link expired or invalid.", { status: 403 });

  const container = getContainer(env.YOUTUBE_DOWNLOADER_CONTAINER, miniContainerId(userId, sessionId));
  const headers = new Headers();
  const range = request.headers.get("range");
  if (range) headers.set("range", range);
  const source = await container.fetch(new Request(`http://container/mini/file?fileId=${encodeURIComponent(fileId)}`, {
    method: request.method === "HEAD" ? "HEAD" : "GET",
    headers,
  }));
  if (!source.ok && source.status !== 206) return new Response("File is no longer available. Prepare it again.", { status: 404 });

  const outgoing = new Headers();
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "content-disposition"]) {
    const value = source.headers.get(name);
    if (value) outgoing.set(name, value);
  }
  outgoing.set("cache-control", "private, no-store");
  outgoing.set("access-control-allow-origin", "https://web.telegram.org");
  outgoing.set("cross-origin-resource-policy", "cross-origin");
  outgoing.set("x-content-type-options", "nosniff");
  return new Response(request.method === "HEAD" ? null : source.body, { status: source.status, headers: outgoing });
}

const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no"><meta name="theme-color" content="#050505"><title>Vexa Downloader</title><script src="https://telegram.org/js/telegram-web-app.js?63"></script><style>
:root{color-scheme:dark;--bg:#050505;--panel:#0b0b0b;--text:#f5f5f5;--muted:#888;--line:#222}*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}html,body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text",Inter,system-ui,sans-serif;min-height:100%;overflow-x:hidden}body:before{content:"";position:fixed;inset:-25%;pointer-events:none;background:radial-gradient(circle at 50% 8%,rgba(255,255,255,.07),transparent 28%);animation:drift 10s ease-in-out infinite alternate}.app{position:relative;max-width:720px;margin:0 auto;padding:max(24px,env(safe-area-inset-top)) 18px max(30px,env(safe-area-inset-bottom));min-height:100vh}.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:52px;animation:rise .55s ease both}.brand{display:flex;align-items:center;gap:10px;font-size:14px;font-weight:700;letter-spacing:.22em}.mark{width:28px;height:28px;border:1px solid #292929;border-radius:50%;display:grid;place-items:center}.live{color:#777;font-size:12px;display:flex;gap:7px;align-items:center}.dot{width:6px;height:6px;border-radius:50%;background:#eee;animation:pulse 2s ease infinite}h1{font-size:clamp(38px,10vw,64px);line-height:.94;letter-spacing:-.055em;margin:0 0 18px;font-weight:650;animation:rise .6s .05s ease both}.sub{color:var(--muted);font-size:15px;line-height:1.6;margin:0 0 32px;max-width:520px;animation:rise .6s .1s ease both}.inputShell{display:flex;align-items:center;gap:10px;padding:8px;border:1px solid var(--line);background:#0a0a0a;border-radius:22px;animation:rise .6s .15s ease both}.linkIcon{width:42px;height:42px;border-radius:15px;background:#111;display:grid;place-items:center;color:#aaa;flex:0 0 auto}input{min-width:0;flex:1;background:transparent;color:#fff;border:0;outline:0;font:inherit;font-size:15px;padding:12px 0}input::placeholder{color:#555}button{font:inherit;border:0;cursor:pointer}.go{height:46px;border-radius:16px;padding:0 18px;background:#fff;color:#050505;font-weight:650}.go:active,.primary:active,.save:active{transform:scale(.975)}button:disabled{opacity:.35}.message{min-height:22px;margin:12px 4px 0;color:#777;font-size:13px}.message.error{color:#e5e5e5}.card{margin-top:26px;border:1px solid var(--line);border-radius:26px;background:#0a0a0a;overflow:hidden;opacity:0;transform:translateY(12px);pointer-events:none;transition:.3s}.card.show{opacity:1;transform:none;pointer-events:auto}.head{padding:22px;border-bottom:1px solid var(--line)}.eyebrow{color:#666;font-size:11px;letter-spacing:.14em;margin-bottom:10px}.title{font-size:18px;line-height:1.35;font-weight:580}.section{padding:20px 22px}.label{font-size:12px;color:#777;margin-bottom:12px}.formats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.format{text-align:left;padding:15px;border:1px solid #222;border-radius:17px;background:#0d0d0d;color:#ddd}.format .name{display:block;font-size:14px;font-weight:600}.format .desc{display:block;font-size:11px;color:#666;margin-top:4px}.format.selected{background:#f3f3f3;color:#090909;border-color:#eee}.format.selected .desc{color:#555}.primary,.save{width:100%;height:54px;border-radius:18px;background:#fff;color:#050505;font-weight:680;margin-top:18px}.progress,.ready{display:none;margin-top:26px;border:1px solid var(--line);border-radius:26px;padding:22px;background:#090909}.progress.show,.ready.show{display:block;animation:rise .3s ease both}.progressTop{display:flex;align-items:center;gap:15px}.orb{position:relative;width:42px;height:42px;border-radius:50%;border:1px solid #262626;flex:0 0 auto}.orb:before{content:"";position:absolute;inset:5px;border-radius:50%;border:2px solid transparent;border-top-color:#fff;animation:spin 1s linear infinite}.progressTitle,.readyTitle{font-size:15px;font-weight:600}.progressSub,.readyMeta{font-size:12px;color:#666;margin-top:5px}.rail{height:2px;background:#171717;margin-top:20px;overflow:hidden;border-radius:99px}.rail:after{content:"";display:block;width:35%;height:100%;background:#eee;animation:scan 1.3s ease-in-out infinite}.readyRow{display:flex;align-items:center;gap:14px}.readyIcon{width:44px;height:44px;border-radius:50%;background:#fff;color:#050505;display:grid;place-items:center;font-size:20px}.readyText{min-width:0;flex:1}.readyMeta{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.foot{margin-top:36px;padding:0 4px;color:#444;font-size:11px;display:flex;justify-content:space-between;gap:12px}@keyframes rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}@keyframes spin{to{transform:rotate(360deg)}}@keyframes pulse{50%{opacity:.35}}@keyframes scan{0%{transform:translateX(-120%)}100%{transform:translateX(390%)}}@keyframes drift{to{transform:translateY(-2%) scale(1.03)}}@media(max-width:420px){.app{padding-left:14px;padding-right:14px}.top{margin-bottom:44px}.head,.section{padding-left:18px;padding-right:18px}}@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important}}
</style></head><body><main class="app"><header class="top"><div class="brand"><span class="mark">V</span>VEXA</div><div class="live"><span class="dot"></span>Downloader</div></header><h1>Paste.<br>Pick. Save.</h1><p class="sub">Drop a YouTube link, choose the quality you want, then save the file directly to your device.</p><div class="inputShell"><div class="linkIcon">↗</div><input id="url" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste YouTube link"><button id="analyze" class="go" type="button">Analyze</button></div><div id="message" class="message" aria-live="polite"></div><section id="result" class="card"><div class="head"><div class="eyebrow">YOUTUBE</div><div id="videoTitle" class="title"></div></div><div class="section"><div class="label">Choose format</div><div id="formats" class="formats"></div><button id="prepare" class="primary" type="button" disabled>Prepare download</button></div></section><section id="progress" class="progress" aria-live="polite"><div class="progressTop"><div class="orb"></div><div><div class="progressTitle">Preparing your file</div><div id="progressSub" class="progressSub">Large files can take a little longer. Keep this Mini App open.</div></div></div><div class="rail"></div></section><section id="ready" class="ready" aria-live="polite"><div class="readyRow"><div class="readyIcon">↓</div><div class="readyText"><div class="readyTitle">Ready to save</div><div id="readyMeta" class="readyMeta"></div></div></div><button id="save" class="save" type="button">Save to Files</button></section><footer class="foot"><span>Direct streaming</span><span>No Bot API 50 MB limit</span></footer></main><script>
(function(){var tg=window.Telegram&&window.Telegram.WebApp?window.Telegram.WebApp:null;var $=function(id){return document.getElementById(id)};var urlInput=$('url'),analyze=$('analyze'),message=$('message'),result=$('result'),videoTitle=$('videoTitle'),formats=$('formats'),prepare=$('prepare'),progress=$('progress'),progressSub=$('progressSub'),ready=$('ready'),readyMeta=$('readyMeta'),save=$('save');var sessionId=makeSessionId(),current=null,selected=null,prepared=null,pollToken=0;
function makeSessionId(){if(window.crypto&&crypto.randomUUID)return crypto.randomUUID().replace(/-/g,'');return String(Date.now())+Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2)}function initData(){return tg&&tg.initData?tg.initData:''}function setMessage(t,e){message.textContent=t||'';message.classList.toggle('error',!!e)}function haptic(k){try{if(tg&&tg.HapticFeedback){if(k==='success'||k==='error')tg.HapticFeedback.notificationOccurred(k);else tg.HapticFeedback.selectionChanged()}}catch(e){}}function formatSize(bytes){if(!bytes||bytes<1)return'File ready';var u=['B','KB','MB','GB'];var i=Math.min(Math.floor(Math.log(bytes)/Math.log(1024)),3);var v=bytes/Math.pow(1024,i);return(v>=100||i===0?Math.round(v):v.toFixed(1))+' '+u[i]}function wait(ms){return new Promise(function(r){setTimeout(r,ms)})}function resetReady(){prepared=null;ready.classList.remove('show')}function choose(v,b){selected=v;Array.prototype.forEach.call(formats.querySelectorAll('.format'),function(x){x.classList.remove('selected')});b.classList.add('selected');prepare.disabled=false;resetReady();haptic('select')}function addFormat(n,d,v){var b=document.createElement('button');b.type='button';b.className='format';var a=document.createElement('span');a.className='name';a.textContent=n;var c=document.createElement('span');c.className='desc';c.textContent=d;b.appendChild(a);b.appendChild(c);b.addEventListener('click',function(){choose(v,b)});formats.appendChild(b);return b}function renderFormats(data){formats.textContent='';selected=null;prepare.disabled=true;var preferred=null;(data.qualities||[]).forEach(function(q){var d=q===360?'Small file':q===480?'Balanced':q===720?'Recommended':'Full HD';var b=addFormat(q+'p',d,{quality:q});if(q===720)preferred=b});if(data.audioAvailable){addFormat('Audio Lite','Smaller M4A',{audioMode:'low'});addFormat('Audio HQ','Best M4A',{audioMode:'hq'})}if(!preferred)preferred=formats.querySelector('.format');if(preferred)preferred.click()}async function api(path,body){var r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});var d=await r.json().catch(function(){return{ok:false,message:'Unexpected server response.'}});if(!r.ok)d.ok=false;return d}
async function analyzeLink(){var v=urlInput.value.trim();if(!v){setMessage('Paste a YouTube link first.',true);return}if(!initData()){setMessage('Open this page from the Vexa bot in Telegram.',true);return}pollToken++;analyze.disabled=true;result.classList.remove('show');progress.classList.remove('show');ready.classList.remove('show');setMessage('Reading video…',false);try{var d=await api('/mini-app/api/metadata',{initData:initData(),sessionId:sessionId,url:v});if(!d.ok)throw new Error(d.message||'Could not read this video.');current=d;videoTitle.textContent=d.title||'YouTube video';renderFormats(d);result.classList.add('show');setMessage('Choose a format below.',false);haptic('success')}catch(e){setMessage(e&&e.message?e.message:'Could not read this video.',true);haptic('error')}finally{analyze.disabled=false}}
async function pollJob(jobId,token){var started=Date.now();while(token===pollToken){await wait(1500);var d=await api('/mini-app/api/status',{initData:initData(),sessionId:sessionId,jobId:jobId});if(token!==pollToken)return;if(d.ok&&d.state==='ready'){prepared=d;progress.classList.remove('show');readyMeta.textContent=formatSize(d.size)+' · '+d.fileName;ready.classList.add('show');setMessage('Your file is ready.',false);prepare.disabled=false;analyze.disabled=false;haptic('success');return}if(!d.ok||d.state==='error'){throw new Error(d.message||'Could not prepare this file.')}var sec=Math.round((Date.now()-started)/1000);progressSub.textContent=sec>45?'Still preparing — larger videos can take a few minutes. Keep this Mini App open.':'Downloading and packaging the selected quality…';if(sec>30*60)throw new Error('This download took too long. Please try again.')}}
async function prepareFile(){if(!current||!selected)return;var token=++pollToken;prepare.disabled=true;analyze.disabled=true;ready.classList.remove('show');progress.classList.add('show');progressSub.textContent='Starting download…';setMessage('',false);try{var body={initData:initData(),sessionId:sessionId,videoId:current.videoId};if(selected.quality)body.quality=selected.quality;else body.audioMode=selected.audioMode;var d=await api('/mini-app/api/start',body);if(!d.ok||!d.jobId)throw new Error(d.message||'Could not start this download.');await pollJob(d.jobId,token)}catch(e){if(token===pollToken){progress.classList.remove('show');prepare.disabled=false;analyze.disabled=false;setMessage(e&&e.message?e.message:'Could not prepare this file.',true);haptic('error')}}}
function saveFile(){if(!prepared||!prepared.downloadUrl)return;haptic('select');if(tg&&typeof tg.downloadFile==='function'){tg.downloadFile({url:prepared.downloadUrl,file_name:prepared.fileName},function(accepted){if(accepted){setMessage('Download started. Telegram will let you save the file.',false);haptic('success')}else{setMessage('Telegram did not start the download. Tap Save again.',true)}});return}if(tg&&typeof tg.openLink==='function'){tg.openLink(prepared.downloadUrl);setMessage('Opened the direct download.',false);return}window.location.href=prepared.downloadUrl}
analyze.addEventListener('click',analyzeLink);prepare.addEventListener('click',prepareFile);save.addEventListener('click',saveFile);urlInput.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();analyzeLink()}});urlInput.addEventListener('input',function(){pollToken++;resetReady()});if(tg){try{tg.ready();tg.expand();if(tg.setHeaderColor)tg.setHeaderColor('#050505');if(tg.setBackgroundColor)tg.setBackgroundColor('#050505');if(tg.setBottomBarColor)tg.setBottomBarColor('#050505');if(tg.onEvent)tg.onEvent('fileDownloadRequested',function(e){if(e&&e.status==='downloading')setMessage('Download started.',false);else if(e&&e.status==='cancelled')setMessage('Download was cancelled.',true)})}catch(e){}}else setMessage('Open this page from the Vexa bot in Telegram.',true)
})();</script></body></html>`;

function htmlResponse(): Response {
  return new Response(HTML, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

export async function handleMiniAppRequestV2(request: Request, env: MiniAppEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === MINI_APP_PATH || url.pathname === `${MINI_APP_PATH}/`) {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    return request.method === "HEAD" ? new Response(null, { headers: htmlResponse().headers }) : htmlResponse();
  }
  if (url.pathname === `${MINI_APP_PATH}/api/metadata` && request.method === "POST") return handleMetadata(request, env);
  if (url.pathname === `${MINI_APP_PATH}/api/start` && request.method === "POST") return handleStart(request, env);
  if (url.pathname === `${MINI_APP_PATH}/api/status` && request.method === "POST") return handleStatus(request, env);
  if (url.pathname === `${MINI_APP_PATH}/file` && (request.method === "GET" || request.method === "HEAD")) return handleFile(request, env);
  if (url.pathname.startsWith(`${MINI_APP_PATH}/`)) return new Response("Not found", { status: 404 });
  return null;
}
