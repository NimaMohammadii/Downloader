import { Container, getContainer } from "@cloudflare/containers";
import {
  DurableObject,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import storyWorker, { parseInstagramVideoTarget, parseInstagramAudioTarget, resolveInstagramVideo, instagramVideoErrorText, type InstagramVideoTarget, type InstagramVideoSource } from "./story-main";
import type { InstagramPostUpload } from "./index";
import {
  telegramTextMotion,
  telegramCustomEmoji,
  ADMIN_USER_ID,
  recordSuccessfulDelivery,
  recordUserActivity,
  recordDownload,
  recordUsage,
  recordMediaDelivery,
  type UsageSample,
  type ContainerRun,
  type MediaUsage,
  isInstagramDownloadLink,
  type DownloadRecord,
  type DownloadStatus,
  telegramFileCache,
  type CachedTelegramFile,
  type AdminStatsEnv,
  type TrackedUser,
} from "./admin";

export { AdminStatsStore } from "./admin";

const SUPPORTED_QUALITIES = [360, 480, 720, 1080] as const;
type YoutubeQuality = (typeof SUPPORTED_QUALITIES)[number];
type YoutubeAudioMode = "low" | "hq";
type RecognitionInput = { fileId: string; fileSize?: number };
type PlaylistInput = { url: string; start: number; end: number };
type SocialInput = { platform: "x" | "pinterest" | "tiktok" | "soundcloud" | "aparat"; url: string; audioOnly?: boolean; itemIndex?: number };
type MediaSource = InstagramVideoSource & { recognition?: RecognitionInput; playlist?: PlaylistInput; social?: SocialInput;
  instagramPost?: Pick<InstagramPostUpload, "shortcode" | "media"> };
const RECOGNITION_FILE_LIMIT = 20_000_000;

type YoutubeDownloadJob = {
  id: string;
  containerIndex?: number;
  chatId: number;
  requestMessageId: number;
  userId: number;
  url: string;
  source?: "pornhub";
  quality?: YoutubeQuality;
  audioMode?: YoutubeAudioMode;
  statusMessageId?: number;
  instagram?: InstagramVideoTarget;
  instagramPost?: InstagramPostUpload;
  recognition?: RecognitionInput;
  playlist?: PlaylistInput;
  social?: SocialInput;
};

type Env = AdminStatsEnv & {
  BOT_TOKEN: string;
  WEBHOOK_SECRET?: string;
  API_ID?: string;
  API_HASH?: string;
  PORNHUB_COOKIES?: string;
  YOUTUBE_DOWNLOAD_WORKFLOW: Workflow<YoutubeDownloadJob>;
  YOUTUBE_DOWNLOADER_CONTAINER: DurableObjectNamespace<YoutubeDownloaderContainer>;
  DOWNLOAD_POOL: DurableObjectNamespace<DownloadPool>;
  INSTAGRAM_SESSIONID?: string;
  INSTAGRAM_CSRFTOKEN?: string;
  INSTAGRAM_DS_USER_ID?: string;
  INSTAGRAM_MID?: string;
  INSTAGRAM_IG_DID?: string;
};

type TelegramUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
};

type TelegramMessage = {
  message_id: number;
  chat: { id: number; type?: string };
  from?: TelegramUser;
  text?: string;
  caption?: string;
  voice?: TelegramMedia;
  audio?: TelegramMedia;
  video?: TelegramMedia;
  video_note?: TelegramMedia;
  document?: TelegramMedia;
  reply_to_message?: TelegramMessage;
};

type TelegramMedia = { file_id: string; file_size?: number; mime_type?: string; file_name?: string };

type TelegramCallbackQuery = {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

type ContainerResult = {
  ok: boolean;
  partial?: boolean;
  message?: string;
  title?: string;
  parts?: number;
  quality?: number;
  audioMode?: YoutubeAudioMode;
  errorCode?: string;
  diagnostic?: string;
  phase?: string;
  errorType?: string;
  rpcMethod?: string;
  rpcCode?: number;
  retryAfterSeconds?: number;
  retrySafe?: boolean;
  sourceDiagnostics?: {
    probeVersion: string;
    redirectKind: string;
    suppliedCookieCount: number;
    matchingCookies: boolean;
    httpOnlyCookieCount: number;
  };
};

type YoutubeFileSize = { bytes: number; estimated: boolean };

type YoutubeMetadataResult = {
  ok: boolean;
  message?: string;
  title?: string;
  videoId?: string;
  qualities?: number[];
  audioAvailable?: boolean;
  sizes?: Record<string, YoutubeFileSize>;
};

type ParsedQualityCallback = {
  videoId: string;
  requestMessageId: number;
  userId: number;
  quality?: YoutubeQuality;
  audioMode?: YoutubeAudioMode;
};

const WEBHOOK_SECRET = "dlr_7Tz91mQX4pK8vN2sR6cH5bJ3wF9yUaE1";

const POOL_INSTANCES = 20;
const JOBS_PER_CONTAINER = 5;
type PoolLease = { instance: number; token: string; until: number };

// Admission only: no waiting list, alarms, polling, or additional Container.
// Persist assignments so Workflow replays and stop callbacks find the same host.
export class DownloadPool extends DurableObject<Env> {
  async acquire(id: string): Promise<PoolLease | null> {
    return this.ctx.storage.transaction(async storage => {
      const jobs = await storage.get<Record<string, PoolLease>>("jobs") || {};
      const now = Date.now();
      for (const [key, lease] of Object.entries(jobs)) if (lease.until <= now) delete jobs[key];
      if (jobs[id]) return jobs[id];
      const counts = Array<number>(POOL_INSTANCES).fill(0);
      for (const lease of Object.values(jobs)) counts[lease.instance]++;
      // Pack live work first, avoiding twenty cold boots for a small burst.
      let instance = counts.findIndex(count => count > 0 && count < JOBS_PER_CONTAINER);
      if (instance < 0) instance = counts.indexOf(0);
      if (instance < 0) return null;
      const lease = { instance, token: crypto.randomUUID(), until: now + 4 * 60 * 60 * 1000 };
      jobs[id] = lease;
      await storage.put("jobs", jobs);
      return lease;
    });
  }

  async lookup(id: string): Promise<PoolLease | null> {
    const jobs = await this.ctx.storage.get<Record<string, PoolLease>>("jobs") || {};
    return jobs[id]?.until > Date.now() ? jobs[id] : null;
  }

  async release(id: string, token: string): Promise<void> {
    await this.ctx.storage.transaction(async storage => {
      const jobs = await storage.get<Record<string, PoolLease>>("jobs") || {};
      if (jobs[id]?.token !== token) return;
      delete jobs[id];
      await storage.put("jobs", jobs);
    });
  }
}

function downloadPool(env: Env) {
  return env.DOWNLOAD_POOL.getByName("downloads-v1");
}

function pooledContainer(env: Env, job: Pick<YoutubeDownloadJob, "containerIndex">) {
  if (!Number.isInteger(job.containerIndex) || job.containerIndex! < 0 || job.containerIndex! >= POOL_INSTANCES) throw new Error("DOWNLOAD_POOL_ASSIGNMENT");
  return getContainer(env.YOUTUBE_DOWNLOADER_CONTAINER, `download-pool-v1-${job.containerIndex}`);
}

export class YoutubeDownloaderContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter: string | number = "5m";
  enableInternet = true;
  envVars: Record<string, string> = {
    API_ID: this.env.API_ID || "", API_HASH: this.env.API_HASH || "",
    PORNHUB_COOKIES: this.env.PORNHUB_COOKIES || "",
  };
  private starting?: Promise<void>;
  private idleShutdownRequested = false;

  override async onStart(): Promise<void> {
    this.idleShutdownRequested = false;
    await this.trackContainerRun(false);
  }

  private async trackContainerRun(stopped: boolean): Promise<void> {
    try {
      const saved = await this.ctx.storage.get<ContainerRun>("adminUsageRun");
      if (stopped && !saved) return;
      const run: ContainerRun = stopped ? { ...saved!, end: saved!.end ?? Date.now() }
        : saved?.end === null ? saved : { key: `run:${crypto.randomUUID()}`, start: Date.now(), end: null };
      await this.ctx.storage.put("adminUsageRun", run);
      // Retry the previous closed run too, in case its stop report was lost.
      await recordUsage(this.env, [], [], !stopped && saved?.end != null ? [saved, run] : [run]);
    } catch { console.warn("container lifecycle stats unavailable"); }
  }

  async refreshUsage(): Promise<void> {
    // Read the existing process directly: never start a stopped container or
    // renew its activity timeout merely because an admin opened a report.
    if (!this.ctx.container?.running) return;
    try {
      const response = await this.ctx.container.getTcpPort(8080).fetch("http://container/admin-usage", { signal: AbortSignal.timeout(1500) });
      if (!response.ok) return;
      const body = await response.json() as { samples: UsageSample[]; deliveries: MediaUsage[] };
      await recordUsage(this.env, body.samples, body.deliveries);
    } catch { /* Last persisted samples remain available during a restart. */ }
  }

  async startShared(index: number): Promise<void> {
    if (!Number.isInteger(index) || index < 0 || index >= POOL_INSTANCES) throw new Error("DOWNLOAD_POOL_ASSIGNMENT");
    if (!this.starting) {
      this.starting = (async () => {
        const tag = await this.sessionTag();
        const saved = await this.ctx.storage.get<{ tag: string; session: string }>("telegramSession");
        this.envVars = { ...this.envVars,
          TELEGRAM_BOT_SESSION: saved?.tag === tag ? saved.session : "",
          ADMIN_USAGE_URL: `https://downloader.vexaagent.workers.dev/container-usage/${index}`,
          ADMIN_USAGE_TOKEN: await instagramSignature(this.env.BOT_TOKEN, `usage:${index}`),
          TELEGRAM_SESSION_URL: `https://downloader.vexaagent.workers.dev/telegram-session/${index}`,
          TELEGRAM_SESSION_TOKEN: await instagramSignature(this.env.BOT_TOKEN, `telegram-session:${index}:${this.env.API_ID}:${this.env.API_HASH}`),
        };
        await this.startAndWaitForPorts({
          ports: [8080],
          cancellationOptions: { instanceGetTimeoutMS: 45_000, portReadyTimeoutMS: 60_000 },
        });
      })().finally(() => { this.starting = undefined; });
    }
    await this.starting;
  }

  private sessionTag(): Promise<string> {
    return instagramSignature(this.env.BOT_TOKEN, `telegram-session-config:${this.env.API_ID}:${this.env.API_HASH}`);
  }

  async saveTelegramSession(session: string): Promise<void> {
    if (!/^1[A-Za-z0-9_=-]{300,500}$/.test(session)) throw new Error("Invalid Telegram session");
    await this.ctx.storage.put("telegramSession", { tag: await this.sessionTag(), session });
  }

  async instagramRequest(action: string, payload: Record<string, unknown>): Promise<ContainerResult> {
    if (!["start", "stop", "send", "cleanup"].includes(action)) throw new Error("IG_ACTION");
    // Cleanup must not start a fresh instance after a crash or rollout.
    if (action === "cleanup" && !this.ctx.container?.running) return { ok: true };
    if (action === "start") {
      await this.ctx.storage.transaction(async storage => {
        const jobs = await storage.get<Record<string, number>>("instagramJobs") || {};
        jobs[String(payload.id)] = Date.now() + 3 * 60 * 60 * 1000;
        await storage.put("instagramJobs", jobs);
      });
    }
    const response = await this.containerFetch(`http://container/instagram/${action}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`IG_CONTAINER_${response.status}`);
    return response.json() as Promise<ContainerResult>;
  }

  async releaseInstagram(id: string): Promise<void> {
    await this.ctx.storage.transaction(async storage => {
      const jobs = await storage.get<Record<string, number>>("instagramJobs") || {};
      delete jobs[id];
      await storage.put("instagramJobs", jobs);
    });
    this.sleepAfter = "5m";
    this.renewActivityTimeout();
  }

  override async onActivityExpired(): Promise<void> {
    const jobs = await this.ctx.storage.get<Record<string, number>>("instagramJobs") || {};
    const until = Math.max(0, ...Object.values(jobs));
    if (until > Date.now()) {
      this.sleepAfter = Math.ceil((until - Date.now()) / 1000);
      this.renewActivityTimeout();
      return;
    }
    // The Python HTTP server runs as PID 1 without a SIGTERM handler. The
    // default stop() only signals it and can leave idle instances occupying
    // capacity. The SDK excludes in-flight HTTP requests before this hook;
    // the lease above separately protects background capture/preparation.
    this.idleShutdownRequested = true;
    try {
      await this.destroy();
    } catch (error) {
      this.idleShutdownRequested = false;
      throw error;
    }
  }

  private async instagramInterrupted(): Promise<boolean> {
    const jobs = await this.ctx.storage.get<Record<string, number>>("instagramJobs") || {};
    const active = Object.entries(jobs).filter(([, until]) => until > Date.now());
    await Promise.allSettled(active.map(async ([id]) => {
      const instance = await this.env.YOUTUBE_DOWNLOAD_WORKFLOW.get(id);
      await instance.sendEvent({ type: "instagram-ready", payload: { ok: false, message: "❌ سرور هنگام دریافت فایل ری‌استارت شد؛ درخواست کامل نشد. دوباره درخواست را بفرست." } });
    }));
    return active.length > 0;
  }

  override async onStop(): Promise<void> {
    await this.trackContainerRun(true);
    await this.instagramInterrupted();
  }
  override async onError(error: unknown): Promise<void> {
    const idleShutdownRequested = this.idleShutdownRequested;
    this.idleShutdownRequested = false;
    if (!this.ctx.container?.running) await this.trackContainerRun(true);
    if (await this.instagramInterrupted()) return;
    const message = error instanceof Error ? error.message : String(error);
    if (idleShutdownRequested && message === "The RPC call destroy() was called") {
      console.info("container stopped after idle timeout", { sleepAfter: this.sleepAfter });
      return;
    }
    super.onError(error);
  }
}

async function instagramSignature(token: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(signature)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function equalSignature(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function mediaCacheContext(env: Env, job: YoutubeDownloadJob) {
  return {
    cacheUrl: `https://downloader.vexaagent.workers.dev/media-cache/${job.id}`,
    cacheToken: await instagramSignature(env.BOT_TOKEN, `cache:${job.id}`),
    mediaCacheKey: await mediaCacheKey(job),
  };
}

async function mediaCacheKey(job: YoutubeDownloadJob): Promise<string | undefined> {
  if (job.instagram?.kind === "music") {
    return job.instagram.musicVideoId ? `yt:${job.instagram.musicVideoId}:mp3` : undefined;
  }
  const target = job.instagram;
  const id = target?.shortcode || target?.mediaId;
  if (target && id && target.kind !== "live") return `ig:${job.userId}:${id}:${target.videoIndex ?? 0}:${target.recognizeMusic ? "song" : target.kind}`;
  if (job.quality || job.audioMode) {
    const id = new URL(job.url).searchParams.get("v");
    if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) return `yt:${id}:${job.audioMode ? job.audioMode === "hq" ? "ah" : "al" : `v${job.quality}`}`;
  }
}

