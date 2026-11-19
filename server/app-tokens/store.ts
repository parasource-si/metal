// Token apps' credentials, sealed under a key of their own (a 0600 file beside the store), like the email store.
// Security: no route, card, bot or log gets a token back; the box hides the data folder from every bot's shell.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { TOKEN_APPS, type TokenAccountView, type TokenAppId } from "../../shared/app-tokens.ts";
import { writeFileAtomic } from "../atomic.ts";
import { decryptBrowserState, encryptBrowserState } from "../browser-sites.ts";

export const APP_TOKENS_FILE = "app-tokens.json.enc";
export const APP_TOKENS_KEY_FILE = "app-tokens-key";
export const MAX_TOKEN_ACCOUNTS = 40;

const appIds = TOKEN_APPS.map((app) => app.id) as [TokenAppId, ...TokenAppId[]];
const accountSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{16}$/u),
  app: z.enum(appIds),
  label: z.string().min(1).max(120),
  server: z.string().min(1).max(32),
  fields: z.record(z.string(), z.string().max(4_096)),
  /** api apps: the bearer Metal's own MCP endpoint asks of the server entry. */
  mcpKey: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  /** Unix ms when `fields.token` stops working; a device sign-in refreshes it before then. */
  expiresAt: z.number().optional(),
  via: z.enum(["token", "device"]),
  connectedAt: z.number(),
  /** The app refused this sign-in (expired, revoked or a dead refresh token); only a reconnect helps. */
  needsReconnect: z.literal(true).optional(),
});
const fileSchema = z.object({ version: z.literal(1), accounts: z.array(accountSchema).max(MAX_TOKEN_ACCOUNTS) });

export type TokenAccount = z.infer<typeof accountSchema>;
type StoreFile = z.infer<typeof fileSchema>;
const EMPTY: StoreFile = { version: 1, accounts: [] };

export const accountView = (account: TokenAccount): TokenAccountView => ({
  id: account.id, app: account.app, label: account.label, server: account.server, via: account.via,
  connectedAt: new Date(account.connectedAt).toISOString(),
  ...(account.needsReconnect ? { needsReconnect: true } : {}),
});

export class TokenStore {
  private readonly file: string;
  private readonly keyFile: string;
  private cache: StoreFile | null = null;

  constructor(dataDir: string) {
    this.file = join(dataDir, APP_TOKENS_FILE);
    this.keyFile = join(dataDir, APP_TOKENS_KEY_FILE);
  }

  private key(create: boolean): string | null {
    try {
      const existing = readFileSync(this.keyFile, "utf8").trim();
      if (/^[0-9a-f]{64}$/u.test(existing)) return existing;
    } catch {}
    if (!create) return null;
    const key = randomBytes(32).toString("hex");
    mkdirSync(dirname(this.keyFile), { recursive: true });
    writeFileAtomic(this.keyFile, `${key}\n`, { mode: 0o600 });
    return key;
  }

  private read(): StoreFile {
    if (this.cache) return this.cache;
    let data = EMPTY;
    if (existsSync(this.file)) {
      try {
        const key = this.key(false);
        if (!key) throw new Error("missing key");
        data = fileSchema.parse(JSON.parse(decryptBrowserState(readFileSync(this.file), key)));
      } catch {
        // never log an unreadable file's contents
        console.warn("App tokens: the saved tokens could not be opened; connect those apps again");
      }
    }
    this.cache = data;
    return data;
  }

  private write(accounts: TokenAccount[]): void {
    const parsed = fileSchema.parse({ version: 1, accounts });
    if (!parsed.accounts.length) {
      this.cache = EMPTY;
      rmSync(this.file, { force: true });
      return;
    }
    const key = this.key(true)!;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, encryptBrowserState(JSON.stringify(parsed), key), { mode: 0o600 });
    this.cache = parsed;
  }

  list(): readonly TokenAccount[] {
    return this.read().accounts;
  }

  get(id: string): TokenAccount | null {
    return this.list().find((account) => account.id === id) ?? null;
  }

  put(account: TokenAccount): void {
    this.write([...this.list().filter((other) => other.id !== account.id), account]);
  }

  remove(id: string): TokenAccount | null {
    const gone = this.get(id);
    if (gone) this.write(this.list().filter((account) => account.id !== id));
    return gone;
  }

  /** Every saved secret, for the transcript scrubber. */
  secretValues(): string[] {
    return this.list().flatMap((account) => [account.fields.token, account.fields.refresh, account.mcpKey]).filter((value): value is string => Boolean(value));
  }
}
