import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { PROVIDER_NAME as RETIRED_PROVIDER, PROVIDER_WORD } from "../../scripts/provider-names.ts";
import en from "./en.json";
import { locales } from "./index";

const RETIRED: ReadonlyArray<readonly [string, RegExp, string]> = [
  ["Dusk Bot Cloud", /Dusk Bot Cloud/i, "Dusk Cloud"],
  ["Dusk Pro", /Dusk Pro\b/, "Dusk Cloud"],
  // \b before "_" fails, so environment names such as DUSK_PUBLIC_IPV4 pass.
  ["OMB", /\bOMB\b/, "Metal"],
  ["Cloud box", /Cloud box/i, "cloud desktop"],
  ["Hosted desktop", /Hosted desktop/i, "cloud desktop"],
  ["Cloud VM", /Cloud VM/i, "cloud desktop"],
  [PROVIDER_WORD, RETIRED_PROVIDER, "cloud desktop"],
  ["Cloud dashboard", /Cloud dashboard/i, "Plan page"],
  ["Connect to my Cloud", /Connect to my Cloud/i, "Open the Cloud"],
  ["your Cloud", /\b[Yy]our Cloud\b(?! plan| account| sign-in| subscription)/, "the Cloud"],
  ["my Cloud", /\bmy Cloud\b/, "the Cloud"],
  ["Local (this computer)", /Local \(this computer\)/, "This computer"],
  ["Cloud as a Works on choice", /\b(?:[Cc]hoose|[Ss]elect) Cloud\b(?! computer| desktop)|\bAuto, Cloud\b(?! computer| desktop)|, Cloud, /, "Cloud desktop"],
  ["T3", /\bT3\b/, "no other app's name"],
];

function retiredIn(text: string): string[] {
  return RETIRED.filter(([, pattern]) => pattern.test(text)).map(([word, , use]) => `"${word}" (say ${use})`);
}

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCANNED = ["src", "server", "electron", "shared"];
// Test fixtures and generated output are not copy anyone reads.
const SKIPPED_DIRS = new Set(["node_modules", "resources", "testing", "dist"]);
const isSource = (name: string) => /\.(?:ts|tsx|mjs|cjs|js)$/.test(name) && !/\.test\.|\.node-test\.|\.d\.ts$/.test(name);

/** No snippet keeps the word file-wide; otherwise only literals containing the snippet. */
const ALLOWED: ReadonlyArray<{ file: string; snippet?: string; why: string }> = [
  { file: "server/workspace-backup.ts", snippet: "OMB-WORKSPACE-1", why: "a backup file's format marker" },
  { file: "electron/company-backups.mjs", snippet: "OMB-WORKSPACE-1", why: "a backup file's format marker" },
];

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (isSource(name)) yield path;
  }
}

