import { describe, expect, it } from "vitest";
import type { GiftBrief } from "@/lib/contracts/api";
import { defaultConciergeCatalog, searchCatalog } from "../catalog";
import { GroundingLedger, ProseScrubber, sanitizeReason, scrubProse, validateBrief, validateSuggestions } from "../grounding";

const catalog = defaultConciergeCatalog();
const HALO = "dca42809-a2e1-5b50-8339-240170c69845"; // Halo Drop Earrings: yellow 245, rose 249, white 265
const DOT = "0ace33fe-4801-5f52-a56c-462d2b2c97de"; // Dot Bezel Studs: silver 198, yellow 425, rose 425
const PEARL_1050 = "06e30d30-7b89-54a1-8344-ee721c917337";
const FAKE = "deadbeef-dead-beef-dead-beefdeadbeef";
const brief: GiftBrief = { mode: "help_me_choose", occasion: "anniversary", budgetMax: 250, currency: "USD" };

const ledgerWith = (...ids: string[]) => {
  const l = new GroundingLedger();
  l.add(ids);
  return l;
};

describe("validateSuggestions (adversarial model output)", () => {
  it("strips an unknown SKU id, an id no tool returned, and a design with no variant within budget", () => {
    const { suggestions, dropped } = validateSuggestions(
      [
        { catalogId: FAKE, reason: "made up" },
        { catalogId: DOT, reason: "not returned by any tool" },
        { catalogId: PEARL_1050, reason: "over budget" },
        { catalogId: HALO, reason: "ok" },
      ],
      brief,
      catalog,
      ledgerWith(FAKE, PEARL_1050, HALO),
    );
    expect(suggestions.map((s) => s.catalogId)).toEqual([HALO]);
    expect(dropped).toBe(3);
  });

  it("recomputes prices from the catalog and keeps only variants within the cap and lock", () => {
    const { suggestions } = validateSuggestions([{ catalogId: HALO, reason: "ok", price: 1, fromPrice: 1, eligibleMetals: [{ metal: "platinum", price: 1 }] }], brief, catalog, ledgerWith(HALO));
    expect(suggestions[0].eligibleMetals).toEqual([
      { metal: "yellow_gold", price: 245 },
      { metal: "rose_gold", price: 249 },
    ]);
    expect(suggestions[0].fromPrice).toBe(245);
    const locked = validateSuggestions([{ catalogId: DOT, reason: "x" }], { ...brief, budgetMax: 500, metalLock: ["rose_gold"] }, catalog, ledgerWith(DOT));
    expect(locked.suggestions[0].eligibleMetals).toEqual([{ metal: "rose_gold", price: 425 }]);
  });

  it("caps at 3, dedupes, and ignores non-objects", () => {
    const { rows } = searchCatalog(catalog, { maxPrice: 250, limit: 6 });
    const ids = rows.map((r) => r.id);
    const { suggestions } = validateSuggestions([null, "x", ...ids.map((catalogId) => ({ catalogId, reason: "r" })), { catalogId: ids[0], reason: "dup" }], brief, catalog, ledgerWith(...ids));
    expect(suggestions).toHaveLength(3);
    expect(new Set(suggestions.map((s) => s.catalogId)).size).toBe(3);
  });

  it("scrubs reasons", () => {
    expect(sanitizeReason(`Great ${HALO} see https://evil.example/x.png and #c68e6b, ${"a".repeat(300)}`)).not.toMatch(/https|#c68e6b|dca42809/);
    expect(sanitizeReason(`${"a".repeat(300)}`).length).toBeLessThanOrEqual(220);
    expect(sanitizeReason(42)).toBe("");
  });
});

describe("validateBrief", () => {
  it("drops unknown (recipient-like) fields and normalises", () => {
    const v = validateBrief({ ...brief, currency: "usd", selfie: "data:image/png;base64,AA", undertone: "warm", faceShape: "Oval", categories: ["ring", "ring"] }, catalog, null);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.brief).toEqual({ ...brief, categories: ["ring"] });
  });

  it("rejects another currency, a non-positive budget and unknown enums", () => {
    expect(validateBrief({ ...brief, currency: "VND", budgetMax: 2_000_000 }, catalog, null).ok).toBe(false);
    expect(validateBrief({ ...brief, budgetMax: 0 }, catalog, null).ok).toBe(false);
    expect(validateBrief({ ...brief, occasion: "funeral" }, catalog, null).ok).toBe(false);
    expect(validateBrief({ ...brief, metalLock: ["unobtainium"] }, catalog, null).ok).toBe(false);
  });

  it("rejects a budget below every eligible design and says where prices start", () => {
    const v = validateBrief({ ...brief, budgetMax: 5 }, catalog, null);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors[0]).toMatch(/cheapest starts at \d+/);
  });

  it("i_have_ideas keeps only grounded, eligible shortlist ids, else falls back to help_me_choose", () => {
    const ok = validateBrief({ ...brief, mode: "i_have_ideas", shortlistIds: [HALO, FAKE, PEARL_1050] }, catalog, ledgerWith(HALO, PEARL_1050));
    expect(ok.ok && ok.brief).toMatchObject({ mode: "i_have_ideas", shortlistIds: [HALO] });
    const none = validateBrief({ ...brief, mode: "i_have_ideas", shortlistIds: [HALO] }, catalog, ledgerWith());
    expect(none.ok && none.brief.mode).toBe("help_me_choose");
    expect(none.ok && none.brief.shortlistIds).toBeUndefined();
  });

  it("help_me_choose never carries a shortlist", () => {
    const v = validateBrief({ ...brief, shortlistIds: [HALO] }, catalog, ledgerWith(HALO));
    expect(v.ok && v.brief.shortlistIds).toBeUndefined();
  });
});

describe("prose scrubbing", () => {
  it("removes ids, SKU codes, URLs, app paths and hex values", () => {
    const s = scrubProse(`Try ${HALO}:yellow_gold (AUR-EAR-028) at https://x.y/z or /catalog/aurum/a.png, colour #aabbcc.`);
    expect(s).not.toMatch(/dca42809|AUR-EAR-028|https|\/catalog\/|#aabbcc/);
    expect(s).toMatch(/^Try/);
  });

  it("catches an id split across stream deltas", () => {
    const sc = new ProseScrubber();
    const deltas = ["Here is ", HALO.slice(0, 10), HALO.slice(10, 25), `${HALO.slice(25)} for you`, " today."];
    const out = deltas.map((d) => sc.push(d)).join("") + sc.flush();
    expect(out).not.toContain(HALO.slice(0, 8));
    expect(out).toContain("Here is");
    expect(out).toContain("today.");
  });
});
