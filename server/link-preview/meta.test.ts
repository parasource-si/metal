import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { cleanText, decodeEntities, isThin, mergeMeta, parseOembed, parsePageMeta, tidyTitle, EMPTY_META } from "./meta.ts";
import { readRedditListing, readTweet, readTweetOembed, redditPostId, sitePlan, syndicationToken, tweetId, youtubeId } from "./sites.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
const page = (name: string, at = "https://site.example/a/b") => parsePageMeta(fixture(name), new URL(at));

describe("parsePageMeta", () => {
  it("reads Open Graph first, with the first image and its size", () => {
    expect(page("article.html")).toEqual({
      title: "How tide pools survive the winter",
      description: "A season of measurements from three rocky shores, and what the anemones did when the storms came.",
      siteName: "Field Notes",
      image: { url: "https://cdn.fieldnotes.example/tide/cover.jpg", width: 1200, height: 630 },
      video: false,
      oembed: null,
    });
  });

  it("copes with reversed, single-quoted, unquoted and upper-case attributes, entities and a <base>", () => {
    const meta = page("messy.html");
    expect(meta.title).toBe("Café & Bar \u2014 menu ☃");
    expect(meta.description).toBe("Unquoted-description");
    expect(meta.image?.url).toBe("https://images.messy.example/hero.png?w=1200&h=630");
    expect(meta.oembed).toBe("https://static.messy.example/oembed?url=x");
  });

  it("never takes a title from a comment or a script", () => {
    expect(page("messy.html").title).not.toMatch(/commented-out|inside a script/);
  });

  it("falls back to Twitter card names and resolves relative images", () => {
    const meta = page("twitter-card.html", "https://cardly.example/posts/9");
    expect(meta.title).toBe("Only a Twitter card here");
    expect(meta.description).toBe("No Open Graph at all, just the twitter: names.");
    expect(meta.siteName).toBe("Cardly");
    expect(meta.image?.url).toBe("https://cardly.example/cards/large.webp");
  });

  it("turns hostile markup into inert text and refuses script and data images", () => {
    const meta = page("hostile.html");
    expect(meta.title).toBe("Late but real");
    expect(meta.description).toBe("bold text with controls");
    expect(meta.image).toBeNull();
    const titleOnly = parsePageMeta(fixture("hostile.html").replace(/<body>.*<\/body>/, ""), new URL("https://h.example"));
    // the decoded angle brackets stay as text for React to render, and the bidi override is gone
    expect(titleOnly.title).toBe("<script>alert(1)</script> Totally normal txt.exe");
  });

  it("marks video pages", () => {
    const meta = page("video.html");
    expect(meta.video).toBe(true);
    expect(meta.image?.url).toBe("https://img.vids.example/abc/poster.jpg");
  });

  it("finds the JSON oEmbed link of a thin page, never the XML one", () => {
    const meta = page("thin.html");
    expect(meta.title).toBe("Gallery");
    expect(isThin(meta)).toBe(true);
    expect(meta.oembed).toBe("https://thin.example/oembed.json?url=https%3A%2F%2Fthin.example%2Fp%2F1");
  });

  it("caps long text at a word", () => {
    const text = cleanText(`${"word ".repeat(200)}end`, 50)!;
    expect(text.length).toBeLessThanOrEqual(50);
    expect(text.endsWith("word…")).toBe(true);
  });

  it("decodes entities without inventing characters", () => {
    expect(decodeEntities("&#65;&#x42;&amp;&unknown;&#0;&#xD800;")).toBe("AB&&unknown;");
  });
});

describe("oEmbed and merging", () => {
  it("reads a video oEmbed's thumbnail but never its html", () => {
    const meta = parseOembed({ type: "video", title: "Clip", provider_name: "Vids", thumbnail_url: "/t.jpg", thumbnail_width: 480, thumbnail_height: 360, html: "<iframe src=x>" }, new URL("https://vids.example/oembed"));
    expect(meta).toEqual({ title: "Clip", description: null, siteName: "Vids", image: { url: "https://vids.example/t.jpg", width: 480, height: 360 }, video: true, oembed: null });
  });

  it("keeps the first source's fields and fills gaps from the second", () => {
    const merged = mergeMeta({ ...EMPTY_META, title: "A" }, { ...EMPTY_META, title: "B", description: "d" });
    expect(merged.title).toBe("A");
    expect(merged.description).toBe("d");
  });

  it("drops a site's own name from its titles", () => {
    expect(tidyTitle("Fix the parser by sam · Pull Request #12 · acme-labs/tool · GitHub", "github.com")).toBe("Fix the parser by sam · Pull Request #12 · acme-labs/tool");
    expect(tidyTitle("Song - YouTube", "youtube.com")).toBe("Song");
    expect(tidyTitle("Song - YouTube", "example.com")).toBe("Song - YouTube");
  });
});

