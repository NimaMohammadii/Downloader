// Bandcamp-only routing. Other platform parsers do not depend on this module.
export type BandcampInput = { url: string };

export function parseBandcampUrl(text: string): BandcampInput | null {
  for (const raw of text.match(/https?:\/\/[^\s<>"']+/gi) || []) {
    try {
      const url = new URL(raw.replace(/[),.!?\]}،]+$/gu, ""));
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port) continue;
      if (!/^(?!www\.|daily\.|get\.|support\.|help\.)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.bandcamp\.com$/i.test(url.hostname)) continue;
      if (!/^\/(?:track|album)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) continue;
      return { url: `https://${url.hostname.toLowerCase()}${url.pathname.replace(/\/$/, "")}` };
    } catch { /* Keep scanning for an actual Bandcamp track or album. */ }
  }
  return null;
}