async function sendCachedMedia(env: Env, job: YoutubeDownloadJob, statusId?: number): Promise<boolean> {
  const key = await mediaCacheKey(job);
  if (!key) return false;
  const cached = await telegramFileCache(env, "get", key);
  if (!cached) return false;
  try {
    const sent = await telegramCall(env.BOT_TOKEN, cached.method, {
      ...cached.data, [cached.method === "sendAudio" ? "audio" : "video"]: cached.fileId,
      chat_id: job.chatId, reply_parameters: { message_id: job.requestMessageId, allow_sending_without_reply: true },
    });
    await recordMediaDelivery(env, job.userId, job.chatId, sent, true, cached.fileSize);
  } catch (error) {
    if (/wrong.*file|file.*(?:invalid|expired)|file_reference|failed to get.*file/i.test(error instanceof Error ? error.message : "")) {
      await telegramFileCache(env, "delete", key);
      return false;
    }
    throw error; // An ambiguous send must never trigger a duplicate upload.
  }
  if (statusId) await safeTelegramCall(env.BOT_TOKEN, "deleteMessage", { chat_id: job.chatId, message_id: statusId });
  return true;
}

function redactDiagnostic(detail: string, env: Env): string {
  const cookieValues = (env.PORNHUB_COOKIES || "").split(/\r?\n/)
    .map(line => line.split("\t")).filter(fields => fields.length === 7).map(fields => fields[6]);
  try {
    const exported = JSON.parse((env.PORNHUB_COOKIES || "").replace(/^[\uFEFF \t\r\n]+/, ""));
    const entries = Array.isArray(exported) ? exported : exported?.cookies;
    if (Array.isArray(entries)) {
      for (const entry of entries) if (typeof entry?.value === "string") cookieValues.push(entry.value);
    }
  } catch { /* Invalid exports are reported without their contents by the Container. */ }
  const secrets = [env.BOT_TOKEN, env.API_HASH, env.INSTAGRAM_SESSIONID, env.PORNHUB_COOKIES, ...cookieValues]
    .filter((secret): secret is string => Boolean(secret)).sort((a, b) => b.length - a.length);
  for (const secret of secrets) {
    detail = detail.split(secret).join("[redacted]");
  }
  return detail.replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/\b(?:authorization|cookie|sessionid)\b["']?\s*[:=]\s*[^\r\n]+/gi, "[redacted]").slice(0, 2000);
}

function safeSourceDiagnostics(value: ContainerResult["sourceDiagnostics"]): ContainerResult["sourceDiagnostics"] {
  if (!value || !["ph-session-v1", "ph-session-v2"].includes(value.probeVersion)
      || !["login", "age_verification", "access_restricted", "homepage", "external", "other"].includes(value.redirectKind)
      || typeof value.matchingCookies !== "boolean"
      || ![value.suppliedCookieCount, value.httpOnlyCookieCount].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 999999)) return undefined;
  // Copy only fixed categories, booleans and counts; never trust arbitrary fields.
  return { probeVersion: value.probeVersion, redirectKind: value.redirectKind,
    suppliedCookieCount: value.suppliedCookieCount, matchingCookies: value.matchingCookies,
    httpOnlyCookieCount: value.httpOnlyCookieCount };
}

function workflowFailureMessage(detail: string, phase: string): string {
  if (detail.includes("YT_CONFIG")) {
    return "❌ تنظیمات ارسال فایل آماده نیست؛ API_ID و API_HASH باید در Secretهای همین Worker تنظیم شوند.";
  }
  if (/DOWNLOAD_POOL_FULL|YT_HTTP_(503|429)|no container instance|max.*instance|provision/i.test(detail)) {
    return "❌ سرور دانلود هنوز آماده نیست یا ظرفیتش پر شده؛ کمی بعد دوباره لینک رو بفرست.";
  }
  if (phase === "startup" || /YT_HTTP_500|not listening|port.*ready/i.test(detail)) {
    return "❌ راه‌اندازی سرور دانلود ناموفق بود؛ وضعیت کانتینر باید بررسی شود.";
  }
  if (phase === "metadata") {
    return "❌ دریافت اطلاعات ویدیو از سرور دانلود کامل نشد؛ دوباره لینک رو بفرست.";
  }
  return "❌ ارتباط با سرور هنگام دانلود یا ارسال فایل قطع شد؛ دوباره لینک رو بفرست.";
}

async function containerResult<T>(env: Env, job: YoutubeDownloadJob, request: Request): Promise<T> {
  const container = pooledContainer(env, job);
  const response = await container.fetch(request);
  if (!response.ok) {
    const detail = redactDiagnostic(await response.text(), env);
    console.error("youtube container response failed", { jobId: job.id, status: response.status, detail });
    throw new Error(`YT_HTTP_${response.status}`);
  }
  try {
    return await response.json() as T;
  } catch {
    throw new Error("YT_INVALID_RESPONSE");
  }
}

