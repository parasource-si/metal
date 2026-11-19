import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EngineSetup, EngineUpdateNotice, installCommandFor, needsCli, needsSignIn } from "./EngineSetup";
import { StoreProvider, type InstanceInfo } from "@/state/store";

afterEach(() => vi.unstubAllGlobals());

it("chooses the server installer even when the client has a different OS", () => {
  vi.stubGlobal("window", { duskDesktop: { platform: "win32" } });
  expect(installCommandFor({ platform: "linux", command: { linux: "linux-install", win32: "windows-install" } })).toBe("linux-install");
  expect(installCommandFor({ platform: "linux", command: { win32: "windows-only" } })).toBeNull();
});

function instance(snapshot: InstanceInfo["snapshot"]): InstanceInfo {
  return {
    instanceId: "kimi",
    driverKind: "kimiAgent",
    displayName: "Kimi",
    models: { default: "kimi-code/k3", options: [] },
    snapshot,
  };
}

describe("needsCli / needsSignIn", () => {
  it("treats a missing binary as a CLI install, not a sign-in", () => {
    const missing = instance({ state: "unavailable", reason: "`kimi` CLI not found" });
    expect(needsCli(missing)).toBe(true);
    expect(needsSignIn(missing)).toBe(false);
  });

  it("lets Custom inject run when the CLI is installed but unsigned-in", () => {
    const unsigned = instance({ state: "available", authenticated: false, version: "0.36.1" });
    expect(needsCli(unsigned)).toBe(false);
    expect(needsSignIn(unsigned)).toBe(true);
  });

  it("is ready for inject when the CLI is present", () => {
    const ready = instance({ state: "available", authenticated: true, version: "0.36.1" });
    expect(needsCli(ready)).toBe(false);
    expect(needsSignIn(ready)).toBe(false);
  });
});

describe("managed engine setup errors", () => {
  function managed(snapshot: InstanceInfo["snapshot"]): InstanceInfo {
    return {
      ...instance(snapshot),
      instanceId: "antigravity",
      driverKind: "antigravityAgent",
      displayName: "Antigravity",
      install: { managed: { label: "install official Antigravity", downloadBytes: 1024 } },
    };
  }

  function render(engine: InstanceInfo): string {
    vi.stubGlobal("window", { duskDesktop: { platform: "darwin" } });
    return renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: engine })));
  }

  it("shows profile failures without claiming the runtime is missing", () => {
    const reason = "Cannot write Antigravity profile settings (EACCES).";
    const engine = managed({ state: "unavailable", reason });
    const markup = render(engine);
    expect(markup).toContain(reason);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("install official Antigravity");
    expect(markup).not.toMatch(/CLI not found|Not installed/);
  });

  it("renders an initialization failure reported by the snapshot", () => {
    const engine = managed({ state: "unavailable", reason: "initialize timed out." });
    expect(render(engine)).toContain("initialize timed out.");
  });

  it("wraps long Antigravity profile paths inside the setup panel", () => {
    const reason = `/home/dusk/.duskbot/providers/antigravity/${"provider-config-".repeat(5)}settings.json`;
    const snapshots = [
      { state: "unavailable" as const, reason },
      { state: "unavailable" as const, authenticationUnavailableReason: reason },
    ];
    for (const snapshot of snapshots) {
      const markup = render(managed(snapshot));
      expect(markup).toContain(reason);
      expect(markup).toContain("[overflow-wrap:anywhere]");
    }
  });

  it("preserves the installed engine's sign-in flow", () => {
    const engine = managed({ state: "available", authenticated: false, version: "1.1.1" });
    const markup = render(engine);
    expect(markup).toContain("Sign in with Google");
    expect(markup).not.toContain("install official Antigravity");
  });
});

