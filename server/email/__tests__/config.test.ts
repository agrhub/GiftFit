import { describe, expect, it } from "vitest";
import { describeEmailConfig, readSmtpConfig, selectEmailProvider } from "../config";
import { createEmailSender } from "../index";

// Fake values only; nothing here touches the network.
const SMTP = {
  SMTP_HOST: "smtp.example.test",
  SMTP_PORT: "465",
  SMTP_SECURE: "true",
  SMTP_USER: "user@example.test",
  SMTP_PASS: "not-a-real-pass",
  EMAIL_FROM: "sender@example.test",
};
const LIVE = { NODE_ENV: "production", YOUCAM_MOCK: "0" };

describe("selectEmailProvider", () => {
  it("defaults to smtp when SMTP_HOST is set and sending is enabled", () => {
    expect(selectEmailProvider({ ...LIVE, ...SMTP, EMAIL_SEND_ENABLED: "1" })).toEqual({ provider: "smtp", requested: "smtp", reason: "ok" });
  });

  it("is console when nothing is configured", () => {
    expect(selectEmailProvider({ ...LIVE, EMAIL_SEND_ENABLED: "1" })).toMatchObject({ provider: "console", reason: "not_configured" });
  });

  it("always uses console under NODE_ENV=test or YOUCAM_MOCK=1", () => {
    const base = { ...SMTP, EMAIL_SEND_ENABLED: "1", EMAIL_PROVIDER: "smtp" };
    expect(selectEmailProvider({ ...base, NODE_ENV: "test" })).toMatchObject({ provider: "console", reason: "mock_mode" });
    expect(selectEmailProvider({ ...base, NODE_ENV: "production", YOUCAM_MOCK: "1" })).toMatchObject({ provider: "console", reason: "mock_mode" });
  });

  it("kill-switch: real providers need EMAIL_SEND_ENABLED=1 exactly", () => {
    for (const v of [undefined, "", "0", "true", "yes"]) {
      expect(selectEmailProvider({ ...LIVE, ...SMTP, EMAIL_SEND_ENABLED: v })).toMatchObject({ provider: "console", requested: "smtp", reason: "send_disabled" });
    }
    expect(selectEmailProvider({ ...LIVE, EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_fake", EMAIL_FROM: "a@example.test" })).toMatchObject({
      provider: "console",
      requested: "resend",
      reason: "send_disabled",
    });
  });

  it("selects resend only when asked and configured", () => {
    const env = { ...LIVE, ...SMTP, EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_fake", EMAIL_SEND_ENABLED: "1" };
    expect(selectEmailProvider(env)).toEqual({ provider: "resend", requested: "resend", reason: "ok" });
    expect(selectEmailProvider({ ...env, RESEND_API_KEY: "" })).toMatchObject({ provider: "console", reason: "resend_config_missing" });
  });

  it("falls back to console on missing config or an unknown provider", () => {
    expect(selectEmailProvider({ ...LIVE, ...SMTP, EMAIL_FROM: "", EMAIL_SEND_ENABLED: "1" })).toMatchObject({ provider: "console", reason: "smtp_config_missing" });
    expect(selectEmailProvider({ ...LIVE, EMAIL_PROVIDER: "smtp", EMAIL_SEND_ENABLED: "1", EMAIL_FROM: "a@example.test" })).toMatchObject({
      provider: "console",
      reason: "smtp_config_missing",
    });
    expect(selectEmailProvider({ ...LIVE, ...SMTP, EMAIL_PROVIDER: "sendgrid", EMAIL_SEND_ENABLED: "1" })).toMatchObject({ provider: "console", reason: "unknown_provider" });
    expect(selectEmailProvider({ ...LIVE, ...SMTP, EMAIL_PROVIDER: "console", EMAIL_SEND_ENABLED: "1" })).toMatchObject({ provider: "console", reason: "explicit_console" });
  });

  it("an invalid EMAIL_FROM counts as missing", () => {
    expect(selectEmailProvider({ ...LIVE, ...SMTP, EMAIL_FROM: "not an address", EMAIL_SEND_ENABLED: "1" })).toMatchObject({ reason: "smtp_config_missing" });
    expect(selectEmailProvider({ ...LIVE, ...SMTP, EMAIL_FROM: "GiftFit <sender@example.test>", EMAIL_SEND_ENABLED: "1" })).toMatchObject({ provider: "smtp" });
  });
});

describe("readSmtpConfig", () => {
  it("parses port and secure, defaulting to implicit TLS on 465", () => {
    expect(readSmtpConfig(SMTP)).toMatchObject({ port: 465, secure: true });
    expect(readSmtpConfig({ SMTP_HOST: "h.example.test" })).toMatchObject({ port: 465, secure: true });
    expect(readSmtpConfig({ SMTP_HOST: "h.example.test", SMTP_PORT: "587" })).toMatchObject({ port: 587, secure: false });
    expect(readSmtpConfig({ SMTP_HOST: "h.example.test", SMTP_SECURE: "false" })).toMatchObject({ port: 587, secure: false });
    expect(readSmtpConfig({})).toBeUndefined();
  });
});

describe("describeEmailConfig", () => {
  it("reports presence flags, never values", () => {
    const out = JSON.stringify(describeEmailConfig({ ...LIVE, ...SMTP, EMAIL_SEND_ENABLED: "1" }));
    for (const v of Object.values(SMTP).filter((v) => v.length > 4)) expect(out).not.toContain(v);
    expect(out).toContain('"smtpAuthSet":true');
  });
});

describe("createEmailSender", () => {
  it("returns the console sender in this test process even with full SMTP config", () => {
    const { sender, selection } = createEmailSender({ ...SMTP, NODE_ENV: "test", EMAIL_SEND_ENABLED: "1" });
    expect(sender.provider).toBe("console");
    expect(selection.reason).toBe("mock_mode");
  });

  it("builds real providers when selected (no network until send)", () => {
    expect(createEmailSender({ ...LIVE, ...SMTP, EMAIL_SEND_ENABLED: "1" }).sender.provider).toBe("smtp");
    expect(createEmailSender({ ...LIVE, EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_fake", EMAIL_FROM: "a@example.test", EMAIL_SEND_ENABLED: "1" }).sender.provider).toBe(
      "resend",
    );
  });
});
