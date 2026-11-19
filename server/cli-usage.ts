export { HEADLESS_VERBS as HEADLESS_VERB_NAMES } from "./headless/args.ts";

export const HEADLESS_USAGE = `Drive a running workspace (scripts, CI, other agents):
  metal doctor                    check the server answers and an engine is ready
  metal bots | channels | models  your bots, your rooms, the engines and their models
  metal run BOT "do this"         give a bot one job and wait until it and every teammate it asked are done
  metal send BOT "text"           send one message and return at once
  metal wait BOT                  wait on work already running
  metal messages BOT              the latest messages of a conversation
  metal interrupt BOT [--tree]    press Stop (--tree: and every teammate on its job)
  metal export BOT --out DIR      write a job's transcripts, files and screens to DIR
  metal events [--job THREAD]     the server's live events as JSON lines
  metal team apply FILE           make the workspace match a team file (team export writes one)
  metal engine set claude --key-env ANTHROPIC_API_KEY   give it an engine without a screen
  metal connect URL --code CODE --out FILE              get a token for a workspace elsewhere
  metal new-bot | new-channel | set-model | edit | mcp

  Server: --url URL (or DUSK_URL), --port N (or DUSK_PORT), else this computer's.
  Token: DUSK_TOKEN or --token-file FILE. --json prints one JSON document;
  progress goes to stderr (--quiet drops it). metal help VERB for the details.`;

export const USAGE = `Metal: your team of AI bots, ready in a few steps

  metal                         set up once, then open your workspace
  metal setup [--data-dir DIR]
  metal start [the same options as serve]
  metal serve [--port 8799] [--data-dir DIR] [--label NAME]
                    [--public-url https://host] [--tailscale | --tunnel | --domain HOST] [--no-pair]
  metal pair  [--label NAME] [--client] [--phone ios|android]
                    [--public-url https://host]
  metal sessions [revoke ID]
  metal status
  metal vps status|doctor [--port N] [--data-dir DIR] [--json]
  metal vps logs [--service server|link|fence] [--lines 100] [--json]
  metal login [--email you@example.com]
  metal logout
  metal access list | add EMAIL [--chat-only] | remove EMAIL
  metal service install [--domain HOST | --tunnel | --tailscale] [--port N] [--data-dir DIR] | uninstall
                    [--sentinel]   (the health scan below, every two minutes, instead of the server)
  metal sentinel [--data-dir DIR] [--out DIR] [--once] [--json]   (read-only health scan; see --help)
  metal browser install [--with-deps] | status | setup
  metal free-backup install [--data-dir DIR]
                    [--anthropic-key-file FILE] [--cap USD] [--memory 1G]
                  | list | users NAME add|remove EMAIL [--chat-only] | suspend NAME | resume NAME
                  | delete NAME --yes [--keep-data] | upgrade   (all take --dry-run)
                  | agent [--socket PATH] [--group USER]   (root; installed by init --operator)

setup   choose AI access and optional phone access; keep existing bots and chats
start   same as metal: use your saved settings and open the workspace
serve   starts the server without prompts and prints a pairing link + QR code
pair    mints a pairing code against a running server (--client: chat only)
sessions lists paired devices; "sessions revoke ID" signs one out
status  what the server says about itself
vps     read-only Linux VPS status, host resources, managed computers and
        bounded redacted logs, including when the server is stopped.
        Run on the VPS; no sudo, service changes or credential reads.
login   signs this machine in to a Dusk account (an emailed code)
        and reserves its public address for --tunnel
logout  releases that address and signs out
access  who may sign in with an emailed code at /pair: an address or
        @domain; --chat-only gives chat and approvals without settings.
        Takes effect at once, no restart.
service keep the server running across reboots: writes a systemd unit
        (Linux) or a launchd agent (macOS) for the same serve options and
        prints the commands that install it. Install the private
        package permanently first (see the end of this help).
browser install: the bots' browser engine (agent-browser, pinned) into the
        data dir, and Chrome for Testing into the user's browser cache.
        --with-deps also installs
        the Linux libraries Chrome needs (run as root once). Then run
        browser install as the user running serve, from that user's home.
        status: what the current user and data directory have.
        setup (Linux, as root): the libraries, plus the AppArmor profile
        Ubuntu 23.10+ needs before Chrome may use its sandbox.
free-backup install: OpenCode's own build (pinned), the free backup AI, into
        the data dir, unless an OpenCode is already installed. Run it as the
        user running serve.
--tailscale  serve over your tailnet: Tailscale terminates HTTPS and the
             link uses this machine's MagicDNS name (needs Tailscale signed in
             and HTTPS certificates enabled for the tailnet)
--tunnel     serve at a public https://c-… address through a
             Cloudflare tunnel: no domain, no proxy, no open port. Run
             \`metal login\` once on this machine first.
--domain     serve at https://HOST on your own domain: a pinned Caddy is
             downloaded once and run alongside the server, and gets the
             certificate itself. Point the domain's DNS at this machine and
             open ports 80 and 443.

--no-open   do not open a browser window
--no-pair   skip phone setup and do not print a pairing code
--local     start locally this time, ignoring saved remote-access settings

${HEADLESS_USAGE}

Install once from the private archive your operator supplies, then type
\`metal\` (add $HOME/.local/bin to PATH if needed). Node 24+ is required.
  npm install --global --prefix "$HOME/.local" ./metal-private.tgz
The desktop's Add your VPS flow installs it on a server for you.
`;