function jobHistory(job: YoutubeDownloadJob): Omit<DownloadRecord, "status"> {
  if (job.instagramPost) return { key: `ig:${job.chatId}:${job.requestMessageId}:${job.userId}`,
    userId: job.userId, source: "Instagram post", request: job.instagramPost.url };
  const ig = job.instagram;
  const source = job.social ? socialName(job.social.platform) : job.playlist ? "YouTube Playlist"
    : job.recognition ? "تشخیص آهنگ" : ig ? ig.kind === "music" ? "جست‌وجو و دانلود آهنگ" : `Instagram ${ig.kind}`
    : job.source === "pornhub" ? "Pornhub" : "YouTube";
  const request = job.url || job.social?.url || (job.playlist ? `${job.playlist.url} • ${job.playlist.start}-${job.playlist.end}` : "")
    || (job.recognition ? "فایل ارسالی برای تشخیص آهنگ" : ig?.musicVideoId ? `https://www.youtube.com/watch?v=${ig.musicVideoId}`
      : ig?.query || (ig?.shortcode ? `https://www.instagram.com/p/${ig.shortcode}/` : ig?.mediaId ? `Instagram Story ${ig.mediaId}`
        : ig?.username ? `Instagram @${ig.username}` : ig?.broadcastId ? `Instagram Live ${ig.broadcastId}` : source));
  return { key: ig || job.social || job.recognition || job.playlist ? job.id : `youtube:${job.chatId}:${job.requestMessageId}:${job.userId}`,
    userId: job.userId, source, request };
}

async function trackJob(env: Env, job: YoutubeDownloadJob, status: DownloadStatus, extra: Partial<DownloadRecord> = {}): Promise<void> {
  await recordDownload(env, { ...jobHistory(job), ...extra, status });
}

export class YoutubeDownloadWorkflow extends WorkflowEntrypoint<Env, YoutubeDownloadJob> {
  async run(event: WorkflowEvent<YoutubeDownloadJob>, step: WorkflowStep) {
    const job: YoutubeDownloadJob = { ...event.payload };
    const inspect = !job.instagram && !job.instagramPost && !job.recognition && !job.playlist && !job.social && !job.quality && !job.audioMode && job.source !== "pornhub";
    await step.do("track download request", () => trackJob(this.env, job, inspect ? "pending" : "processing"));
    if (job.instagram || job.instagramPost || job.recognition || job.playlist || job.social) return this.runInstagram(job, step);
    return this.runYoutube(job, step);
  }

  private async runYoutube(job: YoutubeDownloadJob, step: WorkflowStep): Promise<void> {
    const source = job.source === "pornhub" ? "pornhub" : "youtube";
    let statusMessageId = job.statusMessageId;
    let phase = "startup";
    let lease: PoolLease | undefined;
    const startContainer = async (suffix = "") => {
      const assignment = await step.do(`reserve download capacity${suffix}`, { retries: { limit: 0, delay: "1 second" } }, () => downloadPool(this.env).acquire(job.id));
      if (!assignment) throw new Error("DOWNLOAD_POOL_FULL");
      lease = assignment;
      job.containerIndex = assignment.instance;
      return step.do(
        `start youtube container${suffix}`,
        {
          retries: { limit: 2, delay: "5 seconds", backoff: "linear" },
          timeout: "2 minutes",
        },
        async () => {
          await pooledContainer(this.env, job).startShared(job.containerIndex!);
          return true;
        },
      );
    };

    try {
      if (!job.quality && !job.audioMode && job.source !== "pornhub") {
        statusMessageId = await step.do(
          "show youtube quality status",
          {
            retries: { limit: 3, delay: "2 seconds", backoff: "linear" },
            timeout: "1 minute",
          },
          async () => {
            const status = await telegramCall<TelegramMessage>(this.env.BOT_TOKEN, "sendMessage", {
              chat_id: job.chatId,
              text: "🔎 دارم کیفیت‌های موجود این ویدیو رو بررسی می‌کنم…",
              reply_parameters: { message_id: job.requestMessageId, allow_sending_without_reply: true },
            });
            return status.message_id;
          },
        );

        await startContainer();
        phase = "metadata";
        const metadata = await step.do(
          "inspect youtube qualities",
          {
            retries: { limit: 1, delay: "1 second", backoff: "constant" },
            timeout: "6 minutes",
          },
          async () => {
            return containerResult<YoutubeMetadataResult>(this.env, job,
              new Request("http://container/metadata", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ url: job.url, userId: job.userId }),
              }),
            );
          },
        );

        if (!metadata.ok || !metadata.videoId) {
          await step.do("track metadata failure", () => trackJob(this.env, job, "failed", { detail: metadata.message || "دریافت اطلاعات ویدیو ناموفق بود." }));
          await step.do("show youtube metadata error", async () => {
            await safeTelegramCall(this.env.BOT_TOKEN, "editMessageText", {
              chat_id: job.chatId,
              message_id: statusMessageId,
              text: metadata.message || "❌ کیفیت‌های این ویدیو دریافت نشد. دوباره لینک رو بفرست.",
            });
            return true;
          });
          return;
        }

        const qualities = normalizeQualities(metadata.qualities);
        if (qualities.length === 0 && !metadata.audioAvailable) {
          await step.do("track unavailable qualities", () => trackJob(this.env, job, "failed", { title: metadata.title, detail: "کیفیت قابل دانلود پیدا نشد." }));
          await step.do("show no youtube qualities", async () => {
            await safeTelegramCall(this.env.BOT_TOKEN, "editMessageText", {
              chat_id: job.chatId,
              message_id: statusMessageId,
              text: "❌ کیفیت قابل دانلود برای این ویدیو پیدا نشد.",
            });
            return true;
          });
          return;
        }

