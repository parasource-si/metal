// Sites whose own pages say too little to a fetcher that is not a signed-in browser, and where they say it instead.
import { absoluteUrl, cleanText, EMPTY_META, LIMITS, parseOembed, type PageMeta } from "./meta.ts";

export interface SiteSource {
  url: string;
  read(json: unknown, base: URL): PageMeta;
}

export interface SitePlan {
  /** Whether the page itself is worth fetching. */
  page: boolean;
  /** Instagram and Threads answer Open Graph only to the link fetchers they know. */
  userAgent?: string;
  /** Asked before the page; what they say wins over it. */
  sources: SiteSource[];
  finish(meta: PageMeta): PageMeta;
}

export const UNFURL_USER_AGENT = "Mozilla/5.0 (compatible; Metal link preview; +https://dusk.bot)";
const META_USER_AGENT = "facebookexternalhit/1.1 (compatible; Metal link preview; +https://dusk.bot)";

const hostIs = (url: URL, ...domains: string[]) => {
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
};

const VIDEO_ID = /^[\w-]{11}$/;

export function youtubeId(url: URL): string | null {
  if (hostIs(url, "youtu.be")) {
    const id = url.pathname.split("/")[1] ?? "";
    return VIDEO_ID.test(id) ? id : null;
  }
  if (!hostIs(url, "youtube.com", "youtube-nocookie.com")) return null;
  const v = url.searchParams.get("v");
  if (url.pathname === "/watch" && v && VIDEO_ID.test(v)) return v;
  const match = /^\/(?:shorts|live|embed|v)\/([\w-]{11})(?:[/?]|$)/.exec(url.pathname);
  return match ? match[1]! : null;
}

export function tweetId(url: URL): string | null {
  if (!hostIs(url, "x.com", "twitter.com")) return null;
  const match = /^\/(?:[\w]{1,15}|i\/web|i)\/status(?:es)?\/(\d{5,25})(?:[/?]|$)/.exec(url.pathname);
  return match ? match[1]! : null;
}

export function redditPostId(url: URL): string | null {
  if (hostIs(url, "redd.it")) {
    const id = url.pathname.split("/")[1] ?? "";
    return /^[a-z0-9]{4,10}$/i.test(id) ? id : null;
  }
  if (!hostIs(url, "reddit.com")) return null;
  const match = /^\/(?:r\/\w+\/)?comments\/([a-z0-9]{4,10})(?:[/?]|$)/i.exec(url.pathname);
  return match ? match[1]! : null;
}

/** The token the public tweet embed asks for, derived from the id alone. */
export function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? value as Record<string, unknown> : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const int = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null);

export function readTweet(json: unknown, base: URL): PageMeta {
  const tweet = record(json);
  if (typeof tweet.text !== "string" || tweet.__typename === "TweetTombstone") return EMPTY_META;
  const user = record(tweet.user);
  const name = cleanText(user.name, 80);
  const handle = typeof user.screen_name === "string" && /^\w{1,15}$/.test(user.screen_name) ? user.screen_name : null;
  const media = list(tweet.mediaDetails).map(record);
  const first = media[0];
  const original = record(first?.original_info);
  const photo = record(list(tweet.photos)[0]);
  const poster = record(tweet.video).poster;
  const imageUrl = absoluteUrl(String(first?.media_url_https ?? photo.url ?? poster ?? ""), base);
  const text = tweet.text.replace(/\s*https:\/\/t\.co\/\w+\s*$/g, "");
  return {
    title: name ? (handle ? `${name} (@${handle})` : name) : handle ? `@${handle}` : null,
    description: cleanText(text, LIMITS.DESCRIPTION_MAX),
    siteName: "X",
    image: imageUrl ? { url: imageUrl, width: int(original.width) ?? int(photo.width), height: int(original.height) ?? int(photo.height) } : null,
    video: media.some((item) => item.type === "video" || item.type === "animated_gif") || Boolean(poster),
    oembed: null,
  };
}

/** publish.twitter.com's answer: the tweet's text sits in the blockquote's first paragraph. */
export function readTweetOembed(json: unknown, base: URL): PageMeta {
  const data = record(json);
  const html = typeof data.html === "string" ? data.html : "";
  const paragraph = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(html)?.[1] ?? null;
  const author = cleanText(data.author_name, 80);
  return { ...parseOembed({ ...data, title: undefined }, base), title: author, description: cleanText(paragraph?.replace(/<br\s*\/?>/gi, " "), LIMITS.DESCRIPTION_MAX), siteName: "X" };
}

export function readRedditListing(json: unknown, base: URL): PageMeta {
  const children = list(record(record(list(json)[0]).data).children);
  const post = record(record(children[0]).data);
  if (typeof post.title !== "string") return EMPTY_META;
  const source = record(record(list(record(post.preview).images)[0]).source);
  const imageUrl = absoluteUrl(String(source.url ?? ""), base)
    ?? (typeof post.thumbnail === "string" && post.thumbnail.startsWith("https:") ? post.thumbnail : null);
  return {
    title: cleanText(post.title, LIMITS.TITLE_MAX),
    description: cleanText(post.selftext, LIMITS.DESCRIPTION_MAX),
    siteName: cleanText(post.subreddit_name_prefixed, LIMITS.SITE_MAX) ?? "Reddit",
    image: imageUrl ? { url: imageUrl, width: int(source.width), height: int(source.height) } : null,
    video: post.is_video === true,
    oembed: null,
  };
}

const same = (meta: PageMeta) => meta;

export function sitePlan(url: URL): SitePlan {
  const youtube = youtubeId(url);
  if (youtube) {
    const watch = `https://www.youtube.com/watch?v=${youtube}`;
    return {
      page: true,
      sources: [{ url: `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`, read: parseOembed }],
      finish: (meta) => ({
        ...meta,
        siteName: "YouTube",
        image: meta.image ?? { url: `https://i.ytimg.com/vi/${youtube}/hqdefault.jpg`, width: 480, height: 360 },
        video: true,
      }),
    };
  }
  const tweet = tweetId(url);
  if (tweet) {
    return {
      page: false,
      sources: [
        { url: `https://cdn.syndication.twimg.com/tweet-result?id=${tweet}&lang=en&token=${syndicationToken(tweet)}`, read: readTweet },
        { url: `https://publish.twitter.com/oembed?omit_script=1&dnt=1&url=${encodeURIComponent(`https://x.com/i/status/${tweet}`)}`, read: readTweetOembed },
      ],
      finish: (meta) => ({ ...meta, siteName: "X" }),
    };
  }
  if (hostIs(url, "instagram.com", "threads.net", "threads.com", "facebook.com")) {
    const reel = /^\/(?:[\w.]+\/)?(?:reels?|tv)\//.test(url.pathname);
    return { page: true, userAgent: META_USER_AGENT, sources: [], finish: (meta) => ({ ...meta, video: meta.video || reel }) };
  }
  const reddit = redditPostId(url);
  if (reddit) {
    return {
      page: true,
      sources: [
        { url: `https://www.reddit.com/comments/${reddit}/.json?raw_json=1&limit=1`, read: readRedditListing },
        { url: `https://www.reddit.com/oembed?url=${encodeURIComponent(`https://www.reddit.com/comments/${reddit}/`)}`, read: parseOembed },
      ],
      finish: same,
    };
  }
  return { page: true, sources: [], finish: same };
}
