// The desktop and phone apps read in sentence case, and that includes words written straight into a component instead of
// coming from en.json: JSX text, the text attributes a person sees or hears (titles, placeholders, aria labels) and the
// label fields of objects a screen lists. This fails when one of them starts with a lowercase letter.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

import { startsRight } from "./brand-case";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** the desktop app (src, the website and dashboard live under apps/) and the phone app */
const DIRS = ["src", "apps/mobile/src"];
const SKIP = /(^|\/)(node_modules|dist|locales|testing)(\/|$)|\.test\.|\.d\.ts$|\.stories\./;

const ATTRIBUTES = new Set([
  "aria-label", "aria-description", "aria-roledescription", "title", "placeholder", "alt", "label", "description", "hint", "subtitle",
  "heading", "caption", "confirmLabel", "cancelLabel", "emptyText", "tooltip", "detail",
]);
const FIELDS = new Set(["label", "title", "description", "detail", "placeholder", "hint", "subtitle", "heading", "confirmLabel", "cancelLabel", "ariaLabel", "cta"]);

/** typed commands and units shown as written */
const AS_WRITTEN = /^(npm|pnpm|npx|opencode|noVNC|px|bytes|sha256|localhost)\b/;

/** lowercase values that are ids or typed examples, not words a person reads: the host's "browser" id, and the examples in
 * an MCP server's name field and a webhook's event field */
const ALLOWED = new Set(["src/lib/desktop.ts browser", "src/components/McpServerEditor.tsx github", "src/components/WebhookTrigger.tsx push, workflow_run"]);

/** The allow list and the skip pattern are written with "/", so a path compared against them is too. */
const relativeToRoot = (file: string) => relative(ROOT, file).split(sep).join("/");

function strings(node: ts.Node): ts.Node[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) return [node];
  if (ts.isParenthesizedExpression(node)) return strings(node.expression);
  if (ts.isConditionalExpression(node)) return [...strings(node.whenTrue), ...strings(node.whenFalse)];
  if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.BarBarToken || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) return strings(node.right);
  return [];
}

function textOf(node: ts.Node): string {
  if (ts.isTemplateExpression(node)) return node.head.text;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return (node as ts.JsxText).text;
}

function lowercaseUi(text: string): boolean {
  const trimmed = text.trim();
  // only a plain word counts: "sk-…", "mcp:mail:send" and the like are typed examples
  if (!/^[a-z][a-z'’]+[,.!?…:;)]*$/.test(trimmed.split(/\s/)[0]!)) return false;
  return !startsRight(trimmed) && !AS_WRITTEN.test(trimmed);
}

/** only text that opens its element counts: a word after a {value} or a <b>run</b> continues that line */
function opensLine(node: ts.JsxText | ts.JsxExpression): boolean {
  if (!ts.isJsxElement(node.parent) && !ts.isJsxFragment(node.parent)) return false;
  const siblings = [...node.parent.children];
  return siblings.slice(0, siblings.indexOf(node)).every((sibling) => ts.isJsxSelfClosingElement(sibling) || (ts.isJsxText(sibling) && !sibling.text.trim()));
}

function scan(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const report = (node: ts.Node, text: string) => {
    if (lowercaseUi(text) && !ALLOWED.has(`${relativeToRoot(file)} ${text.trim()}`)) found.push(`${relativeToRoot(file)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} "${text.trim().slice(0, 60)}"`);
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node) && node.text.trim() && opensLine(node)) report(node, node.text);
    if (ts.isJsxExpression(node) && node.expression && opensLine(node)) {
      // A template's opening text opens the element just like a plain string; only a `{value}`-led line is skipped.
      for (const literal of strings(node.expression)) report(literal, textOf(literal));
    }
    if (ts.isJsxAttribute(node) && ATTRIBUTES.has(node.name.getText(sf)) && node.initializer) {
      const value = ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer;
      for (const literal of value ? strings(value) : []) report(literal, textOf(literal));
    }
    if (ts.isPropertyAssignment(node) && FIELDS.has(node.name.getText(sf).replace(/["']/g, ""))) {
      for (const literal of strings(node.initializer)) report(literal, textOf(literal));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

it("no UI text written into a desktop or phone component starts lowercase", () => {
  const files = DIRS.flatMap((dir) => readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" }).map((name) => join(ROOT, dir, name)))
    .filter((file) => /\.tsx?$/.test(file) && !SKIP.test(relativeToRoot(file)));
  expect(files.length).toBeGreaterThan(200);
  const offending = files.flatMap(scan);
  expect(offending, "start UI text with a capital (dusk cloud stays lowercase), or move it into src/locales/en.json").toEqual([]);
});
