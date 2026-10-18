import { pathToFileURL } from 'node:url';

// Run explicitly after configuring the same WEBHOOK_SECRET on the Worker.
// Never put credentials in command-line arguments or print Telegram URLs/errors.
export async function setWebhook(env = process.env, send = fetch) {
  const token = env.BOT_TOKEN || '';
  const secret = env.WEBHOOK_SECRET || '';
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token) || !/^[A-Za-z0-9_-]{32,256}$/.test(secret))
    throw new Error('Set BOT_TOKEN and a fresh 32–256-character WEBHOOK_SECRET in the environment.');
  try {
    const response = await send(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({url:'https://downloader.vexaagent.workers.dev/telegram/webhook',
        secret_token:secret, drop_pending_updates:false}),
    });
    const data = await response.json();
    if (!response.ok || data.ok !== true) throw new Error('rejected');
  } catch {
    throw new Error('Webhook registration failed. Check the credentials and connection; no credentials were printed.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await setWebhook(); console.log('Webhook registered; pending updates preserved.'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