describe("engines set up with a key in Settings", () => {
  it("takes the base URL and the key right in the card, never sending the person to Settings", () => {
    vi.stubGlobal("window", { duskDesktop: { platform: "darwin" } });
    const engine: InstanceInfo = {
      ...instance({ state: "unavailable", reason: "No API key: open Settings → API keys." }),
      instanceId: "openaiCompat",
      driverKind: "openai-compat",
      displayName: "Other (OpenAI-compatible)",
      install: { docsUrl: "https://openrouter.ai/keys", settings: "connections" },
    };
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: engine })));
    expect(markup).toContain("Connect Other (OpenAI-compatible)");
    expect(markup).toContain("Paste its address, and its key if it has one");
    expect(markup).not.toContain("needs an API key");
    expect(markup).toContain('aria-label="OpenAI-compatible base URL"');
    expect(markup).toContain('data-key-row="openaiCompat"');
    expect(markup).not.toContain("Open API keys");
    expect(markup).not.toContain("settings → API keys");
    expect(markup).not.toContain("Open install in Terminal");
    expect(markup).not.toContain("config.json");
  });

  it("still offers the install when a key engine's own CLI is missing, and the key once it is installed", () => {
    vi.stubGlobal("window", { duskDesktop: { platform: "darwin" } });
    const dsh = (snapshot: InstanceInfo["snapshot"]): InstanceInfo => ({
      ...instance(snapshot),
      instanceId: "deepseek",
      driverKind: "deepseekAgent",
      displayName: "DeepSeek Harness",
      install: {
        command: { linux: "npm install -g @deepseek-ai/dsh", darwin: "npm install -g @deepseek-ai/dsh", win32: "npm install -g @deepseek-ai/dsh" },
        docsUrl: "https://github.com/deepseek-ai/deepseek-harness",
        needsNode: true,
        settings: "connections",
        server: { package: "@deepseek-ai/dsh" },
      },
    });
    const missing = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: dsh({ state: "unavailable", reason: "dsh not found" }) })));
    expect(missing).toContain("Install DeepSeek Harness here");
    expect(missing).not.toContain("npm install -g @deepseek-ai/dsh");
    expect(missing).not.toContain("needs an API key");
    const keyless = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: dsh({ state: "available", authenticated: false, version: "0.2.1" }) })));
    expect(keyless).toContain("DeepSeek Harness needs an API key");
    expect(keyless).toContain('data-key-row="deepseek"');
    expect(keyless).not.toContain("Terminal");
    // No key is saved, so nothing was rejected.
    expect(keyless).not.toContain("rejected the saved key");
  });
});

