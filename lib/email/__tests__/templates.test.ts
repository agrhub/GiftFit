import { describe, expect, it } from "vitest";
import { escapeHtml, safeHref } from "../escape";
import { appBaseUrl, giverReportUrl, recipientUrl } from "../links";
import { fitReportReadyEmail, giftCardEmail, OCCASION_THEMES } from "../templates";

const FOOTER = "Didn't expect this? Ignore it — the link expires in 72 h. Report abuse: reply to this email.";
const BASE = "https://giftfit.example.test";

describe("escapeHtml / safeHref", () => {
  it("escapes the five specials and backticks", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&\``)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&#96;");
  });
  it("only allows http(s) hrefs", () => {
    expect(safeHref("javascript:alert(1)")).toBe("#");
    expect(safeHref("data:text/html,x")).toBe("#");
    expect(safeHref("https://a.example.test/r/x?y=1&z=2")).toBe("https://a.example.test/r/x?y=1&amp;z=2");
  });
});

describe("appBaseUrl and link building", () => {
  it("prefers APP_BASE_URL, then the request origin, then localhost", () => {
    const req = new Request("https://from-request.example.test/api/x?y=1");
    expect(appBaseUrl(req, { APP_BASE_URL: "https://app.example.test/some/path/" })).toBe("https://app.example.test");
    expect(appBaseUrl(req, {})).toBe("https://from-request.example.test");
    expect(appBaseUrl(undefined, {})).toBe("http://localhost:3000");
  });
  it("ignores non-http or credentialed APP_BASE_URL values", () => {
    const req = new Request("https://from-request.example.test/");
    expect(appBaseUrl(req, { APP_BASE_URL: "javascript:alert(1)" })).toBe("https://from-request.example.test");
    expect(appBaseUrl(req, { APP_BASE_URL: "https://u:p@evil.example.test" })).toBe("https://from-request.example.test");
    expect(appBaseUrl(req, { APP_BASE_URL: "not a url" })).toBe("https://from-request.example.test");
  });
  it("builds /r/{token} and /g/{token}, encoding the token", () => {
    expect(recipientUrl("abc_DEF-123", BASE)).toBe(`${BASE}/r/abc_DEF-123`);
    expect(giverReportUrl("tok", `${BASE}/ignored`)).toBe(`${BASE}/g/tok`);
    expect(recipientUrl("a/../b?c", BASE)).toBe(`${BASE}/r/a%2F..%2Fb%3Fc`);
    expect(() => recipientUrl("", BASE)).toThrow();
  });
});

describe("giftCardEmail", () => {
  const evil = `<script>alert("x")</script><img src=https://track.example.test/p.gif>`;

  it("escapes every user-supplied value in HTML", () => {
    const m = giftCardEmail({ occasion: "birthday", giverName: evil, recipientName: "<b>Lan</b>", message: `${evil}\nline 2`, recipientToken: "tok", baseUrl: BASE });
    expect(m.html).not.toContain("<script");
    expect(m.html).not.toContain("<img");
    expect(m.html).not.toContain("<b>Lan</b>");
    expect(m.html).toContain("&lt;script&gt;");
    expect(m.html).toContain("&lt;b&gt;Lan&lt;/b&gt;");
    expect(m.html).toContain("<br>line 2");
  });

  it("has no images, remote resources or tracking, and a single destination link", () => {
    const m = giftCardEmail({ occasion: "anniversary", giverName: "Minh", message: "Love you", recipientToken: "tok123", baseUrl: BASE });
    expect(m.html).not.toMatch(/<img|<link|<script|url\(|src=/i);
    const hrefs = [...m.html.matchAll(/href="([^"]+)"/g)].map((x) => x[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    expect(new Set(hrefs)).toEqual(new Set([`${BASE}/r/tok123`]));
  });

  it("includes the CTA link, theme and footer in HTML and text", () => {
    const m = giftCardEmail({ occasion: "anniversary", giverName: "Minh", message: "Love you\nalways", recipientToken: "tok123", baseUrl: BASE });
    expect(m.subject).toBe("Minh sent you a gift card");
    expect(m.html).toContain(OCCASION_THEMES.anniversary.accent);
    expect(m.html).toContain("Happy anniversary");
    expect(m.html).toContain(escapeHtml(FOOTER));
    expect(m.html).toContain('lang="en"');
    expect(m.text).toContain(FOOTER);
    expect(m.text).toContain(`${BASE}/r/tok123`);
    expect(m.text).toContain("> Love you\n> always");
    expect(m.text).not.toMatch(/<[a-z]/i);
  });

  it("renders Vietnamese cards and falls back to English for unknown languages", () => {
    const vi = giftCardEmail({ occasion: "wedding", lang: "vi", giverName: "Minh", recipientToken: "t", baseUrl: BASE });
    expect(vi.subject).toBe("Minh đã gửi bạn một thiệp quà");
    expect(vi.html).toContain('lang="vi"');
    expect(vi.html).toContain("Chúc mừng ngày cưới");
    expect(vi.text).toContain("72 giờ");
    expect(giftCardEmail({ occasion: "wedding", lang: "fr", recipientToken: "t", baseUrl: BASE }).html).toContain('lang="en"');
  });

  it("unknown occasions use the just_because theme; no giver name still reads well", () => {
    const m = giftCardEmail({ occasion: "<x>", recipientToken: "t", baseUrl: BASE });
    expect(m.html).toContain(OCCASION_THEMES.just_because.accent);
    expect(m.subject).toBe("You've received a GiftFit gift card");
  });

  it("keeps CR/LF out of the subject and caps long inputs", () => {
    const m = giftCardEmail({ occasion: "birthday", giverName: "A\r\nBcc: x@example.test" + "z".repeat(200), message: "m".repeat(5000), recipientToken: "t", baseUrl: BASE });
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.subject.length).toBeLessThanOrEqual(200);
    expect(m.text).not.toContain("m".repeat(601));
  });

  it("uses APP_BASE_URL-derived links by default (localhost when unset)", () => {
    const m = giftCardEmail({ occasion: "birthday", recipientToken: "t" });
    expect(m.text).toMatch(/https?:\/\/[^/\s]+\/r\/t/);
  });
});

describe("fitReportReadyEmail", () => {
  it("links to the giver report, escapes names and carries the footer", () => {
    const m = fitReportReadyEmail({ giverName: "<i>Minh</i>", recipientName: "Lan", giverToken: "gtok", baseUrl: BASE });
    expect(m.subject).toBe("Lan's Fit Report is ready");
    expect(m.html).toContain(`href="${BASE}/g/gtok"`);
    expect(m.html).not.toContain("<i>Minh</i>");
    expect(m.html).toContain(escapeHtml(FOOTER));
    expect(m.text).toContain(`${BASE}/g/gtok`);
    expect(m.text).toContain(FOOTER);
    expect(m.html).not.toMatch(/<img|src=/i);
  });

  it("supports vi", () => {
    const m = fitReportReadyEmail({ lang: "vi", giverToken: "g", baseUrl: BASE });
    expect(m.subject).toBe("Fit Report của bạn đã sẵn sàng");
    expect(m.html).toContain('lang="vi"');
  });
});
