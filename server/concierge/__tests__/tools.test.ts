import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findGiverLeaks } from "@/server/privacy/giver-guard";
import { defaultConciergeCatalog } from "../catalog";
import { GroundingLedger } from "../grounding";
import { CONCIERGE_TOOLS, runConciergeTool } from "../tools";
import { CONCIERGE_TOOL_NAMES } from "../types";

const catalog = defaultConciergeCatalog();
const ROOT = path.resolve(__dirname, "../../..");

/** Every property name anywhere in a JSON schema. */
function schemaKeys(schema: unknown, out: string[] = []): string[] {
  if (schema && typeof schema === "object") {
    const props = (schema as { properties?: Record<string, unknown> }).properties;
    if (props) for (const [k, v] of Object.entries(props)) out.push(k, ...schemaKeys(v));
    const items = (schema as { items?: unknown }).items;
    if (items) schemaKeys(items, out);
  }
  return out;
}

const RECIPIENT_WORDS = /selfie|photo|image|face|skin|undertone|hex|colou?r|lab$|landmark|recipient|token|email|phone|name|address|age|tryon|try_on|profile|heart/i;

describe("privacy guard: no recipient fields reachable from any tool", () => {
  it("defines exactly the four catalog tools", () => {
    expect(CONCIERGE_TOOLS.map((t) => t.name)).toEqual([...CONCIERGE_TOOL_NAMES]);
  });

  it("tool input schemas have no recipient, photo, face or contact fields", () => {
    for (const t of CONCIERGE_TOOLS) {
      const keys = schemaKeys(t.input_schema);
      expect(keys.filter((k) => RECIPIENT_WORDS.test(k)), t.name).toEqual([]);
      expect((t.input_schema as { additionalProperties?: boolean }).additionalProperties, t.name).toBe(false);
    }
  });

  it("tool outputs carry catalog facts only, even with recipient-looking input smuggled in", () => {
    const smuggle = { selfie: "data:image/png;base64,AAAA", undertone: "warm", skin_color: "#c68e6b", fitRequestId: "fr1", recipientToken: "r".repeat(43) };
    const ledger = new GroundingLedger();
    const calls: Array<[string, Record<string, unknown>]> = [
      ["search_catalog", { maxPrice: 300, category: ["earring"], ...smuggle }],
      ["fit_preview", { ids: ["dca42809-a2e1-5b50-8339-240170c69845"], budgetMax: 300, ...smuggle }],
      ["check_budget_and_metals", { budgetMax: 300, ids: ["dca42809-a2e1-5b50-8339-240170c69845"], ...smuggle }],
      ["create_fit_request", { brief: { mode: "help_me_choose", occasion: "birthday", budgetMax: 300, currency: "USD", ...smuggle }, suggestions: [{ catalogId: "dca42809-a2e1-5b50-8339-240170c69845", reason: "ok", ...smuggle }], ...smuggle }],
    ];
    for (const [name, input] of calls) {
      const out = runConciergeTool(name, input, catalog, ledger);
      const json = JSON.stringify(out);
      expect(out.isError, `${name}: ${json}`).toBe(false);
      expect(findGiverLeaks(out.result), name).toEqual([]);
      expect(json, name).not.toMatch(/selfie|undertone|skin_color|c68e6b|fitRequestId|recipientToken|rrrrrrrr/);
    }
  });

  it("the concierge sources never import recipient data, photo stores, Fit Request repos or YouCam", () => {
    const dir = path.join(ROOT, "server", "concierge");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const src = readFileSync(path.join(dir, f), "utf8");
      const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
      for (const imp of imports) {
        expect(imp, `${f} imports ${imp}`).not.toMatch(/privacy\/(repos|photo-store|recipient|capture|session|signed-url|renders|carousel)|lib\/youcam|lib\/fit\/(api|repository|deps|score)|lib\/store\/|lib\/email/);
      }
    }
  });
});

describe("tool behaviour", () => {
  it("search_catalog respects the budget cap and metal filter on every returned metal", () => {
    const ledger = new GroundingLedger();
    const out = runConciergeTool("search_catalog", { maxPrice: 200, metal: ["rose_gold", "white_gold"], limit: 12 }, catalog, ledger);
    const rows = (out.result as { rows: Array<{ id: string; metals: Array<{ metal: string; price: number }> }> }).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(ledger.has(r.id)).toBe(true);
      for (const m of r.metals) {
        expect(m.price).toBeLessThanOrEqual(200);
        expect(["rose_gold", "white_gold"]).toContain(m.metal);
      }
    }
  });

  it("filters by category, style and gender presentation", () => {
    const out = runConciergeTool("search_catalog", { category: ["watch"], genderPresentation: "masculine" }, catalog, new GroundingLedger());
    const rows = (out.result as { rows: Array<{ category: string; genderPresentation: string }> }).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.category).toBe("watch");
      expect(["masculine", "unisex"]).toContain(r.genderPresentation);
    }
  });

  it("refuses invalid input with an error result instead of throwing", () => {
    const out = runConciergeTool("search_catalog", { maxPrice: -5 }, catalog, new GroundingLedger());
    expect(out.isError).toBe(true);
    expect(runConciergeTool("delete_everything", {}, catalog, new GroundingLedger()).isError).toBe(true);
  });

  it("fit_preview reports unknown ids and never grounds them", () => {
    const ledger = new GroundingLedger();
    const out = runConciergeTool("fit_preview", { ids: ["nope", "dca42809-a2e1-5b50-8339-240170c69845"], budgetMax: 250 }, catalog, ledger);
    const r = out.result as { unknownIds: string[]; items: Array<{ metals: Array<{ metal: string; withinBudget: boolean }> }> };
    expect(r.unknownIds).toEqual(["nope"]);
    expect(ledger.has("nope")).toBe(false);
    expect(r.items[0].metals.find((m) => m.metal === "white_gold")?.withinBudget).toBe(false);
  });

  it("check_budget_and_metals counts eligible designs and the cheapest price", () => {
    const out = runConciergeTool("check_budget_and_metals", { budgetMax: 100, metalLock: ["silver"] }, catalog, new GroundingLedger());
    const r = out.result as { eligibleDesigns: number; cheapestEligiblePrice: number };
    expect(r.eligibleDesigns).toBeGreaterThan(0);
    expect(r.cheapestEligiblePrice).toBeLessThanOrEqual(100);
  });

  it("create_fit_request only drafts (status draft) and never returns ids no tool produced", () => {
    const ledger = new GroundingLedger();
    const out = runConciergeTool("create_fit_request", { brief: { mode: "help_me_choose", occasion: "birthday", budgetMax: 300, currency: "USD" }, suggestions: [{ catalogId: "dca42809-a2e1-5b50-8339-240170c69845", reason: "x" }] }, catalog, ledger);
    expect(out.result).toMatchObject({ ok: true, status: "draft", suggestions: [] });
    expect(out.draft?.suggestions).toEqual([]);
  });
});
