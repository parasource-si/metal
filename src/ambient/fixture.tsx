// Development only: the notch island and the bot dock on a pretend desktop, each in a frame of its own as in the app,
// fed fixture bots (src/windows/previews/ambient-fixture.html). ?display=external draws a display without a notch, ?island=0 leaves
// the island off as a new install does, ?showcase=1 draws the setup's IslandShowcase. The page takes
// { type: "scene", scene } messages.
import { StrictMode, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
import { DOCK, dockLayout, islandLayout } from "../../electron/ambient-geometry.mjs";
import { Dock } from "./Dock";
import { Island } from "./Island";
import { IslandShowcase } from "./IslandShowcase";
import { BotMark } from "./shared";
import { ambientLabels } from "./labels";
import type { AmbientBot, AmbientBridge, AmbientMessage, AmbientSnapshot, AmbientStatus, DockLayout, IslandLayout } from "./types";
import "@fontsource-variable/geist";

const params = new URLSearchParams(location.search);
const external = params.get("display") === "external";
const screen = external
  ? { id: 2, internal: false, label: "Studio Display", bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 25, width: 1512, height: 957 } }
  : { id: 1, internal: true, label: "Built-in Liquid Retina XDR Display", bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 37, width: 1512, height: 945 } };
const menuBar = screen.workArea.y;
const now = Date.now();
const min = 60_000;

const make = (id: string, name: string, color: AmbientBot["color"], body: string, fields: Partial<AmbientBot> = {}): AmbientBot => ({
  id, threadId: `t-${id}`, name, color, body, face: null, avatar: null, status: "idle", detail: "", line: "", at: now - 3 * 60 * min, unread: false, asks: 0,
  approval: null, waits: null, question: null, step: null, chat: CHATS[id] ?? [], ...fields,
});
const said = (...lines: Array<[AmbientMessage["from"], string]>): AmbientMessage[] => lines.map(([from, text], index) => ({ id: `c${index}`, from, text, at: now - (lines.length - index) * 4 * min }));
const CHATS: Record<string, AmbientMessage[]> = {
  nova: said(["you", "Find me a flight to Lisbon on the 14th, morning if possible"], ["bot", "On it. I'll compare the direct ones first and check bag fees."]),
  quill: said(["you", "Can you turn the release notes into a launch post?"], ["bot", "Here's a first draft: \"Faster turns, a calmer dock, and answers right where you are.\" I'd like to run the build to check the screenshots."]),
  rivet: said(["you", "The footer overlaps the cookie banner on mobile"], ["bot", "Fixed: the banner now sits above the footer, and I removed the old fixed positioning."], ["bot", "The footer is fixed and deployed. I also cleaned up the old styles."]),
  tally: said(["you", "How are we doing on the October budget?"]),
  echo: said(["you", "Check the replies on my launch thread"], ["bot", "Couldn't reach Gmail: the sign-in expired."]),
  juno: said(["you", "Book the flight home on Sunday"], ["bot", "Found two that work: 18:10 and 20:45, both direct. Going with 18:10 unless you'd rather the later one."]),
  lark: said(["you", "Sort my inbox"], ["bot", "I need to sign in to Gmail to do that."]),
  moss: said(["you", "Remind me what we decided about the garden"], ["bot", "You picked the raised beds on the south side, and tomatoes in the first row."]),
  wren: [],
};
const base: AmbientBot[] = [
  make("nova", "Nova", "blue", "blob", { line: "Booked the 9:40 to Lisbon and sent the receipt." }),
  make("quill", "Quill", "purple", "sparkle", { line: "Draft of the launch post is in your docs." }),
  make("rivet", "Rivet", "orange", "hex", { line: "The footer is fixed and deployed." }),
  make("tally", "Tally", "green", "clover", { line: "October spend is 12% under budget." }),
  make("echo", "Echo", "yellow", "star", { line: "Three new replies to your thread." }),
  make("juno", "Juno", "pink", "heart", { line: "Your flight checks in tomorrow at 7." }),
  make("lark", "Lark", "teal", "cloud", { line: "Inbox is sorted." }),
  make("moss", "Moss", "cyan", "gem"),
  make("wren", "Wren", "coral", "flower"),
];
const set = (id: string, fields: Partial<AmbientBot>) => (bot: AmbientBot) => (bot.id === id ? { ...bot, ...fields } : bot);
const mood = (status: AmbientStatus, detail = "") => base.map(set("nova", { status, detail, at: now - 20_000, unread: status === "done", waits: status === "needs-you" ? "approval" : null }));
const busy = base
  .map(set("quill", { status: "needs-you", waits: "approval", detail: "Wants to run a command", asks: 1, at: now - 40_000, approval: { requestId: "r1", threadId: "t-quill", title: "npm run build" } }))
  .map(set("juno", { status: "needs-you", waits: "question", asks: 1, at: now - 4 * min, question: { requestId: "q1", threadId: "t-juno", title: "Aisle or window for the flight home?", choices: ["Aisle", "Window", "Either"], custom: true } }))
  .map(set("lark", { status: "needs-you", waits: "sign-in", asks: 1, detail: "Sign in to Gmail", at: now - 9 * min }))
  .map(set("nova", { status: "working", step: "web", detail: "Comparing 14 flights to Lisbon", at: now - 2 * min }))
  .map(set("tally", { status: "thinking", step: "thinking", detail: "Thinking", at: now - 50_000 }))
  .map(set("rivet", { status: "done", unread: true, at: now - 6 * min, line: "The footer is fixed and deployed. I also cleaned up the old styles." }))
  .map(set("echo", { status: "error", line: "Couldn't reach Gmail: the sign-in expired.", at: now - 30 * min }));