        await step.do("track quality selection", () => trackJob(this.env, job, "awaiting_selection", { title: metadata.title }));
        await step.do("show youtube quality buttons", async () => {
          await telegramCall(this.env.BOT_TOKEN, "editMessageText", {
            chat_id: job.chatId,
            message_id: statusMessageId,
            text: `${formatVideoTitle(metadata.title)}\n\nکیفیت یا حالت دانلود رو انتخاب کن:`,
            reply_markup: {
              inline_keyboard: buildQualityKeyboard(
                qualities,
                Boolean(metadata.audioAvailable),
                metadata.videoId!,
                job.requestMessageId,
                job.userId,
                metadata.sizes,
              ),
            },
          });
          return true;
        });
        return;
      }

      const selectionText = formatSelection(job);
      if (!statusMessageId) {
        statusMessageId = await step.do(
          "show youtube download status",
          {
            retries: { limit: 3, delay: "2 seconds", backoff: "linear" },
            timeout: "1 minute",
          },
          async () => {
            const status = await telegramCall<TelegramMessage>(this.env.BOT_TOKEN, "sendMessage", {
              chat_id: job.chatId,
              text: job.source === "pornhub" ? "⬇️ دارم ویدیوی Pornhub را دانلود می‌کنم…" : `⏳ ${selectionText} انتخاب شد؛ دانلود شروع شد…`,
              reply_parameters: { message_id: job.requestMessageId, allow_sending_without_reply: true },
            });
            return status.message_id;
          },
        );
      }

      if (!/^\d+$/.test(this.env.API_ID || "") || !this.env.API_HASH?.trim()) {
        throw new Error("YT_CONFIG");
      }
      if (await step.do("reuse telegram youtube file", { retries: { limit: 0, delay: "1 second" }, timeout: "1 minute" }, () => sendCachedMedia(this.env, job, statusMessageId))) {
        await step.do("record cached youtube delivery", async () => {
          await recordSuccessfulDelivery(this.env, `youtube:${job.id}`);
          await trackJob(this.env, job, "success", { delivered: 1, detail: formatSelection(job) });
        });
        return;
      }
      await startContainer();
      phase = "transfer";
      let result: ContainerResult;
      let wait = 0;
      while (true) {
        const suffix = wait ? ` after telegram wait ${wait}` : "";
        result = await step.do(
          `${job.audioMode ? "download and send youtube audio" : "download and send youtube video"}${suffix}`,
          {
            retries: { limit: 0, delay: "1 second", backoff: "constant" },
            timeout: "30 minutes",
          },
          async () => {
            return containerResult<ContainerResult>(this.env, job,
              new Request("http://container/download", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ ...job, statusMessageId, botToken: this.env.BOT_TOKEN,
                  ...(job.source === "pornhub" ? { pornhubSessionTag: await instagramSignature(this.env.BOT_TOKEN,
                    `pornhub-session:${this.env.PORNHUB_COOKIES || ""}`) } : {}),
                  ...await mediaCacheContext(this.env, job) }),
              }),
            );
          },
        );
        if (result.ok || !result.retrySafe || result.phase !== "upload" || result.rpcCode !== 420
            || !["FLOOD_WAIT", "SLOWMODE_WAIT"].includes(result.errorCode || "")
            || !Number.isSafeInteger(result.retryAfterSeconds) || result.retryAfterSeconds! < 0) break;
        wait++;
        const waitSuffix = ` for telegram wait ${wait}`;
        console.info("youtube delivery waiting for telegram", { jobId: job.id, rpcMethod: result.rpcMethod,
          retryAfterSeconds: result.retryAfterSeconds });
        await step.do(`track telegram wait${waitSuffix}`, () => trackJob(this.env, job, "processing", { detail: result.message }));
        // A definitive rejection is safe to resume. Release the host while the
        // Workflow timer waits; never replay an ambiguous HTTP/send failure.
        await step.do(`release download capacity${waitSuffix}`, { retries: { limit: 3, delay: "1 second" }, timeout: "1 minute" },
          () => downloadPool(this.env).release(job.id, lease!.token));
        lease = undefined;
        phase = "telegram_wait";
        await step.sleep(`wait for telegram ${wait}`, `${Math.max(1, result.retryAfterSeconds!)} seconds`);
        phase = "startup";
        await startContainer(` after telegram wait ${wait}`);
        phase = "transfer";
      }

      if (result.ok) {
        await step.do("record youtube delivery", async () => {
          await recordSuccessfulDelivery(this.env, `youtube:${job.id}`);
          await trackJob(this.env, job, "success", { delivered: 1, title: result.title, detail: formatSelection(job) });
          return true;
        });
      } else {
        console.error(`${source} download rejected`, { source, jobId: job.id, phase: result.phase || "transfer",
          code: result.errorCode || "SOURCE_REJECTED",
          type: result.errorType, rpcMethod: result.rpcMethod, rpcCode: result.rpcCode, retryAfterSeconds: result.retryAfterSeconds,
          sourceDiagnostics: source === "pornhub" ? safeSourceDiagnostics(result.sourceDiagnostics) : undefined,
          detail: redactDiagnostic(result.diagnostic || result.message || "download failed", this.env) });
        await step.do("track youtube rejection", () => trackJob(this.env, job, "failed", { title: result.title, detail: result.message || "دریافت یا ارسال فایل ناموفق بود." }));
      }
    } catch (error) {
      const detail = redactDiagnostic(error instanceof Error ? error.message : String(error), this.env);
      console.error(`${source} workflow failed`, { source, jobId: job.id, phase, detail });
      const failureMessage = workflowFailureMessage(detail, phase);
      await step.do("track youtube failure", () => trackJob(this.env, job, "failed", { detail: failureMessage }));

      await step.do(
        "notify youtube workflow failure",
        {
          retries: { limit: 3, delay: "3 seconds", backoff: "linear" },
          timeout: "1 minute",
        },
        async () => {
          if (statusMessageId) {
            await safeTelegramCall(this.env.BOT_TOKEN, "editMessageText", {
              chat_id: job.chatId,
              message_id: statusMessageId,
              text: failureMessage,
            });
          } else {
            await safeTelegramCall(this.env.BOT_TOKEN, "sendMessage", {
              chat_id: job.chatId,
              text: failureMessage,
              reply_parameters: { message_id: job.requestMessageId, allow_sending_without_reply: true },
            });
          }
          return true;
        },
      );
    } finally {
      if (lease) await step.do("release download capacity", { retries: { limit: 3, delay: "1 second" }, timeout: "1 minute" }, () => downloadPool(this.env).release(job.id, lease!.token));
    }
  }

  private async runInstagram(job: YoutubeDownloadJob, step: WorkflowStep): Promise<void> {
    let statusId: number | undefined;
    let started = false;
    let lease: PoolLease | undefined;
    let phase = "status";
    try {
      statusId = await step.do("show instagram video status", async () => {
        if (job.instagramPost) return job.instagramPost.statusMessageId;
        const message = await telegramCall<TelegramMessage>(this.env.BOT_TOKEN, "sendMessage", {
          chat_id: job.chatId, reply_parameters: { message_id: job.requestMessageId, allow_sending_without_reply: true },
          text: job.social ? `⬇️ دارم ${job.social.audioOnly ? "صدای ویدیوی" : "فایل"} ${socialName(job.social.platform)} را دریافت می‌کنم…` : job.playlist ? `🎵 دارم آهنگ‌های ${job.playlist.start}-${job.playlist.end} پلی‌لیست را به‌صورت MP3 آماده می‌کنم…` : job.recognition || job.instagram?.recognizeMusic ? "🎧 دارم آهنگ داخل فایل را شناسایی می‌کنم…" : job.instagram?.kind === "music" ? "🔎 دارم آهنگ را پیدا می‌کنم…" : job.instagram?.kind === "audio" ? "🎵 دارم صدای ویدیوی اینستاگرام را آماده می‌کنم…" : "🔎 دارم لایو یا بازپخش اینستاگرام را بررسی می‌کنم…",
        });
        return message.message_id;
      });
      // Private Instagram media must still be visible to the connected account.
      // Public song-query cache hits can be delivered without source resolution.
      const needsAccessCheck = Boolean(job.instagram && job.instagram.kind !== "music");
      if (!needsAccessCheck && await step.do("reuse telegram media file", { retries: { limit: 0, delay: "1 second" }, timeout: "1 minute" }, () => sendCachedMedia(this.env, job, statusId))) {
        await step.do("record cached media delivery", async () => {
          await recordSuccessfulDelivery(this.env, `instagram:${job.id}`);
          await trackJob(this.env, job, "success", { delivered: 1 });
        });
        return;
      }
      // Return friendly failures durably, without retrying rejected Instagram sessions.
      phase = "resolution";
      const resolution = await step.do("resolve instagram live or replay", { retries: { limit: 0, delay: "1 second" }, timeout: "2 minutes" }, async () => {
        try {
          const source: MediaSource = job.instagramPost ? { mode: "replay", title: "Instagram",
            instagramPost: { shortcode: job.instagramPost.shortcode, media: job.instagramPost.media } }
            : job.social ? { mode: "replay", title: socialName(job.social.platform), social: job.social } : job.playlist ? { mode: "replay", title: "YouTube Playlist", audioOnly: true, playlist: job.playlist } : job.recognition
            ? { mode: "replay", title: "Music recognition", audioOnly: true, recognition: job.recognition }
            : await resolveInstagramVideo(job.instagram!, this.env);
          return { source };
        }
        catch (error) { return { message: instagramVideoErrorText(error) }; }
      });
      if (!resolution.source) {
        await step.do("track source failure", () => trackJob(this.env, job, "failed", { detail: resolution.message }));
        await step.do("show instagram resolution error", () => telegramCall<boolean>(this.env.BOT_TOKEN, "editMessageText", {
          chat_id: job.chatId, message_id: statusId, text: resolution.message,
        }));
        return;
      }
      const source = resolution.source;
      if (needsAccessCheck && await step.do("reuse accessible instagram file", { retries: { limit: 0, delay: "1 second" }, timeout: "1 minute" }, () => sendCachedMedia(this.env, job, statusId))) {
        await step.do("record cached media delivery", async () => {
          await recordSuccessfulDelivery(this.env, `instagram:${job.id}`);
          await trackJob(this.env, job, "success", { delivered: 1 });
        });
        return;
      }
      phase = "startup";
      if (!/^\d+$/.test(this.env.API_ID || "") || !this.env.API_HASH?.trim()) throw new Error("YT_CONFIG");
      const assignment = await step.do("reserve download capacity", { retries: { limit: 0, delay: "1 second" } }, () => downloadPool(this.env).acquire(job.id));
      if (!assignment) throw new Error("DOWNLOAD_POOL_FULL");
      lease = assignment;
      job.containerIndex = assignment.instance;
      await step.do("start instagram container", { retries: { limit: 2, delay: "5 seconds", backoff: "linear" }, timeout: "2 minutes" }, async () => {
        await pooledContainer(this.env, job).startShared(job.containerIndex!);
        return true;
      });
      started = true;
      phase = "capture";
      await step.do("begin instagram capture", { retries: { limit: 2, delay: "3 seconds" }, timeout: "1 minute" }, async () => {
        const signature = (await instagramSignature(this.env.BOT_TOKEN, `stop:${job.chatId}:${job.requestMessageId}:${job.userId}`)).slice(0, 16);
        const result = await pooledContainer(this.env, job).instagramRequest("start", {
          id: job.id, source, botToken: this.env.BOT_TOKEN, chatId: job.chatId, requestMessageId: job.requestMessageId, userId: job.userId,
          statusMessageId: statusId,
          stopData: `igs|${job.requestMessageId}|${job.userId}|${signature}`,
          completionUrl: `https://downloader.vexaagent.workers.dev/instagram/events/${job.id}`,
          completionToken: await instagramSignature(this.env.BOT_TOKEN, `event:${job.id}`),
          ...await mediaCacheContext(this.env, job),
        });
        if (!result.ok) throw new Error("IG_START_FAILED");
        return true;
      });
      // A completion event may arrive before this call; Workflows buffers it.
      phase = "wait";
      const ready = await step.waitForEvent<ContainerResult>("await instagram recording", { type: "instagram-ready", timeout: "150 minutes" });
      if (!ready.payload.ok) {
        await step.do("track capture failure", () => trackJob(this.env, job, "failed", { title: source.title, detail: ready.payload.message || "دریافت محتوا کامل نشد." }));
        await step.do("show instagram capture failure", () => telegramCall<boolean>(this.env.BOT_TOKEN, "editMessageText", {
          chat_id: job.chatId, message_id: statusId, text: ready.payload.message || "❌ دریافت لایو کامل نشد؛ دوباره لینک را بفرست.", reply_markup: { inline_keyboard: [] },
        }));
        return;
      }
      phase = "upload";
      let result: ContainerResult;
      let telegramWait = 0;
      while (true) {
        const suffix = telegramWait ? ` after telegram wait ${telegramWait}` : "";
        result = await step.do(`send complete instagram recording${suffix}`, { retries: { limit: 0, delay: "1 second" }, timeout: "30 minutes" }, () =>
          pooledContainer(this.env, job).instagramRequest("send", { id: job.id }),
        );
        if (result.ok || !result.retrySafe || result.phase !== "upload" || result.rpcCode !== 420
            || !["FLOOD_WAIT", "SLOWMODE_WAIT"].includes(result.errorCode || "")
            || !Number.isSafeInteger(result.retryAfterSeconds) || result.retryAfterSeconds! < 0) break;
        telegramWait++;
        console.info("instagram delivery waiting for telegram", { jobId: job.id, rpcMethod: result.rpcMethod,
          retryAfterSeconds: result.retryAfterSeconds });
        await step.do(`track instagram telegram wait ${telegramWait}`, () =>
          trackJob(this.env, job, "processing", { detail: result.message }));
        // Unlike YouTube, the prepared Instagram file lives in this assigned Container.
        // Keep its lease and job while the Workflow sleeps; never replay an ambiguous send.
        phase = "telegram_wait";
        await step.sleep(`wait for instagram telegram ${telegramWait}`, `${Math.max(1, result.retryAfterSeconds!)} seconds`);
        phase = "upload";
      }
      if (result.ok) {
        const searchOnly = job.instagram?.kind === "music" && !job.instagram.musicVideoId;
        await step.do("track media result", () => trackJob(this.env, job, searchOnly ? "results" : result.partial ? "partial" : "success", {
          title: result.title || source.title, delivered: searchOnly ? 0 : Math.min(20, result.parts || 1),
          detail: result.partial ? result.message : undefined,
        }));
        // Search results are messages, not downloaded files.
        if (!(job.instagram?.kind === "music" && !job.instagram.musicVideoId)) await step.do("record instagram video delivery", async () => {
          for (let i = 0; i < Math.min(20, result.parts || 1); i++) await recordSuccessfulDelivery(this.env, `instagram:${job.id}${i ? `:${i}` : ""}`);
        });
      } else if ((job.social || job.instagramPost) && result.message) {
        await step.do("track partial media result", () => trackJob(this.env, job, result.parts ? "partial" : "failed", {
          title: result.title || source.title, delivered: result.parts || 0, detail: result.message,
        }));
        if (result.parts) await step.do("record partial social delivery", async () => {
          for (let i = 0; i < Math.min(20, result.parts || 0); i++) await recordSuccessfulDelivery(this.env, `instagram:${job.id}${i ? `:${i}` : ""}`);
        });
        await step.do("show social delivery failure", () => telegramCall<boolean>(this.env.BOT_TOKEN, "editMessageText", {
          chat_id: job.chatId, message_id: statusId, text: result.message,
        }));
      } else throw new Error(`IG_SEND_FAILED ${redactDiagnostic([result.errorCode, result.diagnostic, result.message].filter(Boolean).join(": "), this.env)}`);
    } catch (error) {
      console.error("instagram video workflow failed", { jobId: job.id, phase,
        type: error instanceof Error ? error.name : "error",
        detail: redactDiagnostic(error instanceof Error ? error.message : String(error), this.env) });
      await step.do("track media failure", () => trackJob(this.env, job, "failed", {
        detail: "دریافت یا ارسال کامل نشد؛ تحویل فایل تأیید نشده است.",
      }));
      await step.do("notify instagram video failure", async () => {
        const text = error instanceof Error && /YT_CONFIG|DOWNLOAD_POOL_FULL|max.*instance|provision/i.test(error.message)
          ? workflowFailureMessage(error.message, "startup")
          : job.instagramPost ? "❌ دریافت یا ارسال پست اینستاگرام کامل نشد؛ اگر فایلی دریافت کرده‌ای، پیش از درخواست دوباره بررسی کن."
          : job.social ? `❌ دریافت یا ارسال فایل ${socialName(job.social.platform)} کامل نشد؛ اگر فایلی دریافت کرده‌ای، پیش از درخواست دوباره بررسی کن.` : job.recognition || job.playlist || job.instagram?.kind === "music" || job.instagram?.kind === "audio" ? "❌ دریافت یا ارسال فایل صوتی کامل نشد؛ درخواست را دوباره بفرست." : "❌ ضبط یا ارسال لایو کامل نشد؛ لینک را دوباره بفرست. ممکن است سرور ری‌استارت شده باشد.";
        await safeTelegramCall(this.env.BOT_TOKEN, statusId ? "editMessageText" : "sendMessage", {
          chat_id: job.chatId, message_id: statusId, text, reply_markup: { inline_keyboard: [] },
        });
        return true;
      });
    } finally {
      try {
        if (started) await step.do("release instagram recording", { retries: { limit: 1, delay: "2 seconds" }, timeout: "1 minute" }, async () => {
          const container = pooledContainer(this.env, job);
          try { await container.instagramRequest("cleanup", { id: job.id }); }
          finally { await container.releaseInstagram(job.id); }
          return true;
        });
      } finally {
        if (lease) await step.do("release download capacity", { retries: { limit: 3, delay: "1 second" }, timeout: "1 minute" }, () => downloadPool(this.env).release(job.id, lease!.token));
      }
    }
  }
}

