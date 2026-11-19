import { describe, expect, it } from "vitest";
import { CHANNELS, CHANNEL_LABEL, KNOWN_SOURCES, classify, findSource, isAiCrawler, type Channel } from "./sources.ts";

describe("traffic sources", () => {
  it("exports the channel order and labels", () => {
    expect(CHANNELS).toEqual(["direct", "search", "social", "ai", "referral", "email", "paid"]);
    expect(CHANNELS.map(channel => CHANNEL_LABEL[channel])).toEqual(["direct", "search", "social", "ai assistants", "referrals", "email", "paid"]);
  });

  it.each([
    ["chatgpt.com", "ChatGPT"], ["chat.openai.com", "ChatGPT"], ["claude.ai", "Claude"],
    ["perplexity.ai", "Perplexity"], ["www.perplexity.ai", "Perplexity"], ["gemini.google.com", "Gemini"],
    ["grok.com", "Grok"], ["grok.x.ai", "Grok"], ["x.ai", "Grok"],
    ["copilot.microsoft.com", "Copilot"], ["copilot.cloud.microsoft", "Copilot"],
    ["meta.ai", "Meta AI"], ["chat.mistral.ai", "Mistral"], ["mistral", "Mistral"],
    ["you.com", "You.com"], ["phind.com", "Phind"], ["poe.com", "Poe"], ["chat.deepseek.com", "DeepSeek"],
  ])("classifies AI referrer %s", (referrer, source) => {
    expect(classify({ referrer })).toEqual({ source, channel: "ai" });
  });

  it.each<[string, string, Channel]>([
    ["www.google.co.uk", "Google", "search"], ["bing.com", "Bing", "search"],
    ["duckduckgo.com", "DuckDuckGo", "search"], ["kagi.com", "Kagi", "search"],
    ["startpage.com", "Startpage", "search"], ["qwant.com", "Qwant", "search"],
    ["naver.com", "Naver", "search"], ["seznam.cz", "Seznam", "search"],
    ["t.co", "X", "social"], ["www.linkedin.com", "LinkedIn", "social"],
    ["discord.com", "Discord", "social"], ["discord.gg", "Discord", "social"],
    ["t.me", "Telegram", "social"], ["telegram.org", "Telegram", "social"],
    ["whatsapp.com", "WhatsApp", "social"], ["wa.me", "WhatsApp", "social"],
    ["team.slack.com", "Slack", "social"], ["lobste.rs", "Lobsters", "social"],
    ["news.ycombinator.com", "Hacker News", "social"], ["github.com", "GitHub", "referral"],
    ["dusk.bot", "Metal", "referral"], ["app.dusk.bot", "Metal", "referral"],
    ["nested.app.dusk.bot", "Metal", "referral"], ["mail.google.com", "Gmail", "email"],
    ["outlook.live.com", "Outlook", "email"],
  ])("classifies %s", (referrer, source, channel) => {
    expect(classify({ referrer })).toEqual({ source, channel });
  });

  it("retains a working canonical domain for every named source", () => {
    expect(KNOWN_SOURCES).toHaveLength(52);
    for (const source of KNOWN_SOURCES) {
      expect(findSource(source.domain || "newsletter")?.name).toBe(source.name);
    }
  });

  it.each(["TW", " ddg ", "chatgpt", "email", "hn", "ph", "devto"])("matches normalized tag %s", tag => {
    expect(findSource(tag)).toBeDefined();
  });

  it.each([null, undefined, "", "missing", "evilchatgpt.com", "chatgpt.com.evil.test", "evildusk.bot", "dusk.bot.evil.test"])("rejects unknown source %s", key => {
    expect(findSource(key)).toBeUndefined();
  });

  it("prefers utm source over the ref tag and referrer", () => {
    expect(classify({ referrer: "google.com", utmSource: "reddit", ref: "claude" })).toEqual({ source: "Reddit", channel: "social" });
  });

  it("prefers an unknown explicit source over a known referrer", () => {
    expect(classify({ referrer: "google.com", utmSource: "Launch-Partner" })).toEqual({ source: "Launch-Partner", channel: "referral" });
  });

  it("classifies known and unknown ref tags before the referrer", () => {
    expect(classify({ referrer: "google.com", ref: "claude" })).toEqual({ source: "Claude", channel: "ai" });
    expect(classify({ referrer: "reddit.com", ref: "launch-tweet" })).toEqual({ source: "launch-tweet", channel: "referral" });
    expect(classify({ referrer: null, ref: "launch" })).toEqual({ source: "launch", channel: "referral" });
  });

  it.each(["cpc", "ppc", "cpm", "paid", "paid_social", "paid-social", "paidsocial", "paidsearch", "ad", "ads", "display", "retargeting", "sponsored", "CPC"])("honors paid medium %s", utmMedium => {
    expect(classify({ referrer: "google.com", utmMedium })).toEqual({ source: "Google", channel: "paid" });
  });

  it.each(["email", "e-mail", "newsletter", "EMAIL"])("honors email medium %s", utmMedium => {
    expect(classify({ referrer: "chatgpt.com", utmMedium })).toEqual({ source: "ChatGPT", channel: "email" });
  });

  it.each(["social", "social_media", "social-media", "socialmedia", "sm"])("uses social medium %s for unknown sources", utmMedium => {
    expect(classify({ referrer: null, utmSource: "community", utmMedium })).toEqual({ source: "community", channel: "social" });
    expect(classify({ referrer: "google.com", utmMedium })).toEqual({ source: "Google", channel: "search" });
  });

  it("normalizes only unknown referrer display and handles direct visits", () => {
    expect(classify({ referrer: "www.someblog.dev" })).toEqual({ source: "someblog.dev", channel: "referral" });
    expect(classify({ referrer: "WWW.SomeBlog.dev" })).toEqual({ source: "someblog.dev", channel: "referral" });
    expect(classify({ referrer: "www.www.someblog.dev" }).source).toBe("www.someblog.dev");
    expect(classify({ referrer: null })).toEqual({ source: "direct", channel: "direct" });
    expect(classify({ referrer: "", utmSource: "", ref: "", utmMedium: "" })).toEqual({ source: "direct", channel: "direct" });
    expect(classify({ referrer: null, utmMedium: "organic" })).toEqual({ source: "direct", channel: "direct" });
  });
});

