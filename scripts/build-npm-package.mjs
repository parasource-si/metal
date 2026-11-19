// Assemble the Metal server package with the built UI, bundled skills and CLI.
//
//   pnpm build:server && pnpm exec vite build && node scripts/build-npm-package.mjs
//   cd release/npm && npm pack
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "release", "npm");
const app = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

for (const required of ["dist-server/index.js", "dist-server/metal.js", "dist/index.html"]) {
  if (!existsSync(join(root, required))) {
    console.error(`missing ${required}: run \`pnpm build:server && pnpm exec vite build\` first`);
    process.exit(1);
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, "dist-server"), join(out, "dist-server"), { recursive: true });
cpSync(join(root, "dist"), join(out, "dist"), { recursive: true });
if (existsSync(join(root, "skills"))) cpSync(join(root, "skills"), join(out, "skills"), { recursive: true });
cpSync(join(root, "LICENSE"), join(out, "LICENSE"));
cpSync(join(root, "docs", "LICENSING.md"), join(out, "LICENSING.md"));
cpSync(join(root, "third_party", "openmausbot"), join(out, "licenses"), { recursive: true });

// The bin lives next to the bundle so serverEntry() finds index.js by path.
writeFileSync(join(out, "cli.js"), `#!/usr/bin/env node\nimport "./dist-server/metal.js";\n`);

writeFileSync(
  join(out, "package.json"),
  JSON.stringify(
    {
      name: "@parasource-si/metal",
      private: true,
      version: app.version,
      description: "Run the Metal server anywhere and pair your devices to it",
      license: "SEE LICENSE IN LICENSE",
      type: "module",
      bin: { metal: "cli.js", duskbot: "cli.js" },
      // Never bundled, so npm installs them beside the server: DuckDB,
      // resvg and node-datachannel (the direct screen path) are native addons
      // that npm picks per platform from their optional packages (linux x64
      // and arm64 included), and the 1Password SDK reads its WebAssembly core
      // from beside itself.
      dependencies: {
        "@1password/sdk": app.dependencies["@1password/sdk"],
        "@duckdb/node-api": app.dependencies["@duckdb/node-api"],
        "@resvg/resvg-js": app.dependencies["@resvg/resvg-js"],
        "node-datachannel": app.dependencies["node-datachannel"],
      },
      // local voice: ONNX Runtime ships prebuilt binaries for some platforms only; where it fails to install, voice is off
      optionalDependencies: {
        "onnxruntime-node": app.dependencies["onnxruntime-node"],
      },
      files: ["cli.js", "dist-server", "dist", "skills", "LICENSE", "LICENSING.md", "licenses", "README.md"],
      engines: { node: ">=24" },
      repository: app.repository,
      homepage: app.homepage,
      keywords: ["metal", "agents", "self-hosted", "server"],
    },
    null,
    2,
  ) + "\n",
);

writeFileSync(
  join(out, "README.md"),
  `# Metal private server

Install the reviewed private archive supplied by your operator. Requires Node 24+.

\`\`\`sh
npm install --global --prefix "$HOME/.local" ./metal-private.tgz
"$HOME/.local/bin/metal" setup
\`\`\`

Use the installed \`metal\` command on later launches. Add
\`$HOME/.local/bin\` to PATH if needed. \`metal start\` is an alias for
the bare command. The desktop's Add your VPS flow installs this private build
through its one-time link; app and server upgrades are operator-managed.

First launch: use arrow keys and Enter (numbered choices in plain terminals) to choose
ChatGPT/Codex, Claude Code, or an API service; sign in or paste a hidden API
key; choose a model and save. Setup asks before installing a missing Codex
or Claude CLI. The saved model applies only to new bots; existing bots and
conversations keep their settings.

One optional step connects your phone, defaulting to Skip for now. Choose
an explicitly approved managed public HTTPS endpoint protected by pairing,
existing Tailscale, or an HTTPS reverse proxy you already configured.
Managed access uses an upstream Dusk account and asks permission for
the public endpoint and possible connector download. The pairing page and
basic server identity are public; chat and settings require pairing.
Tailscale must already be installed and signed in on both devices.

After the HTTPS connection is checked, scan the QR with your phone. When
you pair an Android phone the QR is an app link, so scan it inside the
Metal app; the web address is printed beside it if you would rather
use a browser. On iPhone or iPad, scan with Camera for Safari, or use the
app's own scanner. Choose Connect on the phone; scanning alone is not a
completed pairing. Codes
are private, single-use, and expire after five minutes. Guided phone
access permits chat and approvals, not settings or pairing administration.
Localhost and a bare LAN address cannot connect your phone to this server.

Later launches reuse your saved choices and open Metal on this computer.
Keep the terminal open: this is a foreground server, not a background
service. Ctrl-C stops the server without deleting saved work. Automatic
browser opening uses only the local address; it is skipped for SSH and
headless sessions, and can be disabled with \`--no-open\`.

\`\`\`sh
metal setup          # reconfigure AI and optional phone access; not a reset
metal --no-open       # do not open a browser
metal --local         # ignore saved remote access for this launch
metal --no-pair       # suppress phone prompts and invitations
metal pair           # another phone while the HTTPS server is running
metal sessions       # list devices; sessions revoke ID signs one out
metal serve          # no onboarding prompts; explicit remote flags for services
metal vps status     # Linux service, link, computers and host resources
metal vps doctor    # status with suggested next steps
metal vps logs --service link --lines 100
\`\`\`

Stop an existing server before reconfiguring or changing access mode.
\`--local\` preserves your saved choice for next time. \`--no-pair\` does not
turn off saved remote access; use \`--local\` for that on a new launch.
With a custom \`--data-dir\` or \`--port\`, keep using those options when
starting and pairing.

API services include OpenAI, OpenRouter, Groq, and compatible
endpoints.
API connections currently support chat only. Setup asks before a short,
potentially billable API test; native setup confirms sign-in, with model
access checked when you send a message. API billing is separate from
ChatGPT/Claude subscriptions. New API keys in config.json and managed
account credentials in tunnel-account.json are plaintext, not encrypted,
with owner-only permissions (0600 on Unix). Keep these files private.

Ctrl-C before saving AI setup leaves its pending Metal changes unapplied.
During the later phone step, it keeps the AI setup already saved and exits
without starting a server. Completed installs and sign-ins remain; run
\`metal setup\` to continue without deleting your data.

For a service, use \`serve --tunnel\` after \`login\` for managed HTTPS,
\`serve --tailscale\` for your tailnet, or your own reverse proxy. The
\`login\` command signs in to the upstream Dusk account used for managed HTTPS;
it does not start the tunnel itself.

Scripts, CI and other agents can drive a running workspace without a screen:
set a team up from a file, give a bot one job and wait until it and every
teammate it asked are done, and export what they made.

\`\`\`sh
metal team apply team.yaml
metal run "Room Lead" "Rehearse the launch of https://example.com" --export ./out
metal help run       # every verb: doctor, run, wait, send, export, events, team, engine, connect, mcp
\`\`\`

[Docs](https://github.com/parasource-si/metal/tree/main/docs)
· [Self-hosting](https://github.com/parasource-si/metal/blob/main/docs/self-hosting.md)
`,
);
console.log(`npm package assembled at ${out} (@parasource-si/metal@${app.version})`);
