import { describe, expect, it } from "vitest";
import { driverGateFromReason, driverGateReason, parseDriverGate } from "./cua-gate.mjs";
import { COMPUTER_HELPER_APP, permissionHolder } from "../shared/your-computer.ts";

const PS = [
  "/usr/sbin/cfprefsd agent",
  "/Applications/CuaDriver.app/Contents/MacOS/cua-driver serve --cua-internal-gate-engaged --cua-internal-gate-missing-screen-recording",
  "",
].join("\n");

describe("CuaDriver's permission gate", () => {
  it("reads which grant a waiting CuaDriver needs from its arguments", () => {
    expect(parseDriverGate(PS)).toEqual(["Screen Recording"]);
    expect(parseDriverGate("/Applications/CuaDriver.app/Contents/MacOS/cua-driver serve --cua-internal-gate-engaged --cua-internal-gate-missing-screen-recording --cua-internal-gate-missing-accessibility"))
      .toEqual(["Screen Recording", "Accessibility"]);
  });

  it("ignores a running helper with no gate, and other programs that mention the flags", () => {
    expect(parseDriverGate("/Applications/CuaDriver.app/Contents/MacOS/cua-driver serve\n")).toBeNull();
    expect(parseDriverGate("grep --cua-internal-gate-engaged --cua-internal-gate-missing-screen-recording")).toBeNull();
    expect(parseDriverGate(undefined)).toBeNull();
  });

  it("writes a reason the server and the app read back as CuaDriver's grant", () => {
    const reason = driverGateReason(["Screen Recording", "Accessibility"]);
    expect(reason).toContain("Screen Recording and Accessibility required");
    expect(driverGateFromReason(reason)).toEqual(["Screen Recording", "Accessibility"]);
    expect(permissionHolder(reason)).toBe(COMPUTER_HELPER_APP);
    expect(driverGateFromReason("embedded host failed: Screen Recording required; restart Metal")).toBeNull();
  });
});
