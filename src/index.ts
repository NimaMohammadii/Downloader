type Env = {
  BOT_TOKEN: string;
  BACKEND_URL?: string;
};

type TelegramMessage = {
  message_id: number;
  chat: { id: number };
  text?: string;
  caption?: string;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

const WEBHOOK_SECRET = "dlr_7Tz91mQX4pK8vN2sR6cH5bJ3wF9yUaE1";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

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

  const data = await response.json<TelegramApiResponse<T>>();
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
    console.warn(`Telegram ${method} failed`, error);
  }
}

function extractInstagramUrl(text: string): string | null {
  const matches = text.match(/https?:\/\/[^\s<>"']+/gi) ?? [];

  for (const raw of matches) {
    const candidate = raw.replace(/[),.!?\]}]+$/g, "");
    try {
      const url = new URL(candidate);
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      if (host === "instagram.com" || host.endsWith(".instagram.com")) {
        return url.toString();
      }
    } catch {
      // Continue to the next URL.
    }
  }

  return null;
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function forwardToBackend(
  env: Env,
  update: TelegramUpdate,
  statusMessageId: number,
): Promise<void> {
  const backend = env.BACKEND_URL?.trim().replace(/\/+$/, "");
  if (!backend) return;

  const body = JSON.stringify({ update, statusMessageId });
  const signature = await hmacHex(env.BOT_TOKEN, body);

  try {
    const response = await fetch(`${backend}/telegram/update`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-downloader-signature": signature,
      },
      body,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Backend ${response.status}: ${detail.slice(0, 300)}`);
    }
  } catch (error) {
    console.error("instagram backend forwarding failed", error);
    const chatId = update.message?.chat.id;
    if (chatId) {
      await safeTelegramCall(env.BOT_TOKEN, "editMessageText", {
        chat_id: chatId,
        message_id: statusMessageId,
        text: "❌ سرویس دانلود اینستاگرام فعلاً در دسترس نیست. چند لحظه دیگه دوباره امتحان کن.",
      });
    }
  }
}

async function handleTelegramWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.headers.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  let update: TelegramUpdate;
  try {
    update = await request.json<TelegramUpdate>();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const message = update.message;
  if (!message) return Response.json({ ok: true });

  const text = (message.text || message.caption || "").trim();
  if (text === "/start" || text.startsWith("/start ")) {
    await telegramCall(env.BOT_TOKEN, "sendMessage", {
      chat_id: message.chat.id,
      text: "لینک Reel، پست ویدیویی یا Story اینستاگرام رو بفرست؛ فایلش رو همین‌جا می‌فرستم ⚡️",
    });
    return Response.json({ ok: true });
  }

  const instagramUrl = extractInstagramUrl(text);
  if (!instagramUrl) {
    await telegramCall(env.BOT_TOKEN, "sendMessage", {
      chat_id: message.chat.id,
      text: "یه لینک معتبر Instagram بفرست 👇",
      reply_parameters: { message_id: message.message_id },
    });
    return Response.json({ ok: true });
  }

  if (!env.BACKEND_URL?.trim()) {
    await telegramCall(env.BOT_TOKEN, "sendMessage", {
      chat_id: message.chat.id,
      text: "⚙️ موتور دانلود Instagram هنوز به ربات وصل نشده.",
      reply_parameters: { message_id: message.message_id },
    });
    return Response.json({ ok: true });
  }

  const status = await telegramCall<TelegramMessage>(env.BOT_TOKEN, "sendMessage", {
    chat_id: message.chat.id,
    text: "⏳ لینک اینستاگرام رو گرفتم، دارم دانلودش می‌کنم…",
    reply_parameters: { message_id: message.message_id },
  });

  ctx.waitUntil(forwardToBackend(env, update, status.message_id));
  return Response.json({ ok: true });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          ok: true,
          service: "telegram-instagram-downloader-gateway",
          backendConfigured: Boolean(env.BACKEND_URL?.trim()),
          botConfigured: Boolean(env.BOT_TOKEN),
        }),
        { headers: JSON_HEADERS },
      );
    }

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Telegram Instagram Downloader gateway is running.");
    }

    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      return handleTelegramWebhook(request, env, ctx);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