describe("sites with thin pages", () => {
  it("finds YouTube, X and Reddit ids in their many address shapes", () => {
    for (const href of ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1", "https://youtu.be/dQw4w9WgXcQ", "https://m.youtube.com/shorts/dQw4w9WgXcQ", "https://www.youtube.com/live/dQw4w9WgXcQ?si=x"]) {
      expect(youtubeId(new URL(href)), href).toBe("dQw4w9WgXcQ");
    }
    expect(youtubeId(new URL("https://notyoutube.com/watch?v=dQw4w9WgXcQ"))).toBeNull();
    expect(tweetId(new URL("https://x.com/duskbot/status/1790000000000000000?s=20"))).toBe("1790000000000000000");
    expect(tweetId(new URL("https://twitter.com/i/web/status/1790000000000000000"))).toBe("1790000000000000000");
    expect(tweetId(new URL("https://x.com/duskbot"))).toBeNull();
    expect(redditPostId(new URL("https://www.reddit.com/r/gardening/comments/1abcde/basil/"))).toBe("1abcde");
    expect(redditPostId(new URL("https://redd.it/1abcde"))).toBe("1abcde");
  });

  it("derives the tweet embed token from the id", () => {
    expect(syndicationToken("1790000000000000000")).toMatch(/^[a-z0-9]+$/);
  });

  it("reads a tweet from the public embed's JSON", () => {
    const meta = readTweet(JSON.parse(fixture("tweet.json")), new URL("https://cdn.syndication.twimg.com/"));
    expect(meta.title).toBe("Metal (@duskbot)");
    expect(meta.description).toBe("Shipping link previews today. Hover any link in chat.");
    expect(meta.image).toEqual({ url: "https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/poster.jpg", width: 1280, height: 720 });
    expect(meta.video).toBe(true);
    expect(readTweet({ __typename: "TweetTombstone", text: "gone" }, new URL("https://x.com")).title).toBeNull();
  });

  it("reads a tweet's text from oEmbed's blockquote when the embed JSON is gone", () => {
    const meta = readTweetOembed({ author_name: "Sam", html: "<blockquote><p lang=\"en\">Hello<br>world &amp; you</p>&mdash; Sam</blockquote>" }, new URL("https://publish.twitter.com"));
    expect(meta.title).toBe("Sam");
    expect(meta.description).toBe("Hello world & you");
  });

  it("reads a Reddit post from its listing JSON", () => {
    const meta = readRedditListing(JSON.parse(fixture("reddit.json")), new URL("https://www.reddit.com"));
    expect(meta.title).toBe("What is the best way to keep basil alive indoors?");
    expect(meta.siteName).toBe("r/gardening");
    expect(meta.image).toEqual({ url: "https://preview.redd.it/basil.jpg?width=960&s=abc", width: 960, height: 720 });
  });

  it("gives YouTube a poster and the video mark even when its page says nothing", () => {
    const plan = sitePlan(new URL("https://youtu.be/dQw4w9WgXcQ"));
    expect(plan.sources[0]!.url).toContain("youtube.com/oembed");
    expect(plan.finish(EMPTY_META)).toMatchObject({ siteName: "YouTube", video: true, image: { url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" } });
  });

  it("asks Instagram as the link fetchers it answers, and skips X's script-only pages", () => {
    expect(sitePlan(new URL("https://www.instagram.com/reel/Cabc/")).userAgent).toMatch(/facebookexternalhit/);
    expect(sitePlan(new URL("https://www.instagram.com/reel/Cabc/")).finish(EMPTY_META).video).toBe(true);
    expect(sitePlan(new URL("https://x.com/a/status/1790000000000000000")).page).toBe(false);
  });
});
