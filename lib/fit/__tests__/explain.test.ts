/**
 * explain.ts: template fallback, the Anthropic client contract (mocked; no key in CI) and
 * adversarial grounding tests: every leak or ungrounded output must be rejected or repaired.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import type { CatalogSku, JewelryCategory } from "@/lib/contracts/giftfit";
import {
  AnthropicExplainClient,
  EXPLAIN_MODEL,
  type ExplainClient,
  type ExplainRequest,
  buildExplainInput,
  checkText,
  createExplainClient,
  explainFit,
  explainMaxTokens,
  explainSchema,
  templateExplanation,
  validateExplanation,
  wordCount,
} from "../explain";
import { DEFAULT_CLAUDE_MODEL } from "@/lib/anthropic/budget";
import { type ScoredSku, fitScore } from "../score";
import { seededRandom } from "../rng";
import { fakeRules, makeCatalog, profile, request, sku } from "./fixtures";

type Scored = ScoredSku & { category: JewelryCategory };

const halo = sku("aur-001", { title: "Halo Drop Earrings" });
const luna = sku("aur-002", { title: "Luna Hoop Earrings", attributes: { earring_shape: "hoop_round_large", metal: "white_gold", metal_tone: "cool" } });
const other = sku("aur-099", { title: "Nova Bloom Necklace", category: "necklace", attributes: { category: "necklace" } });
const CATALOG = [halo, luna, other];
const CATALOG_REFS = CATALOG.map((s) => ({ id: s.id, title: s.title }));

const P = profile({ undertoneConfidence: 0.83, heartedSkuIds: ["aur-001"] });
const score = (s: CatalogSku): Scored => ({ ...fitScore(P, s, request(), fakeRules), category: s.category });
const SCORED = [score(halo), score(luna)];

const good = {
  items: [
    { skuId: "aur-001", reason1: "She hearted this piece.", reason2: "Yellow gold suits her warm undertone estimate.", caution: "The try-on is an AI preview." },
    { skuId: "aur-002", reason1: "Within your budget.", reason2: "A natural fit for an anniversary.", caution: "She did not heart this piece." },
  ],
};
const mock = (out: unknown): ExplainClient & { calls: ExplainRequest[] } => {
  const calls: ExplainRequest[] = [];
  return {
    model: EXPLAIN_MODEL,
    calls,
    explain: async (req) => {
      calls.push(req);
      if (out instanceof Error) throw out;
      return out;
    },
  };
};
const withItem = (patch: Record<string, unknown>, i = 0) => ({ items: good.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) });

describe("template mode (no ANTHROPIC_API_KEY)", () => {
  it("createExplainClient returns null without a key and a Sonnet 5.5 client with one", () => {
    expect(createExplainClient({})).toBeNull();
    const c = createExplainClient({ ANTHROPIC_API_KEY: "test-key-not-real" });
    expect(c).toBeInstanceOf(AnthropicExplainClient);
    expect(c!.model).toBe("claude-sonnet-5-5");
  });

  it("explainFit without a client returns the deterministic template", async () => {
    const r = await explainFit(SCORED, { client: null });
    expect(r.source).toBe("template");
    expect(r.results.map((x) => x.reasons)).toEqual(SCORED.map((s) => s.reasons));
    for (const x of r.results) {
      expect(x.reasons).toHaveLength(2);
      for (const t of [...x.reasons, x.caution!]) expect(wordCount(t)).toBeLessThanOrEqual(20);
    }
  });

  it("every template text over 300 random catalog/profile pairs passes the output validator", () => {
    const catalog = makeCatalog(150, "templates");
    const r = seededRandom("profiles");
    const tones = ["warm", "neutral", "cool"] as const;
    const faces = ["Oval", "Round", "Square", "Heart", "InvTriangle", "Oblong", "Diamond", "Triangle", "Unknown"] as const;
    for (let i = 0; i < 300; i++) {
      const s = catalog[i % catalog.length];
      const p = profile({
        undertoneEstimate: tones[Math.floor(r() * 3)],
        undertoneConfidence: r(),
        undertoneOverride: r() < 0.2 ? tones[Math.floor(r() * 3)] : undefined,
        faceShape: faces[Math.floor(r() * faces.length)],
        heartedSkuIds: r() < 0.5 ? [s.id] : [catalog[(i + 1) % catalog.length].id],
      });
      const res = fitScore(r() < 0.1 ? null : p, s, request({ budgetMin: 100, budgetMax: 400 }), fakeRules, { heartedSkus: catalog.slice(0, 20) });
      for (const t of [...res.reasons, res.caution!]) {
        expect(checkText(t, s.id, { allowedIds: [s.id], catalog: catalog.map((c) => ({ id: c.id, title: c.title })) })).toEqual([]);
      }
    }
  });
});

describe("model input is grounded and giver-safe", () => {
  it("sends only scored ids, scores, categories, breakdown numbers and signal labels", async () => {
    const client = mock(good);
    await explainFit(SCORED, { client, catalog: CATALOG_REFS });
    const sent = client.calls[0];
    expect(sent.items.map((i) => i.skuId)).toEqual(["aur-001", "aur-002"]);
    for (const it of sent.items) expect(Object.keys(it).sort()).toEqual(["breakdown", "category", "score", "signals", "skuId"]);
    const json = JSON.stringify(sent);
    expect(json).not.toMatch(/Halo|Luna|Nova|aur-099/); // no titles, no unscored ids
    expect(json).not.toMatch(/#[0-9a-f]{3,8}|https?:|\.png|catalog\//i); // no hex, URLs or image paths
    expect(json).not.toMatch(/0\.83|confidence"|lab|hueDeg|faceShape|undertoneEstimate/); // no raw profile fields
    expect(json).toContain("hearted");
    expect(json).toContain("warm undertone estimate → yellow gold: recommended");
  });

  it("refuses to build input from a label that carries a hex value or URL", () => {
    const bad: Scored = { ...SCORED[0], signals: [{ factor: "metal", polarity: "positive", label: "skin #C68642 → gold", text: "x", points: 1 }] };
    expect(() => buildExplainInput([bad])).toThrow(/not giver-safe/);
    const url: Scored = { ...SCORED[0], signals: [{ factor: "metal", polarity: "positive", label: "see https://x.test/a.png", text: "x", points: 1 }] };
    expect(() => buildExplainInput([url])).toThrow(/not giver-safe/);
  });

  it("schema is strict and restricts skuId to the scored ids", () => {
    const schema = explainSchema(["aur-001", "aur-002"]) as {
      additionalProperties: boolean;
      properties: { items: { items: { additionalProperties: boolean; required: string[]; properties: { skuId: { enum: string[] } } } } };
    };
    expect(schema.additionalProperties).toBe(false);
    const item = schema.properties.items.items;
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(["skuId", "reason1", "reason2", "caution"]);
    expect(item.properties.skuId.enum).toEqual(["aur-001", "aur-002"]);
  });
});

describe("valid model output", () => {
  it("is accepted as-is", async () => {
    const r = await explainFit(SCORED, { client: mock(good), catalog: CATALOG_REFS });
    expect(r.source).toBe("llm");
    expect(r.issues).toEqual([]);
    expect(r.results[0]).toMatchObject({ skuId: "aur-001", reasons: ["She hearted this piece.", "Yellow gold suits her warm undertone estimate."], caution: "The try-on is an AI preview." });
    expect(r.results[0].score).toBe(SCORED[0].score); // scores never come from the model
  });

  it("allows jewelry words that look like leaks but are not (lab-grown, beaded, facade-free)", () => {
    for (const t of ["A lab-grown stone keeps it bright.", "Beaded detail matches her classic style.", "Within your $150–$300 budget."]) {
      expect(checkText(t, "aur-001", { allowedIds: ["aur-001"] })).toEqual([]);
    }
  });
});

describe("adversarial grounding: rejected or repaired", () => {
  const cases: { name: string; out: unknown; code: string; field?: string }[] = [
    { name: "id not in the input", out: { items: [...good.items, { skuId: "aur-099", reason1: "a", reason2: "b", caution: "c" }] }, code: "unknown_sku" },
    { name: "invented id", out: { items: [{ ...good.items[0], skuId: "aur-777" }, good.items[1]] }, code: "unknown_sku" },
    { name: "names another product", out: withItem({ reason2: "Pairs well with the Nova Bloom Necklace." }), code: "foreign_reference", field: "reason2" },
    { name: "names another scored id", out: withItem({ reason1: "Better than aur-002 for her." }), code: "foreign_reference", field: "reason1" },
    { name: "uuid-shaped id", out: withItem({ reason1: "Matches 3f2a1b4c-1111-4222-8333-123456789abc." }), code: "foreign_reference", field: "reason1" },
    { name: "hex with #", out: withItem({ reason2: "Her skin #C68642 suits gold." }), code: "leak_hex", field: "reason2" },
    { name: "bare hex", out: withItem({ reason2: "Skin tone c68642 suits gold." }), code: "leak_hex", field: "reason2" },
    { name: "rgb()", out: withItem({ caution: "Her RGB reading is warm." }), code: "leak_hex", field: "caution" },
    { name: "CIELAB", out: withItem({ reason2: "Her L* of 62 and b*=18 suggest warmth." }), code: "leak_biometric", field: "reason2" },
    { name: "hue angle", out: withItem({ reason2: "A hue angle of 58 degrees means warm." }), code: "leak_biometric", field: "reason2" },
    { name: "confidence number", out: withItem({ caution: "Undertone estimate is 83% certain." }), code: "leak_biometric", field: "caution" },
    { name: "decimal confidence", out: withItem({ caution: "Confidence is 0.83 for warm." }), code: "leak_biometric", field: "caution" },
    { name: "face measurements", out: withItem({ reason2: "Her face width ratio favors drops." }), code: "leak_biometric", field: "reason2" },
    { name: "Fitzpatrick", out: withItem({ caution: "Fitzpatrick type IV skin." }), code: "leak_biometric", field: "caution" },
    { name: "mentions her selfie", out: withItem({ reason1: "Looked great in her selfie." }), code: "leak_photo", field: "reason1" },
    { name: "mentions photos", out: withItem({ caution: "Photos showed a warm cast." }), code: "leak_photo", field: "caution" },
    { name: "URL", out: withItem({ reason1: "See https://cdn.example.com/tryon/1.png." }), code: "leak_url", field: "reason1" },
    {
      name: "over 20 words",
      out: withItem({ reason1: "This piece is a wonderful choice because she hearted it and it suits her warm undertone estimate and her oval face shape nicely." }),
      code: "too_long",
      field: "reason1",
    },
    { name: "empty text", out: withItem({ caution: "   " }), code: "empty", field: "caution" },
    { name: "non-string text", out: withItem({ reason2: 42 }), code: "empty", field: "reason2" },
    { name: "duplicate id", out: { items: [good.items[0], { ...good.items[0], reason1: "dup" }, good.items[1]] }, code: "duplicate_sku" },
    { name: "missing sku", out: { items: [good.items[0]] }, code: "missing_sku" },
  ];

  it.each(cases)("$name → $code", async ({ out, code, field }) => {
    const r = await explainFit(SCORED, { client: mock(out), catalog: CATALOG_REFS });
    expect(r.issues.map((i) => i.code)).toContain(code);
    expect(r.source).toBe("llm_repaired");
    // Repaired output is always grounded and safe.
    expect(r.results.map((x) => x.skuId)).toEqual(["aur-001", "aur-002"]);
    for (const x of r.results) {
      for (const t of [...x.reasons, x.caution!]) {
        expect(checkText(t, x.skuId, { allowedIds: ["aur-001", "aur-002"], catalog: CATALOG_REFS })).toEqual([]);
      }
    }
    if (field) {
      const idx = r.issues.find((i) => i.code === code)!.skuId === "aur-002" ? 1 : 0;
      const template = { reason1: SCORED[idx].reasons[0], reason2: SCORED[idx].reasons[1], caution: SCORED[idx].caution };
      const got = { reason1: r.results[idx].reasons[0], reason2: r.results[idx].reasons[1], caution: r.results[idx].caution };
      expect(got[field as keyof typeof got]).toBe(template[field as keyof typeof template]);
    }
  });

  it("keeps the clean slots of a partially bad item", async () => {
    const r = await explainFit(SCORED, { client: mock(withItem({ reason2: "Her skin #C68642 suits gold." })), catalog: CATALOG_REFS });
    expect(r.results[0].reasons[0]).toBe("She hearted this piece.");
    expect(r.results[0].reasons[1]).toBe(SCORED[0].reasons[1]);
  });

  it("falls back to the template on malformed output", async () => {
    for (const out of [null, "not json", { items: "nope" }, 42]) {
      const r = await explainFit(SCORED, { client: mock(out) });
      expect(r.source).toBe("template");
      expect(r.issues[0].code).toBe("bad_shape");
      expect(r.results.map((x) => x.reasons)).toEqual(SCORED.map((s) => s.reasons));
    }
  });

  it("falls back to the template when the client throws", async () => {
    const r = await explainFit(SCORED, { client: mock(new Error("529 overloaded")) });
    expect(r.source).toBe("template");
    expect(r.issues).toEqual([{ code: "client_error", detail: "529 overloaded" }]);
  });

  it("validateExplanation never lets the model change scores or breakdowns", () => {
    const tampered = { items: good.items.map((it) => ({ ...it, score: 100, breakdown: { hearts: 50 } })) };
    const { results } = validateExplanation(tampered, SCORED);
    expect(results.map((r) => r.score)).toEqual(SCORED.map((s) => s.score));
    expect(results.map((r) => r.breakdown)).toEqual(SCORED.map((s) => s.breakdown));
  });
});

describe("AnthropicExplainClient request shape (SDK mocked)", () => {
  const USAGE = { input_tokens: 900, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const fakeSdk = (response: unknown) => {
    const create = vi.fn(async () => response);
    return { sdk: { beta: { messages: { create } } } as unknown as Anthropic, create };
  };
  /** A reservation spy: records the reserve input and the usage it was settled with. */
  const spendSpy = (ok = true) => {
    const log: { reserved?: { model: string; inputTokens: number; maxTokens: number }; settled?: unknown[] } = { settled: [] };
    const reserve = vi.fn(async (input: { model: string; inputTokens: number; maxTokens: number }) => {
      log.reserved = input;
      if (!ok) return { ok: false as const, reason: "daily_cap" as const };
      return { ok: true as const, settle: async (u: unknown) => void log.settled!.push(u) };
    });
    return { reserve, log };
  };

  it("calls DEFAULT_CLAUDE_MODEL with a strict json_schema output, a cached system prompt and tight max_tokens", async () => {
    const { sdk, create } = fakeSdk({ stop_reason: "end_turn", model: EXPLAIN_MODEL, usage: USAGE, content: [{ type: "text", text: JSON.stringify(good) }] });
    const { reserve, log } = spendSpy();
    const r = await explainFit(SCORED, { client: new AnthropicExplainClient(sdk, { reserve }), catalog: CATALOG_REFS });
    expect(r.source).toBe("llm");
    const params = (create.mock.calls[0] as unknown as [Record<string, unknown>])[0] as {
      model: string;
      max_tokens: number;
      thinking?: { type: string };
      output_config: { effort: string; format: { type: string; schema: unknown } };
      tool_choice?: unknown;
      messages: { content: string }[];
      system: { type: string; text: string; cache_control?: { type: string } }[];
    };
    expect(EXPLAIN_MODEL).toBe(DEFAULT_CLAUDE_MODEL);
    expect(params.model).toBe(DEFAULT_CLAUDE_MODEL);
    expect(params.max_tokens).toBe(explainMaxTokens(2));
    expect(params.max_tokens).toBeLessThanOrEqual(1600);
    expect(params.thinking).toEqual({ type: "between_tools" }); // no extended thinking on Sonnet 5.5
    expect(params.output_config.effort).toBe("low");
    expect(params.output_config.format.type).toBe("json_schema");
    expect(params.output_config.format.schema).toEqual(explainSchema(["aur-001", "aur-002"]));
    expect(params.tool_choice).toBeUndefined(); // forced tool_choice is rejected on Sonnet 5.5
    expect(params.system).toHaveLength(1);
    expect(params.system[0].text).toMatch(/never name products/i);
    expect(params.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(JSON.parse(params.messages[0].content)).toEqual(buildExplainInput(SCORED));
    // Reserve before, settle with the real usage after.
    expect(log.reserved).toMatchObject({ model: DEFAULT_CLAUDE_MODEL, maxTokens: explainMaxTokens(2) });
    expect(log.reserved!.inputTokens).toBeGreaterThan(100);
    expect(log.settled).toEqual([USAGE]);
  });

  it("treats a refusal or truncation as an error (template fallback) and still settles the spend", async () => {
    for (const stop_reason of ["refusal", "max_tokens"]) {
      const { sdk } = fakeSdk({ stop_reason, usage: USAGE, content: [] });
      const { reserve, log } = spendSpy();
      const r = await explainFit(SCORED, { client: new AnthropicExplainClient(sdk, { reserve }) });
      expect(r.source).toBe("template");
      expect(r.issues[0].code).toBe("client_error");
      expect(log.settled).toEqual([USAGE]);
    }
  });

  it("spend cap refusal: no API call, template text, issue spend_cap", async () => {
    const { sdk, create } = fakeSdk({ stop_reason: "end_turn", usage: USAGE, content: [{ type: "text", text: JSON.stringify(good) }] });
    const { reserve } = spendSpy(false);
    const r = await explainFit(SCORED, { client: new AnthropicExplainClient(sdk, { reserve }) });
    expect(create).not.toHaveBeenCalled();
    expect(r.source).toBe("template");
    expect(r.issues).toEqual([{ code: "spend_cap", detail: "daily_cap" }]);
    expect(r.results).toEqual(templateExplanation(SCORED));
  });

  it("the real daily cap (ANTHROPIC_DAILY_USD_CAP=0) refuses without calling the API", async () => {
    const { sdk, create } = fakeSdk({ stop_reason: "end_turn", usage: USAGE, content: [] });
    const prev = process.env.ANTHROPIC_DAILY_USD_CAP;
    process.env.ANTHROPIC_DAILY_USD_CAP = "0";
    try {
      const r = await explainFit(SCORED, { client: new AnthropicExplainClient(sdk) });
      expect(create).not.toHaveBeenCalled();
      expect(r.issues[0]).toEqual({ code: "spend_cap", detail: "disabled" });
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_DAILY_USD_CAP;
      else process.env.ANTHROPIC_DAILY_USD_CAP = prev;
    }
  });
});
