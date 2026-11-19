// "Your Mac": what a linked server's bot asks this Mac to do (shared/mac-control.ts MacJob), run here as the person who
// is signed in, with every action appended to ~/Library/Logs/Dusk Bot/mac-control.log (never file contents).
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, promises as fsp } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const OUTPUT_TAIL = 200 * 1024;
const READ_MAX = 262_144;
const LIST_MAX = 500;
const KILL_GRACE_MS = 3000;
const DOWNLOAD_MAX = 2 * 1024 ** 3;

export function macLogFile(home = homedir()) {
  return path.join(home, "Library", "Logs", "Dusk Bot", "mac-control.log");
}

/** `~`, `~/x` and relative paths start at the home folder */
export function resolveMacPath(value, home = homedir()) {
  const text = String(value ?? "").trim();
  if (!text || text === "~") return home;
  if (text.startsWith("~/")) return path.join(home, text.slice(2));
  return path.isAbsolute(text) ? path.normalize(text) : path.join(home, text);
}

/** a bot's name as one folder name */
export function folderName(value) {
  return String(value ?? "").replace(/[/\\:\0]/g, "-").replace(/^\.+/, "").trim().slice(0, 60) || "Dusk";
}

function tail() {
  let chunks = [], size = 0;
  return {
    push(chunk) {
      chunks.push(chunk);
      size += chunk.length;
      while (chunks.length > 1 && size - chunks[0].length >= OUTPUT_TAIL) size -= chunks.shift().length;
    },
    text() {
      const all = Buffer.concat(chunks);
      return (all.length > OUTPUT_TAIL ? all.subarray(all.length - OUTPUT_TAIL) : all).toString("utf8");
    },
    cut: () => size > OUTPUT_TAIL,
  };
}

export function runShell(command, { cwd, timeoutMs, shell = "/bin/zsh", spawnImpl = spawn, signal: abort }) {
  return new Promise((resolve) => {
    const output = tail();
    let timedOut = false, stopped = false, killer = null;
    const child = spawnImpl(shell, ["-l", "-c", command], { cwd, env: { ...process.env, TERM: "dumb" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const stop = (signal) => { try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* gone */ } } };
    const end = () => { stop("SIGTERM"); killer = setTimeout(() => stop("SIGKILL"), KILL_GRACE_MS); };
    const timer = setTimeout(() => { timedOut = true; end(); }, timeoutMs);
    const onAbort = () => { stopped = true; clearTimeout(timer); end(); };
    if (abort?.aborted) onAbort(); else abort?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", output.push);
    child.stderr?.on("data", output.push);
    child.on("error", (error) => { clearTimeout(timer); abort?.removeEventListener("abort", onAbort); resolve({ code: null, output: String(error?.message ?? error), timedOut: false, stopped, cut: false }); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killer);
      abort?.removeEventListener("abort", onAbort);
      resolve({ code: code ?? (signal ? `signal ${signal}` : null), output: output.text(), timedOut, stopped, cut: output.cut() });
    });
  });
}

/** a file name a site gave, or the link's last part */
export function downloadName(url, disposition) {
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(disposition ?? "")?.[1];
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition ?? "")?.[1];
  let name = "";
  try { name = decodeURIComponent((star ?? plain ?? path.posix.basename(url.pathname)).trim()); } catch { name = (plain ?? "").trim(); }
  const clean = path.posix.basename(name.replace(/\\/g, "/")).replace(/[/:\0]/g, "-").replace(/^\.+/, "").trim().slice(0, 120);
  return clean || "download";
}

const run = (file, args, timeout = 20_000) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout }, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr: String(stderr ?? "") })) : resolve(String(stdout ?? ""))));
});

async function exists(file) {
  try { return await fsp.stat(file); } catch { return null; }
}

/** a free name beside `file`: "name (2).ext" and on */
async function freeName(file) {
  if (!(await exists(file))) return file;
  const { dir, name, ext } = path.parse(file);
  for (let n = 2; n < 1000; n += 1) {
    const next = path.join(dir, `${name} (${n})${ext}`);
    if (!(await exists(next))) return next;
  }
  throw new Error("too many files with that name");
}

/** what one line of the log says about a job: the command or the paths, never what is written */
export function jobSummary(job) {
  const a = job.arguments ?? {};
  const clip = (value) => String(value ?? "").replace(/\s+/g, " ").slice(0, 500);
  switch (job.tool) {
    case "mac_exec": return clip(a.command) + (a.cwd ? ` (in ${clip(a.cwd)})` : "");
    case "mac_open": return clip(a.target) + (a.app ? ` with ${clip(a.app)}` : "");
    case "mac_save_from_cloud": return `${clip(a.source)} -> ${clip(a.to ?? "~/Downloads")}`;
    case "mac_screenshot": return "screen";
    case "mac_download": return `${clip(a.url)} -> ${clip(a.to ?? "~/Downloads/")}`;
    default: return clip(a.path ?? "~");
  }
}

