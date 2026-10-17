import { Container, getContainer } from "@cloudflare/containers";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import storyWorker, { parseInstagramVideoTarget, parseInstagramAudioTarget, resolveInstagramVideo, instagramVideoErrorText, type InstagramVideoTarget } from "./story-main";
import {
  ADMIN_USER_ID,
  recordSuccessfulDelivery,
  recordUserActivity,
  type AdminStatsEnv,
  type TrackedUser,
} from "./admin";

export { AdminStatsStore } from "./admin";

const SUPPORTED_QUALITIES = [360, 480, 720, 1080] as const;
type YoutubeQuality = (typeof SUPPORTED_QUALITIES)[number];
type YoutubeAudioMode = "low" | "hq";

type YoutubeDownloadJob = {
  id: string;
  chatId: number;
  requestMessageId: number;
  userId: number;
  url: string;
  quality?: YoutubeQuality;
  audioMode?: YoutubeAudioMode;
  statusMessageId?: number;
  instagram?: InstagramVideoTarget;
};

type Env = AdminStatsEnv & {
  BOT_TOKEN: string;
  API_ID?: string;
  API_HASH?: string;
  YOUTUBE_DOWNLOAD_WORKFLOW: Workflow<YoutubeDownloadJob>;
  YOUTUBE_DOWNLOADER_CONTAINER: DurableObjectNamespace<YoutubeDownloaderContainer>;
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
  chat: { id: number };
  from?: TelegramUser;
  text?: string;
  caption?: string;
};

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
  message?: string;
  title?: string;
  parts?: number;
  quality?: number;
  audioMode?: YoutubeAudioMode;
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

