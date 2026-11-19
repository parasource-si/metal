import { handoffPage } from "./handoff-page.mjs";

const STATE = /^[0-9a-f]{64}$/;
const CODE = /^[A-Za-z0-9._-]{8,256}$/;
const ERROR = /^[a-z_]{1,64}$/;
const escapeHtml = (value) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&#39;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function slackCallback(res, params) {
  const states = params.getAll("state");
  const codes = params.getAll("code");
  const errors = params.getAll("error");
  const valid = states.length === 1 && STATE.test(states[0]) && (
    (codes.length === 1 && errors.length === 0 && CODE.test(codes[0])) ||
    (errors.length === 1 && codes.length === 0 && ERROR.test(errors[0]))
  );
  let content = "<h1>that link didn&#39;t work</h1><p>This Slack link is not valid. Start again from Metal.</p>";
  let head = "";
  let mood = "oops";
  if (valid) {
    const query = new URLSearchParams(codes.length ? { code: codes[0], state: states[0] } : { error: errors[0], state: states[0] });
    const link = escapeHtml(`duskbot://slack/oauth?${query}`);
    const denied = errors[0] === "access_denied";
    head = `<meta http-equiv="refresh" content="0;url=${link}">`;
    mood = denied ? "oops" : "go";
    content = `<h1>${escapeHtml(denied ? "Slack didn't add the bot" : "Returning to Metal")}</h1>
<p>${denied ? "You can close this tab." : "If nothing happens, open Metal yourself."}</p>
<p class="go"><a href="${link}">Open Metal</a></p>
<p class="hint">Or copy this link and paste it into Metal:</p>
<code>${link}</code>`;
  }
  res.writeHead(valid ? 200 : 400, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(handoffPage({ title: "Returning to Metal", mood, content, head }));
}