const wake = (fields: Partial<AmbientBot>) => base.map(set("nova", { at: now - 20_000, ...fields }));
const SCENES: Record<string, AmbientBot[]> = {
  question: wake({ status: "needs-you", waits: "question", asks: 1, question: { requestId: "q1", threadId: "t-nova", title: "Aisle or window for the flight home?", choices: ["Aisle", "Window"], custom: true } }),
  approval: wake({ status: "needs-you", waits: "approval", asks: 1, detail: "Wants to run a command", approval: { requestId: "r1", threadId: "t-nova", title: "npm run build" } }),
  "sign-in": wake({ status: "needs-you", waits: "sign-in", asks: 1, detail: "Sign in to Gmail" }),
  failed: wake({ status: "error", unread: true, line: "Couldn't reach Gmail: the sign-in expired." }),
  "long-done": wake({ status: "done", unread: true, ran: 6 * min, line: "Compared 14 flights and booked the 9:40 to Lisbon." }),
  scheduled: wake({ status: "done", unread: true, scheduled: true, line: "Your morning digest is ready." }),
  "quick-reply": wake({ status: "done", unread: true, ran: 20_000, line: "Done." }),
  quiet: base,
  empty: [],
  few: busy.slice(0, 4),
  thinking: mood("thinking", "Thinking"),
  working: mood("working", "Reading itinerary.pdf"),
  talking: mood("talking", "Writing a reply"),
  done: mood("done"),
  error: mood("error"),
  busy,
  // a bot's intro is not an ask: it rests, unread
  intro: base.map(set("nova", { status: "done", unread: true, line: "Hey! I'm Nova. I'm new here.", at: now - 3 * 24 * 60 * min })),
};
const snapshot = (scene: string): AmbientSnapshot => ({ bots: SCENES[scene] ?? busy, labels: ambientLabels(), lang: "en" });

const island = islandLayout(screen, { platform: "darwin", size: params.get("size") ?? "medium" });
const dock = dockLayout(screen);
const islandLayoutMessage: IslandLayout = { surface: "island", width: island.window.width, height: island.window.height, collapsed: island.collapsed, tile: island.tile, size: island.size };
const dockLayoutMessage: DockLayout = { surface: "dock", width: dock.window.width, height: dock.window.height, body: dock.body, top: dock.top, dock: { ...DOCK }, order: [] };

function fakeBridge(surface: "island" | "dock", scene: string): AmbientBridge {
  const states = new Set<(value: AmbientSnapshot) => void>(), layouts = new Set<(value: IslandLayout | DockLayout) => void>();
  let current = snapshot(scene);
  // { type: "scene" } picks a made-up scene; { type: "snapshot" } shows a summary the real app's page published
  window.addEventListener("message", (event) => {
    if (event.data?.type === "scene") current = snapshot(String(event.data.scene));
    else if (event.data?.type === "snapshot" && event.data.snapshot) current = event.data.snapshot as AmbientSnapshot;
    else return;
    for (const cb of states) cb(current);
  });
  const log = (...args: unknown[]) => console.info("[ambient]", ...args);
  // ?seen=1 starts with every reply and failure already seen
  const seenKeys = new Set(params.get("seen") === "1" ? current.bots.map((bot) => `${bot.id}:${bot.status}:${bot.at}`) : []);
  const seenListeners = new Set<(keys: string[]) => void>();
  return {
    surface,
    onSeen: (cb) => { seenListeners.add(cb); return () => { seenListeners.delete(cb); }; },
    seen: (keys) => { for (const key of keys) seenKeys.add(key); log("seen", keys); },
    onState: (cb) => { states.add(cb); return () => { states.delete(cb); }; },
    onLayout: (cb) => { layouts.add(cb); return () => { layouts.delete(cb); }; },
    pointer: (on) => { document.documentElement.dataset.pointer = String(on); },
    open: (botId) => { log("open", botId); document.documentElement.dataset.lastOpen = botId; },
    act: (act) => { log("act", JSON.stringify(act)); document.documentElement.dataset.lastAct = JSON.stringify(act); },
    order: (ids) => log("order", ids),
    ready: () => queueMicrotask(() => {
      for (const cb of layouts) cb(surface === "island" ? islandLayoutMessage : dockLayoutMessage);
      for (const cb of seenListeners) cb([...seenKeys]);
      for (const cb of states) cb(current);
    }),
  };
}