/**
 * @param {{ home?: string, shell?: string, log?(line: string): void, now?(): Date, spawnImpl?: typeof spawn,
 *   screenshot?(): Promise<{ data: string, mimeType: string }>, opener?(args: string[]): Promise<unknown>,
 *   fetch?: typeof fetch, source?: string, defaultCwd?(): string }} [options] `source` starts each log line ("cloud");
 *   `defaultCwd` is where mac_exec runs without a cwd (the home folder otherwise).
 */
export function createMacExecutor(options = {}) {
  const home = options.home ?? homedir();
  const logFile = macLogFile(home);
  const at = (value) => resolveMacPath(value, home);
  let logReady = null;
  async function record(job, outcome) {
    const from = options.source ? `${options.source} ` : "";
    const approved = job.approved === true ? " (allowed in chat)" : "";
    const line = `${(options.now?.() ?? new Date()).toISOString()} ${from}${folderName(job.bot?.name)} ${job.tool} ${jobSummary(job)}${approved} -> ${outcome.ok ? "ok" : `failed: ${String(outcome.error).slice(0, 300)}`}\n`;
    try {
      logReady ??= fsp.mkdir(path.dirname(logFile), { recursive: true, mode: 0o700 });
      await logReady;
      await fsp.appendFile(logFile, line, { mode: 0o600 });
    } catch (error) { options.log?.(`mac control: could not write the log (${error?.message ?? error})`); }
  }

  const tools = {
    async mac_exec(a, { signal } = {}) {
      const cwd = a.cwd ? at(a.cwd) : options.defaultCwd ? at(options.defaultCwd()) : home;
      if (!a.cwd && options.defaultCwd) await fsp.mkdir(cwd, { recursive: true });
      if (!(await exists(cwd))?.isDirectory()) throw new Error(`${cwd} is not a folder`);
      const seconds = Number.isInteger(a.timeoutSeconds) ? a.timeoutSeconds : 120;
      const result = await runShell(String(a.command), { cwd, timeoutMs: seconds * 1000, shell: options.shell, spawnImpl: options.spawnImpl, signal });
      const head = result.stopped ? "stopped on the Mac by the person (it may have changed things already); output so far:"
        : result.timedOut ? `stopped after ${seconds} s (it may have changed things already); output so far:` : `exit code ${result.code}`;
      return { text: `${head}${result.cut ? " (last 200 KB of output)" : ""}\n${result.output}` };
    },
    async mac_read_file(a) {
      const file = at(a.path);
      const handle = await fsp.open(file, "r");
      try {
        const { size } = await handle.stat();
        const offset = Number.isInteger(a.offset) ? a.offset : 0;
        const length = Math.max(0, Math.min(Number.isInteger(a.maxBytes) ? a.maxBytes : READ_MAX, READ_MAX, size - offset));
        const bytes = Buffer.alloc(length);
        await handle.read(bytes, 0, length, offset);
        if (bytes.subarray(0, 8192).includes(0)) return { text: `${file} is a binary file of ${size} bytes; inspect it with mac_exec.` };
        const more = offset + length < size ? `; ${size - offset - length} more bytes after this` : "";
        return { text: `${file} (${size} bytes, from byte ${offset}${more})\n${bytes.toString("utf8")}` };
      } finally { await handle.close(); }
    },
    async mac_write_file(a) {
      const file = at(a.path);
      const bytes = a.encoding === "base64" ? Buffer.from(String(a.content), "base64") : Buffer.from(String(a.content), "utf8");
      await fsp.mkdir(path.dirname(file), { recursive: true });
      if (a.append === true) await fsp.appendFile(file, bytes);
      else await fsp.writeFile(file, bytes);
      return { text: `${a.append === true ? "added" : "wrote"} ${bytes.length} bytes ${a.append === true ? "to" : "in"} ${file}` };
    },
    async mac_list(a) {
      const dir = at(a.path ?? "~");
      const entries = (await fsp.readdir(dir, { withFileTypes: true })).filter((entry) => a.hidden === true || !entry.name.startsWith("."));
      entries.sort((x, y) => Number(y.isDirectory()) - Number(x.isDirectory()) || x.name.localeCompare(y.name));
      const shown = await Promise.all(entries.slice(0, LIST_MAX).map(async (entry) => {
        const info = await fsp.lstat(path.join(dir, entry.name)).catch(() => null);
        const kind = entry.isDirectory() ? "folder" : entry.isSymbolicLink() ? "link" : "file";
        return `${kind}\t${entry.isDirectory() ? "-" : info?.size ?? "?"}\t${info ? info.mtime.toISOString().slice(0, 16) : "?"}\t${entry.name}`;
      }));
      const more = entries.length > LIST_MAX ? `\n(${entries.length - LIST_MAX} more not shown)` : "";
      return { text: `${dir}: ${entries.length} entries\nkind\tbytes\tchanged\tname\n${shown.join("\n")}${more}` };
    },
    async mac_open(a) {
      const target = String(a.target).trim();
      const url = /^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("/");
      const file = url ? null : at(target);
      const found = file ? await exists(file) : null;
      const args = a.app ? ["-a", String(a.app), ...(url ? [target] : found ? [file] : [])]
        : url ? [target] : found ? [file] : ["-a", target];
      try { await (options.opener ?? ((list) => run("/usr/bin/open", list)))(args); }
      catch (error) { throw new Error(String(error?.stderr || error?.message || error).trim().split("\n")[0] || "macOS could not open it"); }
      return { text: `opened ${a.app ? `${target} with ${a.app}` : url ? target : found ? file : `the app ${target}`}` };
    },
    async mac_download(a, { signal } = {}) {
      const url = new URL(String(a.url));
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("only https and http links download");
      const response = await (options.fetch ?? fetch)(url, { redirect: "follow", signal });
      if (!response.ok || !response.body) throw new Error(`${url.host} answered ${response.status}`);
      if (Number(response.headers.get("content-length")) > DOWNLOAD_MAX) throw new Error("the file is over 2 GB");
      const wanted = a.to ? String(a.to) : "~/Downloads/";
      const folderLike = /[/\\]$/.test(wanted) || (await exists(at(wanted)))?.isDirectory();
      const file = await freeName(folderLike ? path.join(at(wanted), downloadName(url, response.headers.get("content-disposition"))) : at(wanted));
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const part = `${file}.${randomBytes(4).toString("hex")}.part`;
      let size = 0;
      const counted = Readable.fromWeb(response.body).map((chunk) => {
        size += chunk.length;
        if (size > DOWNLOAD_MAX) throw new Error("the file is over 2 GB");
        return chunk;
      });
      let saved;
      try {
        await pipeline(counted, createWriteStream(part, { flags: "wx" }), { signal });
        saved = await freeName(file);
        await fsp.rename(part, saved);
      } catch (error) {
        await fsp.rm(part, { force: true });
        throw error;
      }
      return { text: `saved ${size} bytes from ${url.host} to ${saved}` };
    },
    async mac_screenshot() {
      if (options.screenshot) return { text: "screenshot of the main screen", image: await options.screenshot() };
      const file = path.join(tmpdir(), `dusk-mac-${randomBytes(6).toString("hex")}.jpg`);
      try {
        try { await run("/usr/sbin/screencapture", ["-x", "-t", "jpg", file]); }
        catch { throw new Error("macOS did not allow a screenshot: allow Metal under System Settings > Privacy & Security > Screen Recording"); }
        await run("/usr/bin/sips", ["-Z", "1600", file]).catch(() => {});
        return { text: "screenshot of the main screen", image: { data: (await fsp.readFile(file)).toString("base64"), mimeType: "image/jpeg" } };
      } finally { await fsp.rm(file, { force: true }); }
    },
  };

  /** runs one job; `download(path)` fetches a mac_save_from_cloud file from the server that sent it; `signal` stops it */
  return async function execute(job, { download, signal } = {}) {
    let outcome;
    try {
      if (job.tool === "mac_save_from_cloud") {
        if (!job.download || !download) throw new Error("the server sent no file");
        const name = folderName(path.basename(job.download.name));
        const wanted = job.arguments?.to ? String(job.arguments.to) : `~/Downloads/${folderName(job.bot?.name)}/`;
        const folderLike = /[/\\]$/.test(wanted) || (await exists(at(wanted)))?.isDirectory();
        const file = await freeName(folderLike ? path.join(at(wanted), name) : at(wanted));
        await fsp.mkdir(path.dirname(file), { recursive: true });
        const response = await download(job.download.path);
        if (!response.ok || !response.body) throw new Error(`the server did not hand over the file (${response.status})`);
        await pipeline(Readable.fromWeb(response.body), createWriteStream(file, { flags: "wx" }));
        const { size } = await fsp.stat(file);
        outcome = { ok: true, result: { text: `saved ${size} bytes to ${file}` } };
      } else {
        const tool = tools[job.tool];
        if (!tool) throw new Error(`this Mac app does not know ${job.tool}; update Metal on the Mac`);
        outcome = { ok: true, result: await tool(job.arguments ?? {}, { signal }) };
      }
    } catch (error) {
      outcome = { ok: false, error: String(error?.message ?? error).slice(0, 2000) };
    }
    await record(job, outcome);
    return outcome;
  };
}