describe("install from Settings on the server", () => {
  function npmEngine(snapshot: InstanceInfo["snapshot"], server = true): InstanceInfo {
    return {
      ...instance(snapshot),
      install: {
        command: { linux: "npm install -g kimi-fixture", darwin: "npm install -g kimi-fixture", win32: "npm install -g kimi-fixture" },
        needsNode: true,
        signInCommand: "kimi login",
        ...(server ? { server: { package: "kimi-fixture" } } : {}),
      },
    };
  }
  function render(engine: InstanceInfo): string {
    vi.stubGlobal("window", { duskDesktop: { platform: "linux" } });
    return renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: engine })));
  }

  it("offers one click on the computer the bots run on, with no terminal command anywhere", () => {
    const markup = render(npmEngine({ state: "unavailable", reason: "`kimi` CLI not found" }));
    expect(markup).toContain("Install Kimi here");
    expect(markup).toContain("installs Kimi on the computer your bots run on");
    for (const line of ["Prefer a terminal?", "npm install", "Terminal", "check again", "CLI path", "View setup guide", "Requires Node.js"]) expect(markup).not.toContain(line);
  });

  it("installs a vendor-script AI like Cursor the same way, never showing its installer", () => {
    const curl = "curl https://cursor.com/install -fsS | bash";
    const markup = render({
      ...instance({ state: "unavailable", reason: "`cursor-agent` CLI not found" }),
      instanceId: "cursor", driverKind: "cursorAgent", displayName: "Cursor",
      install: { command: { linux: curl, darwin: curl }, docsUrl: "https://cursor.com/docs/cli/installation", signInCommand: "cursor-agent login", server: { script: true } },
    });
    expect(markup).toContain("Install Cursor here");
    for (const line of [curl, "cursor.com/install", "Copy command", "Check again", "settings → model providers", "View setup guide", "Install it and sign in"]) expect(markup).not.toContain(line);
  });

  it("keeps a quiet setup's probe reason behind Details, in plain grey, never as an alert", () => {
    vi.stubGlobal("window", { duskDesktop: { platform: "linux" } });
    const reason = "`kimi` isn't installed yet: the probe timed out.";
    const engine = npmEngine({ state: "unavailable", reason });
    const quiet = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: engine, quiet: true })));
    expect(quiet).toMatch(/<details data-engine-setup-reason="true" class="[^"]*text-ink-tertiary"><summary[^>]*>Details<\/summary><p[^>]*>`kimi` isn&#x27;t installed yet/);
    expect(quiet).not.toContain('role="alert"');
    expect(quiet).not.toContain("text-danger");
    expect(quiet).toContain("Install Kimi here");
    expect(render(engine)).toMatch(/role="alert" class="[^"]*text-danger">`kimi` isn&#x27;t installed yet/);
  });

  it("shows an AI that isn't installed yet as a plain setup card, with no error before anyone has tried", () => {
    const markup = render(npmEngine({ state: "unavailable", reason: "`kimi` CLI not found" }, false));
    expect(markup).toContain("Set up Kimi");
    expect(markup).not.toContain("CLI not found");
    expect(render(npmEngine({ state: "unavailable", reason: "`kimi` isn't installed, or isn't on this app's PATH." }, false))).not.toContain("text-danger");
    expect(markup).not.toContain("text-danger");
  });

  it("says in one plain line when it can't install here, with no command to copy", () => {
    const markup = render(npmEngine({ state: "unavailable", reason: "`kimi` CLI not found" }, false));
    expect(markup).not.toContain("Install Kimi here");
    expect(markup).toContain("can&#x27;t install Kimi on this computer");
    expect(markup).not.toContain("npm install");
    expect(markup).not.toContain("<button");
  });

  it("offers the vendor's own build on a machine without Node.js, and drops the Node.js line", () => {
    const opencode = (server?: NonNullable<InstanceInfo["install"]>["server"]): InstanceInfo => ({
      ...instance({ state: "unavailable", reason: "`opencode` CLI not found" }),
      instanceId: "opencode",
      driverKind: "opencodeGo",
      displayName: "OpenCode",
      install: {
        command: { linux: "npm install -g opencode-ai", darwin: "npm install -g opencode-ai", win32: "npm install -g opencode-ai" },
        needsNode: true,
        ...(server ? { server } : {}),
      },
    });
    const standalone = render(opencode({ standalone: { version: "1.19.4", downloadBytes: 79_667_571 } }));
    expect(standalone).toContain("Install OpenCode here");
    expect(standalone).not.toContain("Requires Node.js");
    // No npm on the server, so no npm command to paste into a terminal.
    expect(standalone).not.toContain("npm install -g opencode-ai");
    // Decimal megabytes, as macOS and Windows show file sizes: 79,667,571 bytes is about 80 MB.
    expect(standalone).toContain("About 80 MB download");
    expect(render(opencode({ standalone: { version: "1.19.4", downloadBytes: 64_291_659 } }))).toContain("About 64 MB download");
    const withNpm = render(opencode({ standalone: { version: "1.19.4", downloadBytes: 79_667_571 }, package: "opencode-ai" }));
    expect(withNpm).not.toContain("Prefer a terminal?");
    expect(withNpm).not.toContain("npm install -g opencode-ai");
    const neither = render(opencode());
    expect(neither).not.toContain("Install OpenCode here");
    expect(neither).not.toContain("Requires Node.js");
  });

  it("finishes the app's own signed-out copy in the app, never in a terminal", () => {
    const appCopy = (snapshot: InstanceInfo["snapshot"]): InstanceInfo => ({
      ...instance(snapshot),
      instanceId: "opencodeGo",
      driverKind: "opencodeGo",
      displayName: "OpenCode",
      install: {
        command: { linux: "npm install -g opencode-ai", darwin: "npm install -g opencode-ai", win32: "npm install -g opencode-ai" },
        needsNode: true,
        docsUrl: "https://opencode.ai/docs/",
        server: { standalone: { version: "1.19.4", downloadBytes: 64_291_659 } },
        appCopy: true,
      },
    });
    const markup = render(appCopy({ state: "available", authenticated: false, version: "1.19.4" }));
    expect(markup).toContain("OpenCode is installed");
    expect(markup).toContain("free models");
    expect(markup).toContain("Open API keys");
    expect(markup).toContain("Check again");
    for (const line of ["Terminal", "terminal", "one-line installer", "npm install", "Install and sign in on the computer", "sign in to OpenCode"]) {
      expect(markup).not.toContain(line);
    }
    // A remote client's Settings has no keys, so it names the computer instead of offering the button.
    vi.stubGlobal("window", { duskDesktop: { platform: "linux", remoteClient: { active: true } } });
    const remote = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: appCopy({ state: "available", authenticated: false, version: "1.19.4" }) })));
    expect(remote).toContain("on the computer running Metal");
    expect(remote).not.toContain("Open API keys");
    // Missing or broken, the app's copy is installed again from here.
    expect(render(appCopy({ state: "unavailable", reason: "`opencode` version check failed." }))).toContain("Install OpenCode here");
  });

  it("never offers an install when only sign-in is missing", () => {
    const markup = render(npmEngine({ state: "available", authenticated: false, version: "1.0.0" }));
    expect(markup).not.toContain("Install Kimi here");
    expect(markup).toContain("kimi login");
  });

  it("turns the update notice into a button when the server can update", () => {
    const update = { title: "Kimi update available", message: "Newer models need it.", command: "npm install -g kimi-fixture@latest" };
    vi.stubGlobal("window", { duskDesktop: { platform: "linux" } });
    const withServer = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineUpdateNotice, { update, instance: npmEngine({ state: "available", authenticated: true }) })));
    expect(withServer).toContain("Update Kimi here");
    expect(withServer).not.toContain("Prefer a terminal?");
    const without = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineUpdateNotice, { update, instance: npmEngine({ state: "available", authenticated: true }, false) })));
    expect(without).not.toContain("Update Kimi here");
    expect(without).toContain("npm install -g kimi-fixture@latest");
  });
});

