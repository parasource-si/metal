// Source and channel table ported from Minilytics (https://github.com/surendrapandar/minilytics),
// Copyright (c) 2026 surendrapandar, MIT License. Adapted for dusk bot.

export type Channel = "direct" | "search" | "social" | "ai" | "referral" | "email" | "paid";

export const CHANNELS: Channel[] = ["direct", "search", "social", "ai", "referral", "email", "paid"];
export const CHANNEL_LABEL: Record<Channel, string> = {
  direct: "direct", search: "search", social: "social", ai: "ai assistants", referral: "referrals", email: "email", paid: "paid",
};

interface KnownSource {
  name: string;
  domain: string;
  channel: Channel;
  match: RegExp;
}

export const KNOWN_SOURCES: KnownSource[] = [
  { name: "X", domain: "x.com", channel: "social", match: /^(t\.co|(.*\.)?(x|twitter)\.com|x|twitter|tw)$/ },
  { name: "Google", domain: "google.com", channel: "search", match: /^((www\.)?google\.[a-z.]+|google)$/ },
  { name: "Bing", domain: "bing.com", channel: "search", match: /^((.*\.)?bing\.com|bing)$/ },
  { name: "DuckDuckGo", domain: "duckduckgo.com", channel: "search", match: /^((.*\.)?duckduckgo\.com|duckduckgo|ddg)$/ },
  { name: "Yahoo", domain: "yahoo.com", channel: "search", match: /^((.*\.)?yahoo\.[a-z.]+|yahoo)$/ },
  { name: "Yandex", domain: "yandex.com", channel: "search", match: /^((.*\.)?yandex\.[a-z.]+|yandex)$/ },
  { name: "Baidu", domain: "baidu.com", channel: "search", match: /^((.*\.)?baidu\.com|baidu)$/ },
  { name: "Ecosia", domain: "ecosia.org", channel: "search", match: /^((.*\.)?ecosia\.org|ecosia)$/ },
  { name: "Brave Search", domain: "search.brave.com", channel: "search", match: /^(search\.brave\.com)$/ },
  { name: "ChatGPT", domain: "chatgpt.com", channel: "ai", match: /^((.*\.)?(chatgpt\.com|openai\.com)|chatgpt|chatgpt\.com|openai)$/ },
  { name: "Claude", domain: "claude.ai", channel: "ai", match: /^((.*\.)?claude\.ai|claude)$/ },
  { name: "Perplexity", domain: "perplexity.ai", channel: "ai", match: /^((.*\.)?perplexity\.ai|perplexity)$/ },
  { name: "Gemini", domain: "gemini.google.com", channel: "ai", match: /^(gemini\.google\.com|gemini|bard\.google\.com)$/ },
  { name: "Copilot", domain: "copilot.microsoft.com", channel: "ai", match: /^(copilot\.microsoft\.com|copilot\.cloud\.microsoft|copilot)$/ },
  { name: "DeepSeek", domain: "deepseek.com", channel: "ai", match: /^((.*\.)?deepseek\.com|deepseek)$/ },
  { name: "Grok", domain: "grok.com", channel: "ai", match: /^((.*\.)?grok\.com|grok\.x\.ai|x\.ai|grok)$/ },
  { name: "YouTube", domain: "youtube.com", channel: "social", match: /^((.*\.)?(youtube\.com|youtu\.be)|youtube|yt)$/ },
  { name: "LinkedIn", domain: "linkedin.com", channel: "social", match: /^((.*\.)?(linkedin\.com|lnkd\.in)|linkedin)$/ },
  { name: "Reddit", domain: "reddit.com", channel: "social", match: /^((.*\.)?reddit\.com|reddit)$/ },
  { name: "Facebook", domain: "facebook.com", channel: "social", match: /^((.*\.)?(facebook\.com|fb\.com|fb\.me)|facebook|fb)$/ },
  { name: "Instagram", domain: "instagram.com", channel: "social", match: /^((.*\.)?instagram\.com|instagram|ig)$/ },
  { name: "Threads", domain: "threads.net", channel: "social", match: /^((.*\.)?threads\.(net|com)|threads)$/ },
  { name: "TikTok", domain: "tiktok.com", channel: "social", match: /^((.*\.)?tiktok\.com|tiktok)$/ },
  { name: "Pinterest", domain: "pinterest.com", channel: "social", match: /^((.*\.)?pinterest\.[a-z.]+|pinterest)$/ },
  { name: "Bluesky", domain: "bsky.app", channel: "social", match: /^((.*\.)?bsky\.app|bluesky|bsky)$/ },
  { name: "Mastodon", domain: "mastodon.social", channel: "social", match: /^((.*\.)?mastodon\.[a-z.]+|mastodon)$/ },
  { name: "Hacker News", domain: "news.ycombinator.com", channel: "social", match: /^(news\.ycombinator\.com|hackernews|hn)$/ },
  { name: "Product Hunt", domain: "producthunt.com", channel: "referral", match: /^((.*\.)?producthunt\.com|producthunt|ph)$/ },
  { name: "Medium", domain: "medium.com", channel: "referral", match: /^((.*\.)?medium\.com|medium)$/ },
  { name: "Substack", domain: "substack.com", channel: "referral", match: /^((.*\.)?substack\.com|substack)$/ },
  { name: "Dev.to", domain: "dev.to", channel: "referral", match: /^(dev\.to|devto)$/ },
  { name: "Indie Hackers", domain: "indiehackers.com", channel: "referral", match: /^((.*\.)?indiehackers\.com|indiehackers)$/ },
  { name: "GitHub", domain: "github.com", channel: "referral", match: /^((.*\.)?github\.com|github)$/ },
  { name: "Gmail", domain: "mail.google.com", channel: "email", match: /^(mail\.google\.com|gmail)$/ },
  { name: "Outlook", domain: "outlook.com", channel: "email", match: /^((.*\.)?(outlook\.(com|live\.com)|outlook\.office\.com))$/ },
  { name: "Newsletter", domain: "", channel: "email", match: /^(newsletter|email|mail)$/ },
  { name: "Kagi", domain: "kagi.com", channel: "search", match: /^((.*\.)?kagi\.com|kagi)$/ },
  { name: "Startpage", domain: "startpage.com", channel: "search", match: /^((.*\.)?startpage\.com|startpage)$/ },
  { name: "Qwant", domain: "qwant.com", channel: "search", match: /^((.*\.)?qwant\.com|qwant)$/ },
  { name: "Naver", domain: "naver.com", channel: "search", match: /^((.*\.)?naver\.com|naver)$/ },
  { name: "Seznam", domain: "seznam.cz", channel: "search", match: /^((.*\.)?seznam\.cz|seznam)$/ },
  { name: "Meta AI", domain: "meta.ai", channel: "ai", match: /^((.*\.)?meta\.ai|meta)$/ },
  { name: "Mistral", domain: "chat.mistral.ai", channel: "ai", match: /^(chat\.mistral\.ai|mistral)$/ },
  { name: "You.com", domain: "you.com", channel: "ai", match: /^((.*\.)?you\.com|you)$/ },
  { name: "Phind", domain: "phind.com", channel: "ai", match: /^((.*\.)?phind\.com|phind)$/ },
  { name: "Poe", domain: "poe.com", channel: "ai", match: /^((.*\.)?poe\.com|poe)$/ },
  { name: "Discord", domain: "discord.com", channel: "social", match: /^((.*\.)?discord\.(com|gg)|discord)$/ },
  { name: "Telegram", domain: "t.me", channel: "social", match: /^((.*\.)?(t\.me|telegram\.org)|telegram)$/ },
  { name: "WhatsApp", domain: "whatsapp.com", channel: "social", match: /^((.*\.)?(whatsapp\.com|wa\.me)|whatsapp)$/ },
  { name: "Slack", domain: "slack.com", channel: "social", match: /^((.*\.)?slack\.com|slack)$/ },
  { name: "Lobsters", domain: "lobste.rs", channel: "social", match: /^(lobste\.rs|lobsters)$/ },
  { name: "Metal", domain: "dusk.bot", channel: "referral", match: /^(.*\.)?dusk\.bot$/ },
];

