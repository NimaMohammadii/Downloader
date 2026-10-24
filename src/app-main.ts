import { handleBroadcastUpdate } from "./broadcast";
import { enforceMembership } from "./membership";
import { PUBLIC_ERROR_MESSAGE, telegramTextMotion, telegramCustomEmoji, type AdminStatsEnv } from "./admin";
import youtubeWorker from "./youtube-main";
export { AdminStatsStore, DownloadPool, YoutubeDownloaderContainer, YoutubeDownloadWorkflow } from "./youtube-main";
import { MINI_APP_HTML } from "./mini-app-ui";
import { WEB_APP_HTML } from "./web-ui";
import { applyWebBackground } from "./web-mesh-background";
import { applyWebViewport } from "./web-viewport";

type Env = Partial<AdminStatsEnv> & {
  BOT_TOKEN: string;
  WEBHOOK_SECRET?: string;
  MEMBERSHIP_CHANNEL?: string;
  INSTAGRAM_SESSIONID?: string;
  INSTAGRAM_CSRFTOKEN?: string;
  INSTAGRAM_DS_USER_ID?: string;
  INSTAGRAM_MID?: string;
  INSTAGRAM_IG_DID?: string;
};

function htmlResponse(request: Request, html: string): Response {
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  const response = new Response(request.method === "HEAD" ? null : html, { headers });
  return request.method === "HEAD"
    ? response
    : applyWebViewport(applyWebBackground(response));
}

function disabledContainerResponse(request: Request): Response {
  const url = new URL(request.url);
  const isApi = url.pathname.includes("/api/");
  if (isApi) {
    return Response.json(
      {
        ok: false,
        message: PUBLIC_ERROR_MESSAGE,
      },
      {
        status: 503,
        headers: {
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      },
    );
  }
  return new Response(PUBLIC_ERROR_MESSAGE, {
    status: 503,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

const appWorker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (
      (url.pathname === "/" || url.pathname === "/app" || url.pathname === "/app/") &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      return htmlResponse(request, WEB_APP_HTML);
    }

    if (
      (url.pathname === "/mini-app" || url.pathname === "/mini-app/") &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      return htmlResponse(request, MINI_APP_HTML);
    }

    if (url.pathname === "/robots.txt" && request.method === "GET") {
      return new Response("User-agent: *\nAllow: /\nDisallow: /web/\n", {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "public, max-age=3600",
        },
      });
    }

    if (url.pathname.startsWith("/web/") || url.pathname.startsWith("/mini-app/")) {
      return disabledContainerResponse(request);
    }

    const broadcastResponse = await handleBroadcastUpdate(request, env);
    if (broadcastResponse) return broadcastResponse;
    const membershipResponse = await enforceMembership(request, env, ctx);
    if (membershipResponse) return membershipResponse;
    return youtubeWorker.fetch(request, env as any, ctx);
  },
} satisfies ExportedHandler<Env>;


export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const trustedWebhook = new URL(request.url).pathname === "/telegram/webhook" && env.WEBHOOK_SECRET &&
      request.headers.get("x-telegram-bot-api-secret-token") === env.WEBHOOK_SECRET;
    const update = trustedWebhook ? await request.clone().json().catch(() => null) as any : null;
    try {
      return await appWorker.fetch(request, env, ctx);
    } catch (error) {
      console.error("request failed", { type: error instanceof Error ? error.name : "unknown" });
      // Only trusted webhook updates may select a Telegram destination.
      if (trustedWebhook && update) {
        try {
          const message = update.message || update.callback_query?.message;
          if (message?.chat?.id) {
            const payload: Record<string, unknown> = { chat_id: message.chat.id,
              text: "❌ پردازش درخواست کامل نشد.", _errorDetail: String(error) };
            await telegramTextMotion(env.BOT_TOKEN, "sendMessage", payload);
            await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify(telegramCustomEmoji("sendMessage", payload)), signal: AbortSignal.timeout(5000),
            });
            return Response.json({ ok: true });
          }
        } catch { /* Return only the public message, including notification failures. */ }
      }
      return Response.json({ ok: false, message: PUBLIC_ERROR_MESSAGE }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