describe("server device-code sign-in", () => {
  it("offers the distinct ChatGPT plan connection without the legacy Codex command", () => {
    vi.stubGlobal("window", { duskDesktop: { platform: "linux" } });
    const engine: InstanceInfo = {
      ...instance({ state: "available", authenticated: false, chatgptPlan: true }),
      instanceId: "chatgpt", displayName: "ChatGPT plan", driverKind: "codex",
      authentication: { method: "browser-pkce" }, install: { signInCommand: "codex login" },
    };
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: engine })));
    expect(markup).toContain("Continue with ChatGPT");
    expect(markup).toContain("separate from dusk cloud and from paying with an API key");
    expect(markup).not.toContain("codex login");
    expect(markup).not.toContain("Device-code login");
  });

  it("explains unavailable hosted plan auth without offering a broken login or install", () => {
    vi.stubGlobal("window", { duskDesktop: { platform: "linux" } });
    const engine: InstanceInfo = {
      ...instance({ state: "unavailable", authenticated: false, chatgptPlan: true, authenticationUnavailableReason: "Hosted ChatGPT plan access requires approval." }),
      instanceId: "chatgpt", displayName: "ChatGPT plan", driverKind: "codex",
      authentication: { method: "browser-pkce" }, install: { command: { linux: "npm install -g @openai/codex" }, signInCommand: "codex login" },
    };
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: engine })));
    expect(markup).toContain("Hosted ChatGPT plan access requires approval.");
    expect(markup).not.toContain("Continue with ChatGPT");
    expect(markup).not.toContain("npm install");
    expect(markup).not.toContain("codex login");
  });

  it("uses the supported browser sign-in flow instead of asking a remote user to run a command", () => {
    vi.stubGlobal("window", { duskDesktop: { platform: "linux" } });
    const engine: InstanceInfo = {
      ...instance({ state: "available", authenticated: false }),
      instanceId: "codex",
      driverKind: "codexAgent",
      displayName: "Codex",
      authentication: { method: "device-code" },
      install: { signInCommand: "codex login" },
    };
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: engine })));
    expect(markup).toContain("Connect ChatGPT");
    expect(markup).toContain("no terminal or password sharing");
    expect(markup).not.toContain("codex login");
  });

  it("does not ask to sign in when installing a CLI for local-model injection", () => {
    vi.stubGlobal("window", { duskDesktop: { platform: "linux" } });
    const engine: InstanceInfo = {
      ...instance({ state: "available", authenticated: false }),
      authentication: { method: "device-code" },
      install: { command: { linux: "npm install -g @openai/codex" }, signInCommand: "codex login" },
    };
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: engine, intent: "inject" })));
    expect(markup).not.toContain("Connect ChatGPT");
    expect(markup).not.toContain("npm install");
  });
});

