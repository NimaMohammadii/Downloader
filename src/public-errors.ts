import catalog from "../container/public_errors.json";
export const PUBLIC_ERROR_MESSAGE = catalog[catalog.length - 1].message;
const publicMessages = new Set(catalog.map(row => row.message));
export function isPublicErrorMessage(text: unknown): text is string {
  return typeof text === "string" && publicMessages.has(text);
}
export function isPublicErrorFrame(text: unknown): boolean {
  return typeof text === "string" && catalog.some(row => row.message.startsWith(text));
}
export function publicError(text: string, detail = "") {
  const known = catalog.find(row => row.message === text);
  if (known) return known;
  // Match only; never interpolate raw diagnostics, links or account data into output.
  const input = `${detail}\n${text}`.replace(/https?:\/\/\S+/gi, "[URL]")
    .replace(/(?:token|secret|cookie|sessionid|authorization|api_hash)\s*[:=]\s*\S+/gi, "[REDACTED]");
  return catalog.find(row => row.patterns.some(pattern => new RegExp(pattern, "i").test(input))) || catalog[catalog.length - 1];
}
