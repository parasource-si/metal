import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createMacControlHost } from "./mac-control.mjs";
import { createMacExecutor, folderName, jobSummary, macLogFile, resolveMacPath } from "./mac-control-tools.mjs";

const job = (tool, args = {}, extra = {}) => ({ id: `job-${tool}`, tool, arguments: args, bot: { id: "b1", name: "Nova" }, expiresAt: Date.now() + 60_000, ...extra });

function scratchHome(t) {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "dusk-mac-home-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test("paths start at the home folder and a bot's name makes one safe folder", () => {
  assert.equal(resolveMacPath("~", "/Users/me"), "/Users/me");
  assert.equal(resolveMacPath("~/Downloads/x", "/Users/me"), "/Users/me/Downloads/x");
  assert.equal(resolveMacPath("notes.txt", "/Users/me"), "/Users/me/notes.txt");
  assert.equal(resolveMacPath("/tmp/a/../b", "/Users/me"), "/tmp/b");
  assert.equal(folderName("../Nova/Bot"), "-Nova-Bot");
  assert.equal(folderName(""), "Dusk");
});

test("the log line names the command or the paths, never what is written", () => {
  assert.equal(jobSummary(job("mac_exec", { command: "ls\n -la", cwd: "~/x" })), "ls -la (in ~/x)");
  assert.equal(jobSummary(job("mac_write_file", { path: "~/a.txt", content: "secret" })), "~/a.txt");
});

test("exec, write, read, list and open run on this computer and each is logged", async (t) => {
  const home = scratchHome(t);
  const opened = [];
  const execute = createMacExecutor({ home, shell: "/bin/sh", opener: async (args) => { opened.push(args); } });

  const ran = await execute(job("mac_exec", { command: "echo hello from $PWD; echo oops >&2; exit 3" }));
  assert.equal(ran.ok, true);
  assert.match(ran.result.text, /^exit code 3\n/);
  assert.match(ran.result.text, new RegExp(`hello from ${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(ran.result.text, /oops/);

  const slow = await execute(job("mac_exec", { command: "echo started; sleep 5", timeoutSeconds: 1 }));
  assert.match(slow.result.text, /^stopped after 1 s .*\nstarted/s);

  const wrote = await execute(job("mac_write_file", { path: "notes/today.txt", content: "line one\n" }));
  assert.deepEqual(wrote, { ok: true, result: { text: `wrote 9 bytes in ${path.join(home, "notes/today.txt")}` } });
  await execute(job("mac_write_file", { path: "~/notes/today.txt", content: "line two\n", append: true }));
  assert.equal(readFileSync(path.join(home, "notes/today.txt"), "utf8"), "line one\nline two\n");

  const read = await execute(job("mac_read_file", { path: "~/notes/today.txt" }));
  assert.match(read.result.text, /\(18 bytes, from byte 0\)\nline one\nline two\n$/);
  const listed = await execute(job("mac_list", {}));
  assert.match(listed.result.text, /folder\t-\t.*\tnotes/);

  const url = await execute(job("mac_open", { target: "https://example.com" }));
  const app = await execute(job("mac_open", { target: "Safari" }));
  const file = await execute(job("mac_open", { target: "~/notes", app: "Finder" }));
  assert.deepEqual(opened, [["https://example.com"], ["-a", "Safari"], ["-a", "Finder", path.join(home, "notes")]]);
  assert.equal(url.ok && app.ok && file.ok, true);

  const missing = await execute(job("mac_read_file", { path: "~/nope.txt" }));
  assert.equal(missing.ok, false);

  const log = readFileSync(macLogFile(home), "utf8").trim().split("\n");
  assert.equal(log.length, 10);
  assert.match(log[0], / Nova mac_exec echo hello from \$PWD; echo oops >&2; exit 3 -> ok$/);
  assert.ok(!log.join("\n").includes("line one"), "file contents never reach the log");
  assert.match(log.at(-1), /mac_read_file ~\/nope\.txt -> failed: /);
});

test("a file from the cloud lands in ~/Downloads/<bot>/ without replacing one there", async (t) => {
  const home = scratchHome(t);
  const execute = createMacExecutor({ home });
  const asked = [];
  const download = async (where) => { asked.push(where); return new Response("report body"); };
  const save = job("mac_save_from_cloud", { source: "out/report.pdf" }, { download: { path: "/api/mac/self/jobs/j1/file", name: "report.pdf", bytes: 11 } });
  const first = await execute(save, { download });
  const second = await execute(save, { download });
  assert.equal(first.result.text, `saved 11 bytes to ${path.join(home, "Downloads/Nova/report.pdf")}`);
  assert.equal(second.result.text, `saved 11 bytes to ${path.join(home, "Downloads/Nova/report (2).pdf")}`);
  assert.deepEqual(asked, ["/api/mac/self/jobs/j1/file", "/api/mac/self/jobs/j1/file"]);
  const named = await execute({ ...save, arguments: { source: "x", to: "~/Desktop/final.pdf" } }, { download });
  assert.equal(named.result.text, `saved 11 bytes to ${path.join(home, "Desktop/final.pdf")}`);
});

test("the host takes jobs from the linked server, answers each, and stops when the link goes", async () => {
  const calls = [];
  let handed = false;
  const results = [];
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method ?? "GET", origin: init.headers.origin });
    if (url.includes("/result")) { results.push(JSON.parse(init.body)); return new Response("{}"); }
    if (!handed) { handed = true; return Response.json({ job: job("mac_exec", { command: "true" }) }); }
    await new Promise((resolve) => init.signal.addEventListener("abort", resolve, { once: true }));
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  };
  const host = createMacControlHost({ fetch, name: () => "Sid's MacBook", execute: async (j) => ({ ok: true, result: { text: `ran ${j.tool}` } }) });
  host.follow("http://vps-abc.localhost:5123");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(results, [{ ok: true, result: { text: "ran mac_exec" } }]);
  assert.equal(calls[0].url, "http://vps-abc.localhost:5123/api/mac/self/jobs?name=Sid's%20MacBook");
  assert.ok(calls.every((call) => call.origin === "http://vps-abc.localhost:5123"));
  assert.ok(calls.some((call) => call.url.endsWith("/api/mac/self/jobs/job-mac_exec/result") && call.method === "POST"));
  host.follow(null);
  assert.equal(host.serving(), null);
});

test("a server that refuses this session is asked again only much later", async () => {
  const waits = [];
  let asked = 0;
  const host = createMacControlHost({
    fetch: async () => { asked += 1; return Response.json({ error: "Only the owner's own Metal app on their Mac can serve this server's bots." }, { status: 403 }); },
    name: () => "Mac", execute: async () => ({ ok: true, result: { text: "" } }), log: () => {},
    wait: async (ms, signal) => { waits.push(ms); if (waits.length > 1) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })); },
  });
  host.follow("https://vps.example.com");
  await new Promise((resolve) => setTimeout(resolve, 20));
  host.close();
  assert.equal(asked, 2);
  assert.deepEqual(waits, [600_000, 600_000]);
});

test("a screenshot comes back as an image", async (t) => {
  const execute = createMacExecutor({ home: scratchHome(t), screenshot: async () => ({ data: "AAAA", mimeType: "image/jpeg" }) });
  assert.deepEqual(await execute(job("mac_screenshot")), { ok: true, result: { text: "screenshot of the main screen", image: { data: "AAAA", mimeType: "image/jpeg" } } });
});
