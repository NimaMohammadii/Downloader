import youtubeWorker, {
  AdminStatsStore,
  YoutubeDownloadWorkflow,
  YoutubeDownloaderContainer as BaseYoutubeDownloaderContainer,
} from "./youtube-main";
import { handleMiniAppRequestV2 } from "./mini-app-v2";
import { handleWebAppRequest } from "./web-app";
import { applyWebBackground } from "./web-mesh-background";
import { applyWebViewport } from "./web-viewport";

export { AdminStatsStore, YoutubeDownloadWorkflow };

export class YoutubeDownloaderContainer extends BaseYoutubeDownloaderContainer {
  requiredPorts = [8080];
  sleepAfter = "15m";

  override async fetch(request: Request): Promise<Response> {
    await this.startAndWaitForPorts({
      ports: [8080],
      cancellationOptions: {
        instanceGetTimeoutMS: 60_000,
        portReadyTimeoutMS: 90_000,
        waitInterval: 500,
      },
    });
    return this.containerFetch(request);
  }

  override onError(error: unknown): never {
    console.error("youtube container lifecycle error", error);
    throw error;
  }
}

type Env = {
  BOT_TOKEN: string;
  YOUTUBE_DOWNLOADER_CONTAINER: DurableObjectNamespace<any>;
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const webAppResponse = await handleWebAppRequest(request, env);
    if (webAppResponse) {
      const url = new URL(request.url);
      const isWebPage =
        (url.pathname === "/" || url.pathname === "/app" || url.pathname === "/app/") &&
        (request.method === "GET" || request.method === "HEAD") &&
        (webAppResponse.headers.get("content-type") || "").includes("text/html");

      if (isWebPage) {
        return request.method === "HEAD"
          ? webAppResponse
          : applyWebViewport(applyWebBackground(webAppResponse));
      }
      return webAppResponse;
    }

    const miniAppResponse = await handleMiniAppRequestV2(request, env);
    if (miniAppResponse) {
      const url = new URL(request.url);
      const isMiniAppPage =
        (url.pathname === "/mini-app" || url.pathname === "/mini-app/") &&
        (request.method === "GET" || request.method === "HEAD") &&
        (miniAppResponse.headers.get("content-type") || "").includes("text/html");

      if (isMiniAppPage) {
        return request.method === "HEAD"
          ? miniAppResponse
          : applyWebViewport(applyWebBackground(miniAppResponse));
      }
      return miniAppResponse;
    }
    return youtubeWorker.fetch(request, env as any, ctx);
  },
} satisfies ExportedHandler<Env>;
