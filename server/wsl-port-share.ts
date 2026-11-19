// WSL2's localhost forwarding (wslrelay.exe) publishes a port bound on 127.0.0.1 inside the distro as 127.0.0.1 on
// Windows, where that specific bind outranks a Windows program listening on 0.0.0.0 at the same port: the program's
// own calls to 127.0.0.1 then reach this server and fail as unauthorized, and nothing says which app took the port.
import { readFileSync } from "node:fs";
import { connect } from "node:net";

type ReadText = (path: string) => string;
const readText: ReadText = (path) => readFileSync(path, "utf8");

export function insideWsl(env: NodeJS.ProcessEnv = process.env, read: ReadText = readText): boolean {
  if (env.WSL_DISTRO_NAME) return true;
  try { return /microsoft/i.test(read("/proc/sys/kernel/osrelease")); } catch { return false; }
}

/** The Windows host as WSL2 reaches it: the default route's gateway in /proc/net/route (hex, little-endian). */
export function windowsHostAddress(read: ReadText = readText): string | null {
  try {
    for (const line of read("/proc/net/route").split("\n").slice(1)) {
      const [, destination, gateway] = line.trim().split(/\s+/);
      if (destination !== "00000000" || !gateway || !/^[0-9a-f]{8}$/i.test(gateway) || gateway === "00000000") continue;
      return [6, 4, 2, 0].map((at) => parseInt(gateway.slice(at, at + 2), 16)).join(".");
    }
  } catch {}
  return null;
}

function answers(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (open: boolean) => { socket.destroy(); resolve(open); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export function sharedPortWarning(port: number, host: string): string {
  return `[port] another program on Windows (${host}) also listens on port ${port}. WSL forwards this server's ${port} to `
    + `127.0.0.1 on Windows, so that program's own local calls reach Metal instead and fail as unauthorized `
    + `(an OpenMausBot or MausBot server does this). Give Metal its own port, such as --port 8789 or DUSK_PORT=8789, `
    + `or move the other program.`;
}

/** A warning when this server runs inside WSL and a Windows program also listens on its port; null otherwise. */
export async function wslPortShareWarning(port: number, options: {
  env?: NodeJS.ProcessEnv; read?: ReadText; probe?: (host: string, port: number) => Promise<boolean>;
} = {}): Promise<string | null> {
  if (!insideWsl(options.env, options.read)) return null;
  const host = windowsHostAddress(options.read);
  if (!host) return null;
  const open = await (options.probe ?? ((h, p) => answers(h, p, 1_500)))(host, port);
  return open ? sharedPortWarning(port, host) : null;
}
