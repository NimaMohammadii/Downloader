import { recordLanguagePresence } from "./language-admin-store";
import { handleLanguageUpdate, withUserLanguage } from "./localization";
import { enforceRestriction } from "./restrictions";
import { parseBandcampUrl, bandcampFailureDiagnostic } from "./bandcamp";
import { publicError } from "./public-errors";
import { handleBroadcastUpdate } from "./broadcast";
import { handleInstagramVisit, enforceMembership } from "./membership";
import { PUBLIC_ERROR_MESSAGE, telegramTextMotion, telegramCustomEmoji, type AdminStatsEnv } from "./admin";
import youtubeWorker, { WEBHOOK_SECRET } from "./youtube-main";
export { AdminStatsStore, DownloadPool, YoutubeDownloaderContainer, YoutubeDownloadWorkflow } from "./youtube-main";
export { WebAppContainer } from "./web-app";
import { handleWebAppRequest, type WebAppContainer } from "./web-app";
import { MINI_APP_HTML } from "./mini-app-ui";
import { applyWebBackground } from "./web-mesh-background";
import { applyWebViewport } from "./web-viewport";

type Env = Partial<AdminStatsEnv> & {
  BOT_TOKEN: string;
  WEB_APP_CONTAINER: DurableObjectNamespace<WebAppContainer>;
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
    const instagramVisit = await handleInstagramVisit(request, env);
    if (instagramVisit) return instagramVisit;

    const webResponse = await handleWebAppRequest(request, env);
    if (webResponse) {
      return (webResponse.headers.get("content-type") || "").includes("text/html") && request.method !== "HEAD"
        ? applyWebViewport(applyWebBackground(webResponse)) : webResponse;
    }

    if (
      (url.pathname === "/mini-app" || url.pathname === "/mini-app/") &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      return htmlResponse(request, MINI_APP_HTML);
    }

    if (url.pathname.startsWith("/mini-app/")) {
      return disabledContainerResponse(request);
    }

    const languageResponse = await handleLanguageUpdate(request, env);
    if (languageResponse) return languageResponse;

    const restrictionResponse = await enforceRestriction(request, env);
    if (restrictionResponse) return restrictionResponse;
    const broadcastResponse = await handleBroadcastUpdate(request, env);
    if (broadcastResponse) return broadcastResponse;
    const membershipResponse = await enforceMembership(request, env, ctx, async update => {
      // Membership already accepted this request. Resume the original update only
      // after confirmation deletion, preserving message IDs and workflow identity.
      const resumed = new Request(request.url, {
        method: "POST", headers: request.headers, body: JSON.stringify(update),
      });
      if (await enforceRestriction(resumed, env)) return;
      const response = await youtubeWorker.fetch(resumed, env as any, ctx);
      if (!response.ok) throw new Error("MEMBERSHIP_RESUME_FAILED");
    });
    if (membershipResponse) return membershipResponse;
    return youtubeWorker.fetch(request, env as any, ctx);
  },
} satisfies ExportedHandler<Env>;


export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const trustedWebhook = new URL(request.url).pathname === "/telegram/webhook" && env.WEBHOOK_SECRET &&
      request.headers.get("x-telegram-bot-api-secret-token") === env.WEBHOOK_SECRET;
    // Bandcamp diagnostics must also work with the existing fallback key.
    // Keep other routes' error handling and all authentication rules unchanged.
    const fallbackWebhook = !env.WEBHOOK_SECRET && new URL(request.url).pathname === "/telegram/webhook" &&
      request.headers.get("x-telegram-bot-api-secret-token") === WEBHOOK_SECRET;
    const update = trustedWebhook || fallbackWebhook ? await request.clone().json().catch(() => null) as any : null;
    try {
      const actor = update?.callback_query?.from || update?.message?.from;
      const actorId = actor?.id;
      if (Number.isSafeInteger(actorId) && actorId > 0) await recordLanguagePresence(env, {
        id: actorId, username: actor.username, firstName: actor.first_name, lastName: actor.last_name,
      });
      return await withUserLanguage(env, actorId, () => appWorker.fetch(request, env, ctx));
    } catch (error) {
      const bandcamp = update && parseBandcampUrl(String(update.message?.text || update.message?.caption || ""));
      console.error("request failed", { type: error instanceof Error ? error.name : "unknown",
        ...(bandcamp ? { phase: "webhook", ...bandcampFailureDiagnostic(error, env) } : {}) });
      // Only trusted webhook updates may select a Telegram destination.
      if ((trustedWebhook || (fallbackWebhook && bandcamp)) && update) {
        try {
          const message = update.message || update.callback_query?.message;
          if (message?.chat?.id) {
            const payload: Record<string, unknown> = { chat_id: message.chat.id,
              text: bandcamp ? publicError("❌ پردازش درخواست کامل نشد.").message : "❌ پردازش درخواست کامل نشد.", _errorDetail: String(error) };
            await withUserLanguage(env, update.callback_query?.from?.id || update.message?.from?.id, async () => {
              await telegramTextMotion(env.BOT_TOKEN, "sendMessage", payload);
              await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify(telegramCustomEmoji("sendMessage", payload)), signal: AbortSignal.timeout(5000),
              });
            });
            return Response.json({ ok: true });
          }
        } catch { /* Return only the public message, including notification failures. */ }
      }
      return Response.json({ ok: false, message: PUBLIC_ERROR_MESSAGE }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
