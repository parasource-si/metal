// whether this app, a linked server's link agent and the server behind it can work together, and what to update when
// they cannot. protocol numbers decide, never app versions; an optional feature checks its capability instead.

/** the link protocol this app speaks with the agent (apps/link-service/agent.mjs LINK_PROTOCOL) and the oldest agent it uses */
export const APP_LINK_PROTOCOL = 2;
export const MIN_AGENT_PROTOCOL = 1;

const whole = (value) => (Number.isInteger(value) && value > 0 ? value : 1);
const label = (value) => (typeof value === "string" && value ? value.slice(0, 40) : null);

/**
 * what an agent said about itself: its answer to the `hello` control op or its direct hello. `null` (an agent from
 * before the handshake answers "unknown request") is protocol 1 with no capabilities
 */
export function agentInfo(said) {
  if (!said || typeof said !== "object") return { protocol: 1, minApp: 1, minServer: 1, agent: null, caps: [], server: null, legacy: true };
  const server = said.server && typeof said.server === "object"
    ? { version: label(said.server.version), protocol: whole(said.server.protocol), minAgent: whole(said.server.minAgent) }
    : null;
  const update = said.update && typeof said.update === "object" ? { running: label(said.update.running), staged: label(said.update.staged) } : null;
  return {
    protocol: whole(said.protocol), minApp: whole(said.minApp), minServer: whole(said.minServer), agent: label(said.agent),
    caps: Array.isArray(said.caps) ? said.caps.filter((cap) => typeof cap === "string" && cap.length <= 40).slice(0, 64) : [],
    server, update, legacy: false,
  };
}

/**
 * `{ update: null | "app" | "agent" | "server", message }` for a server called `name`: the first of this app, the agent
 * and the server that is too old for another, with one sentence a person can act on
 */
export function linkCompat(info, name = "your server") {
  const how = info.caps.includes("self-update") ? "It updates itself when nobody is using it." : "Run its setup line on the server again.";
  if (APP_LINK_PROTOCOL < info.minApp) return { update: "app", message: `Update Metal on this Mac to keep using ${name}.` };
  if (info.protocol < MIN_AGENT_PROTOCOL) return { update: "agent", message: `Update the link on ${name}: it is older than this app works with. ${how}` };
  if (info.server && info.protocol < info.server.minAgent) return { update: "agent", message: `Update the link on ${name}: Metal there needs a newer one. ${how}` };
  if (info.server && info.server.protocol < info.minServer) return { update: "server", message: `Update Metal on ${name}: its link is newer than it works with.` };
  return { update: null, message: null };
}

const FEATURES = {
  "direct-wss": "connect over port 443 when your network blocks ssh",
  "self-update": "let it update itself (run its setup line on the server again)",
};

/** the sentence for a feature the agent lacks, or null when it has it (or nothing is known about it yet) */
export function missingCap(info, cap, name = "your server") {
  if (!info || info.caps.includes(cap)) return null;
  return `Update the link on ${name} to ${FEATURES[cap] ?? `use ${cap}`}.`;
}