const PAID_MEDIUM = /^(cpc|ppc|cpm|paid|paid[_-]?social|paidsearch|ads?|display|retargeting|sponsored)$/i;
const EMAIL_MEDIUM = /^(e-?mail|newsletter)$/i;
const SOCIAL_MEDIUM = /^(social|social[_-]?media|sm)$/i;

export function findSource(key: string | null | undefined): KnownSource | undefined {
  if (!key) return undefined;
  const normalized = key.toLowerCase().trim();
  return KNOWN_SOURCES.find(source => source.match.test(normalized));
}

export function classify(input: {
  referrer: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  ref?: string | null;
}): { source: string; channel: Channel } {
  const tag = input.utmSource || input.ref || null;
  const known = findSource(tag || input.referrer);
  const host = input.referrer?.toLowerCase().replace(/^www\./, "");
  const source = known?.name ?? tag ?? (host || "direct");
  let channel: Channel;
  if (input.utmMedium && PAID_MEDIUM.test(input.utmMedium)) channel = "paid";
  else if (input.utmMedium && EMAIL_MEDIUM.test(input.utmMedium)) channel = "email";
  else if (known) channel = known.channel;
  else if (input.utmMedium && SOCIAL_MEDIUM.test(input.utmMedium)) channel = "social";
  else if (tag || host) channel = "referral";
  else channel = "direct";
  return { source, channel };
}