describe("AI crawlers", () => {
  it.each([
    ["ChatGPT-User", "answers"], ["OAI-SearchBot", "indexing"], ["GPTBot", "training"],
    ["Claude-User", "answers"], ["Claude-Web", "answers"], ["Claude-SearchBot", "indexing"],
    ["ClaudeBot", "training"], ["anthropic-ai", "training"], ["PerplexityBot", "indexing"],
    ["Perplexity-User", "answers"], ["Google-Extended", "training"], ["Google-Gemini", "answers"],
    ["Applebot-Extended", "training"], ["Bytespider", "training"], ["CCBot", "training"],
    ["meta-externalagent", "training"], ["Meta-ExternalFetcher", "answers"], ["Amazonbot", "indexing"],
    ["DuckAssistBot", "answers"], ["MistralAI-User", "answers"], ["cohere-ai", "training"],
    ["YouBot", "indexing"], ["Diffbot", "training"], ["Timpibot", "training"],
  ])("detects %s as %s", (bot, kind) => {
    expect(isAiCrawler(`Mozilla/5.0 (compatible; ${bot}/1.0)`)).toEqual({ bot, kind });
    expect(isAiCrawler(bot.toUpperCase())).toEqual({ bot, kind });
  });

  it.each(["", "Mozilla/5.0 Safari/605.1.15", "Googlebot/2.1", "Applebot/0.1", "Gemini", "some AI browser"])("ignores %s", userAgent => {
    expect(isAiCrawler(userAgent)).toBeNull();
  });
});
