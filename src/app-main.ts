import youtubeWorker from "./youtube-main";
import { handleMiniAppRequestV2 } from "./mini-app-v2";

export { AdminStatsStore, YoutubeDownloaderContainer, YoutubeDownloadWorkflow } from "./youtube-main";

type Env = {
  BOT_TOKEN: string;
  YOUTUBE_DOWNLOADER_CONTAINER: DurableObjectNamespace<any>;
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const miniAppResponse = await handleMiniAppRequestV2(request, env);
    if (miniAppResponse) return miniAppResponse;
    return youtubeWorker.fetch(request, env as any, ctx);
  },
} satisfies ExportedHandler<Env>;