async function telegramCall<T = unknown>(
  token: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<T> {
  await telegramTextMotion(token, method, payload);
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(telegramCustomEmoji(method, payload)),
  });
  const data = (await response.json()) as TelegramApiResponse<T>;
  if (!response.ok || !data.ok) {
    throw new Error(data.description || `Telegram ${method} failed`);
  }
  return data.result as T;
}

async function safeTelegramCall(
  token: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await telegramCall(token, method, payload);
  } catch (error) {
    console.warn("youtube telegram call failed", {
      method,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function isYoutubeQuality(value: number): value is YoutubeQuality {
  return SUPPORTED_QUALITIES.includes(value as YoutubeQuality);
}

function normalizeQualities(values: number[] | undefined): YoutubeQuality[] {
  if (!Array.isArray(values)) return [];
  return SUPPORTED_QUALITIES.filter((quality) => values.includes(quality));
}

function formatVideoTitle(title: string | undefined): string {
  const clean = (title || "YouTube video").replace(/\s+/g, " ").trim();
  const truncated = clean.length > 120 ? `${clean.slice(0, 117)}…` : clean;
  return `🎬 ${truncated}`;
}

function qualityLabel(quality: YoutubeQuality): string {
  if (quality === 360) return "360p Low";
  if (quality === 480) return "480p Standard";
  if (quality === 720) return "⭐ 720p HD";
  return "1080p Full HD";
}

function formatSelection(job: Pick<YoutubeDownloadJob, "quality" | "audioMode">): string {
  if (job.audioMode === "low") return "🎵 Audio Low";
  if (job.audioMode === "hq") return "🎧 Audio HQ";
  return qualityLabel(job.quality!);
}

function fileSizeLabel(size: YoutubeFileSize | undefined): string {
  if (!size || !Number.isFinite(size.bytes) || size.bytes <= 0) return "Size unknown";
  const bytes = size.bytes;
  const label = bytes >= 1_000_000_000 ? `${(bytes / 1_000_000_000).toFixed(2)} GB`
    : bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1000))} KB`;
  return label;
}

function buildQualityKeyboard(
  qualities: YoutubeQuality[],
  audioAvailable: boolean,
  videoId: string,
  requestMessageId: number,
  userId: number,
  sizes?: Record<string, YoutubeFileSize>,
): Array<Array<{ text: string; callback_data: string }>> {
  const buttons = qualities.map((quality) => ({
    text: `${qualityLabel(quality)} ${fileSizeLabel(sizes?.[String(quality)])}`,
    callback_data: `ytq|${videoId}|${quality}|${requestMessageId}|${userId}`,
  }));
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let index = 0; index < buttons.length; index += 2) {
    rows.push(buttons.slice(index, index + 2));
  }
  if (audioAvailable) {
    rows.push([
      {
        text: `🎵 Audio Low ${fileSizeLabel(sizes?.low)}`,
        callback_data: `ytq|${videoId}|al|${requestMessageId}|${userId}`,
      },
      {
        text: `🎧 Audio HQ ${fileSizeLabel(sizes?.hq)}`,
        callback_data: `ytq|${videoId}|ah|${requestMessageId}|${userId}`,
      },
    ]);
  }
  return rows;
}

function parseQualityCallback(data: string | undefined): ParsedQualityCallback | null {
  if (!data) return null;
  const match = /^ytq\|([A-Za-z0-9_-]{6,20})\|(360|480|720|1080|al|ah)\|(\d+)\|(\d+)$/.exec(data);
  if (!match) return null;

  const requestMessageId = Number(match[3]);
  const userId = Number(match[4]);
  if (
    !Number.isSafeInteger(requestMessageId) ||
    requestMessageId <= 0 ||
    !Number.isSafeInteger(userId) ||
    userId <= 0
  ) {
    return null;
  }

  const choice = match[2];
  if (choice === "al" || choice === "ah") {
    return {
      videoId: match[1],
      audioMode: choice === "al" ? "low" : "hq",
      requestMessageId,
      userId,
    };
  }

  const quality = Number(choice);
  if (!isYoutubeQuality(quality)) return null;
  return {
    videoId: match[1],
    quality,
    requestMessageId,
    userId,
  };
}

function socialName(platform: SocialInput["platform"]): string {
  return { x: "X", pinterest: "Pinterest", tiktok: "TikTok", soundcloud: "SoundCloud", aparat: "Aparat" }[platform];
}

// Only individual posts/tracks, never profiles, boards, feeds or arbitrary URLs.
function parseSocialUrl(text: string): SocialInput | null {
  const command = /^\/([a-z]+)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.exec(text);
  if (command && !["x", "twitter", "pinterest", "tiktok", "soundcloud", "aparat", "audio"].includes(command[1].toLowerCase())) return null;
  const audio = command?.[1].toLowerCase() === "audio" ? { audioOnly: true as const } : {};
  for (const raw of text.match(/https?:\/\/[^\s<>"']+/gi) || []) {
    try {
      const u = new URL(raw.replace(/[),.!?\]}،؛]+$/g, ""));
      if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.port) continue;
      const host = u.hostname.toLowerCase();
      const path = u.pathname;
      let m: RegExpExecArray | null;
      if (["aparat.com", "www.aparat.com"].includes(host)
          && (m = /^\/(?:v\/|video\/video\/embed\/videohash\/)([A-Za-z0-9]{1,32})(?:\/[^?#]*)?$/.exec(path))) {
        return { platform: "aparat", url: `https://www.aparat.com/v/${m[1]}`, ...audio };
      }
      if (["x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com", "m.twitter.com"].includes(host)
          && (m = /^\/(?:[A-Za-z0-9_]+\/status|i\/web\/status|statuses)\/(\d{1,25})(?:\/video\/([1-9]\d?))?\/?$/.exec(path))) {
        return { platform: "x", url: `https://x.com/i/status/${m[1]}${m[2] ? `/video/${m[2]}` : ""}`, ...audio };
      }
      if (/^(?:(?:www|[a-z]{2})\.)?pinterest\.(?:com|fr|de|ch|jp|cl|ca|it|co\.uk|nz|ru|com\.au|at|pt|co\.kr|es|com\.mx|dk|ph|th|com\.uy|co|nl|info|kr|ie|vn|com\.vn|ec|mx|in|pe|co\.at|hu|co\.in|co\.nz|id|com\.ec|com\.py|tw|be|uk|com\.bo|com\.pe)$/.test(host)
          && (m = /^\/pin\/(?:[\w-]+--)?(\d{1,25})(?:\/sent)?\/?$/.exec(path))) {
        return { platform: "pinterest", url: `https://www.pinterest.com/pin/${m[1]}/`, ...audio };
      }
      if (["pin.it", "vm.tiktok.com", "vt.tiktok.com", "on.soundcloud.com"].includes(host) && /^\/[A-Za-z0-9_-]{3,128}\/?$/.test(path)) {
        return { platform: host === "pin.it" ? "pinterest" : host === "on.soundcloud.com" ? "soundcloud" : "tiktok", url: `https://${host}${path}`, ...audio };
      }
      if (["tiktok.com", "www.tiktok.com", "m.tiktok.com"].includes(host)) {
        if ((m = /^\/@([\w.-]+)\/(video|photo)\/(\d{1,25})\/?$/.exec(path))) return { platform: "tiktok", url: `https://www.tiktok.com/@${m[1]}/${m[2]}/${m[3]}`, ...audio };
        if (/^\/t\/[A-Za-z0-9_-]{3,128}\/?$/.test(path)) return { platform: "tiktok", url: `https://www.tiktok.com${path}`, ...audio };
      }
      if (["soundcloud.com", "www.soundcloud.com", "m.soundcloud.com"].includes(host) && /^\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/?$/.test(path)
          && !/^\/(?:discover|search|you|stations|charts|stream|upload)\//i.test(path)
          && !/\/(?:sets|tracks|albums|likes|reposts|popular-tracks|spotlight|comments)\/?$/i.test(path)) {
        return { platform: "soundcloud", url: `https://soundcloud.com${path.replace(/\/$/, "")}`, ...audio };
      }
    } catch { /* Keep scanning message URLs. */ }
  }
  return null;
}

