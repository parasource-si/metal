import type { LookupAddress } from "node:dns";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { encodePng } from "../site-icons.ts";
import type { Answer, PinnedRequest } from "./net.ts";
import { createLinkPreviews, EMPTY_TTL_MS, PREVIEW_TTL_MS } from "./service.ts";
import { syndicationToken } from "./sites.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name));
const PNG = encodePng(2, 1, Buffer.alloc(8, 200));

function harness(answers: Record<string, Partial<Answer>>, dir = mkdtempSync(join(tmpdir(), "dusk-link-preview-"))) {
  dirs.push(dir);
  const asked: string[] = [];
  let clock = 1_000_000;
  const request: PinnedRequest = async (url) => {
    asked.push(url.href);
    const answer = answers[url.href];
    if (!answer) return { status: 404, location: null, type: "", body: Buffer.alloc(0), truncated: false };
    return { status: 200, location: null, type: "text/html", body: Buffer.alloc(0), truncated: false, ...answer };
  };
  const resolve = async (host: string): Promise<LookupAddress[]> => [
    { address: isIP(host) ? host : host.startsWith("inside") ? "10.0.0.2" : "93.184.215.14", family: isIP(host) === 6 ? 6 : 4 },
  ];
  const make = () => createLinkPreviews({ dir, net: { resolve, request }, now: () => clock });
  return { previews: make(), make, asked, dir, tick: (ms: number) => { clock += ms; } };
}

const ARTICLE = "https://fieldnotes.example/tide";
const COVER = "https://cdn.fieldnotes.example/tide/cover.jpg";

describe("link previews", () => {
  it("builds a preview with a served image, never the site's own image address", async () => {
    const { previews } = harness({ [ARTICLE]: { body: fixture("article.html") }, [COVER]: { type: "image/png", body: PNG } });
    const preview = await previews.get(`${ARTICLE}#comments`);
    expect(preview).toMatchObject({ url: ARTICLE, title: "How tide pools survive the winter", siteName: "Field Notes", video: false });
    expect(preview!.image!.src).toMatch(/^\/api\/link-preview\/image\/[a-f0-9]{32}$/);
    expect(preview!.image).toMatchObject({ width: 1200, height: 630 });
    const image = await previews.image(preview!.image!.src.split("/").pop()!);
    expect(image).toEqual({ type: "image/png", body: PNG });
  });

  it("decodes a page in the charset it declares", async () => {
    const { previews } = harness({ "https://old.example/": { type: "text/html", body: fixture("latin1.html") } });
    expect((await previews.get("https://old.example/"))!.title).toBe("Naïve café “quotes”");
  });

  it("asks a thin page's oEmbed endpoint for what it lacks", async () => {
    const { previews } = harness({
      "https://thin.example/p/1": { body: fixture("thin.html") },
      "https://thin.example/oembed.json?url=https%3A%2F%2Fthin.example%2Fp%2F1": { type: "application/json", body: Buffer.from(JSON.stringify({ type: "photo", url: "https://thin.example/full.jpg", width: 800, height: 600, provider_name: "Thin" })) },
    });
    const preview = await previews.get("https://thin.example/p/1");
    expect(preview).toMatchObject({ title: "Gallery", siteName: "Thin", image: { width: 800, height: 600 } });
  });

  it("answers from memory, then from disk in a new process, and asks the site again after the TTL", async () => {
    const { previews, make, asked, tick } = harness({ [ARTICLE]: { body: fixture("article.html") } });
    await previews.get(ARTICLE);
    await previews.get(ARTICLE);
    const pages = () => asked.filter((href) => href === ARTICLE).length;
    expect(pages()).toBe(1);
    expect(await make().get(ARTICLE)).toMatchObject({ title: "How tide pools survive the winter" });
    expect(pages()).toBe(1);
    tick(PREVIEW_TTL_MS + 1);
    await previews.get(ARTICLE);
    expect(pages()).toBe(2);
  });

  it("shares one fetch between requests that arrive together", async () => {
    const { previews, asked } = harness({ [ARTICLE]: { body: fixture("article.html") } });
    await Promise.all([previews.get(ARTICLE), previews.get(ARTICLE), previews.get(ARTICLE)]);
    expect(asked.filter((href) => href === ARTICLE).length).toBe(1);
  });

  it("keeps an empty answer only briefly", async () => {
    const { previews, asked, tick } = harness({});
    expect(await previews.get("https://gone.example/")).toMatchObject({ title: null, image: null });
    tick(EMPTY_TTL_MS - 1);
    await previews.get("https://gone.example/");
    expect(asked.length).toBe(1);
    tick(2);
    await previews.get("https://gone.example/");
    expect(asked.length).toBe(2);
  });

  it("gives an empty preview, never an error, for a page it may not fetch", async () => {
    const { previews, asked } = harness({});
    for (const href of ["https://inside.example/", "https://a.example:8443/", "http://127.0.0.1/"]) {
      expect(await previews.get(href), href).toMatchObject({ title: null, description: null, image: null });
    }
    expect(asked).toEqual([]);
    expect(await previews.get("javascript:alert(1)")).toBeNull();
    expect(await previews.get("not a url")).toBeNull();
  });

  it("serves only images it registered, and only real raster bytes", async () => {
    const { previews, make } = harness({
      [ARTICLE]: { body: fixture("article.html") },
      [COVER]: { type: "image/png", body: Buffer.from("<svg onload=alert(1)>") },
    });
    const preview = await previews.get(ARTICLE);
    const id = preview!.image!.src.split("/").pop()!;
    expect(await previews.image(id)).toBeNull();
    expect(await previews.image("0".repeat(32))).toBeNull();
    expect(await previews.image("../../etc/passwd")).toBeNull();
    // a new process finds the registration on disk
    expect(await make().image(id)).toBeNull();
  });

  it("keeps fetched images on disk for the next process", async () => {
    const { previews, make, asked, dir } = harness({ [ARTICLE]: { body: fixture("article.html") }, [COVER]: { type: "image/png", body: PNG } });
    const id = (await previews.get(ARTICLE))!.image!.src.split("/").pop()!;
    await previews.image(id);
    const before = asked.filter((href) => href === COVER).length;
    expect(await make().image(id)).toEqual({ type: "image/png", body: PNG });
    expect(asked.filter((href) => href === COVER).length).toBe(before);
    expect(readdirSync(join(dir, "images")).some((name) => name.endsWith(".img"))).toBe(true);
  });

  it("previews a link straight to a picture as that picture", async () => {
    const { previews } = harness({ "https://pics.example/sunset%20pier.png": { type: "image/png", body: PNG } });
    expect(await previews.get("https://pics.example/sunset%20pier.png")).toMatchObject({ title: "sunset pier.png", image: { width: null } });
  });

  it("reads a tweet from the embed JSON without fetching x.com", async () => {
    const id = "1790000000000000000";
    const { previews, asked } = harness({
      [`https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=${syndicationToken(id)}`]: { type: "application/json", body: fixture("tweet.json") },
    });
    expect(await previews.get(`https://x.com/duskbot/status/${id}`)).toMatchObject({ title: "Metal (@duskbot)", siteName: "X", video: true });
    expect(asked.some((href) => href.startsWith("https://x.com/"))).toBe(false);
  });
});
