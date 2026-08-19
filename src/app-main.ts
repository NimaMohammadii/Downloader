import youtubeWorker from "./youtube-main";
import { handleMiniAppRequest } from "./mini-app";

export { AdminStatsStore, YoutubeDownloaderContainer, YoutubeDownloadWorkflow } from "./youtube-main";

type Env = {
  BOT_TOKEN: string;
  YOUTUBE_DOWNLOADER_CONTAINER: DurableObjectNamespace<any>;
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const miniAppResponse = await handleMiniAppRequest(request, env);
    if (miniAppResponse) return miniAppResponse;
    return youtubeWorker.fetch(request, env as any, ctx);
  },
} satisfies ExportedHandler<Env>;
