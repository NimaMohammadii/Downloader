import { withUserLanguage } from "./localization";
import { ADMIN_USER_ID, getAdminIds, isAdmin, telegramCustomEmoji, telegramTextMotion, type AdminStatsEnv, type AdminAccessEnv } from "./admin";

type Env = Partial<AdminStatsEnv> & { BOT_TOKEN?: string; WEBHOOK_SECRET?: string };
type Entity = Record<string, unknown>;
export type BroadcastContent = { kind: "text"; text: string; entities?: Entity[] }
  | { kind: "photo"; photo: string; caption?: string; caption_entities?: Entity[] };
type Job = { id: string; status: string; content: string; chat_id: string; message_id: number; next_at: number };
export type BroadcastStatus = { id: string; status: string; total: number; sent: number; failed: number; unknown: number; pending: number; nextAt: number };

function contentPayload(content: BroadcastContent): Record<string, unknown> {
  return content.kind === "text" ? { text: content.text, entities: content.entities }
    : { photo: content.photo, caption: content.caption, caption_entities: content.caption_entities };
}
function validContent(content: any): content is BroadcastContent {
  return content?.kind === "text" ? typeof content.text === "string" && content.text.length > 0 && content.text.length <= 4096
    : content?.kind === "photo" && typeof content.photo === "string" && content.photo.length > 0 && content.photo.length <= 1024
      && (content.caption === undefined || typeof content.caption === "string" && content.caption.length <= 1024);
}

async function telegram(env: Env, method: string, payload: Record<string, unknown>) {
  if (!env.BOT_TOKEN) throw new Error("BROADCAST_TOKEN_UNAVAILABLE");
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000),
  });
  const body = await response.json() as { ok: boolean; result?: { message_id: number }; error_code?: number; description?: string; parameters?: { retry_after?: number } };
  return { ...body, status: response.status };
}

export function broadcastPanel(status?: BroadcastStatus): Record<string, unknown> {
  const title = "📤 پیام همگانی";
  const labels: Record<string, string> = { running: "در حال ارسال", completed: "ارسال تمام شد", stopped: "متوقف شد", failed: "خطا در شروع ارسال" };
  const text = status ? [title, "", `وضعیت: ${labels[status.status] || status.status}`,
    `👥 کل مخاطبان: ${status.total}`, `✅ ارسال موفق: ${status.sent}`, `❌ ارسال ناموفق: ${status.failed}`,
    ...(status.unknown ? [`❔ نتیجه نامشخص: ${status.unknown}`] : []), `⏳ باقی‌مانده: ${status.pending}`,
    ...(status.status === "running" && status.nextAt > Date.now() ? ["مکث کوتاه طبق محدودیت تلگرام؛ ادامه خودکار است."] : []),
    "", "ارسال موفق یعنی تلگرام پیام را پذیرفته؛ وضعیت خواندن مشخص نیست."].join("\n")
    : `${title}\n\nمتن، عکس یا عکس همراه کپشن برای همهٔ کاربران بفرست.\nبولد، لینک و قالب‌بندی تلگرام عیناً حفظ می‌شود.`;
  const rows = status?.status === "running" ? [[{ text: "⏹ توقف ارسال", callback_data: `admin:broadcast:stop:${status.id}` }]]
    : [[{ text: "نوشتن پیام همگانی", callback_data: "admin:broadcast:compose" }]];
  if (status) rows.push([{ text: "🔄 آمار لحظه‌ای", callback_data: `admin:broadcast:status:${status.id}` }]);
  rows.push([{ text: "بازگشت به پنل", callback_data: "admin:stats" }]);
  return { text, entities: [{ type: "bold", offset: 0, length: title.length }], reply_markup: { inline_keyboard: rows } };
}

