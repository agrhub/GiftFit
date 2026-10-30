import { describe, expect, it, vi } from "vitest";
import type { NormalizedMessage } from "../address";
import { createConsoleSender } from "../providers/console";
import { createResendSender, RESEND_API_URL } from "../providers/resend";
import { classifySmtpError, createSmtpSender, redactResponse, smtpTransportOptions, type SmtpTransportLike } from "../providers/smtp";
import { EmailSendError, EmailValidationError } from "../types";

const MSG = { to: "Lan.Nguyen@Recipient.Example.test", subject: "Minh sent you a gift card", html: "<p>secret body</p>", text: "secret body" };
const SMTP_CFG = { host: "smtp.example.test", port: 465, secure: true, user: "u@example.test", pass: "fake-pass" };

describe("console provider", () => {
  it("logs only the recipient domain and subject", async () => {
    const lines: string[] = [];
    const outbox: NormalizedMessage[] = [];
    const s = createConsoleSender({ log: (l) => lines.push(l), outbox, note: "send_disabled" });
    const r = await s.send(MSG);
    expect(r.provider).toBe("console");
    expect(r.accepted).toEqual([MSG.to]);
    expect(r.messageId).toMatch(/^console-[0-9a-f]{16}$/);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("recipient.example.test");
    expect(lines[0]).toContain(MSG.subject);
    expect(lines[0]).toContain("send_disabled");
    expect(lines[0]).not.toContain("Lan.Nguyen");
    expect(lines[0]).not.toContain("secret body");
    expect(outbox[0].to).toEqual([MSG.to]);
  });

  it("uses console.info by default without leaking the address", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    await createConsoleSender().send(MSG);
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0][0])).not.toContain("Lan.Nguyen");
  });

  it("validates before sending", async () => {
    const s = createConsoleSender({ log: () => {} });
    await expect(s.send({ ...MSG, to: "bad address" })).rejects.toBeInstanceOf(EmailValidationError);
    await expect(s.send({ ...MSG, to: "a@example.test\r\nBcc: b@example.test" })).rejects.toBeInstanceOf(EmailValidationError);
    await expect(s.send({ ...MSG, to: [] })).rejects.toBeInstanceOf(EmailValidationError);
    await expect(s.send({ ...MSG, replyTo: "nope" })).rejects.toBeInstanceOf(EmailValidationError);
    await expect(s.send({ ...MSG, text: " " })).rejects.toBeInstanceOf(EmailValidationError);
  });
});

