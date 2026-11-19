// The secure credential cards request_credential adds: the card on the conversation's visible branch, settling it,
// resuming the turn it paused, and the value a paired phone sealed for this computer. No card, message or log holds the value.
import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import {
  CREDENTIAL_TARGETS,
  CUSTOM_SECRET_LABEL_MAX,
  CUSTOM_SECRET_REASON_MAX,
  CUSTOM_SECRET_TARGET,
  LOGIN_CREDENTIAL,
  SECRET_DELIVERIES,
  credentialIsConfigured,
  isCredentialTargetId,
  isPendingCredentialRequest,
  isPendingCustomSecretRequest,
  type CredentialTargetId,
  type SecretDelivery,
} from "../../shared/credential-request.ts";
import { EMAIL_CREDENTIAL, type EmailConnectAnswer, type EmailConnectRequest, type EmailServerFields } from "../../shared/email.ts";
import type { SecretRequestCardData } from "../../shared/wire.ts";
import type { AppConfig } from "../config.ts";
import { perBotLocalVmTarget, poolLocalVmTarget, SHARED_LOCAL_VM_TARGET, VM_WORKSPACE_GUEST } from "../container-computer.ts";
import { addHeldSecretScrubber } from "../redact.ts";
import { CardSealError, createCardSealer, type CardSealer } from "../card-seal.ts";
import { HeldSecrets } from "../login-store.ts";
import { SavedSecretsUnavailable, type SavedSecretStore } from "../saved-secrets.ts";
import type { SealedCardSecret } from "../../shared/saved-secrets.ts";
import { SECRET_FILE_TTL_MS, SECRET_FOLDER, SECRET_VALUE_MAX_BYTES, SecretVault, type SavedSecret, type SecretFileHome } from "../secret-vault.ts";
import type { HandedCardFile } from "../vault-move.ts";
import {
  PHONE_SECRET_PROTOCOL_VERSION,
  PhoneSecretError,
  assertPhoneSecretRequestMatches,
  phoneSecretOperationId,
  type PhoneSecretBridge,
  type PhoneSecretContext,
  type PhoneSecretSubmissionRegistry,
} from "../phone-secret.ts";
import type { BotLogins } from "../bot-logins.ts";
import { normalizeSignInSite } from "../../shared/sign-in-request.ts";
import { parseLoginFields, parseTotpField } from "../routes/logins.ts";
import type { TotpKey } from "../totp.ts";
import type { BotRecord, GroupRecord, Message, Store } from "../store.ts";
import { serverLine } from "../server-lines.ts";
import { classifyApiFailure } from "../secret-failure.ts";
import { pastedSecret, sameSecretName } from "./pasted-secret.ts";

export const phoneSecretEnvelopeSchema = z.object({
  version: z.literal(PHONE_SECRET_PROTOCOL_VERSION),
  threadId: z.string().regex(/^[\w-]{1,128}$/),
  keyId: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  deviceId: z.string().regex(/^[\w-]{1,128}$/),
  target: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/),
  requestKey: z.string().regex(/^[\w-]{1,128}$/),
  encapsulatedKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
  ciphertext: z.string().regex(/^[A-Za-z0-9_-]{23,5483}$/),
}).strict();

export interface SecretCardsDeps {
  store: Pick<Store, "activePath" | "appendMessage" | "patchMessage" | "messagesFor" | "botByThread" | "groupByThread" | "onChange">;
  cfg: AppConfig;
  botLogins: Pick<BotLogins, "credentialConfig">;
  phoneSecrets: Pick<PhoneSecretBridge, "provide" | "open">;
  phoneSecretSubmissions: PhoneSecretSubmissionRegistry;
  connectorThread(botId: string, threadId: string): { bot: BotRecord; group: GroupRecord | undefined } | null;
  answerCardNode(threadId: string, messageId: string, text: string): boolean;
  /** A newer card replaced `from`: a turn parked on it waits on `to`. */
  followCard(threadId: string, from: string, to: string): void;
  dataDir: string;
  /** Admin manages this server's models: an AI provider key cannot be saved here. */
  /** The bot's own folder a turn in this conversation writes to (on a Team Cloud, the member's or room's layer). */
  layerFolder(botId: string, threadId: string): string;
  /** The Local VM (its target key) this conversation's turn holds right now, if any. */
  turnVm(threadId: string): string | undefined;
  /** The language a line in this conversation is written in for its person (server/server-lines.ts). */
  threadLanguage?(threadId: string): string | undefined;
  /** The Email connector the mailbox card saves to: connecting proves it reads a real header before anything is kept. */
  email?: {
    connect(request: EmailConnectRequest): Promise<EmailConnectAnswer>;
    /** Why a mailbox can't be connected here, if so. */
    refusal(): string | undefined;
    /** Already connected and working. */
    connected(address: string): boolean;
    /** The person's own address, the likeliest mailbox when the bot names none. */
    profileAddress(): string | undefined;
  };
  /** The Vault a card saves to when the person keeps Save on: the bot uses it again later without a card. */
  savedSecrets?: SavedSecretStore;
  sealer?: CardSealer;
  /** Website logins typed into a login card: kept for fill_login, in the Vault or for this bot's next fills only. */
  logins?: {
    /** A saved login this bot may use already fills on this host. */
    has(botId: string, host: string): boolean;
    keep(login: { botId: string; host: string; username: string; password: string; totp: TotpKey | null; remember: boolean }): void;
  };
}

/** What the bot is told when the person answered a login card; never a value. */
export function loginCardUpdateText(site: string, outcome: "provided" | "dismissed", kept?: "vault" | "once"): string {
  return outcome === "provided"
    ? `Metal login update: the person typed their login for ${site} on the secure card${kept === "vault" ? " and saved it to their Vault, so next time no card is needed" : ", for this task only (not saved)"}. Open ${site}'s login page where you work (your browser, or Chromium on your own VPS desktop) and call fill_login: Metal types it and submits it, and you never see the password. Then check you are signed in and continue the task that paused for it. Never ask for the password in chat.`
    : `Metal login update: the person declined to give their login for ${site}. If they would rather sign in themselves, call request_sign_in; otherwise say in one line what you cannot do without it. Do not ask for it in chat.`;
}