function extractYouTubeUrl(text: string): string | null {
  const matches = text.match(/https?:\/\/[^\s<>"']+/gi) ?? [];

  for (const raw of matches) {
    const candidate = raw.replace(/[),.!?\]}،؛]+$/g, "");
    try {
      const url = new URL(candidate);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port) continue;
      const host = url.hostname.toLowerCase();
      if (!["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be",
            "youtube-nocookie.com", "www.youtube-nocookie.com"].includes(host)) continue;
      const id = host.endsWith("youtu.be") ? /^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1]
        : url.pathname === "/watch" ? url.searchParams.get("v")
        : /^\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
      if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) return `https://www.youtube.com/watch?v=${id}`;
    } catch {
      // Keep scanning URLs in the message.
    }
  }

  return null;
}

function extractPornhubUrl(text: string): string | null {
  for (const raw of text.match(/https?:\/\/[^\s<>"']+/gi) ?? []) {
    try {
      const url = new URL(raw.replace(/[),.!?\]}]+$/g, ""));
      if (url.username || url.password || url.port || !/(^|\.)pornhub\.(com|org|net)$/i.test(url.hostname)) continue;
      const id = url.pathname === "/view_video.php" ? url.searchParams.get("viewkey") : /^\/embed\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname)?.[1];
      if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) continue;
      return `https://${url.hostname.toLowerCase()}/view_video.php?viewkey=${id}`;
    } catch { /* Keep scanning URLs in the message. */ }
  }
  return null;
}

function parsePlaylist(text: string): PlaylistInput | null {
  const explicit = /^\/playlist(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text);
  const args = explicit ? text.replace(/^\/playlist(?:@[A-Za-z0-9_]+)?\s*/i, "").trim().split(/\s+/)
    : [(text.match(/https?:\/\/[^\s<>"']+/i)?.[0] || text).replace(/[),.!?\]}،؛]+$/g, "")];
  if (args.length > 2) return null;
  try {
    const url = new URL(args[0]);
    if (url.protocol !== "https:" || url.username || url.password || url.port
        || !["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(url.hostname)) return null;
    if (!explicit && url.pathname !== "/playlist") return null;
    const id = url.searchParams.get("list");
    if (!id || !/^[A-Za-z0-9_-]{6,150}$/.test(id)) return null;
    const range = args[1] ? /^(\d+)-(\d+)$/.exec(args[1]) : null;
    if (args[1] && !range) return null;
    const start = range ? Number(range[1]) : 1, end = range ? Number(range[2]) : 20;
    if (!Number.isSafeInteger(start) || start < 1 || end < start || end - start >= 20 || end > 10000) return null;
    return { url: `https://www.youtube.com/playlist?list=${id}`, start, end };
  } catch { return null; }
}

function isStartCommand(text: string): boolean {
  return /^\/start(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text.trim());
}

function trackedUser(message: TelegramMessage): TrackedUser | null {
  const id = message.from?.id ?? (message.chat.id > 0 ? message.chat.id : 0);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return {
    id,
    username: message.from?.username,
    firstName: message.from?.first_name,
    lastName: message.from?.last_name,
  };
}

async function createYoutubeInspectWorkflow(
  env: Env,
  update: TelegramUpdate,
  url: string,
  source?: "pornhub",
): Promise<Response> {
  const message = update.message!;
  const user = trackedUser(message);
  const userId = user?.id ?? message.chat.id;
  const job: YoutubeDownloadJob = {
    id: source === "pornhub" ? `ytdl-${message.chat.id}-${message.message_id}-${userId}` : `ytq-${update.update_id}`,
    chatId: message.chat.id,
    requestMessageId: message.message_id,
    userId,
    url,
    ...(source ? { source } : {}),
  };

  await trackJob(env, job, "pending");
  try {
    await env.YOUTUBE_DOWNLOAD_WORKFLOW.create({ id: job.id, params: job });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!/already|exists|duplicate|conflict/i.test(detail)) {
      await trackJob(env, job, "failed", { detail: "ایجاد درخواست دانلود ناموفق بود." });
      console.error("youtube inspect workflow create failed", { jobId: job.id, detail });
      await safeTelegramCall(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: source === "pornhub" ? "❌ شروع دانلود Pornhub ناموفق بود؛ دوباره لینک را بفرست." : "❌ نتونستم کیفیت‌های YouTube رو بررسی کنم. دوباره لینک رو بفرست.",
        reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
      });
    }
  }

  return Response.json({ ok: true });
}

async function handleQualityCallback(
  env: Env,
  update: TelegramUpdate,
  callback: TelegramCallbackQuery,
): Promise<Response> {
  const parsed = parseQualityCallback(callback.data);
  if (!parsed || !callback.message) {
    await safeTelegramCall(env.BOT_TOKEN, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "این انتخاب دیگه معتبر نیست.",
      show_alert: false,
    });
    return Response.json({ ok: true });
  }

  if (callback.from.id !== parsed.userId) {
    await safeTelegramCall(env.BOT_TOKEN, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "این دکمه برای شما نیست.",
      show_alert: true,
    });
    return Response.json({ ok: true });
  }

  const job: YoutubeDownloadJob = {
    id: `ytdl-${callback.message.chat.id}-${parsed.requestMessageId}-${parsed.userId}`,
    chatId: callback.message.chat.id,
    requestMessageId: parsed.requestMessageId,
    userId: parsed.userId,
    url: `https://www.youtube.com/watch?v=${parsed.videoId}`,
    quality: parsed.quality,
    audioMode: parsed.audioMode,
    statusMessageId: callback.message.message_id,
  };
  const selectionText = formatSelection(job);

  await trackJob(env, job, "pending");
  try {
    await env.YOUTUBE_DOWNLOAD_WORKFLOW.create({ id: job.id, params: job });
    await safeTelegramCall(env.BOT_TOKEN, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: `${selectionText} انتخاب شد`,
      show_alert: false,
    });
    await safeTelegramCall(env.BOT_TOKEN, "editMessageText", {
      chat_id: job.chatId,
      message_id: job.statusMessageId,
      text: `⏳ ${selectionText} انتخاب شد؛ دانلود شروع شد…`,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/already|exists|duplicate|conflict/i.test(detail)) {
      await safeTelegramCall(env.BOT_TOKEN, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "دانلود این درخواست قبلاً شروع شده؛ برای دانلود دوباره لینک رو بفرست.",
        show_alert: false,
      });
    } else {
      await trackJob(env, job, "failed", { detail: "شروع دانلود ناموفق بود." });
      console.error("youtube download workflow create failed", { jobId: job.id, detail });
      await safeTelegramCall(env.BOT_TOKEN, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "شروع دانلود ناموفق بود. دوباره لینک رو بفرست.",
        show_alert: true,
      });
    }
  }

  return Response.json({ ok: true });
}

async function createInstagramWorkflow(env: Env, update: TelegramUpdate, target?: InstagramVideoTarget, recognition?: RecognitionInput, playlist?: PlaylistInput, social?: SocialInput): Promise<Response> {
  const message = update.message!;
  const user = trackedUser(message);
  const userId = user?.id ?? message.chat.id;
  const job: YoutubeDownloadJob = {
    id: `igdl-${message.chat.id}-${message.message_id}-${userId}${target?.musicVideoId ? `-music-${target.musicVideoId}` : target?.kind === "audio" ? target.recognizeMusic ? "-song" : "-audio" : ""}`, chatId: message.chat.id,
    requestMessageId: message.message_id, userId, url: "", instagram: target,
    ...(recognition ? { recognition } : {}),
    ...(playlist ? { playlist } : {}),
    ...(social ? { social } : {}),
  };
  await trackJob(env, job, "pending");
  try {
    await env.YOUTUBE_DOWNLOAD_WORKFLOW.create({ id: job.id, params: job });
  } catch (error) {
    if (!/already|exists|duplicate|conflict/i.test(error instanceof Error ? error.message : String(error))) {
      await trackJob(env, job, "failed", { detail: "شروع دریافت فایل ناموفق بود." });
      await safeTelegramCall(env.BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, text: "❌ شروع دریافت فایل ناموفق بود؛ درخواست را دوباره بفرست." });
    }
  }
  return Response.json({ ok: true });
}

