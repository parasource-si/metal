import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

import { brandCase, entryCase, isFragment, sentenceCase, startsRight } from "./brand-case";
import en from "./en.json";

const entries = Object.entries(en as Record<string, string>);
const english = en as Record<string, string>;

it("every string in the desktop and phone app reads in sentence case: labels, titles, buttons, pills and messages alike", () => {
  const offending = entries
    .filter(([key, value]) => entryCase(key, value) !== value)
    .map(([key, value]) => `${key}: "${value}" should read "${entryCase(key, value)}"`);
  expect(offending, "start with a capital; keep Metal capitalized and dusk cloud lowercase; add another company's name to src/locales/brand-case.ts").toEqual([]);
});

it("no string starts lowercase unless it starts with dusk cloud, a placeholder, a number or a lowercase name", () => {
  const offending = entries.filter(([key, value]) => !isFragment(key) && !startsRight(value)).map(([key, value]) => `${key}: "${value}"`);
  expect(offending, "a piece filled into the middle of another line goes in FRAGMENT_KEYS in src/locales/brand-case.ts").toEqual([]);
});

it("settings read in sentence case: the sidebar, page titles, section headers, rows, pills and buttons", () => {
  expect(english["settings.section.general"]).toBe("General");
  expect(english["settings.pane.usage"]).toBe("Usage & billing");
  expect(english["settings.pane.advanced"]).toBe("Advanced features");
  expect(english["settings.docs.you"]).toBe("You");
  expect(english["settings.docs.look"]).toBe("How it looks");
  expect(english["settings.simple.theme.system"]).toBe("Follow system");
  expect(english["settings.accent.title"]).toBe("Your message color");
  expect(english["settings.accent.neutral"]).toBe("Neutral");
  expect(english["settings.talkingStyle.casual"]).toBe("Casual");
  expect(english["settings.ambient.island.title"]).toBe("Show island");
  expect(english["settings.ambient.display.built-in"]).toBe("Built-in display");
  expect(english["settings.simple.account.add"]).toBe("Add");
  expect(english["settings.ambient.island.subtitle"]).toMatch(/^Your bots at the top of the screen/);
  expect(english["runsOn.getCloud"]).toBe("Get dusk cloud");
  expect(english["runsOn.status.asleep"]).toBe("Asleep");
});

it("the pieces filled into the middle of another line stay lowercase", () => {
  expect(isFragment("call.live.device.ios")).toBe(true);
  expect(english["call.live.device.ios"]).toBe("an iPhone");
  expect(english["chat.event.and"]).toBe("and");
  expect(isFragment("settings.title")).toBe(false);
});

it("sentenceCase capitalises each sentence and keeps dusk, placeholders, code, abbreviations and lowercase names", () => {
  expect(sentenceCase("signed out. try again, e.g. later. i'll wait")).toBe("Signed out. Try again, e.g. later. I'll wait");
  expect(sentenceCase("Metal is ready. dusk cloud keeps it")).toBe("Metal is ready. dusk cloud keeps it");
  expect(sentenceCase("{bot} is busy. open `settings.json` or notes.md")).toBe("{bot} is busy. Open `settings.json` or notes.md");
  expect(sentenceCase("your bots run 24/7. close your laptop")).toBe("Your bots run 24/7. Close your laptop");
  expect(sentenceCase("npm install, then iPhone")).toBe("npm install, then iPhone");
  expect(entryCase("settings.nav.x", "usage & billing")).toBe("Usage & billing");
  expect(entryCase("sidebar.nav.x", "Take Over")).toBe("Take over");
  expect(entryCase("x.title", "talk to Metal")).toBe("Talk to Metal");
});

it("a chat button named inside a sentence keeps its capital, the rest of the sentence is cased as usual", () => {
  expect(entryCase("signIn.humanCheck", "{site} wants a quick human check. Tap Take over and I'll carry on from there.")).toBe("{site} wants a quick human check. Tap Take over and I'll carry on from there.");
  expect(entryCase("chat.x", "Press I'm done when you Finish.")).toBe("Press I'm done when you finish.");
  expect(english["server.notify.humanCheckBody"]).toBe("Open Metal, tap Take over and tick the box.");
});

it("brandCase keeps names, acronyms, placeholders, code and key combos", () => {
  expect(brandCase("Open Settings in Dusk Cloud")).toBe("open settings in dusk cloud");
  expect(brandCase("Sign in with Google on your Mac")).toBe("sign in with Google on your Mac");
  expect(brandCase("Turn on {app} in System Settings → Privacy & Security")).toBe("turn on {app} in System Settings → Privacy & Security");
  expect(brandCase("Paste your OpenAI API key into `CLAUDE.md`")).toBe("paste your OpenAI API key into `CLAUDE.md`");
  expect(brandCase("Press Shift+Enter. I'll wait")).toBe("press Shift+Enter. i'll wait");
  expect(brandCase("Search X with Claude Code on macOS")).toBe("search X with Claude Code on macOS");
  expect(brandCase("Open https://dusk.bot/Docs or mail Hello@dusk.bot")).toBe("open https://dusk.bot/Docs or mail Hello@dusk.bot");
});

it("translations in languages with capitals start with one too, fragments aside", () => {
  const offending: string[] = [];
  for (const code of ["de", "es", "fr", "it", "pl", "pt-br", "ru", "tr", "uk", "vi"]) {
    const pack = JSON.parse(readFileSync(new URL(`./${code}.json`, import.meta.url), "utf8")) as Record<string, string>;
    for (const [key, value] of Object.entries(pack)) {
      if (isFragment(key) || /^desktopViewer\.(key|notice)/.test(key)) continue;
      const word = value.replace(/^[\s“"'«„([¿¡]*/, "").split(/\s/)[0]!;
      if (/^\p{Ll}/u.test(word) && !/\p{Lu}|[0-9@/.]/u.test(word.slice(1).replace(/[.,:;!?…]+$/, "")) && !/^dusk$/.test(word)) offending.push(`${code} ${key}: "${value}"`);
    }
  }
  expect(offending).toEqual([]);
});
