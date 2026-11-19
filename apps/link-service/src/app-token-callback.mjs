// Metal's own OAuth apps (Notion, Linear, Airtable, Todoist, ClickUp, Trello, Dropbox) are registered to this one
// fixed address, so a sign-in works whichever port the desktop app ended up on. The state names that port; this sends
// the browser straight back to it on this computer, with nothing stored or logged here. Trello's token rides in the
// address's #fragment, which the browser keeps across the redirect and never sends to us.
import { handoffPage } from "./handoff-page.mjs";

export const APP_TOKENS_CALLBACK_ROUTE = "/oauth/app-tokens";
/** the desktop app's ports (electron/desktop-ports.mjs): never anywhere else */
const PORTS = new Set(["8799", "18799", "28799"]);
const STATE = /^(\d{4,5})\.[0-9a-f]{32}$/;
const VALUE = /^[\x20-\x7e]{1,2048}$/;
const PASSED = ["code", "error", "error_description"];

export function appTokenCallback(res, params) {
  const states = params.getAll("state");
  const port = states.length === 1 ? STATE.exec(states[0])?.[1] : undefined;
  const query = new URLSearchParams({ state: states[0] ?? "" });
  let valid = port !== undefined && PORTS.has(port);
  for (const name of PASSED) {
    const values = params.getAll(name);
    if (values.length > 1 || (values.length === 1 && !VALUE.test(values[0]))) valid = false;
    else if (values.length === 1) query.set(name, values[0]);
  }
  const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
  if (valid) {
    res.writeHead(302, { ...headers, location: `http://127.0.0.1:${port}/api/app-tokens/callback?${query}` });
    return res.end();
  }
  res.writeHead(400, {
    ...headers,
    "content-type": "text/html; charset=utf-8",
    "x-frame-options": "DENY",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(handoffPage({ title: "Metal", mood: "oops", content: "<h1>that link didn&#39;t work</h1><p>This sign-in link is not valid. Start again from Metal.</p>" }));
}