async function stopInstagramRecording(env: Env, callback: TelegramCallbackQuery): Promise<Response> {
  const match = /^igs\|(\d+)\|(\d+)\|([a-f0-9]{16})$/.exec(callback.data || "");
  const chatId = callback.message?.chat.id;
  let text = "این دکمه معتبر نیست یا برای شما نیست.";
  if (match && chatId && callback.from.id === Number(match[2])) {
    const signature = (await instagramSignature(env.BOT_TOKEN, `stop:${chatId}:${match[1]}:${match[2]}`)).slice(0, 16);
    if (equalSignature(signature, match[3])) {
      // Acknowledge immediately; the capture process finalizes its file separately.
      await safeTelegramCall(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "درخواست توقف ارسال شد…" });
      try {
        const id = `igdl-${chatId}-${match[1]}-${match[2]}`;
        const lease = await downloadPool(env).lookup(id);
        const result = lease
          ? await pooledContainer(env, { containerIndex: lease.instance }).instagramRequest("stop", { id })
          : { ok: false, message: "ضبط قبلاً تمام شده یا در حال ارسال است." };
        if (!result.ok) await safeTelegramCall(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: result.message || "ضبط قبلاً تمام شده یا در حال ارسال است." });
      } catch {
        await safeTelegramCall(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: "❌ ارتباط با ضبط‌کننده برقرار نشد؛ ممکن است ضبط پایان یافته یا سرور ری‌استارت شده باشد." });
      }
      return Response.json({ ok: true });
    }
  }
  await safeTelegramCall(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text, show_alert: true });
  return Response.json({ ok: true });
}

function musicQuery(text: string): string | null {
  if (/https?:\/\//i.test(text)) return null;
  const explicit = /^\/(?:music|song)(?:@[A-Za-z0-9_]+)?\s+(.+)$/is.exec(text);
  if (text.startsWith("/") && !explicit) return null;
  const query = (explicit?.[1] || text.replace(/^(?:دانلود\s+)?(?:آهنگ|اهنگ|موزیک|موسیقی)\s+/u, "")).replace(/\s+/g, " ").trim();
  return query.length >= 2 && query.length <= 200 ? query : null;
}

async function musicSelection(env: Env, update: TelegramUpdate, callback: TelegramCallbackQuery): Promise<Response> {
  const match = /^msc\|([A-Za-z0-9_-]{11})\|(\d+)\|(\d{10})\|([a-f0-9]{16})$/.exec(callback.data || "");
  const message = callback.message;
  if (!match || !message || callback.from.id !== Number(match[2])) {
    await safeTelegramCall(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "این انتخاب برای درخواست‌کنندهٔ آهنگ است.", show_alert: true });
    return Response.json({ ok: true });
  }
  const [, videoId, owner, expiry, signature] = match;
  const expected = (await instagramSignature(env.BOT_TOKEN, `music-select:${message.chat.id}:${owner}:${videoId}:${expiry}`)).slice(0, 16);
  if (Number(expiry) < Date.now() / 1000 || Number(expiry) > Date.now() / 1000 + 86460 || !equalSignature(signature, expected)) {
    await safeTelegramCall(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "این فهرست منقضی یا نامعتبر است؛ دوباره جست‌وجو کن.", show_alert: true });
    return Response.json({ ok: true });
  }
  await safeTelegramCall(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "آهنگ انتخاب شد؛ دانلود شروع می‌شود." });
  return createInstagramWorkflow(env, { ...update, message: { ...message, from: callback.from } }, { kind: "music", musicVideoId: videoId });
}

function recognitionMedia(message: TelegramMessage): TelegramMedia | undefined {
  const media = message.voice || message.audio || message.video || message.video_note;
  if (media) return media;
  const document = message.document;
  if (document && (/^(audio|video)\//i.test(document.mime_type || "")
      || /\.(mp3|m4a|wav|ogg|opus|flac|aac|aiff|mp4|mov|mkv|webm|avi|wma)$/i.test(document.file_name || ""))) return document;
  return undefined;
}

async function recognizeMessage(env: Env, update: TelegramUpdate, media: TelegramMedia): Promise<Response> {
  if (typeof media.file_id !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/.test(media.file_id)
      || (media.file_size !== undefined && (!Number.isSafeInteger(media.file_size) || media.file_size <= 0 || media.file_size > RECOGNITION_FILE_LIMIT))) {
    await safeTelegramCall(env.BOT_TOKEN, "sendMessage", {
      chat_id: update.message!.chat.id, reply_parameters: { message_id: update.message!.message_id, allow_sending_without_reply: true },
      text: "برای تشخیص آهنگ یک تکهٔ صوتی یا ویدیویی با حجم حداکثر 20 MB بفرست؛ 10 تا 30 ثانیه از بخش واضح آهنگ کافی است.",
    });
    return Response.json({ ok: true });
  }
  return createInstagramWorkflow(env, update, undefined, { fileId: media.file_id, ...(media.file_size ? { fileSize: media.file_size } : {}) });
}

async function instagramAudioCallback(env: Env, update: TelegramUpdate, callback: TelegramCallbackQuery): Promise<Response> {
  const findMusic = callback.data?.startsWith("igm|");
  const match = /^iga\|(p|s)\|([A-Za-z0-9_-]{1,20})\|(\d{1,3})\|(\d+)$/.exec((callback.data || "").replace(/^igm\|/, "iga|"));
  if (!match || !callback.message || callback.from.id !== Number(match[4]) || (match[1] === "s" && !/^\d+$/.test(match[2]))) {
    await safeTelegramCall(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "این دکمه معتبر نیست یا برای شما نیست.", show_alert: true });
    return Response.json({ ok: true });
  }
  await safeTelegramCall(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "در حال آماده‌سازی فایل صوتی…" });
  const target: InstagramVideoTarget = match[1] === "p" ? { kind: "audio", shortcode: match[2], videoIndex: Number(match[3]) } : { kind: "audio", mediaId: match[2] };
  if (findMusic) target.recognizeMusic = true;
  return createInstagramWorkflow(env, { ...update, message: { ...callback.message, from: callback.from } }, target);
}

