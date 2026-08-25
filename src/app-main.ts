import storyWorker, { AdminStatsStore } from "./story-main";
import { MINI_APP_HTML } from "./mini-app-ui";
import { WEB_APP_HTML } from "./web-ui";
import { applyWebBackground } from "./web-mesh-background";
import { applyWebViewport } from "./web-viewport";

export { AdminStatsStore };

type Env = {
  BOT_TOKEN: string;
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
        message: "This feature is temporarily unavailable.",
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
  return new Response("This feature is temporarily unavailable.", {
    status: 503,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

export default {
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

    return storyWorker.fetch(request, env as any, ctx);
  },
} satisfies ExportedHandler<Env>;
