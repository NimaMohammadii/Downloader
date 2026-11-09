import { telegramCustomEmoji } from "./admin";
import { translate, type Language } from "./localization";

const VIDEO_DOWNLOAD_WIDGET = `
<style>
#vexa-download {
  color-scheme: light dark;
  --ink: light-dark(#22201e, #f6f0e9);
  --muted: light-dark(#62574d, #b9aea5);
  --tone: light-dark(#a04429, #ffb092);
  --fill: light-dark(#a04429, #ffc3a8);
  --track: light-dark(#eddcd2, #47332f);
  box-sizing: border-box;
  padding: 16px 16px max(26px, env(safe-area-inset-bottom));
  background: radial-gradient(ellipse at top right, light-dark(#ffe7d9, #422825), transparent 75%),
    light-dark(#faf5ee, #241c1a);
  color: var(--ink);
  font: 14px/1.35 system-ui;
}
#vexa-download[data-state="sent"] {
  --tone: light-dark(#32624e, #9bd5b8);
  --fill: var(--tone);
}
#vexa-download[data-state="failed"] {
  --tone: light-dark(#a22e3a, #ffb3b8);
  --fill: var(--tone);
}
.vexa-download-header { display: flex; align-items: center; gap: 10px; justify-content: space-between; margin-bottom: 13px; }
.vexa-download-brand { color: var(--muted); font: 600 11px/1.3 ui-monospace; letter-spacing: 1px; }
.vexa-download-quality {
  color: var(--tone);
  background: light-dark(#f7e6dc, #4a3029);
  padding: 3px 7px;
  border-radius: 7px;
  font: 600 11px/1.3 ui-monospace;
}
.vexa-download-title { font-size: 16px; font-weight: 650; }
.vexa-download-note { color: var(--muted); font-size: 12px; }
.vexa-download-track {
  position: relative;
  overflow: hidden;
  height: 4px;
  margin-top: 13px;
  border-radius: 4px;
  background: var(--track);
}
.vexa-download-fill {
  position: absolute;
  left: 0;
  top: 0;
  height: 100%;
  width: 100%;
  border-radius: 4px;
  background: var(--fill);
}
[data-state="preparing"] .vexa-download-fill {
  width: 38%;
  background: linear-gradient(90deg, transparent, var(--fill));
  animation: vexa-download-sweep 1.7s ease-in-out infinite;
}
[data-state="failed"] .vexa-download-fill { width: 24px; }
@keyframes vexa-download-sweep {
  from { transform: translateX(-100%); }
  to { transform: translateX(270%); }
}
@media (prefers-reduced-motion: reduce) {
  [data-state="preparing"] .vexa-download-fill { animation: none; }
}
</style>
<section id="vexa-download" data-state="preparing" lang="en">
  <header class="vexa-download-header" dir="ltr">
    <span class="vexa-download-brand">VEXA / VIDEO</span>
    <span class="vexa-download-quality">YouTube</span>
  </header>
  <div role="status" aria-live="polite">
    <div class="vexa-download-title">Preparing video</div>
    <div class="vexa-download-note">YouTube</div>
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
    if (!data || typeof data.title !== "string" || typeof data.note !== "string") return;
    const lang = data.language === "fa" || data.language === "ru" ? data.language : "en";
    const state = data.state === "sent" || data.state === "failed" ? data.state : "preparing";
    card.lang = lang;
    card.dir = lang === "fa" ? "rtl" : "ltr";
    card.dataset.state = state;
    card.querySelector(".vexa-download-quality").textContent = data.quality ? data.quality + "p" : "YouTube";
    card.querySelector(".vexa-download-title").textContent = data.title;
    card.querySelector(".vexa-download-note").textContent = data.note;
  }
  widget.onEvent("chatDataChanged", render);
  render();
})();
</script>`;

type WidgetData = { state: "preparing" | "sent" | "failed"; quality: number; language: Language };

const widgetCopy = {
  preparing: ["در حال آماده‌سازی ویدیو", "داریم فایل رو آماده می‌کنیم"],
  sent: ["ویدیو ارسال شد", "فایل توی همین چته"],
  failed: ["دانلود ویدیو کامل نشد", "پیام وضعیت ربات رو ببین"],
} as const;

function widgetChatData({ state, quality, language }: WidgetData): string {
  const [title, note] = widgetCopy[state];
  return JSON.stringify({ state, quality, language, title: translate(title, language), note: translate(note, language) });
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
  const caption = telegramCustomEmoji("sendVideo", { caption: "⬇️ YouTube  ·  📤 Telegram" });
  const result = await widgetCall(token, "sendWidget", {
    ...caption,
    show_caption_above_media: true,
    chat_id: chatId,
    message_thread_id: threadId,
    reply_parameters: { message_id: requestMessageId, allow_sending_without_reply: true },
    disable_notification: true,
    html: VIDEO_DOWNLOAD_WIDGET,
    width: 316,
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
