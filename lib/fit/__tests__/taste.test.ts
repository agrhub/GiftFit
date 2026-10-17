/**
 * "Help me choose" report extras (ADR-045): the taste summary (template, Claude with validation,
 * spend-cap fallback, privacy of the prompt) and the "not tried on" picks.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import type { CatalogSku, Metal } from "@/lib/contracts/giftfit";
import aurum from "@/data/aurum/catalog.json";
import { DEFAULT_CLAUDE_MODEL } from "@/lib/anthropic/budget";
import { ClaudeSpendRefused } from "../claude";
import { curate, silhouetteOf, styleFamilyOf } from "../curate";
import { genderOf } from "../decoys";
import {
  AnthropicTasteClient,
  TASTE_MAX_TOKENS,
  type TasteClient,
  type TasteInput,
  buildTasteInput,
  checkTasteText,
  createTasteClient,
  similarNotTried,
  tasteSummary,
  templateTasteSummary,
} from "../taste";
import { eligibleVariants, variantsOf } from "../variants";
import { fakeRules } from "./fixtures";

const AURUM = aurum as unknown as CatalogSku[];
const byTitle = (t: string) => AURUM.find((s) => s.title === t)!;
const hearted = [
  { sku: byTitle("Arc Mini Hoops"), metal: "mixed_two_tone" as Metal },
  { sku: byTitle("Strand Box Chain"), metal: variantsOf(byTitle("Strand Box Chain"))[0].metal },
];
const INPUT = buildTasteInput(hearted, 6, 1);
const REFS = AURUM.map((s) => ({ id: s.id, title: s.title }));

describe("buildTasteInput (the only input of the template and the Claude prompt)", () => {
  it("holds catalog attributes and counts only", () => {
    expect(Object.keys(INPUT).sort()).toEqual(["hearted", "heartedCount", "shownCount", "wishedCount"]);
    for (const h of INPUT.hearted) expect(Object.keys(h).sort()).toEqual(["category", "metal", "silhouette", "style"]);
    const text = JSON.stringify(INPUT);
    for (const re of [/undertone/i, /face/i, /skin/i, /confidence/i, /#[0-9a-f]{6}/i, /photo|selfie|image|http/i, /"L"|"lab"|hue/i]) expect(text).not.toMatch(re);
    // No product names or ids either.
    for (const h of hearted) {
      expect(text).not.toContain(h.sku.title);
      expect(text).not.toContain(h.sku.id);
    }
  });
});

describe("templateTasteSummary", () => {
  it("summarises style, metal and shapes from the hearts", () => {
    const t = templateTasteSummary(INPUT);
    expect(t).toMatch(/^They hearted 2 of 6 pieces\./);
    expect(t).toMatch(/minimal/);
    expect(t).toMatch(/hoops/);
    expect(t).toMatch(/wished for another metal/);
    expect(checkTasteText(t, REFS)).toEqual([]);
  });

  it("says there is no clear signal without hearts", () => {
    const t = templateTasteSummary({ shownCount: 7, heartedCount: 0, wishedCount: 0, hearted: [] });
    expect(t).toMatch(/didn't heart any of the 7 pieces/);
  });
});

describe("tasteSummary (Claude with validation, template fallback)", () => {
  const client = (out: unknown): TasteClient & { calls: TasteInput[] } => {
    const calls: TasteInput[] = [];
    return {
      model: DEFAULT_CLAUDE_MODEL,
      calls,
      summarize: async (i) => {
        calls.push(i);
        if (out instanceof Error) throw out;
        return out;
      },
    };
  };

  it("uses the model's text when it passes the checks (source claude)", async () => {
    const c = client({ summary: "Their hearts lean minimal, in two-tone metal and rose gold, with a liking for small hoops and fine chains." });
    const r = await tasteSummary(INPUT, { client: c, catalog: REFS });
    expect(r.summary.source).toBe("claude");
    expect(c.calls).toEqual([INPUT]);
  });

  it.each([
    ["names a product", "They loved the Arc Mini Hoops in two-tone."],
    ["mentions the undertone", "Their warm undertone suits yellow gold."],
    ["mentions a photo", "From their photo, they like hoops."],
    ["hex", "They like #D4AF37 metals."],
    ["too long", Array.from({ length: 60 }, () => "word").join(" ")],
    ["empty", ""],
  ])("falls back to the template when the output %s", async (_label, text) => {
    const r = await tasteSummary(INPUT, { client: client({ summary: text }), catalog: REFS });
    expect(r.summary).toEqual({ text: templateTasteSummary(INPUT), source: "template" });
    expect(r.issue).toBeTruthy();
  });

  it("spend-cap refusal or API error → template", async () => {
    expect((await tasteSummary(INPUT, { client: client(new ClaudeSpendRefused("daily_cap")) })).issue).toBe("spend_cap");
    expect((await tasteSummary(INPUT, { client: client(new Error("boom")) })).issue).toBe("client_error");
    expect((await tasteSummary(INPUT, { client: client(new Error("boom")) })).summary.source).toBe("template");
  });

  it("no hearts or no key: template without calling Claude", async () => {
    const c = client({ summary: "x" });
    expect((await tasteSummary({ ...INPUT, heartedCount: 0, hearted: [] }, { client: c })).summary.source).toBe("template");
    expect(c.calls).toHaveLength(0);
    expect((await tasteSummary(INPUT, { client: null })).summary.source).toBe("template");
    expect(createTasteClient({})).toBeNull();
    expect(createTasteClient({ ANTHROPIC_API_KEY: "test-key-not-real" })).toBeInstanceOf(AnthropicTasteClient);
  });
});

describe("AnthropicTasteClient (SDK mocked)", () => {
  it("sends only the taste input, caches the system prompt, keeps max_tokens tight and settles the spend", async () => {
    const usage = { input_tokens: 400, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    const create = vi.fn(async () => ({ stop_reason: "end_turn", model: DEFAULT_CLAUDE_MODEL, usage, content: [{ type: "text", text: JSON.stringify({ summary: "ok" }) }] }));
    const settled: unknown[] = [];
    const reserve = vi.fn(async () => ({ ok: true as const, settle: async (u: unknown) => void settled.push(u) }));
    const c = new AnthropicTasteClient({ beta: { messages: { create } } } as unknown as Anthropic, { reserve });
    expect(await c.summarize(INPUT)).toEqual({ summary: "ok" });
    const params = (create.mock.calls[0] as unknown as [Record<string, unknown>])[0] as {
      model: string;
      max_tokens: number;
      system: { text: string; cache_control?: unknown }[];
      messages: { content: string }[];
    };
    expect(params.model).toBe(DEFAULT_CLAUDE_MODEL);
    expect(params.max_tokens).toBe(TASTE_MAX_TOKENS);
    expect(params.max_tokens).toBeLessThanOrEqual(300);
    expect(params.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(JSON.parse(params.messages[0].content)).toEqual(INPUT);
    expect(settled).toEqual([usage]);
  });

  it("spend cap refuses before any request", async () => {
    const create = vi.fn();
    const c = new AnthropicTasteClient({ beta: { messages: { create } } } as unknown as Anthropic, { reserve: async () => ({ ok: false, reason: "daily_cap" }) });
    const r = await tasteSummary(INPUT, { client: c });
    expect(create).not.toHaveBeenCalled();
    expect(r).toMatchObject({ issue: "spend_cap", summary: { source: "template" } });
  });
});

describe("similarNotTried", () => {
  const request = { budgetMax: 300, currency: "USD" };
  const shown = curate(AURUM, { seed: "sim", occasion: "birthday", request, categories: ["earring", "necklace"], rules: fakeRules });
  const shownSkus = shown.ids.map((id) => AURUM.find((s) => s.id === id)!);
  const hearts = shownSkus.slice(0, 2).map((s) => ({ sku: s, metal: eligibleVariants(s, request)[0].metal }));

  it("returns 2–3 designs the recipient did not see, labelled not tried on, within the cap", () => {
    const picks = similarNotTried(AURUM, hearts, { request, shownIds: shown.ids, seed: "x" });
    expect(picks.length).toBeGreaterThanOrEqual(2);
    expect(picks.length).toBeLessThanOrEqual(3);
    for (const p of picks) {
      expect(shown.ids).not.toContain(p.catalogId);
      expect(p.label).toBe("not tried on");
      expect(p.price).toBeLessThanOrEqual(300);
      const s = AURUM.find((x) => x.id === p.catalogId)!;
      expect(eligibleVariants(s, request).map((v) => v.variantId)).toContain(p.variantId);
    }
    expect(new Set(picks.map((p) => p.catalogId)).size).toBe(picks.length);
  });

  it("matches the hearted taste (shares a style family or silhouette with a heart)", () => {
    const picks = similarNotTried(AURUM, hearts, { request, shownIds: shown.ids, seed: "x" });
    for (const p of picks) {
      const s = AURUM.find((x) => x.id === p.catalogId)!;
      const shares = hearts.some((h) => styleFamilyOf(h.sku) === styleFamilyOf(s) || (h.sku.category === s.category && silhouetteOf(h.sku) === silhouetteOf(s)));
      expect(shares).toBe(true);
    }
  });

  it("respects the metal lock and gender presentation", () => {
    const locked = { budgetMax: 600, currency: "USD", metalLock: ["yellow_gold", "rose_gold"] as Metal[] };
    const men = curate(AURUM, { seed: "m", occasion: "birthday", request: locked, genderPresentation: "masculine", rules: fakeRules });
    const menHearts = men.ids.slice(0, 2).map((id) => {
      const s = AURUM.find((x) => x.id === id)!;
      return { sku: s, metal: eligibleVariants(s, locked)[0].metal };
    });
    const picks = similarNotTried(AURUM, menHearts, { request: locked, shownIds: men.ids, genderPresentation: "masculine", seed: "m" });
    expect(picks.length).toBeGreaterThan(0);
    for (const p of picks) {
      const s = AURUM.find((x) => x.id === p.catalogId)!;
      expect(genderOf(s)).not.toBe("feminine");
      const v = variantsOf(s).find((x) => x.variantId === p.variantId)!;
      expect(["yellow_gold", "rose_gold"]).toContain(v.metal);
      expect(v.price).toBeLessThanOrEqual(600);
    }
  });

  it("is empty without hearts", () => {
    expect(similarNotTried(AURUM, [], { request, shownIds: shown.ids, seed: "x" })).toEqual([]);
  });
});