export class YoutubeDownloaderContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter: string | number = "5m";
  enableInternet = true;
  envVars = { API_ID: this.env.API_ID || "", API_HASH: this.env.API_HASH || "" };

  async instagramRequest(action: string, payload: Record<string, unknown>): Promise<ContainerResult> {
    if (!["start", "stop", "send", "cleanup"].includes(action)) throw new Error("IG_ACTION");
    if (action === "start") {
      await this.ctx.storage.put("instagramJob", { id: String(payload.id), until: Date.now() + 3 * 60 * 60 * 1000 });
    }
    const response = await this.containerFetch(`http://container/instagram/${action}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`IG_CONTAINER_${response.status}`);
    return response.json() as Promise<ContainerResult>;
  }

  async releaseInstagram(): Promise<void> {
    await this.ctx.storage.delete("instagramJob");
    this.sleepAfter = "5m";
    this.renewActivityTimeout();
  }

  override async onActivityExpired(): Promise<void> {
    const job = await this.ctx.storage.get<{ until: number }>("instagramJob");
    if (job && job.until > Date.now()) {
      this.sleepAfter = Math.ceil((job.until - Date.now()) / 1000);
      this.renewActivityTimeout();
      return;
    }
    await super.onActivityExpired();
  }

  private async instagramInterrupted(): Promise<boolean> {
    const job = await this.ctx.storage.get<{ id: string }>("instagramJob");
    if (!job) return false;
    const instance = await this.env.YOUTUBE_DOWNLOAD_WORKFLOW.get(job.id);
    await instance.sendEvent({ type: "instagram-ready", payload: { ok: false, message: "❌ سرور هنگام دریافت فایل ری‌استارت شد؛ درخواست کامل نشد. دوباره درخواست را بفرست." } });
    return true;
  }

  override async onStop(): Promise<void> { await this.instagramInterrupted(); }
  override async onError(error: unknown): Promise<void> {
    if (!await this.instagramInterrupted()) super.onError(error);
  }
}

function containerSessionId(job: Pick<YoutubeDownloadJob, "chatId" | "requestMessageId" | "userId">): string {
  return `yt-session-${job.chatId}-${job.requestMessageId}-${job.userId}`;
}

function instagramContainer(env: Env, job: Pick<YoutubeDownloadJob, "id">) {
  return getContainer(env.YOUTUBE_DOWNLOADER_CONTAINER, `instagram-${job.id}`);
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

function redactDiagnostic(detail: string, env: Env): string {
  for (const secret of [env.BOT_TOKEN, env.API_HASH]) {
    if (secret) detail = detail.split(secret).join("[redacted]");
  }
  return detail.slice(0, 2000);
}

function workflowFailureMessage(detail: string, phase: string): string {
  if (detail.includes("YT_CONFIG")) {
    return "❌ تنظیمات ارسال فایل آماده نیست؛ API_ID و API_HASH باید در Secretهای همین Worker تنظیم شوند.";
  }
  if (/YT_HTTP_(503|429)|no container instance|max.*instance|provision/i.test(detail)) {
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
  const container = getContainer(env.YOUTUBE_DOWNLOADER_CONTAINER, containerSessionId(job));
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

export class YoutubeDownloadWorkflow extends WorkflowEntrypoint<Env, YoutubeDownloadJob> {
  async run(event: WorkflowEvent<YoutubeDownloadJob>, step: WorkflowStep) {
    const job = event.payload;
    if (job.instagram) return this.runInstagram(job, step);
    let statusMessageId = job.statusMessageId;
    let phase = "startup";
    const startContainer = () => step.do(
      "start youtube container",
      {
        retries: { limit: 2, delay: "5 seconds", backoff: "linear" },
        timeout: "2 minutes",
      },
      async () => {
        const container = getContainer(this.env.YOUTUBE_DOWNLOADER_CONTAINER, containerSessionId(job));
        await container.startAndWaitForPorts({
          ports: [8080],
          cancellationOptions: { instanceGetTimeoutMS: 45_000, portReadyTimeoutMS: 60_000 },
        });
        return true;
      },
    );

    try {
      if (!job.quality && !job.audioMode) {
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
              reply_parameters: { message_id: job.requestMessageId },
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
                body: JSON.stringify({ url: job.url }),
              }),
            );
          },
        );

        if (!metadata.ok || !metadata.videoId) {
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
              text: `⏳ ${selectionText} انتخاب شد؛ دانلود شروع شد…`,
              reply_parameters: { message_id: job.requestMessageId },
            });
            return status.message_id;
          },
        );
      }

      if (!/^\d+$/.test(this.env.API_ID || "") || !this.env.API_HASH?.trim()) {
        throw new Error("YT_CONFIG");
      }
      await startContainer();
      phase = "transfer";
      const result = await step.do(
        job.audioMode ? "download and send youtube audio" : "download and send youtube video",
        {
          retries: { limit: 0, delay: "1 second", backoff: "constant" },
          timeout: "30 minutes",
        },
        async () => {
          return containerResult<ContainerResult>(this.env, job,
            new Request("http://container/download", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ ...job, statusMessageId, botToken: this.env.BOT_TOKEN }),
            }),
          );
        },
      );

      if (result.ok) {
        await step.do("record youtube delivery", async () => {
          await recordSuccessfulDelivery(this.env, `youtube:${job.id}`);
          return true;
        });
      }
    } catch (error) {
      const detail = redactDiagnostic(error instanceof Error ? error.message : String(error), this.env);
      console.error("youtube workflow failed", { jobId: job.id, phase, detail });
      const failureMessage = workflowFailureMessage(detail, phase);

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
              reply_parameters: { message_id: job.requestMessageId },
            });
          }
          return true;
        },
      );
    }
  }

  private async runInstagram(job: YoutubeDownloadJob, step: WorkflowStep): Promise<void> {
    let statusId: number | undefined;
    let started = false;
    try {
      statusId = await step.do("show instagram video status", async () => {
        const message = await telegramCall<TelegramMessage>(this.env.BOT_TOKEN, "sendMessage", {
          chat_id: job.chatId, reply_parameters: { message_id: job.requestMessageId },
          text: job.instagram?.kind === "music" ? "🔎 دارم آهنگ را پیدا می‌کنم…" : job.instagram?.kind === "audio" ? "🎵 دارم صدای ویدیوی اینستاگرام را آماده می‌کنم…" : "🔎 دارم لایو یا بازپخش اینستاگرام را بررسی می‌کنم…",
        });
        return message.message_id;
      });
      if (!/^\d+$/.test(this.env.API_ID || "") || !this.env.API_HASH?.trim()) throw new Error("YT_CONFIG");
      // Return friendly failures durably, without retrying rejected Instagram sessions.
      const resolution = await step.do("resolve instagram live or replay", { retries: { limit: 0, delay: "1 second" }, timeout: "2 minutes" }, async () => {
        try { return { source: await resolveInstagramVideo(job.instagram!, this.env) }; }
        catch (error) { return { message: instagramVideoErrorText(error) }; }
      });
      if (!resolution.source) {
        await step.do("show instagram resolution error", () => telegramCall<boolean>(this.env.BOT_TOKEN, "editMessageText", {
          chat_id: job.chatId, message_id: statusId, text: resolution.message,
        }));
        return;
      }
      const source = resolution.source;
      await step.do("start instagram container", { retries: { limit: 2, delay: "5 seconds", backoff: "linear" }, timeout: "2 minutes" }, async () => {
        await instagramContainer(this.env, job).startAndWaitForPorts({ ports: [8080], cancellationOptions: { instanceGetTimeoutMS: 45_000, portReadyTimeoutMS: 60_000 } });
        return true;
      });
      started = true;
      await step.do("begin instagram capture", { retries: { limit: 2, delay: "3 seconds" }, timeout: "1 minute" }, async () => {
        const signature = (await instagramSignature(this.env.BOT_TOKEN, `stop:${job.chatId}:${job.requestMessageId}:${job.userId}`)).slice(0, 16);
        const result = await instagramContainer(this.env, job).instagramRequest("start", {
          id: job.id, source, botToken: this.env.BOT_TOKEN, chatId: job.chatId, requestMessageId: job.requestMessageId,
          statusMessageId: statusId,
          stopData: `igs|${job.requestMessageId}|${job.userId}|${signature}`,
          completionUrl: `https://downloader.vexaagent.workers.dev/instagram/events/${job.id}`,
          completionToken: await instagramSignature(this.env.BOT_TOKEN, `event:${job.id}`),
        });
        if (!result.ok) throw new Error("IG_START_FAILED");
        return true;
      });
      // A completion event may arrive before this call; Workflows buffers it.
      const ready = await step.waitForEvent<ContainerResult>("await instagram recording", { type: "instagram-ready", timeout: "150 minutes" });
      if (!ready.payload.ok) {
        await step.do("show instagram capture failure", () => telegramCall<boolean>(this.env.BOT_TOKEN, "editMessageText", {
          chat_id: job.chatId, message_id: statusId, text: ready.payload.message || "❌ دریافت لایو کامل نشد؛ دوباره لینک را بفرست.", reply_markup: { inline_keyboard: [] },
        }));
        return;
      }
      const result = await step.do("send complete instagram recording", { retries: { limit: 0, delay: "1 second" }, timeout: "30 minutes" }, () =>
        instagramContainer(this.env, job).instagramRequest("send", { id: job.id }),
      );
      if (result.ok) await step.do("record instagram video delivery", () => recordSuccessfulDelivery(this.env, `instagram:${job.id}`));
      else throw new Error("IG_SEND_FAILED");
    } catch (error) {
      console.error("instagram video workflow failed", { jobId: job.id, type: error instanceof Error ? error.name : "error" });
      await step.do("notify instagram video failure", async () => {
        const text = error instanceof Error && error.message.includes("YT_CONFIG")
          ? workflowFailureMessage("YT_CONFIG", "startup")
          : job.instagram?.kind === "music" || job.instagram?.kind === "audio" ? "❌ دریافت یا ارسال فایل صوتی کامل نشد؛ درخواست را دوباره بفرست." : "❌ ضبط یا ارسال لایو کامل نشد؛ لینک را دوباره بفرست. ممکن است سرور ری‌استارت شده باشد.";
        await safeTelegramCall(this.env.BOT_TOKEN, statusId ? "editMessageText" : "sendMessage", {
          chat_id: job.chatId, message_id: statusId, text, reply_markup: { inline_keyboard: [] },
        });
        return true;
      });
    } finally {
      if (started) await step.do("release instagram recording", { retries: { limit: 1, delay: "2 seconds" }, timeout: "1 minute" }, async () => {
        const container = instagramContainer(this.env, job);
        try { await container.instagramRequest("cleanup", { id: job.id }); }
        finally { await container.releaseInstagram(); }
        return true;
      });
    }
  }
}

