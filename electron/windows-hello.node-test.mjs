import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createUserPresence } from "./user-presence.mjs";
import {
  AVAILABILITY, INTEROP_IID, RESULT, STATICS_IID, VERIFICATION_OPERATION_IID, WINDOWS_HELLO_SCRIPT, encodedCommand, helloOutcome, parseHelloOutput,
  runWindowsHello, windowHandleText, windowsPowerShell, winrtPinterfaceIid,
} from "./windows-hello.mjs";

function fakeSpawn(lines, { exit = true, code = 0 } = {}) {
  const calls = [];
  const spawn = (file, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.killed = false;
    child.kill = () => { child.killed = true; queueMicrotask(() => child.emit("close", null)); };
    calls.push({ file, args, options, child });
    queueMicrotask(() => {
      for (const line of lines) child.stdout.emit("data", `${line}\r\n`);
      if (exit) child.emit("close", code);
    });
    return child;
  };
  return { spawn, calls };
}

test("WinRT parameterized IIDs match the ones Windows publishes", () => {
  // windows.foundation.h: IAsyncOperation<bool> and IAsyncOperation<HSTRING>
  assert.equal(winrtPinterfaceIid("pinterface({9fc2b0bb-e446-44e2-aa61-9cab8f636af2};b1)"), "cdb5efb3-5788-509d-9be1-71ccb8a3362a");
  assert.equal(winrtPinterfaceIid("pinterface({9fc2b0bb-e446-44e2-aa61-9cab8f636af2};string)"), "3e1fe603-f897-5263-b328-0806426b8a79");
  assert.match(VERIFICATION_OPERATION_IID, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(WINDOWS_HELLO_SCRIPT.includes(VERIFICATION_OPERATION_IID));
  // the Windows SDK's IUserConsentVerifierStatics and IUserConsentVerifierInterop
  assert.equal(STATICS_IID, "af4f3f91-564c-4ddc-b8b5-973447627c65");
  assert.equal(INTEROP_IID, "39e050c3-4e74-441a-8dc0-b81104df949c");
  for (const iid of [STATICS_IID, INTEROP_IID]) assert.ok(WINDOWS_HELLO_SCRIPT.includes(iid));
});

test("the helper script carries no input and fits a Windows command line", () => {
  assert.ok(!WINDOWS_HELLO_SCRIPT.includes("${"), "no unexpanded template");
  assert.ok(WINDOWS_HELLO_SCRIPT.includes("$env:DUSK_HELLO_REASON"));
  assert.ok(encodedCommand().length < 30_000);
  assert.equal(windowsPowerShell({ SystemRoot: "D:\\Win" }), "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
});

test("the window handle is read as a pointer of the platform's width", () => {
  const wide = Buffer.alloc(8); wide.writeBigUInt64LE(0x1a2b3cn);
  const narrow = Buffer.alloc(4); narrow.writeUInt32LE(77);
  assert.equal(windowHandleText(wide), String(0x1a2b3c));
  assert.equal(windowHandleText(narrow), "77");
  assert.equal(windowHandleText(undefined), "0");
});

test("only Verified passes; a missing Hello is unavailable; an offered prompt that did not verify fails", () => {
  const out = (text) => helloOutcome(parseHelloOutput(text));
  assert.equal(out("availability=0\r\nparented=1\r\nresult=0\r\n"), "pass");
  for (const result of [RESULT.canceled, RESULT.retriesExhausted, RESULT.deviceBusy, 99]) assert.equal(out(`availability=0\nresult=${result}\n`), "fail");
  for (const result of [RESULT.deviceNotPresent, RESULT.notConfiguredForUser, RESULT.disabledByPolicy]) assert.equal(out(`availability=0\nresult=${result}\n`), "unavailable");
  for (const availability of [AVAILABILITY.deviceNotPresent, AVAILABILITY.notConfiguredForUser, AVAILABILITY.disabledByPolicy]) assert.equal(out(`availability=${availability}\n`), "unavailable");
  assert.equal(out("availability=4\n"), "fail");
  assert.equal(out("availability=0\nerror=verify\n"), "fail", "an error after Hello was offered never drops to the weaker confirm");
  assert.equal(out("error=compile\n"), "unavailable");
  assert.equal(out(""), "unavailable");
});

test("the helper gets its inputs through the environment, hidden, from the system PowerShell", async () => {
  const { spawn, calls } = fakeSpawn(["availability=0", "parented=1", "result=0"]);
  const output = await runWindowsHello({ hwnd: "123", reason: "x'; rm -rf /", spawn, env: { SystemRoot: "C:\\Windows" } });
  assert.deepEqual({ ...output, timedOut: output.timedOut }, { availability: 0, result: 0, parented: true, error: false, stage: null, timedOut: false });
  const [{ file, args, options }] = calls;
  assert.equal(file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(args.slice(0, -1), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
  assert.ok(!args.join(" ").includes("rm -rf"));
  assert.equal(options.env.DUSK_HELLO_REASON, "x'; rm -rf /");
  assert.equal(options.env.DUSK_HELLO_HWND, "123");
  assert.equal(options.env.DUSK_HELLO_MODE, "verify");
  assert.equal(options.windowsHide, true);
});

test("a helper that never answers is killed at the deadline", async () => {
  const { spawn, calls } = fakeSpawn(["availability=0"], { exit: false });
  const output = await runWindowsHello({ spawn, timeoutMs: 20, env: {} });
  assert.equal(output.timedOut, true);
  assert.equal(calls[0].child.killed, true);
  assert.equal(helloOutcome(output), "fail", "Hello was showing, so a timeout is a no");
});

test("a helper that cannot start resolves as unavailable", async () => {
  const output = await runWindowsHello({ spawn: () => { throw new Error("ENOENT"); }, env: {} });
  assert.equal(helloOutcome(output), "unavailable");
});

const onWindows = process.platform === "win32";

test("on a real Windows: the availability probe answers cleanly", { skip: !onWindows && "Windows only" }, async () => {
  const output = await runWindowsHello({ mode: "check", timeoutMs: 90_000 });
  console.log(`availability probe: availability=${output.availability} error=${output.stage} timedOut=${output.timedOut}`);
  assert.equal(output.error, false);
  assert.equal(output.timedOut, false);
  assert.ok(Object.values(AVAILABILITY).includes(output.availability));
  if (process.env.CI) assert.notEqual(output.availability, AVAILABILITY.available, "a CI runner has no Hello set up");
});

test("on a real Windows: the parented verification call reaches WinRT and completes", { skip: !onWindows && "Windows only" }, async () => {
  const output = await runWindowsHello({ mode: "force-verify", reason: "Metal CI check", timeoutMs: 90_000 });
  console.log(`forced verification: availability=${output.availability} parented=${output.parented} result=${output.result} error=${output.stage}`);
  assert.equal(output.error, false);
  assert.ok(Object.values(RESULT).includes(output.result));
  if (process.env.CI) assert.equal(helloOutcome(output), "unavailable");
});

test("on a real Windows without Hello: the app falls back to its own confirm", { skip: !(onWindows && process.env.CI) && "Windows CI only" }, async () => {
  const asked = [];
  const presence = createUserPresence({
    platform: "win32",
    windowsHello: (input) => runWindowsHello({ ...input, timeoutMs: 90_000 }),
    helloOutcome,
    confirm: async (reason) => { asked.push(reason); return true; },
  });
  assert.equal(await presence("show a code that links a phone"), true);
  assert.deepEqual(asked, ["show a code that links a phone"]);
});
