import { describe, expect, it } from "vitest";

import { setLocale } from "./i18n";
import { serverCheckPhase, serverUpdateRow, type ServerUpdateCheck } from "./server-update";

const check = (patch: Partial<ServerUpdateCheck> = {}): ServerUpdateCheck => ({
  current: "0.1.92",
  install: "docker",
  available: false,
  ...patch,
});

describe("self-hosted update row", () => {
  it("offers a check before anything is known", () => {
    expect(serverUpdateRow("idle", null)).toEqual({ label: "Check for updates" });
    expect(serverUpdateRow("checking", null)).toEqual({ label: "Checking for updates…" });
  });

  it("names the new version and how this install is updated", () => {
    const docker = check({ available: true, latest: "0.1.93", command: "docker compose pull dusk && docker compose up -d", restart: false });
    expect(serverUpdateRow("available", docker)).toEqual({
      label: "Version 0.1.93 available (release notes)",
      subtitle: "Update with: docker compose pull dusk && docker compose up -d",
    });
    const npm = check({ install: "npm", available: true, latest: "0.1.93", command: "npm install -g duskbot@latest", restart: true });
    expect(serverUpdateRow("available", npm).subtitle).toBe("Update with: npm install -g duskbot@latest, then restart the app");
    // an install it cannot recognise still learns there is a new version
    expect(serverUpdateRow("available", check({ install: "unknown", available: true, latest: "0.1.93" }))).toEqual({
      label: "Version 0.1.93 available (release notes)",
      subtitle: undefined,
    });
  });

  it("says when it is up to date, and with which version", () => {
    expect(serverUpdateRow("up-to-date", check({ latest: "0.1.92" }))).toEqual({ label: "You're up to date", subtitle: "v0.1.92" });
  });

  it("asks a page older than its server to reload instead of calling it up to date", () => {
    // The server was updated while this page kept running the bundle About reports
    const stale = check({ current: "0.1.114" });
    expect(serverCheckPhase(stale, "0.1.113")).toBe("reload");
    expect(serverUpdateRow("reload", stale, "0.1.113")).toEqual({
      label: "Reload to update",
      subtitle: "This page is out of date",
    });
  });

  it("never asks a page newer than its server to reload, since a reload brings back the same page", () => {
    expect(serverCheckPhase(check({ current: "0.2.12" }), "0.2.15")).toBe("up-to-date");
    expect(serverCheckPhase(check({ current: "unknown" }), "0.2.15")).toBe("up-to-date");
  });

  it("keeps the other check results when the page matches or can't tell", () => {
    expect(serverCheckPhase(check({ current: "0.1.114" }), "0.1.114")).toBe("up-to-date");
    expect(serverCheckPhase(check({ current: "0.1.114" }), "dev")).toBe("up-to-date");
    expect(serverCheckPhase(check({ current: "0.1.114", available: true, latest: "0.1.115" }), "0.1.113")).toBe("available");
    expect(serverCheckPhase(check({ current: "0.1.114", install: "desktop" }), "0.1.113")).toBe("up-to-date");
    expect(serverCheckPhase(check({ current: "0.1.114", install: "managed" }), "0.1.113")).toBe("up-to-date");
  });

  it("explains servers that are updated elsewhere", () => {
    expect(serverUpdateRow("up-to-date", check({ install: "desktop" })).label).toBe(
      "Updates come from the Metal app on the computer these bots run on",
    );
    expect(serverUpdateRow("up-to-date", check({ install: "managed" })).label).toBe("Kept up to date for you");
  });

  it("points a desktop app with a newer signed release at the download page", () => {
    const desktop = check({ install: "desktop", available: true, latest: "0.1.150", releaseUrl: "https://dusk.bot/download" });
    expect(serverCheckPhase(desktop, "0.1.141")).toBe("available");
    expect(serverUpdateRow("available", desktop)).toEqual({ label: "Version 0.1.150 available (release notes)", subtitle: "Download it from dusk.bot/download" });
  });

  it("reports a failed check plainly", () => {
    expect(serverUpdateRow("error", null)).toEqual({ label: "Couldn't check for updates. Try again." });
  });
});

describe("the update row for another server the app shows", () => {
  const npm = check({ current: "0.1.116", install: "npm", available: true, latest: "0.1.127", command: "npm install -g duskbot@latest", restart: true });

  it("says whose update it is, and that whoever runs that server installs it", () => {
    expect(serverUpdateRow("available", npm, "0.1.116", "Office Mac")).toEqual({
      label: "Office Mac can update to 0.1.127",
      subtitle: "Whoever runs that server updates it with: npm install -g duskbot@latest, then restarts it",
    });
    const docker = check({ available: true, latest: "0.1.127", command: "docker compose pull dusk && docker compose up -d", restart: false });
    expect(serverUpdateRow("available", docker, "0.1.116", "Office Mac").subtitle).toBe(
      "Whoever runs that server updates it with: docker compose pull dusk && docker compose up -d",
    );
    expect(serverUpdateRow("up-to-date", check({ current: "0.1.127" }), "0.1.127", "Office Mac")).toEqual({
      label: "Office Mac is up to date",
      subtitle: "v0.1.127",
    });
  });

  it("keeps the rows of servers updated for their owner, and the row of this computer", () => {
    expect(serverUpdateRow("up-to-date", check({ install: "desktop" }), "0.1.116", "Office Mac").label).toBe(
      "Updates come from the Metal app on the computer these bots run on",
    );
    expect(serverUpdateRow("up-to-date", check({ install: "managed" }), "0.1.116", "Office Mac").label).toBe("Kept up to date for you");
    expect(serverUpdateRow("available", npm, "0.1.116", null).label).toBe("Version 0.1.127 available (release notes)");
  });

  it("says it in German too", () => {
    setLocale("de");
    try {
      expect(serverUpdateRow("available", npm, "0.1.116", "Office Mac")).toEqual({
        label: "Office Mac kann auf 0.1.127 aktualisiert werden",
        subtitle: "Wer diesen Server betreibt, aktualisiert ihn mit: npm install -g duskbot@latest und startet ihn danach neu",
      });
    } finally {
      setLocale("en");
    }
  });
});