async function telegramCall<T = unknown>(
  token: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
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

function extractYouTubeUrl(text: string): string | null {
  const matches = text.match(/https?:\/\/[^\s<>"']+/gi) ?? [];

  for (const raw of matches) {
    const candidate = raw.replace(/[),.!?\]}]+$/g, "");
    try {
      const url = new URL(candidate);
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      const isYoutube =
        host === "youtu.be" ||
        host === "youtube.com" ||
        host.endsWith(".youtube.com") ||
        host === "youtube-nocookie.com" ||
        host.endsWith(".youtube-nocookie.com");

      if (isYoutube && (url.protocol === "https:" || url.protocol === "http:")) {
        return url.toString();
      }
    } catch {
      // Keep scanning URLs in the message.
    }
  }

  return null;
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
): Promise<Response> {
  const message = update.message!;
  const user = trackedUser(message);
  if (user && user.id !== ADMIN_USER_ID) {
    await recordUserActivity(env, user, true);
  }

  const userId = user?.id ?? message.chat.id;
  const job: YoutubeDownloadJob = {
    id: `ytq-${update.update_id}`,
    chatId: message.chat.id,
    requestMessageId: message.message_id,
    userId,
    url,
  };

  try {
    await env.YOUTUBE_DOWNLOAD_WORKFLOW.create({ id: job.id, params: job });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!/already|exists|duplicate|conflict/i.test(detail)) {
      console.error("youtube inspect workflow create failed", { jobId: job.id, detail });
      await safeTelegramCall(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: "❌ نتونستم کیفیت‌های YouTube رو بررسی کنم. دوباره لینک رو بفرست.",
        reply_parameters: { message_id: message.message_id },
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

async function createInstagramWorkflow(env: Env, update: TelegramUpdate, target: InstagramVideoTarget): Promise<Response> {
  const message = update.message!;
  const user = trackedUser(message);
  const userId = user?.id ?? message.chat.id;
  const job: YoutubeDownloadJob = {
    id: `igdl-${message.chat.id}-${message.message_id}-${userId}`, chatId: message.chat.id,
    requestMessageId: message.message_id, userId, url: "", instagram: target,
  };
  try {
    await env.YOUTUBE_DOWNLOAD_WORKFLOW.create({ id: job.id, params: job });
    if (user && user.id !== ADMIN_USER_ID) await recordUserActivity(env, user, true);
  } catch (error) {
    if (!/already|exists|duplicate|conflict/i.test(error instanceof Error ? error.message : String(error))) {
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
      await safeTelegramCall(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "درخواست توقف ضبط ارسال شد…" });
      try {
        const result = await instagramContainer(env, { id: `igdl-${chatId}-${match[1]}-${match[2]}` }).instagramRequest("stop", { id: `igdl-${chatId}-${match[1]}-${match[2]}` });
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

async function instagramAudioCallback(env: Env, update: TelegramUpdate, callback: TelegramCallbackQuery): Promise<Response> {
  const match = /^iga\|(p|s)\|([A-Za-z0-9_-]{1,20})\|(\d{1,3})\|(\d+)$/.exec(callback.data || "");
  if (!match || !callback.message || callback.from.id !== Number(match[4]) || (match[1] === "s" && !/^\d+$/.test(match[2]))) {
    await safeTelegramCall(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "این دکمه معتبر نیست یا برای شما نیست.", show_alert: true });
    return Response.json({ ok: true });
  }
  await safeTelegramCall(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callback.id, text: "در حال آماده‌سازی فایل صوتی…" });
  const target: InstagramVideoTarget = match[1] === "p" ? { kind: "audio", shortcode: match[2], videoIndex: Number(match[3]) } : { kind: "audio", mediaId: match[2] };
  return createInstagramWorkflow(env, { ...update, message: { ...callback.message, from: callback.from } }, target);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestUrl = new URL(request.url);

    const completion = /^\/instagram\/events\/(igdl--?\d+-\d+-\d+)$/.exec(requestUrl.pathname);
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
      request.headers.get("x-telegram-bot-api-secret-token") === WEBHOOK_SECRET
    ) {
      let update: TelegramUpdate | null = null;
      try {
        update = (await request.clone().json()) as TelegramUpdate;
      } catch {
        // Let the existing worker keep its current malformed-update behavior.
      }

      if (update?.callback_query?.data?.startsWith("ytq|")) {
        return handleQualityCallback(env, update, update.callback_query);
      }
      if (update?.callback_query?.data?.startsWith("igs|")) return stopInstagramRecording(env, update.callback_query);
      if (update?.callback_query?.data?.startsWith("iga|")) return instagramAudioCallback(env, update, update.callback_query);

      const message = update?.message;
      if (update && message) {
        const text = (message.text || message.caption || "").trim();

        if (isStartCommand(text)) {
          const user = trackedUser(message);
          if (user && user.id !== ADMIN_USER_ID) {
            await recordUserActivity(env, user, false);
          }
          await telegramCall(env.BOT_TOKEN, "sendMessage", {
            chat_id: message.chat.id,
            text: "لینک YouTube یا اینستاگرام رو بفرست؛ فایلش رو همین‌جا می‌فرستم ⚡️\n\n🎵 برای آهنگ، اسم آهنگ و خواننده را بنویس یا /music نام آهنگ\n🎧 صدای اینستاگرام: دکمهٔ «فقط صدا» یا /audio و لینک ویدیو\nضبط لایو: /live username\nبازپخش: /replay و لینک بازپخش منتشرشده\nتوقف ضبط با دکمهٔ زیر پیام ضبط انجام می‌شود.",
          });
          return Response.json({ ok: true });
        }

        if (/^\/audio(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text)) {
          const target = parseInstagramAudioTarget(text);
          if (target) return createInstagramWorkflow(env, update, target);
          await safeTelegramCall(env.BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, text: "بعد از /audio لینک Reel، پست ویدیویی یا یک Story ویدیویی اینستاگرام را بفرست." });
          return Response.json({ ok: true });
        }
        const instagramTarget = parseInstagramVideoTarget(text);
        if (instagramTarget) return createInstagramWorkflow(env, update, instagramTarget);
        if (/^\/(live|replay)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text)) {
          await safeTelegramCall(env.BOT_TOKEN, "sendMessage", { chat_id: message.chat.id, text: "ضبط لایو: /live username\nبازپخش: /replay و لینک پست، Reel یا TV\nهمچنین می‌توانی لینک مستقیم Live را بفرستی." });
          return Response.json({ ok: true });
        }
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

    // Instagram, admin panel and media proxy remain on the existing worker unchanged.
    return storyWorker.fetch(request, env as any, ctx);
  },
} satisfies ExportedHandler<Env>;
