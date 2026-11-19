import { describe, expect, it } from "vitest";

import { newPhone, relayPairingUsable, relayUnavailableMessage } from "./phone-relay";

describe("phone relay in the pairing pane", () => {
  it("offers pairing from anywhere while the relay is up or can come up", () => {
    for (const status of ["off", "starting", "ready"] as const) expect(relayPairingUsable({ status })).toBe(true);
    for (const status of ["signed-out", "error"] as const) expect(relayPairingUsable({ status })).toBe(false);
    expect(relayPairingUsable(null)).toBe(false);
  });

  it("says what to do instead of a dead end", () => {
    expect(relayUnavailableMessage({ status: "signed-out" })).toMatch(/Sign in to your Dusk account/);
    expect(relayUnavailableMessage({ status: "error", message: "This account already has 20 linked servers." })).toContain("20 linked servers");
    expect(relayUnavailableMessage({ status: "error", code: "tunnel_limit", message: "This account already has 20 linked servers. Remove one in the app to link another." }))
      .toMatch(/limit of linked servers and computers.*same Wi-Fi/);
    expect(relayUnavailableMessage({ status: "ready" })).toBeNull();
    expect(relayUnavailableMessage(null)).toBeNull();
  });

  it("finds the phone that used the code", () => {
    const phone = { id: "b", name: "Pixel", platform: "android" as const, createdAt: 1, lastSeenAt: 1, expiresAt: 2, relay: true, push: null };
    expect(newPhone(["a"], [{ ...phone, id: "a" }, phone])).toBe(phone);
    expect(newPhone(["a", "b"], [phone])).toBeNull();
  });
});
