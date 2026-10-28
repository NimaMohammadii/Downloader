// Reddit-only input validation; no other platform parser depends on this module.
export type RedditInput = { url: string };

export function parseRedditUrl(text: string): RedditInput | null {
  for (const raw of text.match(/https?:\/\/[^\s<>"']+/gi) || []) {
    try {
      const url = new URL(raw.replace(/[),.!?\]}،]+$/gu, ""));
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port) continue;
      const host = url.hostname.toLowerCase(), path = url.pathname;
      if (["reddit.com", "www.reddit.com", "old.reddit.com", "new.reddit.com", "m.reddit.com"].includes(host)) {
        const post = path.match(/^\/(?:(?:r|user)\/[^/]+\/)?comments\/([a-z0-9]+)(?:\/.*)?$/i)
          || path.match(/^\/gallery\/([a-z0-9]+)\/?$/i);
        if (post) return { url: `https://www.reddit.com/comments/${post[1].toLowerCase()}` };
        if (/^\/(?:r\/[^/]+\/)?s\/[A-Za-z0-9]+\/?$/.test(path)) return { url: `https://www.reddit.com${path.replace(/\/$/, "")}` };
      }
      if (host === "redd.it" && /^\/[a-z0-9]+\/?$/i.test(path)) return { url: `https://www.reddit.com/comments/${path.split("/")[1].toLowerCase()}` };
      if (host === "v.redd.it" && /^\/[a-z0-9]+(?:\/DASH_[A-Za-z0-9_.-]+\.mp4)?\/?$/i.test(path)) return { url: `https://v.redd.it/${path.split("/")[1]}` };
      if (host === "i.redd.it" && /^\/[a-z0-9]+\.(?:jpe?g|png|gif|webp)$/i.test(path)) return { url: `https://i.redd.it${path}` };
    } catch { /* Keep scanning for a supported Reddit post or native media link. */ }
  }
  return null;
}
