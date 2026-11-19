/** single words that keep their capital wherever they appear: other companies, their products, people, places, days */
export const KEEP_WORDS: ReadonlySet<string> = new Set([
  // companies and products
  "Agentcard", "Android", "AssemblyAI", "Cartesia", "Deepgram", "Whisper", "Anthropic", "Antigravity", "Apple", "Azure", "Bionic", "Caddy", "Cerebras", "Chatterbox", "Chrome",
  "Claude", "Clef", "Cloudflare", "Codex", "Copilot", "Composio", "Cua", "Cursor", "Debian", "Discord", "Docker", "Dropbox", "Electron", "Entra", "Firefox",
  "Foundry", "Gemini", "Gmail", "GitHub", "Google", "Greenference", "Grok", "Groq", "Jev", "Kimi", "Linux", "Mac", "Markdown",
  "Mermaid", "Meta", "Metal", "Microsoft", "Mistral", "Moonshot", "Muse", "Node", "Notion", "Ollama", "OpenClaw", "Outlook", "Pi", "Podman",
  "PowerShell", "Qwen", "Reddit", "Safari", "Slack", "Stripe", "Tailscale", "Telegram", "Terminal", "Twitter", "Ubuntu",
  "Unsloth", "Venice", "Vercel", "Wayland", "Whop", "Windows", "Windsurf", "Xorg", "Accessibility", "Downloads", "Applications",
  // people and places
  "Karan", "Bansal", "Europe", "Lisbon",
  // days, months, languages
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
  "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December",
  "English", "Japanese", "German", "French", "Spanish", "Italian", "Portuguese", "Russian", "Polish", "Turkish", "Ukrainian",
  "Vietnamese", "Chinese", "Korean", "Hindi",
  "Halloween",
]);

/** names of more than one word, or words that are only a name in one context */
export const KEEP_PHRASES: readonly string[] = [
  "System Settings → Privacy & Security → Microphone", "System Settings → Keyboard", "System Settings", "Privacy & Security",
  "Screen Recording", "Speech Recognition", "Microphone and Speech Recognition", "Dictation in System Settings → Keyboard", "Dictation in System Settings",
  "Authorization: Bearer", "Authorization, with Bearer", "Gmail, Calendar",
  "Home Screen", "App Store", "Google Play", "Apple Pay", "Google Pay", "G Pay", "Mac mini",
  "Dusk account", "Dusk companion", "Claude Code", "Hermes Agent", "Kimi Code", "Fish Audio", "LM Studio", "Google AI Studio", "Hacker News", "Vercel AI Gateway",
  "Cloudflare Workers AI", "OpenCode Zen, Go", "OpenCode Zen and Go", "DeepSeek Harness", "Grok Imagine", "Muse Wonder", "Wispr Flow",
  "Cua Driver", "VS Code", "Node.js", "Wi-Fi", "Gmail, Calendar or Drive", "Outlook, Calendar or OneDrive", "Google Drive",
  "1Password", "AirPods Pro", "Google Calendar", "Google Sheets", "Google Docs", "Google Meet", "Microsoft Teams", "X Developer",
];

/** whole strings left alone: the remote desktop's key caps, drawn as keys, and the viewer's line that starts with noVNC's own name */
export const EXEMPT_KEYS: readonly RegExp[] = [/^desktopViewer\.key/, /^desktopViewer\.notice$/];

