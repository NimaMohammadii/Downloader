// Bandcamp-only routing. Other platform parsers do not depend on this module.
export type BandcampInput = { url: string };

export function bandcampFailureDiagnostic(error: unknown, env: object = {}) {
  const secrets = Object.entries(env).filter(([key, value]) =>
    typeof value === "string" && /TOKEN|SECRET|COOKIE|SESSION|API_HASH|API_KEY|PASSWORD/i.test(key))
    .map(([, value]) => value as string).filter(Boolean).sort((a, b) => b.length - a.length);
  const clean = (value: string, limit: number) => {
    for (const secret of secrets) value = value.split(secret).join("[redacted]");
    return value.replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
      .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, "[redacted]")
      .replace(/\b(?:authorization|cookie|sessionid|token|secret|api_hash|api_key|password)\b["']?\s*[:=]\s*[^\r\n]+/gi, "[redacted]")
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ").slice(0, limit);
  };
  return { source: "Bandcamp", detail: clean(error instanceof Error ? error.message : String(error), 1500),
    ...(error instanceof Error && error.stack ? { stack: clean(error.stack, 2500) } : {}) };
}

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
