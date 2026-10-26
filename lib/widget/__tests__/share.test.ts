import { describe, expect, it } from "vitest";
import { OCCASION_THEMES } from "@/lib/email/templates";
import { cardTheme, cleanMessage, cleanName, messengerShareUrl, shareLinks, shareText, whatsappShareUrl, ZALO_WEB_URL } from "../share";

const LINK = "https://giftfit.example/r/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd";

describe("e-card theme", () => {
  it("uses the e-mail template themes per occasion and card language", () => {
    expect(cardTheme("anniversary", "en")).toEqual({ occasion: "anniversary", accent: OCCASION_THEMES.anniversary.accent, tint: OCCASION_THEMES.anniversary.tint, headline: "Happy anniversary" });
    expect(cardTheme("birthday", "vi").headline).toBe("Chúc mừng sinh nhật");
    expect(cardTheme("nonsense", "en").occasion).toBe("just_because");
  });

  it("cleans names and messages", () => {
    expect(cleanName(" Mai\r\nAnh ")).toBe("Mai Anh");
    expect(cleanName("x".repeat(100))).toHaveLength(60);
    expect(cleanMessage("Hi\r\n\r\n\r\n\r\nlove\u0007you")).toBe("Hi\n\nlove you");
    expect(cleanMessage(42)).toBe("");
  });
});

describe("share builders", () => {
  it("builds the share text in the card language", () => {
    expect(shareText({ lang: "en", occasion: "anniversary", message: "Pick what you love!", link: LINK })).toBe(`Happy anniversary! Pick what you love!\nOpen your gift: ${LINK}`);
    expect(shareText({ lang: "vi", occasion: "birthday", link: LINK })).toBe(`Chúc mừng sinh nhật! Mở quà của bạn: ${LINK}`);
  });

  it("WhatsApp uses wa.me with the encoded text", () => {
    const url = whatsappShareUrl("Hi & bye\nhttps://x.example/r/a?b=c");
    expect(url.startsWith("https://wa.me/?text=")).toBe(true);
    expect(decodeURIComponent(url.slice("https://wa.me/?text=".length))).toBe("Hi & bye\nhttps://x.example/r/a?b=c");
  });

  it("Messenger: web Send Dialog with an app id, else the mobile scheme", () => {
    expect(messengerShareUrl(LINK)).toBe(`fb-messenger://share/?link=${encodeURIComponent(LINK)}`);
    const web = new URL(messengerShareUrl(LINK, { appId: "1234567890" }));
    expect(web.origin + web.pathname).toBe("https://www.facebook.com/dialog/send");
    expect(web.searchParams.get("app_id")).toBe("1234567890");
    expect(web.searchParams.get("link")).toBe(LINK);
    expect(messengerShareUrl(LINK, { appId: "abc" })).toMatch(/^fb-messenger:/);
  });

  it("refuses non-http links everywhere", () => {
    expect(() => messengerShareUrl("javascript:alert(1)")).toThrow();
    expect(() => shareText({ lang: "en", occasion: "birthday", link: "data:text/html,x" })).toThrow();
  });

  it("bundles every target", () => {
    const l = shareLinks({ lang: "en", occasion: "wedding", link: LINK, facebookAppId: "1234567890" });
    expect(l.zaloWeb).toBe(ZALO_WEB_URL);
    expect(l.whatsapp).toContain(encodeURIComponent(LINK));
    expect(l.messenger).toContain("facebook.com/dialog/send");
    expect(l.text).toContain("Congratulations on your wedding");
  });
});
