import { afterEach, describe, expect, it, vi } from "vitest";
import { brevoMailer, codeMessage, consoleMailer, MailDeliveryError, mailerFromEnv, memoryMailer, recoveryMessage, resendMailer } from "./mail.ts";

afterEach(() => vi.restoreAllMocks());

describe("account mail", () => {
  it("keeps code messages in the fixture outbox", async () => {
    const mailer = memoryMailer(), message = codeMessage("fixture@example.test", "01234567");
    await mailer.send(message);
    expect(mailer.outbox).toEqual([message]);
    expect(message.subject).toBe("01234567 is your Metal code");
    expect(message.text).toContain("01234567"); expect(message.html).toContain("01234567");
    expect(message.text).toContain("works for 10 minutes."); expect(message.html).toContain("works for 10 minutes.");
  });
  it("writes recovery mail with the ways in, an escaped link, and no code for an address without an account", () => {
    const message = recoveryMessage("fixture@example.test", { code: "01234567", link: "https://dash.example.test/sign-in?attempt=a&code=01234567", ways: ["email", "google", "apple"] });
    expect(message.text).toContain("    01234567");
    expect(message.text).toContain("this account signs in with an emailed code, google or apple.");
    expect(message.html).toContain('href="https://dash.example.test/sign-in?attempt=a&amp;code=01234567"');
    expect(recoveryMessage("fixture@example.test", { code: "01234567", ways: ["email"] }).text).not.toContain("sign-in?");
    const none = recoveryMessage("fixture@example.test", { code: "01234567", ways: null });
    expect(none.text).not.toContain("01234567"); expect(none.html).not.toContain("01234567");
    expect(`${none.text}${message.text}`).not.toContain("\u2014");
  });
  it("prints development codes only through the console mailer", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await consoleMailer().send(codeMessage("fixture@example.test", "01234567"));
    expect(log).toHaveBeenCalledWith("code for fixture@example.test: 01234567");
  });
  it("posts messages to Resend with bearer authentication", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
    const message = codeMessage("fixture@example.test", "01234567");
    await resendMailer({ apiKey: "fixture-key", from: "Fixture <mail@example.test>", fetch: request }).send(message);
    expect(request).toHaveBeenCalledWith("https://api.resend.com/emails", expect.objectContaining({ method: "POST", redirect: "error",
      headers: { authorization: "Bearer fixture-key", "content-type": "application/json" }, body: JSON.stringify({ from: "Metal <mail@example.test>", reply_to: "hello@dusk.bot", to: message.to, subject: message.subject, html: message.html, text: message.text }) }));
  });
  it.each([400, 401, 429, 500])("hides Resend failure details for status %s", async status => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("sensitive provider details", { status }));
    await expect(resendMailer({ apiKey: "fixture-key", from: "mail@example.test", fetch: request }).send(codeMessage("fixture@example.test", "01234567"))).rejects.toThrow("Email delivery failed.");
  });
  it("hides network errors and never logs provider secrets", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error("sensitive request details"));
    await expect(resendMailer({ apiKey: "fixture-key", from: "mail@example.test", fetch: request }).send(codeMessage("fixture@example.test", "01234567"))).rejects.toThrow("Email delivery failed.");
    expect(log).not.toHaveBeenCalled();
  });
  it("posts messages to Brevo with its api-key header, always named Metal", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 201 }));
    const message = codeMessage("fixture@example.test", "01234567");
    await brevoMailer({ apiKey: "fixture-key", from: "Fixture <mail@example.test>", fetch: request }).send(message);
    expect(request).toHaveBeenCalledWith("https://api.brevo.com/v3/smtp/email", expect.objectContaining({ method: "POST", redirect: "error",
      headers: { "api-key": "fixture-key", "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender: { name: "Metal", email: "mail@example.test" }, replyTo: { email: "hello@dusk.bot" }, to: [{ email: message.to }], subject: message.subject, htmlContent: message.html, textContent: message.text }) }));
    await brevoMailer({ apiKey: "fixture-key", from: "mail@example.test", fetch: request }).send(message);
    expect(JSON.parse(String(request.mock.calls[1][1]?.body)).sender).toEqual({ name: "Metal", email: "mail@example.test" });
  });
  it("names a refusal by status and the provider's error name only, for admin ops", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ name: "rate_limit_exceeded", message: "fixture@example.test sent too many" }, { status: 429 }));
    const error = await resendMailer({ apiKey: "fixture-key", from: "mail@example.test", fetch: request }).send(codeMessage("fixture@example.test", "01234567")).catch(e => e);
    expect(error).toBeInstanceOf(MailDeliveryError);
    expect(error).toMatchObject({ status: 429, reason: "http 429 rate_limit_exceeded", message: "Email delivery failed." });
    const offline = await brevoMailer({ apiKey: "fixture-key", from: "mail@example.test", fetch: vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed")) }).send(codeMessage("fixture@example.test", "01234567")).catch(e => e);
    expect(offline).toMatchObject({ status: null, reason: "no answer (TypeError)" });
  });
  it.each([400, 401, 429, 500])("hides Brevo failure details for status %s", async status => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("sensitive provider details", { status }));
    await expect(brevoMailer({ apiKey: "fixture-key", from: "mail@example.test", fetch: request }).send(codeMessage("fixture@example.test", "01234567"))).rejects.toThrow("Email delivery failed.");
  });
  it("validates mail configuration at startup and restricts console mail to development", () => {
    expect(mailerFromEnv({}, { dev: true })).toHaveProperty("send");
    expect(() => mailerFromEnv({}, { dev: false })).toThrow("Configure DUSK_MAIL_PROVIDER=brevo or resend");
    expect(() => mailerFromEnv({ DUSK_MAIL_PROVIDER: "console" }, { dev: false })).toThrow("console mail is allowed only in development");
    expect(() => mailerFromEnv({ DUSK_MAIL_PROVIDER: "other" }, { dev: true })).toThrow();
    expect(() => mailerFromEnv({ DUSK_MAIL_PROVIDER: "resend" }, { dev: true })).toThrow("DUSK_RESEND_API_KEY and DUSK_MAIL_FROM");
    expect(() => mailerFromEnv({ DUSK_MAIL_PROVIDER: "resend", DUSK_RESEND_API_KEY: "fixture-key" }, { dev: false })).toThrow("DUSK_MAIL_FROM");
    expect(mailerFromEnv({ DUSK_MAIL_PROVIDER: "resend", DUSK_RESEND_API_KEY: "fixture-key", DUSK_MAIL_FROM: "mail@example.test" }, { dev: false })).toHaveProperty("send");
    expect(() => mailerFromEnv({ DUSK_MAIL_PROVIDER: "brevo", DUSK_MAIL_FROM: "mail@example.test" }, { dev: false })).toThrow("DUSK_BREVO_API_KEY and DUSK_MAIL_FROM");
    expect(mailerFromEnv({ DUSK_MAIL_PROVIDER: "brevo", DUSK_BREVO_API_KEY: "fixture-key", DUSK_MAIL_FROM: "Metal <hello@example.test>" }, { dev: false })).toHaveProperty("send");
  });
});
