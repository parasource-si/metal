// `pnpm dev:server`: the harness from a source checkout, whose UI reaches it through Vite's dev proxy in a browser on
// this machine. DUSK_DEV_TRUST_LOCAL_BROWSER=0 tries the sign-in a self-hosted server asks a browser for.
// `pnpm dev:app` runs this same file as the desktop app's own utility child, which alone is granted this computer.
import "../electron/legacy-names.mjs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DESKTOP_COMPUTER_GRANT, desktopComputer } from "./desktop-computer.ts";

process.env.DUSK_DEV_TRUST_LOCAL_BROWSER ??= "1";
// one-click sign-ins to configured OAuth apps, with the clients a release would bake in (names only in the log)
const { loadDevNativeClients } = await import("./dev-native-clients.ts");
const nativeClients = loadDevNativeClients();
if (nativeClients) console.log(`[dev] ${nativeClients} own OAuth client values read from the secrets file`);
await import("./index.ts");

const announceGrant = () => console.log(`[dev] this computer granted by the desktop app (${desktopComputer.connection() ? "driver ready" : desktopComputer.unavailableReason() ?? "no driver"})`);
if (desktopComputer.granted()) announceGrant();
const parentPort = (process as NodeJS.Process & { parentPort?: { on(event: "message", listener: (event: { data?: { type?: unknown; token?: unknown } }) => void): void } }).parentPort;
// under `pnpm dev:app` only the desktop window may change things; the seeding child below is handed its capability
const desktopManaged = process.env.DUSK_DESKTOP_PARENT === "1";
let ownerToken: string | null = null;
parentPort?.on("message", ({ data }) => {
  if (data?.type === DESKTOP_COMPUTER_GRANT) announceGrant();
  if (data?.type === "duskbot:desktop-mutation-token" && typeof data.token === "string" && /^[A-Za-z0-9_-]{43}$/.test(data.token)) ownerToken = data.token;
});
// in a utility child execPath is Electron, which runs a script only as node
const nodeEnv = process.versions.electron ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" } : process.env;

// a fresh checkout starts with test bots to work with, once per workspace; DUSK_NO_TEST_BOTS=1 skips it
if (process.env.DUSK_NO_TEST_BOTS !== "1") {
  const url = `http://127.0.0.1:${Number(process.env.DUSK_PORT || 8799)}`;
  const script = fileURLToPath(new URL("../scripts/demo/test-bots.mjs", import.meta.url));
  const seedOnce = async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const up = await fetch(`${url}/api/health`).then((response) => response.ok, () => false);
      if (up && (!desktopManaged || ownerToken)) {
        // the capability rides a pipe, never argv or env, which other processes on this computer can read
        const child = spawn(process.execPath, [script, "--first-run", "--url", url, ...(ownerToken ? ["--owner-stdin"] : [])],
          { stdio: [ownerToken ? "pipe" : "ignore", "inherit", "inherit"], env: nodeEnv });
        child.on("error", () => {});
        if (ownerToken) { child.stdin?.on("error", () => {}); child.stdin?.end(`${ownerToken}\n`); }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };
  void seedOnce();
}