export type SecretCards = ReturnType<typeof createSecretCards>;

const SWEEP_MS = 10 * 60 * 1000;
/** How long after the Vault hands a bot a secret its failure report can remove it. */
const ISSUED_MS = 24 * 60 * 60 * 1000;
const FAILED_MAX = 600;

/** What a saved login's refused fill changed (BotLogins.rejected). */
export type LoginRejection = { site: string; host: string; change: "removed" | "removedTotp" | "flagged" | "forgotten" };

const credentialUpdateText = (label: string, outcome: "provided" | "dismissed"): string => outcome === "provided"
  ? `Metal credential update: the user securely provided ${label}. Continue the task that paused for it. You do not receive the secret and must not ask them to paste it into chat.`
  : `Metal credential update: the user declined to provide ${label}. Continue without it if possible, or briefly explain the limitation. Do not ask them to paste it into chat.`;

/** What the bot is told a saved custom secret is, and how to use it without ever seeing or showing the value. */
export function savedSecretText(label: string, saved: SavedSecret | null, fromVault = false): string {
  if (!saved) return `The person saved ${label}, but it expired or Metal restarted before you used it. Ask again with request_credential if you still need it.`;
  const who = fromVault ? `${label} is saved in the person's Vault, so no card was needed. It is` : `The person saved ${label}`;
  if ("ref" in saved) {
    return `${who}${fromVault ? " here" : ""} as ${saved.ref}. Put it in an mcp_server env, header or oauth.clientSecret value, alone or inside text such as "Bearer ${saved.ref}": Metal swaps in the value. It works once, only for you in this conversation, for an hour, and you never see the value.`;
  }
  return `${who} ${fromVault ? "in" : "to"} the file ${saved.file}. Read it only inside a command, such as TOKEN="$(cat '${saved.file}')"; never print, echo, log or copy it anywhere else. It is deleted after 24 hours.`;
}

function deliveryNote(botName: string, delivery: SecretDelivery, language: string | undefined): string {
  return serverLine(language, delivery === "file" ? "server.connect.secretFile" : "server.connect.secretRef", { bot: botName });
}

/** Where a file secret goes: the Local VM workspace its card names, else the bot's own folder. */
function vmFileHome(botId: string, vm: string): SecretFileHome | null {
  const pool = /^pool:(\d{1,4})$/.exec(vm);
  const target = vm === SHARED_LOCAL_VM_TARGET.key ? SHARED_LOCAL_VM_TARGET
    : pool ? poolLocalVmTarget(Number(pool[1]))
      : perBotLocalVmTarget(botId).key === vm ? perBotLocalVmTarget(botId) : null;
  return target ? { host: target.workspaceDir, shown: VM_WORKSPACE_GUEST } : null;
}

/** What the bot hears when the mailbox card settles; it never hears the password. */
function emailUpdateText(secret: SecretRequestCardData, outcome: "provided" | "dismissed"): string {
  return outcome === "provided"
    ? `Metal secret update: the person connected the mailbox ${secret.address ?? "they typed"}. The email tools (EMAIL_LIST_MESSAGES, EMAIL_READ_MESSAGE, EMAIL_SEND_MESSAGE and others) are ready. Continue the task that paused for it.`
    : "Metal secret update: the person chose not to connect a mailbox. Say briefly what you cannot do without it, and do not ask for the password in chat.";
}

const SERVER_FIELDS = ["imapHost", "imapPort", "smtpHost", "smtpPort", "username"] as const;
function emailServerFields(fields: Record<string, unknown>): EmailServerFields {
  const out: Record<string, unknown> = {};
  for (const name of SERVER_FIELDS) {
    const value = fields[name];
    if ((name.endsWith("Port") && Number.isInteger(value)) || (!name.endsWith("Port") && typeof value === "string" && value.trim())) out[name] = value;
  }
  return out as EmailServerFields;
}

function customRequest(body: Record<string, unknown>): { label: string; reason: string; placeholder: string; delivery: SecretDelivery } | { error: string } {
  const text = (value: unknown, max: number) => typeof value === "string"
    ? [...value].map((ch) => (ch.charCodeAt(0) < 0x20 || ch === "\u007f" ? " " : ch)).join("").trim().slice(0, max)
    : "";
  const label = text(body.label, CUSTOM_SECRET_LABEL_MAX);
  const reason = text(body.reason, CUSTOM_SECRET_REASON_MAX);
  if (!label) return { error: "request_credential needs credential_id for a key Metal keeps, or label for any other secret." };
  if (!reason) return { error: "request_credential needs reason: one short line on what the secret is for and where the person finds it." };
  if (!SECRET_DELIVERIES.includes(body.delivery as SecretDelivery)) {
    return { error: "request_credential needs delivery: ref for Metal's own tools such as mcp_server, or file for your own commands." };
  }
  return { label, reason, placeholder: text(body.placeholder, CUSTOM_SECRET_LABEL_MAX), delivery: body.delivery as SecretDelivery };
}