describe("smtp provider", () => {
  it("keeps TLS certificate and hostname checks on, and requires STARTTLS off 465", () => {
    const o = smtpTransportOptions(SMTP_CFG);
    expect(o.secure).toBe(true);
    expect(o.tls).toEqual({ minVersion: "TLSv1.2", servername: "smtp.example.test" });
    expect("rejectUnauthorized" in o.tls).toBe(false);
    expect(o.disableFileAccess && o.disableUrlAccess).toBe(true);
    const starttls = smtpTransportOptions({ ...SMTP_CFG, port: 587, secure: false });
    expect(starttls.requireTLS).toBe(true);
    expect(smtpTransportOptions({ ...SMTP_CFG, user: undefined }).auth).toBeUndefined();
  });

  it("sends through the transport with from, reply-to and sanitised subject", async () => {
    const sendMail = vi.fn(async (mail: Record<string, unknown>) => ({ accepted: mail.to as string[], rejected: [], messageId: "<id@example.test>", response: "250 2.0.0 Ok: queued for x@example.test" }));
    const transport: SmtpTransportLike = { sendMail, verify: async () => true };
    const s = createSmtpSender(SMTP_CFG, { from: "sender@example.test", fromName: "GiftFit", replyTo: "reply@example.test", transport });
    const r = await s.send({ ...MSG, subject: "Hi\r\nBcc: evil@example.test", tags: [{ name: "type", value: "gift card" }] });
    expect(r).toMatchObject({ provider: "smtp", accepted: [MSG.to], rejected: [], messageId: "<id@example.test>" });
    expect(r.response).toBe("250 2.0.0 Ok: queued for <redacted>");
    const mail = sendMail.mock.calls[0][0];
    expect(mail.from).toEqual({ name: "GiftFit", address: "sender@example.test" });
    expect(mail.replyTo).toBe("reply@example.test");
    expect(mail.subject).toBe("Hi Bcc: evil@example.test");
    expect((mail.headers as Record<string, string>)["X-GiftFit-Tags"]).toBe("type=gift_card");
    expect((mail.headers as Record<string, string>)["List-Unsubscribe"]).toBe("<mailto:reply@example.test?subject=unsubscribe>");
    expect((mail.headers as Record<string, string>)["List-Unsubscribe-Post"]).toBeUndefined();
  });

  it("adds one-click List-Unsubscribe when the message has an https unsubscribe url", async () => {
    const sendMail = vi.fn(async (mail: Record<string, unknown>) => ({ accepted: mail.to as string[], rejected: [], messageId: "<id@example.test>" }));
    const s = createSmtpSender(SMTP_CFG, { from: "sender@example.test", transport: { sendMail, verify: async () => true } });
    await s.send({ ...MSG, unsubscribeUrl: "https://giftfit.example.test/u/abc" });
    const h = sendMail.mock.calls[0][0].headers as Record<string, string>;
    expect(h["List-Unsubscribe"]).toBe("<https://giftfit.example.test/u/abc>, <mailto:sender@example.test?subject=unsubscribe>");
    expect(h["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    await expect(s.send({ ...MSG, unsubscribeUrl: "http://giftfit.example.test/u/abc" })).rejects.toBeInstanceOf(EmailValidationError);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("wraps transport errors in a print-safe EmailSendError", async () => {
    const authErr = Object.assign(new Error("Invalid login: 535 5.7.8 for u@example.test"), { code: "EAUTH", responseCode: 535, command: "AUTH PLAIN" });
    const transport: SmtpTransportLike = { sendMail: async () => Promise.reject(authErr), verify: async () => Promise.reject(authErr) };
    const s = createSmtpSender(SMTP_CFG, { from: "sender@example.test", transport });
    const e1 = await s.send(MSG).catch((e) => e);
    expect(e1).toBeInstanceOf(EmailSendError);
    expect(e1.code).toBe("EAUTH");
    expect(e1.message).not.toContain("u@example.test");
    const e2 = await s.verify!().catch((e) => e);
    expect(e2.message).toBe("smtp verify failed: auth (EAUTH)");
  });

  it("classifies common SMTP failures", () => {
    expect(classifySmtpError(Object.assign(new Error("x"), { code: "ESOCKET", originalCode: "CERT_HAS_EXPIRED" })).errorClass).toBe("tls_certificate");
    expect(classifySmtpError(Object.assign(new Error("Hostname/IP does not match certificate's altnames"), { code: "ESOCKET", originalCode: "ERR_TLS_CERT_ALTNAME_INVALID" })).errorClass).toBe(
      "tls_certificate",
    );
    expect(classifySmtpError(Object.assign(new Error("x"), { code: "ESOCKET", originalCode: "ECONNREFUSED" })).errorClass).toBe("connection");
    expect(classifySmtpError(Object.assign(new Error("x"), { code: "ETIMEDOUT" })).errorClass).toBe("timeout");
    expect(classifySmtpError(Object.assign(new Error("x"), { code: "EDNS", originalCode: "ENOTFOUND" })).errorClass).toBe("dns");
    expect(classifySmtpError(new Error("weird"))).toMatchObject({ errorClass: "other", code: "UNKNOWN" });
    expect(classifySmtpError(Object.assign(new Error("x"), { code: "lower case <x@y.z>" })).code).toBe("UNKNOWN");
  });

  it("redacts addresses in response lines", () => {
    expect(redactResponse("250 OK <a.b@c.example.test> queued\r\n")).toBe("250 OK <<redacted>> queued ");
  });
});

describe("resend provider", () => {
  it("POSTs the message with a bearer key and returns the id", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ id: "re-msg-1" }));
    const s = createResendSender({ apiKey: "re_fake_key", from: "sender@example.test", fromName: "GiftFit", fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await s.send({ ...MSG, replyTo: "r@example.test", tags: [{ name: "type", value: "gift_card" }] });
    expect(r).toEqual({ accepted: [MSG.to], rejected: [], messageId: "re-msg-1", provider: "resend" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(RESEND_API_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_fake_key");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ from: "GiftFit <sender@example.test>", to: [MSG.to], reply_to: "r@example.test", tags: [{ name: "type", value: "gift_card" }] });
    expect(body.headers["List-Unsubscribe"]).toBe("<mailto:r@example.test?subject=unsubscribe>");
  });

  it("maps HTTP errors without echoing the key", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ name: "validation_error", message: "bad from re_fake_key" }, { status: 422 }));
    const s = createResendSender({ apiKey: "re_fake_key", from: "sender@example.test", fetchImpl: fetchImpl as unknown as typeof fetch });
    const e = await s.send(MSG).catch((x) => x);
    expect(e).toBeInstanceOf(EmailSendError);
    expect(e.code).toBe("HTTP_422");
    expect(e.message).toBe("resend rejected the message (HTTP 422: validation_error)");
    expect(e.message).not.toContain("re_fake_key");
  });

  it("maps network failures", async () => {
    const fetchImpl = vi.fn(async () => Promise.reject(new TypeError("fetch failed")));
    const s = createResendSender({ apiKey: "k", from: "sender@example.test", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(s.send(MSG)).rejects.toMatchObject({ code: "ECONNECTION", provider: "resend" });
  });
});