function literals(path: string): Array<{ line: number; text: string }> {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : /\.(?:mjs|cjs|js)$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, false, kind);
  const found: Array<{ line: number; text: string }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isJsxText(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      found.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function hardcodedFindings(): Array<{ file: string; line: number; text: string; what: string[] }> {
  const found: Array<{ file: string; line: number; text: string; what: string[] }> = [];
  for (const top of SCANNED) {
    for (const path of sources(join(ROOT, top))) {
      const file = relative(ROOT, path).split("\\").join("/");
      for (const { line, text } of literals(path)) {
        const what = retiredIn(text);
        if (what.length > 0) found.push({ file, line, text, what });
      }
    }
  }
  return found;
}

const allows = (entry: (typeof ALLOWED)[number], finding: { file: string; text: string }) =>
  !RETIRED_PROVIDER.test(finding.text) && entry.file === finding.file && (entry.snippet === undefined || finding.text.includes(entry.snippet));

describe("one name per thing", () => {
  it("English copy uses Dusk Cloud, the Cloud, Cloud desktop, This computer and Plan page", () => {
    const offending = Object.entries(en as Record<string, string>)
      .flatMap(([key, value]) => [...(RETIRED_PROVIDER.test(key) ? retiredIn(key) : []), ...retiredIn(value)].map((what) => `${key}: ${what}`));
    expect(offending).toEqual([]);
  });

  const productNames = RETIRED.filter(([, , use]) => use === "Dusk Cloud");
  it("translations never show retired provider names, T3 or an old name for Dusk Cloud, and keep its name as it is", () => {
    const offending = Object.entries(locales).filter(([code]) => code !== "en").flatMap(([code, pack]) =>
      Object.entries(pack)
        .filter(([key, value]) => /\bOMB\b|\bT3\b/.test(value!) || productNames.some(([, pattern]) => pattern.test(value!))
          || (/Dusk Cloud/.test((en as Record<string, string>)[key]!) && !/Dusk Cloud/.test(value!))
          || RETIRED_PROVIDER.test(key) || RETIRED_PROVIDER.test(value!))
        .map(([key]) => `${code}: ${key}`));
    expect([...new Set(offending)]).toEqual([]);
  });

  it("hard-coded strings in src, server, electron and shared use the same words", () => {
    const findings = hardcodedFindings();
    const offending = findings
      .filter((finding) => !ALLOWED.some((entry) => allows(entry, finding)))
      .flatMap(({ file, line, text, what }) => what.map((one) => `${file}:${line}: ${one}: ${JSON.stringify(text.trim().slice(0, 120))}`));
    expect(offending).toEqual([]);
    const stale = ALLOWED.filter((entry) => !findings.some((finding) => allows(entry, finding)))
      .map((entry) => `${entry.file}${entry.snippet ? ` (${entry.snippet})` : ""}`);
    expect(stale).toEqual([]);
  });

  it("copy that points at a control names it exactly as the control is labelled", () => {
    const e = en as Record<string, string>;
    const source = (file: string) => readFileSync(join(ROOT, file), "utf8");
    const myCloud = /CLOUD_HOME_NAME = "([^"]+)"/.exec(source("electron/cloud-home.mjs"))?.[1];
    // the places popup says This Mac on macOS, by the coordinator's call; elsewhere it matches the app's copy
    const thisComputer = /platform === "darwin" \? "This Mac" : "([^"]+)"/.exec(source("electron/environments.cjs"))?.[1];
    const serverMenuLocal = /\{ label: "([^"]+)", type: "radio", checked: !active/.exec(source("electron/menu.mjs"))?.[1];
    // compared without case: native menus and saved names keep their own capitals
    const lower = (text: string | undefined) => text?.toLowerCase();
    expect([myCloud, thisComputer, serverMenuLocal].map(lower)).toEqual([e["cloudSetup.myCloud"], e["place.local"], e["place.local"]].map(lower));
    const pointers: Array<[string, string[]]> = [
      ["cloudHome.connectHelp", [e["place.local"]!]],
      ["cloudPhone.step1", [myCloud!]],
      ["cloudAccount.onCloudSignIn", [e["cloudAccount.signInAgain"]!]],
      ["cloudAccount.storageFailed", [e["cloudAccount.signOut"]!]],
      ["cloudAccount.codeExpired", [e["cloudAccount.signIn"]!]],
      ["computer.routines.offWarning", [e["routines.runsOn.cloudDesktop"]!]],
    ];
    const stale = pointers.flatMap(([key, labels]) => labels.filter((label) => !e[key]!.toLowerCase().includes(label.toLowerCase())).map((label) => `${key} → ${label}`));
    expect(stale).toEqual([]);
  });

  it("the check catches every retired provider mention and lets live env names through", () => {
    for (const bad of [
      "Sign in to OMB Cloud", "Sign in to Dusk Bot Cloud", "Get Dusk Pro", "Dusk Pro plans",
      "restart OMB", "Cloud box", "Hosted desktop", "Run it in its cloud VM", `${PROVIDER_WORD} cloud runner`,
      "Open your Cloud dashboard", "Connect to my Cloud", "Your Cloud is ready", "Let my Cloud use this Mac",
      "Local (this computer)", "Choose Cloud to wake", "Auto, Cloud or Browser", "including one from T3",
      `Auto uses this ${PROVIDER_WORD}`, `New ${PROVIDER_WORD} computer`, `${PROVIDER_WORD}s`, PROVIDER_WORD.toUpperCase(), `place.${PROVIDER_WORD.toLowerCase()}.title`,
      `Add a ${PROVIDER_WORD} API key in Settings → API keys`, `Connect ${PROVIDER_WORD}`, `Check ${PROVIDER_WORD.toLowerCase()}.dev`,
      `Bots here can get their own cloud desktops from ${PROVIDER_WORD}, a paid service`, `Cloud desktops by ${PROVIDER_WORD}`,
    ]) expect(retiredIn(bad), bad).not.toEqual([]);
    for (const good of [
      "Sign in to Dusk Cloud", "Pro active · verified by Dusk Cloud", "Restart Metal", "locked by another Metal process",
      "set DUSK_PUBLIC_IPV4", "Open My Cloud", "Open the Cloud", "Choose Cloud desktop to wake", "Auto, Cloud desktop or Browser",
      "Included with your Cloud plan",
      "Local VM", "Open your Plan page",
    ]) expect(retiredIn(good), good).toEqual([]);
  });
});
