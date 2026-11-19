// cua-driver (0.47) on the VPS bot desktop runs in standard mode without --grant existing-profile, so its typed browser
// tools (get_browser_state, browser_prepare, browser_*, page) refuse every Chromium window with browser_consent_required,
// and its MCP instructions still send the model there and forbid pointer input. On a sandboxed desktop the pointer is the
// bot's own, so the listing drops what cannot work and the instructions say what does.
import { listsComputerTool } from "./computer-tool-list.ts";
import { PLAIN_WORDS } from "./local-computer-guidance.ts";

type JsonObject = Record<string, unknown>;

/** What the driver's MCP instructions say on a bot's own sandboxed desktop. */
export const SANDBOX_DRIVER_INSTRUCTIONS = [
  "cua-driver on your own sandboxed Linux desktop (X11; get_screen_size gives its size). It is not the person's own screen: the pointer and keyboard are yours, and input here defaults to delivery_mode \"foreground\".",
  "1. Find windows with list_windows({app:\"Chromium\"}) and pick one by title for its pid and window_id. To open a page: launch_app({name:\"chromium\", urls:[\"https://...\"]}). Its window can take a few seconds to appear: call list_windows again instead of launching it twice.",
  "2. Read a window with get_window_state. Its accessibility tree names fields, buttons, links, checkboxes and dialogs, web pages in Chromium included, so pass include_screenshot:false when you only need the tree. Look at the screenshot for what the tree does not name (images, charts, canvas, layout) and zoom for small text. On a later read pass since:<snapshot_id> to get only what changed.",
  "3. Act through run_steps and name each target by role and name, such as {\"click\":{\"role\":\"button\",\"name\":\"Save\"}} or {\"set_value\":{\"role\":\"entry\",\"name\":\"Email\",\"value\":\"...\"}}: no read is needed first and one call can cross screens. Put the effect you expect on the step that should cause it, such as expect:[{\"text\":\"Saved\"}] or expect:[{\"name\":\"Cookie consent\",\"gone\":true}]; a check that does not hold stops the batch and says what it found, so a wrong click is caught at once. Add observe:{} to see what changed. Use x,y from the window's latest screenshot only for what the tree does not name.",
  "4. Fill fields with set_value, which reads the value back, rather than click plus type_text. For a menu command its keyboard shortcut is the most reliable route (ctrl+l, then the address and enter, in Chromium; ctrl+shift+n for a new folder in Thunar). A GTK menu item that opens a dialog (a name ending in \"...\") must not go through invoke_menu or a click by role and name: that leaves the app's dialog frozen. Use its shortcut, or click the open menu's item at x,y. A dialog that opens holds the focus, so keys sent with only the pid reach it; name it with app and window in the next step.",
  "5. Close a cookie banner or popup by its button name, with a check that it is gone, before the step it was covering. Click through \"continue\" pages and redirects and wait out slow pages yourself; these never need the person.",
  "6. There are no typed browser tools on this desktop; do not look for get_browser_state or browser_prepare.",
  "7. Command-line work (curl downloads, renaming or moving files, a file's size, parsing a page, writing a CSV, installing software) goes through vm_exec, never typed into a terminal window.",
  "8. If the same step fails twice, change approach (another target, a keyboard route, vm_exec) or report what blocks you; do not repeat it a third time. A read that says the screenshot is unchanged means nothing on screen changed since your last look.",
  "9. A human check or bot block (a \"Just a moment\", \"Verifying...\" or \"Performing security verification\" page, a CAPTCHA, a \"Verify you are human\" box, \"press and hold\", an \"unusual traffic\" or \"access denied\" page) is never yours to get past: never click it. Do not wait for it yourself and say nothing about it yet: call request_sign_in with human_check true at once. Metal waits it out, reloads once and tries the person's own connection, then tells you what to do next: carry on, use another route (curl to the site's API through vm_exec, a connected app, another site), or call again with other_routes for one card to the person. You carry on by yourself once it clears.",
].join("\n");

const SANDBOX_BROWSER_REFUSED =
  "This desktop's Chromium cannot take the typed browser tools, and nothing the person can turn on changes that: do not call browser_prepare again or ask anyone to authorize it. " +
  "Drive this window with get_window_state and run_steps: its accessibility tree names the page's fields, buttons and links, so click, set_value and type_text by role and name, and use x,y from its screenshot only for what the tree does not name; this pointer is your own. " +
  "For a page's text or data, vm_exec with curl or python3 is faster. " + PLAIN_WORDS;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rewriteResult(result: JsonObject): JsonObject | null {
  if (Array.isArray(result.tools)) {
    const tools = result.tools.filter((tool) => !isObject(tool) || typeof tool.name !== "string" || listsComputerTool(tool.name, true));
    return tools.length === result.tools.length ? null : { ...result, tools };
  }
  if (typeof result.instructions === "string" && isObject(result.serverInfo)) return { ...result, instructions: SANDBOX_DRIVER_INSTRUCTIONS };
  const refusal = isObject(result.structuredContent) && isObject(result.structuredContent.refusal) ? result.structuredContent.refusal : null;
  if (refusal?.code === "browser_consent_required" && Array.isArray(result.content)) {
    const { structuredContent: _dropped, ...rest } = result;
    return { ...rest, isError: true, content: [{ type: "text", text: SANDBOX_BROWSER_REFUSED }] };
  }
  return null;
}

/** One MCP stdio frame from a sandboxed desktop's driver: its tool list, its instructions and a browser refusal change. */
export function sandboxComputerResultLine(line: string): string {
  if (!line.includes("\"tools\"") && !line.includes("\"instructions\"") && !line.includes("browser_consent_required")) return line;
  let frame: unknown;
  try {
    frame = JSON.parse(line);
  } catch {
    return line;
  }
  if (!isObject(frame) || !isObject(frame.result)) return line;
  const result = rewriteResult(frame.result);
  return result ? JSON.stringify({ ...frame, result }) : line;
}