const AI_CRAWLERS: { bot: string; kind: "answers" | "indexing" | "training"; match: string }[] = [
  { bot: "ChatGPT-User", kind: "answers", match: "chatgpt-user" },
  { bot: "OAI-SearchBot", kind: "indexing", match: "oai-searchbot" },
  { bot: "GPTBot", kind: "training", match: "gptbot" },
  { bot: "Claude-User", kind: "answers", match: "claude-user" },
  { bot: "Claude-Web", kind: "answers", match: "claude-web" },
  { bot: "Claude-SearchBot", kind: "indexing", match: "claude-searchbot" },
  { bot: "ClaudeBot", kind: "training", match: "claudebot" },
  { bot: "anthropic-ai", kind: "training", match: "anthropic-ai" },
  { bot: "PerplexityBot", kind: "indexing", match: "perplexitybot" },
  { bot: "Perplexity-User", kind: "answers", match: "perplexity-user" },
  { bot: "Google-Extended", kind: "training", match: "google-extended" },
  { bot: "Google-Gemini", kind: "answers", match: "google-gemini" },
  { bot: "Applebot-Extended", kind: "training", match: "applebot-extended" },
  { bot: "Bytespider", kind: "training", match: "bytespider" },
  { bot: "CCBot", kind: "training", match: "ccbot" },
  { bot: "meta-externalagent", kind: "training", match: "meta-externalagent" },
  { bot: "Meta-ExternalFetcher", kind: "answers", match: "meta-externalfetcher" },
  { bot: "Amazonbot", kind: "indexing", match: "amazonbot" },
  { bot: "DuckAssistBot", kind: "answers", match: "duckassistbot" },
  { bot: "MistralAI-User", kind: "answers", match: "mistralai-user" },
  { bot: "cohere-ai", kind: "training", match: "cohere-ai" },
  { bot: "YouBot", kind: "indexing", match: "youbot" },
  { bot: "Diffbot", kind: "training", match: "diffbot" },
  { bot: "Timpibot", kind: "training", match: "timpibot" },
];

export function isAiCrawler(userAgent: string): { bot: string; kind: "answers" | "indexing" | "training" } | null {
  const normalized = userAgent.toLowerCase();
  const crawler = AI_CRAWLERS.find(entry => normalized.includes(entry.match));
  return crawler ? { bot: crawler.bot, kind: crawler.kind } : null;
}