async function socialAudioCallback(env: Env, update: TelegramUpdate, callback: TelegramCallbackQuery): Promise<Response> {
  const match = /^soa\|([0-9]|1[0-9])\|(\d+)\|([a-f0-9]{16})$/.exec(callback.data || "");
  const message = callback.message;
  const target = message ? parseSocialUrl((message.caption || "").split("\n").at(-1) || "") : null;
  if (!match || !message || !target || target.platform === "soundcloud" || callback.from.id !== Number(match[2])
      || !equalSignature((await instagramSignature(env.BOT_TOKEN, `social-audio:${message.chat.id}:${match[2]}:${match[1]}:${target.url}`)).slice(0, 16), match[3])) {
    await safeTelegramCall(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "این دکمه معتبر نیست یا برای شما نیست.", show_alert: true });
    return Response.json({ ok: true });
  }
  await safeTelegramCall(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "در حال آماده‌سازی فایل صوتی…" });
  return createInstagramWorkflow(env, { ...update, message: { ...message, from: callback.from } }, undefined, undefined, undefined,
    { ...target, audioOnly: true, itemIndex: Number(match[1]) });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestUrl = new URL(request.url);

    const usageRequest = /^\/container-usage\/(\d+)$/.exec(requestUrl.pathname);
    if (request.method === "POST" && usageRequest) {
      const index = Number(usageRequest[1]);
      if (index < 0 || index >= POOL_INSTANCES) return new Response("Invalid container", { status: 400 });
      const expected = await instagramSignature(env.BOT_TOKEN, `usage:${index}`);
      if (!equalSignature(request.headers.get("x-admin-usage-token") || "", expected)) return new Response("Forbidden", { status: 403 });
      // Limit the body before decoding JSON, including requests without Content-Length.
      const reader = request.body?.getReader();
      if (!reader) return new Response("Invalid usage", { status: 400 });
      let size = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 200000) { await reader.cancel(); return new Response("Too large", { status: 413 }); }
        chunks.push(chunk.value);
      }
      try {
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        const body = JSON.parse(new TextDecoder().decode(bytes)) as { samples: UsageSample[]; deliveries: MediaUsage[] };
        const ok = await recordUsage(env, body.samples, body.deliveries);
        return Response.json({ ok }, { status: ok ? 200 : 503 });
      } catch { return new Response("Invalid usage", { status: 400 }); }
    }

    // Only the assigned Container receives this capability. Sessions never go
    // into Workflow results, the media cache, logs, or a public read endpoint.
    const sessionRequest = /^\/telegram-session\/(\d+)$/.exec(requestUrl.pathname);
    if (request.method === "POST" && sessionRequest) {
      const index = Number(sessionRequest[1]);
      if (index < 0 || index >= POOL_INSTANCES) return new Response("Invalid container", { status: 400 });
      const expected = await instagramSignature(env.BOT_TOKEN, `telegram-session:${index}:${env.API_ID}:${env.API_HASH}`);
      if (!equalSignature(request.headers.get("x-telegram-session-token") || "", expected)) return new Response("Forbidden", { status: 403 });
      const text = await request.text();
      if (text.length > 1024) return new Response("Too large", { status: 413 });
      try {
        const body = JSON.parse(text) as { session: string };
        if (typeof body.session !== "string" || !/^1[A-Za-z0-9_=-]{300,500}$/.test(body.session)) return new Response("Invalid session", { status: 400 });
        await pooledContainer(env, { containerIndex: index }).saveTelegramSession(body.session);
        return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
      } catch { return new Response("Session storage unavailable", { status: 503 }); }
    }

    const cacheRequest = /^\/media-cache\/((?:igdl|ytdl)--?\d+-\d+-\d+(?:-(?:audio|song|music-[A-Za-z0-9_-]{11}))?)$/.exec(requestUrl.pathname);
    if (request.method === "POST" && cacheRequest) {
      const expected = await instagramSignature(env.BOT_TOKEN, `cache:${cacheRequest[1]}`);
      if (!equalSignature(request.headers.get("x-media-cache-token") || "", expected)) return new Response("Forbidden", { status: 403 });
      const text = await request.text();
      if (text.length > 5000) return new Response("Too large", { status: 413 });
      try {
        const body = JSON.parse(text) as { op: "get" | "put" | "delete"; key: string; value?: CachedTelegramFile };
        if (!["get", "put", "delete"].includes(body.op) || !/^[A-Za-z0-9:_-]{1,180}$/.test(body.key || "")) return new Response("Invalid cache request", { status: 400 });
        return Response.json({ ok: true, value: await telegramFileCache(env, body.op, body.key, body.value) });
      } catch { return new Response("Invalid cache request", { status: 400 }); }
    }

    const completion = /^\/instagram\/events\/(igdl--?\d+-\d+-\d+(?:-(?:audio|song|music-[A-Za-z0-9_-]{11}))?)$/.exec(requestUrl.pathname);
    if (request.method === "POST" && completion) {
      const expected = await instagramSignature(env.BOT_TOKEN, `event:${completion[1]}`);
      if (!equalSignature(request.headers.get("x-instagram-event-token") || "", expected)) return new Response("Forbidden", { status: 403 });
      const body = await request.text();
      if (body.length > 4096) return new Response("Too large", { status: 413 });
      try {
        const payload = JSON.parse(body) as ContainerResult;
        if (typeof payload.ok !== "boolean") return new Response("Invalid event", { status: 400 });
        const instance = await env.YOUTUBE_DOWNLOAD_WORKFLOW.get(completion[1]);
        await instance.sendEvent({ type: "instagram-ready", payload: { ok: payload.ok, message: payload.message?.slice(0, 500) } });
        return Response.json({ ok: true });
      } catch { return new Response("Event delivery failed", { status: 503 }); }
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/telegram/webhook" &&
      request.headers.get("x-telegram-bot-api-secret-token") === (env.WEBHOOK_SECRET || WEBHOOK_SECRET)
    ) {
      let update: TelegramUpdate | null = null;
      try {
        update = (await request.clone().json()) as TelegramUpdate;
      } catch {
        // Let the existing worker keep its current malformed-update behavior.
      }

      // Count every authenticated interaction once, including routes delegated to older handlers.
      const actor = update?.callback_query?.from || update?.message?.from;
      const activityText = (update?.message?.text || update?.message?.caption || "").trim();
      if (actor?.id === ADMIN_USER_ID && update?.callback_query?.data?.startsWith("admin:usage") && env.YOUTUBE_DOWNLOADER_CONTAINER) {
        await Promise.allSettled(Array.from({ length: POOL_INSTANCES }, async (_, index) =>
          pooledContainer(env, { containerIndex: index }).refreshUsage()));
      }
      if (actor && actor.id !== ADMIN_USER_ID && !update?.callback_query?.data?.startsWith("admin:")
          && !/^\/admin(?:@[A-Za-z0-9_]+)?$/i.test(activityText)) {
        const linkSent = Boolean(isInstagramDownloadLink(activityText) || extractYouTubeUrl(activityText)
          || extractPornhubUrl(activityText) || parseSocialUrl(activityText) || parsePlaylist(activityText));
        await recordUserActivity(env, { id: actor.id, username: actor.username, firstName: actor.first_name, lastName: actor.last_name },
          linkSent, update?.update_id, isStartCommand(activityText));
      }

      if (update?.callback_query?.data?.startsWith("ytq|")) {
        return handleQualityCallback(env, update, update.callback_query);
      }
      if (update?.callback_query?.data?.startsWith("igs|")) return stopInstagramRecording(env, update.callback_query);
      if (update?.callback_query?.data?.startsWith("iga|")) return instagramAudioCallback(env, update, update.callback_query);
      if (update?.callback_query?.data?.startsWith("igm|")) return instagramAudioCallback(env, update, update.callback_query);
      if (update?.callback_query?.data?.startsWith("soa|")) return socialAudioCallback(env, update, update.callback_query);
      if (update?.callback_query?.data?.startsWith("msc|")) return musicSelection(env, update, update.callback_query);

      const message = update?.message;
      if (update && message) {
        const text = (message.text || message.caption || "").trim();

        const recognitionCommand = /^\/(?:recognize|shazam|findmusic)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text);
        const inputMedia = recognitionMedia(message) || (recognitionCommand && message.reply_to_message ? recognitionMedia(message.reply_to_message) : undefined);
        if (recognitionCommand || (inputMedia && (!message.chat.type || message.chat.type === "private") && !text.startsWith("/"))) {
          if (inputMedia) return recognizeMessage(env, update, inputMedia);
          const instagram = parseInstagramAudioTarget(text);
          if (instagram) return createInstagramWorkflow(env, update, { ...instagram, recognizeMusic: true });
          await safeTelegramCall(env.BOT_TOKEN, "sendMessage", { chat_id: message.chat.id,
            text: "یک ویس، فایل صوتی یا ویدیو بفرست؛ یا روی فایل ریپلای کن و /shazam بنویس. برای اینستاگرام: /findmusic و لینک Reel یا Story." });
          return Response.json({ ok: true });
        }

        const social = parseSocialUrl(text);
        if (social) return createInstagramWorkflow(env, update, undefined, undefined, undefined, social);
        if (/^\/(?:x|twitter|pinterest|tiktok|soundcloud|aparat)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text)) {
          await safeTelegramCall(env.BOT_TOKEN, "sendMessage", { chat_id: message.chat.id,
            text: "لینک یک پست X، یک Pin پینترست، ویدیو یا پست عکسی TikTok، یک آهنگ SoundCloud یا ویدیوی آپارات را بفرست. لینک پروفایل، بورد و پلی‌لیست پشتیبانی نمی‌شود." });
          return Response.json({ ok: true });
        }

        const playlist = parsePlaylist(text);
        if (playlist) return createInstagramWorkflow(env, update, undefined, undefined, playlist);
        if (/^\/playlist(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text)) {
          await safeTelegramCall(env.BOT_TOKEN, "sendMessage", { chat_id: message.chat.id,
            text: "لینک پلی‌لیست YouTube را بفرست؛ هر درخواست تا 20 آهنگ MP3 می‌فرستد.\nبرای ادامه: /playlist لینک 21-40" });
          return Response.json({ ok: true });
        }

        if (isStartCommand(text)) {
          const startText = [
            "لینک رو بفرست، فایلش رو همین‌جا بگیر ⚡️",
            "",
            "⬇️ دانلود: YouTube، Pornhub، اینستاگرام، X،",
            "Pinterest، TikTok، SoundCloud و Aparat",
            "",
            "🎵 آهنگ: اسم آهنگ و خواننده یا /music",
            "🔎 تشخیص آهنگ: ویس، صدا یا ویدیو؛ در گروه ریپلای + /shazam",
            "🔎 آهنگ اینستاگرام: «پیداکردن آهنگ» یا /findmusic لینک",
            "🎼 پلی‌لیست: /playlist لینک 1-20",
            "🎧 فقط صدا: دکمهٔ «فقط صدا» یا /audio لینک",
            "",
            "ضبط لایو: /live username",
            "بازپخش: /replay لینک",
            "توقف ضبط: دکمهٔ زیر پیام",
          ].join("\n");
          const boldLabels = ["دانلود:", "آهنگ:", "تشخیص آهنگ:", "آهنگ اینستاگرام:",
            "پلی‌لیست:", "فقط صدا:", "ضبط لایو:", "بازپخش:"];
          await telegramCall(env.BOT_TOKEN, "sendMessage", {
            chat_id: message.chat.id,
            text: startText,
            entities: boldLabels.map(label => ({
              type: "bold", offset: startText.indexOf(label), length: label.length,
            })),
          });
          return Response.json({ ok: true });
        }

        if (/^\/audio(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text)) {
          const target = parseInstagramAudioTarget(text);
          if (target) return createInstagramWorkflow(env, update, target);
          await safeTelegramCall(env.BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, text: "بعد از /audio لینک ویدیوی اینستاگرام، X، TikTok، Pinterest یا آپارات را بفرست." });
          return Response.json({ ok: true });
        }
        const instagramTarget = parseInstagramVideoTarget(text);
        if (instagramTarget) return createInstagramWorkflow(env, update, instagramTarget);
        if (/^\/(live|replay)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text)) {
          await safeTelegramCall(env.BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, text: "ضبط لایو: /live username\nبازپخش: /replay و لینک پست، Reel یا TV\nهمچنین می‌توانی لینک مستقیم Live را بفرستی." });
          return Response.json({ ok: true });
        }
        const pornhubUrl = extractPornhubUrl(text);
        if (pornhubUrl) return createYoutubeInspectWorkflow(env, update, pornhubUrl, "pornhub");
        const youtubeUrl = extractYouTubeUrl(text);
        if (youtubeUrl) {
          return createYoutubeInspectWorkflow(env, update, youtubeUrl);
        }
        const query = musicQuery(text);
        if (query) return createInstagramWorkflow(env, update, { kind: "music", query });
        if (/^\/(music|song)(?:@[A-Za-z0-9_]+)?$/i.test(text)) {
          await safeTelegramCall(env.BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, text: "اسم آهنگ و خواننده را بعد از /music بنویس؛ مثلاً /music Adele Hello" });
          return Response.json({ ok: true });
        }
      }
    }

    return storyWorker.fetch(request, { ...env,
      uploadInstagramPost: async (post: InstagramPostUpload) => {
        const id = `igdl-${post.chatId}-${post.requestMessageId}-${post.userId}`;
        const job: YoutubeDownloadJob = { id, chatId: post.chatId, requestMessageId: post.requestMessageId,
          userId: post.userId, url: post.url, instagramPost: post };
        try { await env.YOUTUBE_DOWNLOAD_WORKFLOW.create({ id, params: job }); }
        catch (error) {
          if (!/already|exists|duplicate|conflict/i.test(error instanceof Error ? error.message : String(error))) throw error;
        }
      },
    } as any, ctx);
  },
} satisfies ExportedHandler<Env>;