const PROTECT = new RegExp([
  "\\{[^}]*\\}",                                   // placeholders
  "`[^`]*`",                                       // code
  "\\b(?:https?|wss?|file)://[^\\s)]+",            // links
  "[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+",              // emails
  "~?[\\w.-]*/[\\w./~*-]+",                        // paths
  "\\b[\\w-]+\\.(?:md|json|js|mjs|ts|tsx|py|sh|txt|csv|tsv|png|jpe?g|webp|gif|pdf|zip|yaml|yml|toml|env|app|exe|dmg|log)\\b", // file names
  "\\b[A-Z][A-Za-z]*(?:[+–][A-Z][\\w/]*)+",        // key combos: Shift+Enter, Ctrl–Alt–Del
  ...[...KEEP_PHRASES].sort((a, b) => b.length - a.length).map((phrase) => phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
].join("|"), "g");

const WORD = /[A-Za-z][A-Za-z'’]*/g;

function caseWord(word: string): string {
  const base = word.replace(/['’]s$/, "");
  if (KEEP_WORDS.has(base)) return word;
  if (/^I(['’][a-z]+)?$/.test(word) || word === "A") return word.toLowerCase();
  if (/^[A-Z][a-z]+(['’][a-z]+)?$/.test(word)) return word.toLowerCase();
  return word;
}

function caseRun(text: string): string {
  return text
      .replace(/\b([A-Z])-([A-Z][a-z]+)\b/g, (whole, letter: string, rest: string) => (KEEP_WORDS.has(rest) ? whole : `${letter.toLowerCase()}-${rest.toLowerCase()}`))
    .replace(WORD, caseWord);
}

/** Normalize copy before restoring sentence capitalization and keeping product names as written. */
export function brandCase(text: string): string {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(PROTECT)) {
    out += caseRun(text.slice(last, match.index)) + match[0];
    last = match.index + match[0].length;
  }
  return out + caseRun(text.slice(last));
}

export function brandCaseEntry(key: string, value: string): string {
  return EXEMPT_KEYS.some((pattern) => pattern.test(key)) ? value : brandCase(value);
}

/** the pieces the app fills into the middle of another line ("on a live call from {device}", "your {list}", "turn {name} {state}");
 * they stay lowercase so the line around them reads as one sentence. Everything else starts with a capital. */
const FRAGMENT_KEYS = new RegExp(`^(${[
  "chat\\.event\\.(and|andMore|for|peerReplied)", "approval\\.voice\\.action\\w+", "helperIntro\\.followup\\.(botsNone|botOne|bots|routinesNone|routineOne|routines|more)",
  "call\\.live\\.device\\.\\w+", "vm\\.confirm\\.orphanVps", "vm\\.idle\\.minutes", "mcp\\.state\\.(on|off)", "sidebar\\.preview\\.aBot",
  "vpsLink\\.yourServer", "mobile\\.connection\\.your(Cloud|Computer)", "mobile\\.entry\\.legalAnd", "remote\\.client\\.fallbackName", "remote\\.time\\.justNow", "app\\.sentFrom", "botAccess\\.(theAdmins|folder\\.home)",
  "browser\\.panel\\.tab", "cloudBuy\\.team\\.unnamed", "bring\\.topic\\w+", "cloudTrial\\.yourPlan",
  "room\\.(hint|responder)\\.leadFallback", "call\\.questionOptions", "inbox\\.recommendedInline", "activity\\.(approvalIn|to)", "files\\.countMore", "voice\\.provider",
  "botMove\\.memory", "teamShare\\.skip\\.\\w+", "inbox\\.(in|via)", "model\\.variant\\.(unverified|unavailable)", "vpsLink\\.device\\.\\w+",
  "automations\\.(time|source|skip)\\.\\w+", "automations\\.app\\.(from|about|labeled|mentioning|in)", "cloudSetup\\.ready\\.(today|tomorrow)",
  "connectApps\\.account\\.fallback", "automations\\.does\\.default", "cloudBuy\\.big\\.perMonth(Trial)?",
  "server\\.(runs\\.state|incidents\\.where|reports\\.(when|why))\\.\\w+",
  "server\\.(connect\\.thisApp|rooms\\.sameName\\.chief|teammates\\.(room|handedWork)|mcp\\.card\\.(newKey|newClientSecret))",
].join("|")})$`);

export function isFragment(key: string): boolean {
  return FRAGMENT_KEYS.test(key);
}

/** lowercase words a string may start with: other companies' own lowercase names and commands typed as written */
export const LOWERCASE_STARTS: readonly string[] = ["dusk cloud", "npm", "pnpm", "npx", "noVNC", "iPhone", "iPad", "iOS", "macOS", "x.com", "e.g."];

const ABBREVIATION_BEFORE = /\b(?:e\.g|i\.e|etc|vs|approx)\.\s*$/i;

/** capitalises the first letter of each sentence, and the pronoun I; names, placeholders, code, links and "dusk" stay as they are */
export function sentenceCase(text: string): string {
  const spans = [...text.matchAll(PROTECT)].map((m) => [m.index as number, (m.index as number) + m[0].length] as const);
  const protectedAt = (index: number) => spans.some(([from, to]) => index >= from && index < to);
  const chars = text.split("");
  const starts = [0];
  // the sentence after a filled-in reason: "could not load: {reason} please try again"
  for (const m of text.matchAll(/\{(?:reason|detail|error|message|why)\}\s+/g)) starts.push((m.index as number) + m[0].length);
  // a new paragraph starts a sentence too ("...wrong:\n\n{text}\n\nWhat was wrong with it:")
  for (const m of text.matchAll(/\n\s*\n\s*/g)) starts.push((m.index as number) + m[0].length);
  for (const m of text.matchAll(/[.!?]["”’)]*\s+/g)) {
    const at = (m.index as number) + m[0].length;
    if (!ABBREVIATION_BEFORE.test(text.slice(0, at))) starts.push(at);
  }
  for (const start of starts) {
    const lead = text.slice(start).match(/^[“"'([]*/)?.[0].length ?? 0;
    const at = start + lead;
    if (protectedAt(at)) continue;
    const word = text.slice(at).match(/^[a-z][a-z'’]*(?![A-Za-z0-9_@/]|:\S)/)?.[0];
    if (!word || word === "dusk" || LOWERCASE_STARTS.some((start) => text.startsWith(start, at))) continue;
    chars[at] = chars[at].toUpperCase();
  }
  const out = chars.join("");
  let result = "";
  let last = 0;
  const pronoun = (run: string) => run.replace(/\bi(?=['’][a-z]+\b|(?![\w.'’]))/g, "I");
  for (const [from, to] of spans) {
    result += pronoun(out.slice(last, from)) + out.slice(from, to);
    last = to;
  }
  return result + pronoun(out.slice(last));
}

/** a chat button named inside a sentence ("tap Take over and tick the box") keeps the capital it has on the button */
export const QUOTED_BUTTONS: readonly string[] = ["Take over", "Take control", "Hand control back", "I'm done", "Skip", "Open", "Try again", "Manage subscription"];
const QUOTED_BUTTON = new RegExp(`(?<![\\w'’])(?:${[...QUOTED_BUTTONS].sort((a, b) => b.length - a.length).map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\w'’])`, "g");

/** the policy for one English entry: sentence case everywhere (labels, buttons, titles, messages), other companies' names keep
 * their own case, "dusk cloud" stays lowercase, and the fragments filled into another line stay lowercase */
export function entryCase(key: string, value: string): string {
  if (EXEMPT_KEYS.some((pattern) => pattern.test(key))) return value;
  if (isFragment(key)) return brandCase(value);
  // the names are held as placeholders while the rest is cased, so they come back exactly as written
  const names: string[] = [];
  const held = value.replace(QUOTED_BUTTON, (name) => `{\u0000${names.push(name) - 1}}`);
  // oxlint-disable-next-line no-control-regex -- the NUL marks a held button name no catalog string can contain
  return sentenceCase(brandCase(held)).replace(/\{\u0000(\d+)\}/g, (_, index: string) => names[Number(index)]!);
}

/** whether a string a person reads starts the way the rule asks: a capital, or a placeholder, a number, punctuation, a known
 * lowercase name or anything that isn't Latin text */
export function startsRight(value: string): boolean {
  const text = value.trimStart();
  if (LOWERCASE_STARTS.some((start) => text.startsWith(start))) return true;
  // a first word with a capital, a digit or code inside it is a name or typed text ("xAI", "s2.1-pro", "you@example.com")
  if (/^[“"'([]*[a-z][^\s]*[A-Z0-9@/.]/.test(text)) return true;
  return !/^[“"'([]*[a-z]/.test(text);
}