export function createSecretCards(deps: SecretCardsDeps) {
  const { store, cfg, botLogins, phoneSecrets, phoneSecretSubmissions, connectorThread, answerCardNode } = deps;
  const vault = new SecretVault();
  addHeldSecretScrubber((text) => vault.scrub(text));
  const savedSecrets = deps.savedSecrets;
  const sealer = deps.sealer ?? createCardSealer();
  // A value saved to the Vault is masked wherever text crosses to a bot, a transcript, an event or a log, for as long as it is kept.
  if (savedSecrets) {
    const held = new HeldSecrets(savedSecrets);
    addHeldSecretScrubber((text) => held.scrub(text));
  }

  const custom = (secret: SecretRequestCardData): boolean => secret.target === CUSTOM_SECRET_TARGET;
  // which Vault secrets were handed to which bot in which conversation, and when: only a use proven there can remove one
  const issued = new Map<string, number>();
  const issuedKey = (threadId: string, botId: string, secretId: string) => `${threadId}\n${botId}\n${secretId}`;
  /** Saved where the card says: a named key in the settings or Logins, a custom secret behind its card. */
  const secretSaved = (secret: SecretRequestCardData): boolean =>
    secret.target === CUSTOM_SECRET_TARGET ? secret.savedAt !== undefined : credentialIsConfigured(botLogins.credentialConfig(cfg), secret.target);

  function updateText(messageId: string, secret: SecretRequestCardData, outcome: "provided" | "dismissed"): string {
    if (!custom(secret)) return credentialUpdateText(secret.label, outcome);
    if (secret.delivery === "login") return loginCardUpdateText(secret.site ?? secret.label, outcome, secret.kept);
    if (secret.delivery === "email") return emailUpdateText(secret, outcome);
    return outcome === "provided"
      ? `Metal secret update: ${savedSecretText(secret.label, vault.savedFor(messageId))}${secret.kept === "vault" ? " It is also saved in the person's Vault: next time, request_credential with the same label gets it without a card." : ""} Continue the task that paused for it.`
      : `Metal secret update: the person declined to provide ${secret.label}. Continue without it if you can, or say briefly what you cannot do. Do not ask for it in chat.`;
  }

  function sweepBases(): string[] {
    const under = (folder: string) => {
      try {
        return readdirSync(folder).map((name) => join(folder, name));
      } catch {
        return [];
      }
    };
    return [...under(join(deps.dataDir, "workspaces")), join(deps.dataDir, "vm-home"), ...under(join(deps.dataDir, "vm-homes"))];
  }
  const threadExists = (threadId: string) => Boolean(store.botByThread(threadId) || store.groupByThread(threadId));
  const savedAt = (threadId: string, messageId: string) =>
    store.messagesFor(threadId).find((message) => message.id === messageId)?.secret?.savedAt ?? null;
  const sweep = () => {
    try {
      vault.sweep(sweepBases(), savedAt, threadExists);
    } catch (error) {
      console.warn(`secret files: sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  sweep();
  setInterval(sweep, SWEEP_MS).unref();
  store.onChange((change) => {
    if (change.type === "thread.deleted" || change.type === "bot.deleted" || change.type === "group.deleted") sweep();
    if (change.type === "bot.deleted" && savedSecrets) {
      try {
        savedSecrets.forgetBot(change.botId);
      } catch (error) {
        console.warn(`saved secrets: could not drop a deleted bot's access: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });

  /** Keeps a custom card's value where its delivery says, and marks when; never touches the card's other fields. */
  function storeCustomSecret(message: Message, botId: string, threadId: string, value: string, remember: boolean): void {
    const secret = message.secret!;
    const owner = { botId, threadId };
    // The Vault first: a refused save leaves the card open and nothing kept.
    const kept = remember && savedSecrets ? (savedSecrets.save({ label: secret.label, botId, value }), "vault" as const) : "once" as const;
    if (secret.delivery === "file") {
      const home = (secret.vm ? vmFileHome(botId, secret.vm) : null) ?? { host: deps.layerFolder(botId, threadId), shown: deps.layerFolder(botId, threadId) };
      vault.saveFile(owner, message.id, value, home);
    } else {
      vault.saveRef(owner, message.id, secret.label, value);
    }
    store.patchMessage(threadId, message.id, { secret: { ...secret, savedAt: Date.now(), kept } });
  }

  /** A value typed into a custom card in the app: kept, then the paused turn resumes. */
  function saveCustomSecret(botId: string, threadId: string, messageId: string, raw: unknown, remember = false): { status: number; body: Record<string, unknown> } {
    const message = secretMessage(botId, threadId, messageId);
    if (!message?.secret) return { status: 404, body: { error: "no such credential request" } };
    const secret = message.secret;
    if (!custom(secret)) return { status: 400, body: { error: "this card saves a key in Settings" } };
    if (phoneSecretSubmissions.has(phoneSecretSubmissionKey(threadId, message.id, secret.requestKey))) {
      return { status: 409, body: { error: "this secret is currently being saved from a phone" } };
    }
    if (secret.dismissed) return { status: 409, body: { error: "this request was declined" } };
    if (secret.superseded) return { status: 409, body: { error: "this request was replaced by a newer one" } };
    if (secret.stopped) return { status: 409, body: { error: "this request stopped with its task" } };
    if (secret.provided || secret.savedAt !== undefined) return { status: 409, body: { error: "this secret was already saved" } };
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value || Buffer.byteLength(value) > SECRET_VALUE_MAX_BYTES) {
      return { status: 400, body: { error: `Enter the secret: up to ${SECRET_VALUE_MAX_BYTES} bytes.` } };
    }
    try {
      storeCustomSecret(message, botId, threadId, value, remember);
    } catch (error) {
      if (error instanceof SavedSecretsUnavailable) return { status: 503, body: { error: error.message, code: "secret_store_failed" } };
      console.warn(`secret card: could not keep a secret: ${error instanceof Error ? error.name : "error"}`);
      return { status: 500, body: { error: "The secret could not be kept safely. Nothing was saved.", code: "secret_store_failed" } };
    }
    if (!resumeSecretCard(botId, threadId, message.id, "provided")) return { status: 409, body: { error: "this credential request is no longer available" } };
    return { status: 200, body: currentSecretState(botId, threadId, message.id) ?? { provided: true, resumed: false } };
  }

  /** The mailbox card: the password goes to the Email connector, which reads a real header before keeping it. A wrong one
   * leaves the card open with why, so the person isn't sent back to a new card. */
  async function saveEmailSecret(botId: string, threadId: string, messageId: string, fields: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    const message = secretMessage(botId, threadId, messageId);
    if (!message?.secret || message.secret.delivery !== "email") return { status: 404, body: { error: "no such credential request" } };
    const secret = message.secret;
    if (phoneSecretSubmissions.has(phoneSecretSubmissionKey(threadId, message.id, secret.requestKey))) return { status: 409, body: { error: "this secret is currently being saved from a phone" } };
    if (secret.dismissed) return { status: 409, body: { error: "this request was declined" } };
    if (secret.superseded) return { status: 409, body: { error: "this request was replaced by a newer one" } };
    if (secret.stopped) return { status: 409, body: { error: "this request stopped with its task" } };
    if (secret.provided || secret.savedAt !== undefined) return { status: 409, body: { error: "this mailbox was already connected" } };
    const password = typeof fields.value === "string" ? fields.value : "";
    const address = typeof fields.address === "string" && fields.address.trim() ? fields.address.trim() : secret.address ?? "";
    if (!address || !password.trim() || Buffer.byteLength(password) > SECRET_VALUE_MAX_BYTES) return { status: 400, body: { error: "Enter your email address and its password." } };
    if (!deps.email) return { status: 409, body: { error: "Email can't be connected here." } };
    const answer = await deps.email.connect({ address, password, ...emailServerFields(fields) });
    if (!answer.ok) return { status: 400, body: { error: answer.error, ...(answer.needsServer ? { needsServer: true } : {}) } };
    const current = secretMessage(botId, threadId, messageId);
    if (!current?.secret) return { status: 409, body: { error: "this credential request is no longer available" } };
    store.patchMessage(threadId, message.id, { secret: { ...current.secret, address: answer.account.address, savedAt: Date.now() } });
    if (!resumeSecretCard(botId, threadId, message.id, "provided")) return { status: 409, body: { error: "this credential request is no longer available" } };
    return { status: 200, body: { ...currentSecretState(botId, threadId, message.id), ...(answer.sending.ok ? {} : { sendingProblem: answer.sending.problem }) } };
  }

  /** mcp_server's fields with every secretRef swapped for its value: only in env, headers and oauth.clientSecret. */
  function redeemMcpServer<T>(body: T, botId: string, threadId: string) {
    return vault.redeem(body, { botId, threadId }, (path) =>
      (path.length === 2 && (path[0] === "env" || path[0] === "headers")) || (path.length === 2 && path[0] === "oauth" && path[1] === "clientSecret"),
    "mcp_server's env, headers and oauth.clientSecret");
  }

  function phoneSecretSubmissionKey(threadId: string, messageId: string, requestKey: string): string {
    return `${threadId}:${messageId}:${requestKey}`;
  }

  function credentialDesktopHandoff(label: string, language: string | undefined): string {
    return serverLine(language, "server.connect.secretHandoff", { label });
  }

  function secretMessage(botId: string, threadId: string, messageId: string): Message | null {
    const owner = connectorThread(botId, threadId);
    if (!owner) return null;
    // Actionable only on the visible branch; in a channel only the requesting bot may bind the credential into HPKE AAD or resume its turn.
    const message = store.activePath(threadId).find((candidate) => candidate.id === messageId);
    if (owner.group && message?.from?.botId !== botId) return null;
    return message?.kind === "secret" && message.secret ? message : null;
  }

  function currentSecretState(botId: string, threadId: string, messageId: string) {
    const message = secretMessage(botId, threadId, messageId);
    if (!message?.secret) return null;
    return {
      provided: message.secret.provided === true,
      resumed: message.secret.resumed === true,
    };
  }

  function resumeSecretCard(botId: string, threadId: string, messageId: string, outcome: "provided" | "dismissed") {
    const message = secretMessage(botId, threadId, messageId);
    if (!message?.secret) return false;
    if (message.secret.resumed) return true;
    const resumed = answerCardNode(threadId, messageId, updateText(message.id, message.secret, outcome));
    store.patchMessage(threadId, message.id, {
      secret: {
        ...message.secret,
        provided: outcome === "provided" ? true : message.secret.provided,
        dismissed: outcome === "dismissed" ? true : message.secret.dismissed,
        ...(resumed ? { resumed: true, error: undefined } : {}),
      },
    });
    return true;
  }

  async function provideSecretFromPhone(
    context: PhoneSecretContext,
    authenticatedDeviceId: string,
  ): Promise<{ provided: boolean; resumed: boolean }> {
    const owner = connectorThread(context.botId, context.threadId);
    const message = secretMessage(context.botId, context.threadId, context.messageId);
    if (!owner || !message?.secret) throw new PhoneSecretError("No such credential request", 404);
    if (message.secret.dismissed) throw new PhoneSecretError("This credential request was dismissed", 409);
    if (message.secret.superseded) throw new PhoneSecretError("This credential request was superseded by a newer one", 409);
    assertPhoneSecretRequestMatches(context, authenticatedDeviceId, {
      target: message.secret.target,
      requestKey: message.secret.requestKey,
    });
    const operationId = phoneSecretOperationId(context);
    if (message.secret.phoneOperationId && message.secret.phoneOperationId !== operationId) {
      throw new PhoneSecretError(
        "This credential request was already completed by another submission",
        409,
      );
    }
    // Recording the winning operation precedes completing the card, so an exact retry repairs a crash without writing the credential again.
    if (message.secret.phoneOperationId === operationId && !message.secret.provided) {
      if (!secretSaved(message.secret)) {
        throw new PhoneSecretError(`${message.secret.label} is no longer configured`, 409);
      }
      if (!resumeSecretCard(context.botId, context.threadId, context.messageId, "provided")) {
        throw new PhoneSecretError("This credential request is no longer available", 409);
      }
      const recovered = currentSecretState(context.botId, context.threadId, context.messageId);
      if (!recovered) throw new PhoneSecretError("This credential request is no longer available", 409);
      return recovered;
    }
    if (message.secret.provided) {
      if (message.secret.phoneOperationId !== operationId) {
        throw new PhoneSecretError(
          "This credential request was already completed by another submission",
          409,
        );
      }
      if (!secretSaved(message.secret)) {
        throw new PhoneSecretError(`${message.secret.label} is no longer configured`, 409);
      }
      if (!message.secret.resumed && !resumeSecretCard(
        context.botId,
        context.threadId,
        context.messageId,
        "provided",
      )) {
        throw new PhoneSecretError("This credential request is no longer available", 409);
      }
      const recovered = currentSecretState(context.botId, context.threadId, context.messageId);
      if (!recovered) throw new PhoneSecretError("This credential request is no longer available", 409);
      return recovered;
    }

    const submissionKey = phoneSecretSubmissionKey(context.threadId, context.messageId, context.requestKey);
    await phoneSecretSubmissions.run({
      cardKey: submissionKey,
      botId: context.botId,
      threadId: context.threadId,
      ...(owner.group ? { groupId: owner.group.id } : {}),
    }, operationId, async () => {
      // A custom secret is opened here and kept behind its card; a named key goes to the desktop's store and settings.
      const opened = custom(message.secret!) ? await phoneSecrets.open(context) : null;
      if (opened === null) await phoneSecrets.provide(context);
      const current = secretMessage(context.botId, context.threadId, context.messageId);
      if (!current?.secret || current.secret.requestKey !== context.requestKey) {
        throw new PhoneSecretError("This credential request is no longer available", 409);
      }
      if (current.secret.dismissed) {
        throw new PhoneSecretError("This credential request was dismissed", 409);
      }
      // The card may have been superseded during the save: completing it would leave two cards resolved.
      if (current.secret.superseded) {
        throw new PhoneSecretError("This credential request was superseded by a newer one", 409);
      }
      if (opened !== null) {
        if (current.secret.stopped) throw new PhoneSecretError("This request stopped with its task", 409);
        if (current.secret.delivery === "login") throw new PhoneSecretError("Type this login in Metal on your computer.", 409);
        if (current.secret.delivery === "email") {
          if (!current.secret.address || !deps.email) throw new PhoneSecretError("Type your email address and password on your computer.", 409);
          const answer = await deps.email.connect({ address: current.secret.address, password: opened });
          if (!answer.ok) throw new PhoneSecretError(answer.error, 400);
          store.patchMessage(context.threadId, current.id, { secret: { ...current.secret, savedAt: Date.now() } });
        } else storeCustomSecret(current, context.botId, context.threadId, opened, true);
      }
      const saved = secretMessage(context.botId, context.threadId, context.messageId) ?? current;
      // Electron acknowledges only after credentials.bin and the config update both commit; keep this assertion so no handler resumes first.
      if (!saved.secret || !secretSaved(saved.secret)) {
        throw new PhoneSecretError(`${current.secret.label} was not saved yet`, 409);
      }
      // Persist the winning envelope id before completing the card, so a new sealed value is never reported as the saved one.
      store.patchMessage(context.threadId, current.id, {
        secret: { ...saved.secret, phoneOperationId: operationId },
      });
      if (!resumeSecretCard(context.botId, context.threadId, context.messageId, "provided")) {
        throw new PhoneSecretError("This credential request is no longer available", 409);
      }
    });
    const settled = currentSecretState(context.botId, context.threadId, context.messageId);
    if (!settled) throw new PhoneSecretError("This credential request is no longer available", 409);
    return settled;
  }

  /** request_credential's card: the id is the whole authority, and a newer request supersedes the pending ones. */
  function requestCredential(from: BotRecord, fromThreadId: string, body: Record<string, unknown>): { status: number; body: Record<string, unknown> } {
    const owner = connectorThread(from.id, fromThreadId);
    if (!owner) return { status: 403, body: { error: "source conversation does not belong to sender" } };
    if (body.credentialId === undefined) return requestCustomSecret(from, fromThreadId, Boolean(owner.group), body);
    if (body.credentialId === EMAIL_CREDENTIAL) return requestEmailCard(from, fromThreadId, Boolean(owner.group), body);
    if (body.credentialId === LOGIN_CREDENTIAL) return requestLoginCard(from, fromThreadId, Boolean(owner.group), body);
    if (!isCredentialTargetId(body.credentialId)) {
      return { status: 400, body: { error: "unsupported credential id" } };
    }
    const credentialId: CredentialTargetId = body.credentialId;
    const target = CREDENTIAL_TARGETS[credentialId];
    if (credentialIsConfigured(botLogins.credentialConfig(cfg), credentialId)) {
      return { status: 200, body: { alreadyConfigured: true, label: target.label } };
    }
    // A later request supersedes pending cards; the fresh card is appended FIRST, so a failed save leaves the prior cards actionable.
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 240) : "";
    const language = deps.threadLanguage?.(fromThreadId);
    const message = store.appendMessage(fromThreadId, {
      role: "bot",
      kind: "secret",
      text: credentialDesktopHandoff(target.label, language),
      ...(owner.group ? { from: { botId: from.id, name: from.name, color: from.color } } : {}),
      secret: {
        target: credentialId,
        label: target.label,
        description: `${reason ? `${target.description} ${reason}` : target.description} ${serverLine(language, "server.connect.secretNeverRead", { bot: from.name })}`,
        placeholder: target.placeholder,
        helpUrl: target.helpUrl,
        requestKey: randomUUID(),
      },
    });
    for (const prior of store.activePath(fromThreadId)) {
      if (prior.id === message.id) continue;
      if (!prior.secret || !isPendingCredentialRequest(prior, credentialId, from.id, Boolean(owner.group))) continue;
      store.patchMessage(fromThreadId, prior.id, { secret: { ...prior.secret, superseded: true } });
      deps.followCard(fromThreadId, prior.id, message.id);
    }
    return { status: 201, body: { messageId: message.id, label: target.label } };
  }

  /** One card for a mailbox's address and password, as a custom card so a phone shows it as it does any secret. */
  function requestEmailCard(from: BotRecord, threadId: string, room: boolean, body: Record<string, unknown>): { status: number; body: Record<string, unknown> } {
    const refusal = deps.email ? deps.email.refusal() : "Email can't be connected here.";
    if (refusal || !deps.email) return { status: 403, body: { error: refusal } };
    const named = typeof body.address === "string" && /^[^\s@]+@[^\s@]+$/u.test(body.address.trim()) ? body.address.trim() : undefined;
    if (named && deps.email.connected(named)) return { status: 200, body: { alreadyConfigured: true, label: named } };
    const address = named ?? deps.email.profileAddress();
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, CUSTOM_SECRET_REASON_MAX) : "";
    const language = deps.threadLanguage?.(threadId);
    const label = serverLine(language, "server.connect.emailLabel");
    const message = store.appendMessage(threadId, {
      role: "bot",
      kind: "secret",
      text: credentialDesktopHandoff(label, language),
      ...(room ? { from: { botId: from.id, name: from.name, color: from.color } } : {}),
      secret: {
        target: CUSTOM_SECRET_TARGET,
        label,
        // the card's footer says once how the password is kept, so the card's own words are only the bot's purpose
        description: reason,
        ...(reason ? { reason } : {}),
        placeholder: serverLine(language, "server.connect.emailPlaceholder"),
        helpUrl: "",
        delivery: "email",
        ...(address ? { address } : {}),
        requestKey: randomUUID(),
      },
    });
    for (const prior of store.activePath(threadId)) {
      if (prior.id === message.id || !prior.secret || !isPendingCustomSecretRequest(prior, label, from.id, room)) continue;
      store.patchMessage(threadId, prior.id, { secret: { ...prior.secret, superseded: true } });
    }
    return { status: 201, body: { messageId: message.id, label, delivery: "email" } };
  }

  /** One card for a website's username, password and 2FA key, typed by the person and filled by fill_login. A login the bot
   * may use already fills there: no card. */
  function requestLoginCard(from: BotRecord, threadId: string, room: boolean, body: Record<string, unknown>): { status: number; body: Record<string, unknown> } {
    if (!deps.logins) return { status: 403, body: { error: "Logins can't be saved here. Call request_sign_in so the person signs in themselves." } };
    const target = normalizeSignInSite(body.site);
    if (!target) return { status: 400, body: { error: "site must be the login page's address or the site's domain, such as example.com" } };
    const host = new URL(target.url).hostname.toLowerCase();
    if (deps.logins.has(from.id, host)) {
      return { status: 200, body: { site: target.site, text: `A saved login for ${target.site} is already yours to use, so no card was needed. Open its login page where you work and call fill_login.` } };
    }
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, CUSTOM_SECRET_REASON_MAX) : "";
    const message = appendLoginCard(from, threadId, room, target.site, host, reason);
    return { status: 201, body: { messageId: message.id, site: target.site, delivery: "login" } };
  }

  /** A login card for `site`, replacing this bot's pending one for it. */
  function appendLoginCard(from: BotRecord, threadId: string, room: boolean, site: string, host: string, reason: string): Message {
    const language = deps.threadLanguage?.(threadId);
    const message = store.appendMessage(threadId, {
      role: "bot",
      kind: "secret",
      text: credentialDesktopHandoff(site, language),
      ...(room ? { from: { botId: from.id, name: from.name, color: from.color } } : {}),
      secret: {
        target: CUSTOM_SECRET_TARGET,
        label: site,
        description: reason,
        ...(reason ? { reason } : {}),
        placeholder: "",
        helpUrl: "",
        delivery: "login",
        site: host,
        requestKey: randomUUID(),
      },
    });
    for (const prior of store.activePath(threadId)) {
      if (prior.id === message.id || !prior.secret || !isPendingCustomSecretRequest(prior, site, from.id, room)) continue;
      store.patchMessage(threadId, prior.id, { secret: { ...prior.secret, superseded: true } });
      deps.followCard(threadId, prior.id, message.id);
    }
    return message;
  }

  /** A saved login the site refused, after BotLogins.rejected changed it: the person hears once, on a fresh login card
   * whose line says what happened, and the bot is told. Null when nothing changed. */
  function loginRejected(botId: string, threadId: string, rejection: LoginRejection | null): string | null {
    if (!rejection) return null;
    if (rejection.change === "forgotten") {
      return ` The site said this login is wrong, so Metal dropped it. If you still need it, call request_credential login for ${rejection.site}.`;
    }
    const owner = connectorThread(botId, threadId);
    const language = deps.threadLanguage?.(threadId);
    const key = rejection.change === "removed" ? "server.vault.loginRemoved" : rejection.change === "removedTotp" ? "server.vault.totpRemoved" : "server.vault.loginCheck";
    const what = rejection.change === "flagged"
      ? "It may be wrong, so Metal marked it for the person to check in Settings"
      : rejection.change === "removedTotp" ? "The site refused the code from its saved 2FA key, so Metal removed that key from the Vault"
        : "The site said this login is wrong, so Metal removed it from the Vault";
    if (!owner || !deps.logins) return ` ${what}. Tell the person in one short line; do not call fill_login with it again.`;
    appendLoginCard(owner.bot, threadId, Boolean(owner.group), rejection.site, rejection.host, serverLine(language, key, { site: rejection.site }));
    return ` ${what} and showed the person a login card to add it again, which says so. Do not repeat it or call fill_login again now: end your turn; Metal resumes you when they answer.`;
  }

  /** A login card's answer: `value` is the sealed JSON of its password and 2FA key, opened for this card only. Kept before
   * the card settles, so a refused save leaves it open. */
  function saveLoginSecret(botId: string, threadId: string, messageId: string, fields: Record<string, unknown>, remember: boolean): { status: number; body: Record<string, unknown> } {
    const message = secretMessage(botId, threadId, messageId);
    if (!message?.secret || message.secret.delivery !== "login" || !message.secret.site) return { status: 404, body: { error: "no such credential request" } };
    const secret = message.secret;
    if (secret.dismissed) return { status: 409, body: { error: "this request was declined" } };
    if (secret.superseded) return { status: 409, body: { error: "this request was replaced by a newer one" } };
    if (secret.stopped) return { status: 409, body: { error: "this request stopped with its task" } };
    if (secret.provided || secret.savedAt !== undefined) return { status: 409, body: { error: "this login was already saved" } };
    if (!deps.logins) return { status: 409, body: { error: "Logins can't be saved here." } };
    let opened: { password?: unknown; totp?: unknown } = {};
    try { opened = typeof fields.value === "string" ? JSON.parse(fields.value) as typeof opened : {}; } catch {}
    const parsed = parseLoginFields({ username: typeof fields.username === "string" ? fields.username : "", password: typeof opened.password === "string" ? opened.password : "" }, { passwordRequired: true });
    if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
    const totp = parseTotpField(typeof opened.totp === "string" && opened.totp.trim() ? opened.totp : undefined);
    if (!totp.ok) return { status: 400, body: { error: totp.error } };
    try {
      deps.logins.keep({ botId, host: secret.site!, username: parsed.value.username ?? "", password: parsed.value.password!, totp: totp.value ?? null, remember });
    } catch (error) {
      console.warn(`login card: could not keep a login: ${error instanceof Error ? error.name : "error"}`);
      return { status: 500, body: { error: "The login could not be kept safely. Nothing was saved.", code: "secret_store_failed" } };
    }
    store.patchMessage(threadId, message.id, { secret: { ...secret, savedAt: Date.now(), kept: remember ? "vault" : "once" } });
    if (!resumeSecretCard(botId, threadId, message.id, "provided")) return { status: 409, body: { error: "this credential request is no longer available" } };
    return { status: 200, body: currentSecretState(botId, threadId, message.id) ?? { provided: true, resumed: false } };
  }

  /** A secret Metal does not keep: the same bot asking again for one already saved here gets it back, and a newer
   * card replaces its pending one with the same name. */
  function requestCustomSecret(from: BotRecord, threadId: string, room: boolean, body: Record<string, unknown>): { status: number; body: Record<string, unknown> } {
    const asked = customRequest(body);
    if ("error" in asked) return { status: 400, body: asked };
    // oxlint-disable-next-line no-control-regex -- control characters are what this strips or refuses
    const failed = typeof body.failed === "string" ? body.failed.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, FAILED_MAX) : "";
    let vaulted: VaultFailure = {};
    if (failed) {
      vaulted = savedSecretFailed(from, threadId, asked.label, failed);
      if (vaulted.answer) return vaulted.answer;
    }
    const path = store.activePath(threadId);
    // the one that failed is never handed back
    const earlier = failed ? undefined : [...path].reverse().find((message) => message.kind === "secret" && message.secret && custom(message.secret) &&
      message.secret.savedAt !== undefined && !message.secret.superseded && message.secret.label.toLowerCase() === asked.label.toLowerCase() &&
      (!room || message.from?.botId === from.id));
    const kept = earlier ? vault.savedFor(earlier.id) : null;
    if (earlier && kept && earlier.secret!.delivery === asked.delivery) return { status: 200, body: { label: asked.label, text: savedSecretText(asked.label, kept) } };
    const pastedAs = typeof body.pastedAs === "string" ? body.pastedAs.trim().slice(0, CUSTOM_SECRET_LABEL_MAX) : "";
    const pasted = failed ? null : pastedSecret(path, pastedAs ? [pastedAs, asked.label] : [asked.label]);
    const fromMessage = pasted ? keepPasted(from, threadId, asked, pasted) : null;
    if (fromMessage) return fromMessage;
    const fromVault = failed ? null : issueFromVault(from, threadId, asked);
    if (fromVault) return fromVault;
    const mismatch = earlier && kept ? earlier.secret!.delivery : undefined;
    const vm = asked.delivery === "file" ? deps.turnVm(threadId) : undefined;
    const language = deps.threadLanguage?.(threadId);
    const message = store.appendMessage(threadId, {
      role: "bot",
      kind: "secret",
      text: credentialDesktopHandoff(asked.label, language),
      ...(room ? { from: { botId: from.id, name: from.name, color: from.color } } : {}),
      secret: {
        target: CUSTOM_SECRET_TARGET,
        label: asked.label,
        description: `${vaulted.note ?? asked.reason} ${deliveryNote(from.name, asked.delivery, language)}`,
        reason: vaulted.note ?? asked.reason,
        placeholder: asked.placeholder,
        helpUrl: "",
        delivery: asked.delivery,
        ...(vm ? { vm } : {}),
        requestKey: randomUUID(),
      },
    });
    for (const prior of path) {
      if (!prior.secret || !isPendingCustomSecretRequest(prior, asked.label, from.id, room)) continue;
      store.patchMessage(threadId, prior.id, { secret: { ...prior.secret, superseded: true } });
      deps.followCard(threadId, prior.id, message.id);
    }
    return { status: 201, body: { messageId: message.id, label: asked.label, delivery: asked.delivery, ...(mismatch ? { savedAs: mismatch } : {}), ...(vaulted.vault ? { vault: vaulted.vault } : {}) } };
  }

  type VaultFailure = { answer?: { status: number; body: Record<string, unknown> }; note?: string; vault?: "removed" | "flagged" };

  /** A Vault secret the bot says failed when used. A clear auth failure on one the Vault handed this bot here removes it;
   * a temporary one changes nothing; anything else marks it to check, once. The card that follows says what happened. */
  function savedSecretFailed(from: BotRecord, threadId: string, label: string, failed: string): VaultFailure {
    if (!savedSecrets?.ready()) return {};
    try {
      const found = savedSecrets.find(label, from.id) ?? savedSecrets.find(savedSecrets.labelsFor(from.id).find((saved) => sameSecretName(saved, label)) ?? label, from.id);
      if (!found) return {};
      let verdict = classifyApiFailure({ message: failed });
      if (verdict === "transient") {
        return { answer: { status: 200, body: { label: found.label, text: `That looks like a temporary problem (a rate limit, the network or the service being busy), not a wrong ${found.label}, so it stays saved. Try again in a while, and do not ask for a new one.` } } };
      }
      const at = issued.get(issuedKey(threadId, from.id, found.id));
      // only a use the Vault gave this bot in this conversation proves it wrong
      if (verdict === "invalid" && !(at !== undefined && Date.now() - at < ISSUED_MS)) verdict = "check";
      const language = deps.threadLanguage?.(threadId);
      if (verdict === "invalid") {
        savedSecrets.remove(found.id);
        issued.delete(issuedKey(threadId, from.id, found.id));
        return { note: serverLine(language, "server.vault.removed", { label: found.label }), vault: "removed" };
      }
      if (!savedSecrets.flag(found.id)) {
        return { answer: { status: 200, body: { label: found.label, text: `${found.label} is already marked for the person to check in Settings, and they were asked once. Do not ask again: continue without it, or say in one line that it is not working.` } } };
      }
      return { note: serverLine(language, "server.vault.check", { label: found.label }), vault: "flagged" };
    } catch (error) {
      console.warn(`saved secrets: could not record a failed secret: ${error instanceof Error ? error.name : "error"}`);
      return {};
    }
  }

  /** A value the person wrote in their own message: saved to their Vault when there is one, handed over as a ref or
   * private file like a card's, and no card. */
  function keepPasted(from: BotRecord, threadId: string, asked: { label: string; delivery: SecretDelivery }, value: string): { status: number; body: Record<string, unknown> } | null {
    let vaulted = false;
    try {
      if (savedSecrets) {
        const kept = savedSecrets.save({ label: asked.label, botId: from.id, value });
        issued.set(issuedKey(threadId, from.id, kept.id), Date.now());
        vaulted = true;
      }
    } catch (error) {
      console.warn(`saved secrets: could not keep a pasted secret: ${error instanceof Error ? error.name : "error"}`);
    }
    const owner = { botId: from.id, threadId };
    const issue = `pasted-${randomUUID().slice(0, 8)}`;
    let saved: SavedSecret;
    try {
      if (asked.delivery === "file") {
        const vm = deps.turnVm(threadId);
        const home = (vm ? vmFileHome(from.id, vm) : null) ?? { host: deps.layerFolder(from.id, threadId), shown: deps.layerFolder(from.id, threadId) };
        saved = { file: vault.saveFile(owner, issue, value, home) };
      } else saved = { ref: vault.saveRef(owner, issue, asked.label, value) };
    } catch (error) {
      console.warn(`secret card: could not hand over a pasted secret: ${error instanceof Error ? error.name : "error"}`);
      return null;
    }
    const lead = `Metal took ${asked.label} from the person's own message, so no card was needed${vaulted ? ", and saved it to their Vault" : ""}. Never repeat, quote or confirm the value in a reply.`;
    return { status: 200, body: { label: asked.label, fromMessage: true, ...(vaulted ? { vault: "saved" } : {}), text: `${lead} ${savedSecretText(asked.label, saved)}` } };
  }

  /** A secret the person saved to the Vault for this bot: a fresh one-use ref or private file, and no card. */
  function issueFromVault(from: BotRecord, threadId: string, asked: { label: string; delivery: SecretDelivery }): { status: number; body: Record<string, unknown> } | null {
    if (!savedSecrets?.ready()) return null;
    let found: ReturnType<SavedSecretStore["find"]>;
    try {
      found = savedSecrets.find(asked.label, from.id);
      const alike = found ? undefined : savedSecrets.labelsFor(from.id).find((label) => sameSecretName(label, asked.label));
      if (alike) found = savedSecrets.find(alike, from.id);
    } catch {
      return null;
    }
    if (!found) return null;
    const owner = { botId: from.id, threadId };
    const issue = `vault-${found.id}-${randomUUID().slice(0, 8)}`;
    let saved: SavedSecret;
    try {
      if (asked.delivery === "file") {
        const vm = deps.turnVm(threadId);
        const home = (vm ? vmFileHome(from.id, vm) : null) ?? { host: deps.layerFolder(from.id, threadId), shown: deps.layerFolder(from.id, threadId) };
        saved = { file: vault.saveFile(owner, issue, found.value, home) };
      } else saved = { ref: vault.saveRef(owner, issue, found.label, found.value) };
      savedSecrets.markUsed(found.id);
      issued.set(issuedKey(threadId, from.id, found.id), Date.now());
    } catch (error) {
      console.warn(`saved secrets: could not hand a saved secret to its bot: ${error instanceof Error ? error.name : "error"}`);
      return null;
    }
    return { status: 200, body: { label: found.label, fromVault: true, text: savedSecretText(found.label, saved, true) } };
  }

  /** The key a card seals for; an app gets it before it seals. */
  const sealKey = () => sealer.publicKey();

  /** A sealed value opened for its card: only this server process can. */
  async function openSealed(botId: string, threadId: string, messageId: string, sealed: SealedCardSecret, remember: boolean): Promise<string> {
    const message = secretMessage(botId, threadId, messageId);
    if (!message?.secret) throw new CardSealError("no such credential request", 404);
    return sealer.open(sealed, { botId, threadId, messageId, requestKey: message.secret.requestKey, remember });
  }

  const CARD_ID = /^[\w-]{1,128}$/u;
  /** The file card this conversation holds under `card`, while its file is still kept, and the bot it was saved for. */
  function fileCard(thread: string, card: string): { bot: string } | null {
    if (!CARD_ID.test(thread) || !CARD_ID.test(card)) return null;
    const message = store.messagesFor(thread).find((candidate) => candidate.id === card);
    const secret = message?.kind === "secret" ? message.secret : undefined;
    if (!secret || secret.delivery !== "file" || secret.savedAt === undefined || Date.now() - secret.savedAt >= SECRET_FILE_TTL_MS) return null;
    const bot = message?.from?.botId ?? store.botByThread(thread)?.id;
    return bot ? { bot } : null;
  }

  /** Every card file secret still kept here, with its value: for the move to the person's own Cloud only (vault-move.ts).
   * A file the Vault handed out has no card and stays; the Vault's own secret moves instead. */
  function movableFiles(): HandedCardFile[] {
    const out: HandedCardFile[] = [];
    for (const base of sweepBases()) {
      const folder = join(base, SECRET_FOLDER);
      let threads: string[];
      try { threads = lstatSync(folder).isDirectory() ? readdirSync(folder) : []; } catch { continue; }
      for (const thread of threads) {
        let cards: string[];
        try { cards = lstatSync(join(folder, thread)).isDirectory() ? readdirSync(join(folder, thread)) : []; } catch { continue; }
        for (const card of cards) {
          const owner = fileCard(thread, card);
          if (!owner) continue;
          const file = join(folder, thread, card);
          try {
            if (!lstatSync(file).isFile()) continue;
            const value = readFileSync(file, "utf8");
            if (value && Buffer.byteLength(value) <= SECRET_VALUE_MAX_BYTES) out.push({ bot: owner.bot, thread, card, value });
          } catch { continue; }
        }
      }
    }
    return out;
  }

  /** A card's file secret moved in: written into that bot's private folder here, behind the same card; false when
   * the card is not here or no longer keeps a file. */
  function keepMovedFile(file: HandedCardFile): boolean {
    const owner = fileCard(file.thread, file.card);
    if (!owner || owner.bot !== file.bot) return false;
    const folder = deps.layerFolder(file.bot, file.thread);
    vault.saveFile({ botId: file.bot, threadId: file.thread }, file.card, file.value, { host: folder, shown: folder });
    return true;
  }

  return {
    sealKey, openSealed, movableFiles, keepMovedFile,
    phoneSecretSubmissionKey, secretMessage, currentSecretState, resumeSecretCard, provideSecretFromPhone, requestCredential, saveCustomSecret, saveEmailSecret, saveLoginSecret,
    secretSaved, updateText, redeemMcpServer, loginRejected,
  };
}