describe("API-key engine setup", () => {
  function keyEngine(driverKind: string, snapshot: InstanceInfo["snapshot"]): InstanceInfo {
    return { ...instance(snapshot), instanceId: driverKind, driverKind, displayName: "Grok (API)", access: "api", install: { docsUrl: "https://console.x.ai" } };
  }
  const render = (engine: InstanceInfo, duskDesktop: Record<string, unknown> = { platform: "darwin" }) => {
    vi.stubGlobal("window", { duskDesktop });
    return renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: engine })));
  };

  it("takes a missing key in place, in the same key row as Settings, not in a config file", () => {
    const html = render(keyEngine("grok", { state: "unavailable", reason: "No xAI API key: open Settings → API keys." }));
    expect(html).toContain("data-engine-setup-api-key");
    expect(html).toContain("Grok (API) needs an API key");
    expect(html).toContain("Paste it here. It saves and checks itself");
    expect(html).toContain('data-key-row="xai"');
    expect(html).not.toContain("Open API keys");
    expect(html).not.toContain("config.json");
  });

  it("says so in the key row when the provider rejected the saved key", () => {
    const html = render(keyEngine("grok", { state: "available", authenticated: false, reason: "The provider rejected this key." }));
    expect(html).toContain("data-engine-setup-api-key");
    expect(html).toContain("Didn&#x27;t work: The provider rejected this key.");
    expect(render(keyEngine("grok", { state: "unavailable" }))).not.toContain("rejected");
  });

  it("still sends an engine with no key row of its own to Settings → API keys", () => {
    const html = render(keyEngine("openai-compat", { state: "unavailable" }));
    expect(html).toContain("Open API keys");
    expect(html).not.toContain("data-key-row");
  });

  it("has no button on a remote client, whose settings hide the keys", () => {
    const html = render(keyEngine("openai-compat", { state: "unavailable" }), { platform: "darwin", remoteClient: { active: true } });
    expect(html).toContain("on the computer running Metal");
    expect(html).not.toContain("Open API keys");
  });

  it("leaves CLI engines on their install card", () => {
    expect(render(instance({ state: "unavailable", reason: "`kimi` CLI not found" }))).not.toContain("data-engine-setup-api-key");
  });
});
