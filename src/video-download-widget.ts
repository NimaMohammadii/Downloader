import { telegramCustomEmoji } from "./admin";
import { translate, type Language } from "./localization";

const VIDEO_DOWNLOAD_WIDGET = `
<style>
#vexa-download {
  color: var(--tg-theme-text-color);
  padding-bottom: max(8px, env(safe-area-inset-bottom));
}
.vexa-download-row { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.vexa-download-title { font-weight: 600; }
.vexa-download-quality { color: var(--tg-theme-hint-color); font-size: .85em; white-space: nowrap; }
.vexa-download-track {
  overflow: hidden;
  height: 2px;
  margin-top: 8px;
  border-radius: 2px;
  background: var(--tg-theme-secondary-bg-color);
}
.vexa-download-fill {
  width: 32%;
  height: 100%;
  border-radius: 2px;
  background: var(--tg-theme-hint-color);
  animation: vexa-download-sweep 2s ease-in-out infinite;
}
[data-state="sent"] .vexa-download-track,
[data-state="failed"] .vexa-download-track { visibility: hidden; }
[data-state="sent"] .vexa-download-fill,
[data-state="failed"] .vexa-download-fill { animation: none; }
@keyframes vexa-download-sweep {
  from { transform: translateX(-100%); }
  to { transform: translateX(315%); }
}
@media (prefers-reduced-motion: reduce) {
  .vexa-download-fill { animation: none; }
}
</style>
<section id="vexa-download" data-state="preparing" lang="en">
  <div class="vexa-download-row" role="status" aria-live="polite">
    <span class="vexa-download-title">Preparing video</span>
    <span class="vexa-download-quality" dir="ltr"></span>
  </div>
  <div class="vexa-download-track" dir="ltr" aria-hidden="true">
    <div class="vexa-download-fill"></div>
  </div>
</section>
<script>
(function () {
  const widget = window.TelegramWidget;
  if (!widget) return;
  const card = document.querySelector("#vexa-download");
  function render() {
    let data;
    try { data = JSON.parse(widget.chatData); } catch { return; }
    if (!data || typeof data.title !== "string") return;
    const lang = data.language === "fa" || data.language === "ru" ? data.language : "en";
    const state = data.state === "sent" || data.state === "failed" ? data.state : "preparing";
    card.lang = lang;
    card.dir = lang === "fa" ? "rtl" : "ltr";
    card.dataset.state = state;
    card.querySelector(".vexa-download-quality").textContent = data.quality ? data.quality + "p" : "";
    card.querySelector(".vexa-download-title").textContent = data.title;
  }
  widget.onEvent("chatDataChanged", render);
  render();
})();
</script>`;

type WidgetData = { state: "preparing" | "sent" | "failed"; quality: number; language: Language };

const widgetTitles = {
  preparing: "در حال آماده‌سازی ویدیو",
  sent: "ویدیو ارسال شد",
  failed: "دانلود ویدیو کامل نشد",
} as const;

function widgetChatData({ state, quality, language }: WidgetData): string {
  return JSON.stringify({ state, quality, language, title: translate(widgetTitles[state], language) });
}

async function widgetCall(token: string, method: "sendWidget" | "editMessageWidgetData", payload: Record<string, unknown>) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2500),
    });
    const data = await response.json() as { ok: boolean; result?: { message_id: number } };
    if (response.ok && data.ok) return data.result;
  } catch { /* The ordinary status message is independent of the widget. */ }
  console.warn("Video download widget unavailable", { method });
  return undefined;
}

export async function sendVideoDownloadWidget(
  token: string, chatId: number, requestMessageId: number, threadId: number | undefined, data: WidgetData,
): Promise<number | null> {
  // Telegram renders native custom emoji in the widget caption.
  const caption = telegramCustomEmoji("sendVideo", { caption: "⬇️ YouTube" });
  const result = await widgetCall(token, "sendWidget", {
    ...caption,
    chat_id: chatId,
    message_thread_id: threadId,
    reply_parameters: { message_id: requestMessageId, allow_sending_without_reply: true },
    disable_notification: true,
    html: VIDEO_DOWNLOAD_WIDGET,
    width: 260,
    chat_data: widgetChatData(data),
  });
  return result?.message_id ?? null;
}

export async function updateVideoDownloadWidget(token: string, chatId: number, messageId: number, data: WidgetData): Promise<void> {
  await widgetCall(token, "editMessageWidgetData", {
    chat_id: chatId,
    message_id: messageId,
    chat_data: widgetChatData(data),
  });
}