// Uses the existing stats Durable Object: no new binding or container is needed.
export class BroadcastManager {
  private running = false;
  constructor(private ctx: DurableObjectState, private env: AdminAccessEnv & { BOT_TOKEN?: string }) {
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS broadcast_draft (
        id INTEGER PRIMARY KEY, waiting INTEGER NOT NULL, version INTEGER, content TEXT
      );
      CREATE TABLE IF NOT EXISTS broadcast_jobs (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, content TEXT NOT NULL, chat_id TEXT NOT NULL,
        message_id INTEGER NOT NULL, created_at INTEGER NOT NULL, next_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_broadcast_jobs_status ON broadcast_jobs(status);
      CREATE TABLE IF NOT EXISTS broadcast_recipients (
        job_id TEXT NOT NULL, user_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
        message_id INTEGER, PRIMARY KEY(job_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_state ON broadcast_recipients(job_id, state, user_id);
    `);
    // Preserve an existing owner's draft while allowing one draft per administrator.
    const schema = ctx.storage.sql.exec("SELECT sql FROM sqlite_master WHERE name = 'broadcast_draft'").one();
    if (/CHECK\s*\(\s*id\s*=\s*1\s*\)/i.test(String(schema.sql))) {
      ctx.storage.transactionSync(() => {
        ctx.storage.sql.exec("ALTER TABLE broadcast_draft RENAME TO broadcast_draft_legacy");
        ctx.storage.sql.exec("CREATE TABLE broadcast_draft (id INTEGER PRIMARY KEY, waiting INTEGER NOT NULL, version INTEGER, content TEXT)");
        ctx.storage.sql.exec("INSERT INTO broadcast_draft SELECT ?,waiting,version,content FROM broadcast_draft_legacy", ADMIN_USER_ID);
        ctx.storage.sql.exec("DROP TABLE broadcast_draft_legacy");
      });
    }
  }
  private job(id?: string): Job | undefined {
    return this.ctx.storage.sql.exec(id ? "SELECT * FROM broadcast_jobs WHERE id = ?" : "SELECT * FROM broadcast_jobs ORDER BY created_at DESC, CAST(id AS INTEGER) DESC LIMIT 1",
      ...(id ? [id] : [])).toArray()[0] as unknown as Job | undefined;
  }
  private active(): Job | undefined {
    return this.ctx.storage.sql.exec("SELECT * FROM broadcast_jobs WHERE status = 'running' LIMIT 1").toArray()[0] as unknown as Job | undefined;
  }
  private status(job: Job): BroadcastStatus {
    const row = this.ctx.storage.sql.exec(`SELECT COUNT(*) AS total,
      COALESCE(SUM(state = 'sent'),0) AS sent, COALESCE(SUM(state = 'failed'),0) AS failed,
      COALESCE(SUM(state = 'unknown'),0) AS unknown, COALESCE(SUM(state IN ('pending','sending')),0) AS pending
      FROM broadcast_recipients WHERE job_id = ?`, job.id).one();
    return { id:job.id, status:job.status, total:Number(row.total), sent:Number(row.sent), failed:Number(row.failed),
      unknown:Number(row.unknown), pending:Number(row.pending), nextAt:Number(job.next_at) };
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const adminId = url.searchParams.has("adminId") ? Number(url.searchParams.get("adminId")) : ADMIN_USER_ID;
    if (!isAdmin(this.env, adminId)) return new Response("Forbidden", {status:403});
    if (request.method === "GET") {
      const job = this.job(url.searchParams.get("id") || undefined);
      const draft = this.ctx.storage.sql.exec("SELECT * FROM broadcast_draft WHERE id = ?", adminId).toArray()[0];
      return Response.json({ status:job ? this.status(job) : null, waiting:draft?.waiting === 1 });
    }
    const body = await request.json() as { action:string; version?:number; content?:BroadcastContent; messageId?:number; id?:string };
    const sql = this.ctx.storage.sql;
    if (body.action === "compose") {
      const active = this.active();
      if (active) return Response.json({ status:this.status(active) });
      sql.exec("INSERT INTO broadcast_draft(id,waiting) VALUES (?,1) ON CONFLICT(id) DO UPDATE SET waiting=1,version=NULL,content=NULL", adminId);
      return Response.json({ waiting:true });
    }
    if (body.action === "cancel") {
      sql.exec("DELETE FROM broadcast_draft WHERE id = ?", adminId);
      return Response.json({ ok:true });
    }
    if (body.action === "capture") {
      if (!validContent(body.content) || !Number.isSafeInteger(body.version) || body.version! <= 0) return new Response("Invalid content",{status:400});
      const changed = sql.exec("UPDATE broadcast_draft SET waiting=0,version=?,content=? WHERE id=? AND waiting=1", body.version!, JSON.stringify(body.content), adminId);
      return Response.json({ captured:changed.rowsWritten > 0 });
    }
    if (body.action === "start") {
      if (!Number.isSafeInteger(body.version) || body.version! <= 0 || !Number.isSafeInteger(body.messageId) || body.messageId! <= 0) return new Response("Invalid request",{status:400});
      // Keep legacy owner job IDs; other admins' message IDs are scoped to their chat.
      const id = adminId === ADMIN_USER_ID ? String(body.version) : `${adminId}-${body.version}`;
      let job = this.job(id);
      if (!job) {
        const active = this.active();
        if (active) return Response.json({ status:this.status(active) });
        const draft = sql.exec("SELECT * FROM broadcast_draft WHERE id=? AND waiting=0 AND version=?",adminId,body.version!).toArray()[0];
        if (!draft?.content) return new Response("Draft expired",{status:409});
        this.ctx.storage.transactionSync(() => {
          sql.exec("INSERT INTO broadcast_jobs(id,status,content,chat_id,message_id,created_at) VALUES (?,'running',?,?,?,?)",id,String(draft.content),String(adminId),body.messageId!,Date.now());
          const admins = getAdminIds(this.env).map(String);
          sql.exec(`INSERT INTO broadcast_recipients(job_id,user_id) SELECT ?,id FROM users WHERE id NOT IN (${admins.map(() => "?").join(",")})`,id,...admins);
          sql.exec("DELETE FROM broadcast_draft WHERE id=?",adminId);
        });
        job = this.job(id)!;
        if (!this.status(job).total) { sql.exec("UPDATE broadcast_jobs SET status='completed' WHERE id=?",id); job = this.job(id)!; }
      }
      if (job.status === "running") await this.ctx.storage.setAlarm(Date.now() + 100);
      return Response.json({ status:this.status(job) });
    }
    if (body.action === "stop" && typeof body.id === "string") {
      sql.exec("UPDATE broadcast_jobs SET status='stopped' WHERE id=? AND status='running'",body.id);
      const job = this.job(body.id);
      return job ? Response.json({ status:this.status(job) }) : new Response("Not found",{status:404});
    }
    return new Response("Invalid operation",{status:400});
  }
  private async publish(job: Job) {
    try {
      await withUserLanguage(this.env, Number(job.chat_id), () => telegram(this.env,"editMessageText",telegramCustomEmoji("editMessageText",{
        chat_id:Number(job.chat_id), message_id:Number(job.message_id), ...broadcastPanel(this.status(job)),
      },this.env)));
    } catch { console.warn("broadcast progress update unavailable"); }
  }
  async alarm(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let job = this.active();
      if (!job) return;
      if (!this.env.BOT_TOKEN) {
        this.ctx.storage.sql.exec("UPDATE broadcast_jobs SET status='failed' WHERE id=?",job.id);
        return;
      }
      if (Number(job.next_at) > Date.now()) { await this.ctx.storage.setAlarm(Number(job.next_at)); return; }
      const sql = this.ctx.storage.sql;
      // An interrupted send may already have arrived: never resend it automatically.
      sql.exec("UPDATE broadcast_recipients SET state='unknown' WHERE job_id=? AND state='sending'",job.id);
      await this.ctx.storage.setAlarm(Date.now()+2000);
      const recipients = sql.exec("SELECT user_id FROM broadcast_recipients WHERE job_id=? AND state='pending' ORDER BY user_id LIMIT 10",job.id).toArray();
      const content = JSON.parse(job.content) as BroadcastContent;
      const initial = this.status(job);
      if (initial.sent + initial.failed + initial.unknown === 0) await this.publish(job);
      let lastPublished = Date.now();
      const deadline = Date.now() + 18000;
      for (const recipient of recipients) {
        if (this.job(job.id)?.status !== "running") break;
        sql.exec("UPDATE broadcast_recipients SET state='sending' WHERE job_id=? AND user_id=?",job.id,recipient.user_id);
        try {
          const result = await telegram(this.env, content.kind === "photo" ? "sendPhoto" : "sendMessage",
            { chat_id:Number(recipient.user_id), ...contentPayload(content) });
          if (result.error_code === 429 || result.status === 429) {
            const seconds = Number(result.parameters?.retry_after);
            const next = Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 30) * 1000;
            sql.exec("UPDATE broadcast_recipients SET state='pending' WHERE job_id=? AND user_id=?",job.id,recipient.user_id);
            sql.exec("UPDATE broadcast_jobs SET next_at=? WHERE id=?",next,job.id);
            await this.ctx.storage.setAlarm(next);
            break;
          }
          const state = result.ok && Number.isSafeInteger(result.result?.message_id) ? "sent" : result.status >= 500 || result.ok ? "unknown" : "failed";
          sql.exec("UPDATE broadcast_recipients SET state=?,message_id=? WHERE job_id=? AND user_id=?",state,result.result?.message_id || null,job.id,recipient.user_id);
        } catch {
          sql.exec("UPDATE broadcast_recipients SET state='unknown' WHERE job_id=? AND user_id=?",job.id,recipient.user_id);
        }
        if (Date.now() - lastPublished >= 2000) {
          await this.publish(this.job(job.id)!);
          lastPublished = Date.now();
        }
        if (Date.now() >= deadline) break;
      }
      job = this.job(job.id)!;
      if (job.status === "running" && this.status(job).pending === 0) {
        sql.exec("UPDATE broadcast_jobs SET status='completed',next_at=0 WHERE id=?",job.id);
        job = this.job(job.id)!;
      }
      await this.publish(job);
    } finally { this.running = false; }
  }
}

async function store(env: Env, adminId: number, body?: Record<string, unknown>, id?: string): Promise<any> {
  if (!env.ADMIN_STATS) throw new Error("BROADCAST_STORE_UNAVAILABLE");
  const response = await env.ADMIN_STATS.getByName("global").fetch(`https://admin-stats/broadcast?adminId=${adminId}${id ? `&id=${encodeURIComponent(id)}` : ""}`,
    body ? { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body) } : undefined);
  if (!response.ok) throw new Error("BROADCAST_REQUEST_FAILED");
  return response.json();
}
async function control(env: Env, method: string, body: Record<string, unknown>, animate = true) {
  if (env.BOT_TOKEN && animate) await telegramTextMotion(env.BOT_TOKEN,method,body,{animateEdits:true,adminEnv:env});
  const result = await telegram(env,method,telegramCustomEmoji(method,body,env));
  if (!result.ok && !(method === "editMessageText" && /message is not modified/i.test(result.description || ""))) throw new Error("BROADCAST_CONTROL_FAILED");
  return result.result;
}

export async function handleBroadcastUpdate(request: Request, env: Env): Promise<Response | null> {
  if (!env.ADMIN_STATS || !env.BOT_TOKEN || request.method !== "POST" || new URL(request.url).pathname !== "/telegram/webhook"
      || request.headers.get("x-telegram-bot-api-secret-token") !== (env.WEBHOOK_SECRET || "dlr_7Tz91mQX4pK8vN2sR6cH5bJ3wF9yUaE1")) return null;
  let update:any;
  try { update = await request.clone().json(); } catch { return null; }
  const query = update?.callback_query, message = update?.message;
  const broadcastCallback = typeof query?.data === "string" && /^admin:broadcast(?::|$)/.test(query.data);
  const actor = query?.from || message?.from;
  if (!isAdmin(env, actor?.id)) return broadcastCallback ? Response.json({ok:true}) : null;
  const chat = query?.message?.chat?.id || message?.chat?.id;
  if (chat !== actor.id) {
    if (broadcastCallback) await control(env,"answerCallbackQuery",{callback_query_id:query.id,text:"پیام همگانی را از پیوی ربات مدیریت کن.",show_alert:true});
    return broadcastCallback ? Response.json({ok:true}) : null;
  }
  try {
    if (!broadcastCallback && (query?.data?.startsWith("admin:") || /^\/admin(?:@\w+)?$/i.test(message?.text?.trim() || ""))) {
      await store(env,actor.id,{action:"cancel"});
      return null;
    }
    if (!broadcastCallback && !message) return null;
    if (broadcastCallback) {
      await control(env,"answerCallbackQuery",{callback_query_id:query.id});
      const parts = query.data.split(":"), action = parts[2] || "status", id = parts[3];
      let result:any;
      if (action === "compose") {
        result = await store(env,actor.id,{action:"compose"});
        if (result.waiting) {
          await control(env,"editMessageText",{chat_id:chat,message_id:query.message.message_id,
            text:"📤 پیام همگانی\n\nمتن، عکس یا عکس همراه کپشن را بفرست.\nقالب‌بندی را با ابزار بولد و لینک تلگرام انجام بده؛ نیازی به HTML نیست.",
            entities:[{type:"bold",offset:0,length:"📤 پیام همگانی".length}],
            reply_markup:{inline_keyboard:[[{text:"انصراف",callback_data:"admin:broadcast:cancel"}]]}});
          return Response.json({ok:true});
        }
      } else if (action === "cancel") { await store(env,actor.id,{action:"cancel"}); result = await store(env,actor.id); }
      else if (action === "start" && /^\d{1,16}$/.test(id || "")) result = await store(env,actor.id,{action:"start",version:Number(id),messageId:query.message.message_id});
      else if (action === "stop" && /^(?:\d{1,16}-)?\d{1,16}$/.test(id || "")) result = await store(env,actor.id,{action:"stop",id});
      else if (action === "status") result = await store(env,actor.id,undefined,id);
      else return Response.json({ok:true});
      // The background job owns this status message once sending starts. Avoid
      // overwriting its newer counters with the initial start response.
      if (action === "start" && result.status?.status === "running") return Response.json({ok:true});
      await control(env,"editMessageText",{chat_id:chat,message_id:query.message.message_id,...broadcastPanel(result.status || undefined)},!result.status);
      return Response.json({ok:true});
    }
    const state = await store(env,actor.id);
    if (!state.waiting) return null;
    const photo = Array.isArray(message.photo) ? message.photo.at(-1)?.file_id : undefined;
    const content:BroadcastContent | undefined = photo ? {kind:"photo",photo,caption:message.caption,caption_entities:message.caption_entities}
      : typeof message.text === "string" && message.text.length ? {kind:"text",text:message.text,entities:message.entities} : undefined;
    if (!validContent(content)) {
      await control(env,"sendMessage",{chat_id:chat,text:"متن، عکس یا عکس همراه کپشن بفرست؛ قالب‌های دیگر پشتیبانی نمی‌شوند."});
      return Response.json({ok:true});
    }
    const captured = await store(env,actor.id,{action:"capture",version:message.message_id,content});
    if (!captured.captured) return Response.json({ok:true});
    // Native Telegram entities preserve the admin's actual formatting, including custom emoji.
    const preview = await telegram(env,content.kind === "photo" ? "sendPhoto" : "sendMessage",{chat_id:chat,...contentPayload(content)});
    if (!preview.ok) throw new Error("BROADCAST_PREVIEW_FAILED");
    await control(env,"sendMessage",{chat_id:chat,text:"پیش‌نمایش آماده است. همین پیام برای همهٔ کاربران ارسال شود؟",
      reply_markup:{inline_keyboard:[[{text:"📤 ارسال به همه",callback_data:`admin:broadcast:start:${message.message_id}`}],
        [{text:"تغییر پیام",callback_data:"admin:broadcast:compose"},{text:"انصراف",callback_data:"admin:broadcast:cancel"}]]}});
    return Response.json({ok:true});
  } catch {
    await control(env,"sendMessage",{chat_id:chat,text:"مدیریت پیام همگانی فعلاً در دسترس نیست؛ دوباره از پنل اقدام کن."});
    return Response.json({ok:true});
  }
}