const WALLPAPER = "radial-gradient(120% 90% at 18% 12%, #c9b6a4 0%, #9c7f74 26%, #5d5170 58%, #2b2a40 100%)";

function Desktop() {
  const frames = useRef<HTMLIFrameElement[]>([]);
  useEffect(() => {
    const relay = (event: MessageEvent) => { if ((event.data?.type === "scene" || event.data?.type === "snapshot") && event.source === window) for (const frame of frames.current) frame?.contentWindow?.postMessage(event.data, "*"); };
    window.addEventListener("message", relay);
    return () => window.removeEventListener("message", relay);
  }, []);
  const scene = params.get("scene") ?? "busy";
  const withIsland = params.get("island") !== "0";
  const frameUrl = (surface: string) => `${location.pathname}?frame=${surface}&scene=${scene}${external ? "&display=external" : ""}${params.get("size") ? `&size=${params.get("size")}` : ""}${params.get("seen") ? `&seen=${params.get("seen")}` : ""}`;
  return (
    <div style={{ position: "relative", width: 1512, height: 982, overflow: "hidden", fontFamily: "-apple-system, system-ui, sans-serif", background: WALLPAPER }}>
      <div style={{ position: "absolute", inset: "0 0 auto 0", height: menuBar, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 18px",
        background: "rgb(30 24 40 / 0.28)", backdropFilter: "blur(30px)", color: "#f4f4f4", fontSize: 13, fontWeight: 500 }}>
        <span style={{ display: "flex", gap: 20 }}><b>Metal</b><span>File</span><span>Edit</span><span>View</span><span>Window</span><span>Help</span></span>
        <span style={{ display: "flex", gap: 16 }}><span>100%</span><span>Mon 9 Nov  10:40</span></span>
      </div>
      {!external && <div style={{ position: "absolute", top: 0, left: (1512 - 192) / 2, width: 192, height: 37, background: "#000", borderRadius: "0 0 10px 10px" }} />}
      {withIsland && (
        <iframe ref={(node) => { if (node) frames.current[0] = node; }} title="Island" src={frameUrl("island")}
          style={{ position: "absolute", left: island.window.x, top: island.window.y, width: island.window.width, height: island.window.height, border: 0, background: "transparent", colorScheme: "dark" }} />
      )}
      <iframe ref={(node) => { if (node) frames.current[1] = node; }} title="Dock" src={frameUrl("dock")}
        style={{ position: "absolute", left: dock.window.x, top: dock.window.y, width: dock.window.width, height: dock.window.height, border: 0, background: "transparent", colorScheme: "dark" }} />
    </div>
  );
}

function Showcase() {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", gap: 24, background: "#f3f2ef", fontFamily: "-apple-system, system-ui, sans-serif" }}>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", justifyContent: "center" }}>
        <IslandShowcase className="fixture-frame" width={480} height={300} />
        <IslandShowcase className="fixture-frame" width={480} height={300} kind="pill" open />
      </div>
    </div>
  );
}

const POSES = ["idle", "working", "coding", "reading", "searching", "running", "computing", "thinking", "streaming", "writing", "waiting", "blocked", "alerting", "notifying", "curious", "surprised", "confused", "finished", "happy", "approving", "proud", "excited", "celebrate", "failed", "sad", "sleeping", "drowsy", "humming"] as const;

/** Every pose a dock mascot could take, to pick the ones that keep the bot itself on screen. */
function Poses() {
  return (
    <div className="amb-root" style={{ display: "grid", gridTemplateColumns: "repeat(7, 120px)", gap: 8, padding: 16, background: "#0c0c0c", color: "#f5f5f5", fontSize: 12 }}>
      {POSES.map((pose) => (
        <div key={pose} style={{ display: "grid", placeItems: "center", gap: 6, height: 96 }}>
          <BotMark bot={base[2]!} size={40} state={pose} animated awake={false} />
          <span>{pose}</span>
        </div>
      ))}
    </div>
  );
}

const frame = params.get("frame");
const root = createRoot(document.getElementById("root")!);
if (frame === "island" || frame === "dock") {
  await import("./ambient-page.css");
  await import("./ambient.css");
  document.documentElement.classList.add("amb-root");
  const bridge = fakeBridge(frame, params.get("scene") ?? "busy");
  root.render(<StrictMode><MotionConfig reducedMotion="user">{frame === "island" ? <Island bridge={bridge} /> : <Dock bridge={bridge} />}</MotionConfig></StrictMode>);
} else if (params.get("poses") === "1") {
  await import("./ambient.css");
  document.body.style.margin = "0";
  root.render(<StrictMode><Poses /></StrictMode>);
} else if (params.get("showcase") === "1") {
  document.body.style.margin = "0";
  const style = document.createElement("style");
  style.textContent = ".fixture-frame { border-radius: 14px; background: linear-gradient(180deg, #2a2b31, #1b1c21); box-shadow: 0 1px 2px rgb(0 0 0 / 0.12); }";
  document.head.append(style);
  root.render(<StrictMode><Showcase /></StrictMode>);
} else {
  document.body.style.margin = "0";
  root.render(<StrictMode><Desktop /></StrictMode>);
}
