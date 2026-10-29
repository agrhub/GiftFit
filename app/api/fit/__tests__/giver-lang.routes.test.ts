/**
 * A21: POST /api/fit/requests stores the giver's conversation language (`giverLang`) with the Fit Request,
 * as a short BCP-47 base; anything else is dropped (never refused). The recipient page reads it back by
 * recipient token (lib/privacy/giver-lang.ts) and the giver routes see it on StoredFitRequest.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CreateFitRequestResponse } from "@/lib/contracts/api";
import type { CatalogSku } from "@/lib/contracts/giftfit";
import { giverLangOf } from "@/lib/fit/api";
import { configureFit, getFitDeps, resetFitDeps } from "@/lib/fit/deps";
import { PrivacyFitRepository, StaticCatalog } from "@/lib/fit/repository";
import { fakeRules, makeCatalog, sku } from "@/lib/fit/__tests__/fixtures";
import { giverLangForRecipientToken } from "@/lib/privacy/giver-lang";
import { MemoryPrivacyRepos } from "@/lib/privacy/repos/memory";
import { setPrivacyDeps } from "@/lib/privacy/runtime";
import { POST as requestsPOST } from "../requests/route";

const T0 = new Date("2026-10-20T12:00:00Z");
let repos: MemoryPrivacyRepos;

const CATALOG: CatalogSku[] = [
  sku("fix-001", { title: "Halo Drop Earrings", price: 240 }),
  sku("fix-002", { title: "Luna Hoop Earrings", price: 180, attributes: { earring_shape: "hoop_round_large", metal: "white_gold", metal_tone: "cool" } }),
  ...makeCatalog(120, "lang"),
];

const post = (body: unknown) => new Request("http://localhost/api/fit/requests", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function create(giverLang?: unknown) {
  const res = await requestsPOST(post({ occasion: "birthday", budgetMax: 300, currency: "USD", shortlistIds: ["fix-001", "fix-002"], ...(giverLang !== undefined ? { giverLang } : {}) }));
  expect(res.status).toBe(201);
  const body = (await res.json()) as CreateFitRequestResponse;
  const stored = await repos.fitRequests.findById(body.fitRequestId);
  const recipientToken = body.recipientPath.replace("/r/", "");
  return { body, stored, recipientToken };
}

beforeEach(() => {
  resetFitDeps();
  repos = new MemoryPrivacyRepos(() => T0);
  configureFit({ repository: new PrivacyFitRepository(async () => repos, new StaticCatalog(CATALOG)), rules: fakeRules, explainer: null, decoySecret: "test-secret", now: () => T0 });
});
afterEach(() => {
  resetFitDeps();
  setPrivacyDeps(undefined);
});

describe("giverLang on POST /api/fit/requests", () => {
  it("stores the giver's language and exposes it to the recipient page and the giver routes", async () => {
    const { body, stored, recipientToken } = await create("ja");
    expect(stored?.giverLang).toBe("ja");
    expect(await giverLangForRecipientToken(recipientToken, { repos })).toBe("ja");
    const forGiver = await getFitDeps().repository.findByGiverToken(body.giverToken);
    expect(forGiver?.giverLang).toBe("ja");
    // The giver's response never echoes it (nothing new on the contract).
    expect(JSON.stringify(body)).not.toContain("giverLang");
  });

  it("keeps a language outside the ten (the report and page fall back to English) and reduces a tag to its base", async () => {
    expect((await create("pt")).stored?.giverLang).toBe("pt");
    expect((await create("pt-BR")).stored?.giverLang).toBe("pt");
    expect((await create("zh-Hans-CN")).stored?.giverLang).toBe("zh");
  });

  it("drops an invalid giverLang without refusing the request", async () => {
    for (const bad of ["", "english", "e", "12", "<script>", 42, null, { lang: "vi" }, ["vi"]]) {
      const { stored } = await create(bad);
      expect(stored?.giverLang, JSON.stringify(bad)).toBeUndefined();
    }
    expect((await create()).stored?.giverLang).toBeUndefined();
  });

  it("giverLangOf: BCP-47 base of 2–3 letters, else undefined", () => {
    expect(giverLangOf("VI")).toBe("vi");
    expect(giverLangOf(" de_DE ")).toBe("de");
    expect(giverLangOf("fil")).toBe("fil");
    expect(giverLangOf("deutsch")).toBeUndefined();
    expect(giverLangOf(undefined)).toBeUndefined();
  });

  it("the recipient lookup ignores malformed, unknown and closed links", async () => {
    const { stored, recipientToken } = await create("vi");
    expect(await giverLangForRecipientToken("not-a-token", { repos })).toBeUndefined();
    expect(await giverLangForRecipientToken("x".repeat(43), { repos })).toBeUndefined();
    await repos.fitRequests.setStatus(stored!.id, "deleted");
    expect(await giverLangForRecipientToken(recipientToken, { repos })).toBeUndefined();
  });
});
