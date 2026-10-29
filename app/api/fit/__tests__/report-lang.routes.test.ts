/**
 * A22: POST /api/fit/report answers in the giver's language. The Fit Request's `giverLang` (stored at
 * creation) maps to one of the ten UI locales (else English); the response says which (`lang`), and the
 * template reasons, cautions and the "help me choose" taste summary are written in it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CreateFitRequestResponse, GiverReportStatus } from "@/lib/contracts/api";
import type { CatalogSku } from "@/lib/contracts/giftfit";
import { configureFit, resetFitDeps } from "@/lib/fit/deps";
import type { ExplainClient, ExplainRequest } from "@/lib/fit/explain";
import { PrivacyFitRepository, StaticCatalog } from "@/lib/fit/repository";
import { fakeRules, makeCatalog, sku } from "@/lib/fit/__tests__/fixtures";
import { findGiverLeaks } from "@/lib/privacy/giver-guard";
import { MemoryPrivacyRepos } from "@/lib/privacy/repos/memory";
import { setPrivacyDeps } from "@/lib/privacy/runtime";
import { POST as reportPOST } from "../report/route";
import { POST as requestsPOST } from "../requests/route";

const T0 = new Date("2026-10-20T12:00:00Z");
let repos: MemoryPrivacyRepos;

const CATALOG: CatalogSku[] = [
  sku("fix-001", { title: "Halo Drop Earrings", price: 240 }),
  sku("fix-002", { title: "Luna Hoop Earrings", price: 180, attributes: { earring_shape: "hoop_round_large", metal: "white_gold", metal_tone: "cool" } }),
  sku("fix-003", { title: "Iris Pendant Necklace", category: "necklace", price: 220, attributes: { category: "necklace" } }),
  ...makeCatalog(200, "route"),
];

function setup(explainer: ExplainClient | null = null) {
  repos = new MemoryPrivacyRepos(() => T0);
  configureFit({ repository: new PrivacyFitRepository(async () => repos, new StaticCatalog(CATALOG)), rules: fakeRules, explainer, decoySecret: "test-secret", now: () => T0 });
}

const post = (body: unknown) => new Request("http://localhost/api/fit/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function completedReport(giverLang?: string, over: Record<string, unknown> = {}): Promise<GiverReportStatus> {
  const created = (await (await requestsPOST(post({ occasion: "anniversary", budgetMin: 150, budgetMax: 300, currency: "USD", shortlistIds: ["fix-001", "fix-002", "fix-003"], ...(giverLang ? { giverLang } : {}), ...over }))).json()) as CreateFitRequestResponse;
  const waiting = (await (await reportPOST(post({ giverToken: created.giverToken }))).json()) as GiverReportStatus;
  expect(waiting.status).toBe("waiting");
  await repos.profiles.upsert({
    fitRequestId: created.fitRequestId,
    undertoneEstimate: "warm",
    undertoneConfidence: 0.83,
    undertoneOverride: null,
    faceShape: "Oval",
    hasHandCapture: false,
    consentAt: T0,
    expiresAt: new Date(T0.getTime() + 72 * 3600_000),
  });
  await repos.hearts.add(created.fitRequestId, "fix-001");
  await repos.fitRequests.setStatus(created.fitRequestId, "completed");
  const res = await reportPOST(post({ giverToken: created.giverToken }));
  expect(res.status).toBe(200);
  const body = (await res.json()) as GiverReportStatus;
  expect(body.status).toBe("completed");
  expect(findGiverLeaks(body)).toEqual([]);
  return { ...body, ...(waiting.lang ? { waitingLang: waiting.lang } : {}) } as GiverReportStatus;
}

const allText = (r: GiverReportStatus) => (r.results ?? []).flatMap((x) => [...x.reasons, x.caution ?? ""]).join(" ");

beforeEach(() => resetFitDeps());
afterEach(() => {
  resetFitDeps();
  setPrivacyDeps(undefined);
});

describe("POST /api/fit/report: the giver's language", () => {
  it("giverLang 'vi' → lang 'vi' (waiting and completed), Vietnamese reasons and cautions", async () => {
    setup();
    const r = await completedReport("vi");
    expect(r.lang).toBe("vi");
    expect((r as GiverReportStatus & { waitingLang?: string }).waitingLang).toBe("vi");
    const text = allText(r);
    expect(text).toMatch(/Người nhận|ngân sách|tông da/);
    expect(text).not.toMatch(/\b(They|their|your|budget)\b/);
    // The estimate labels stay the guard's fixed English vocabulary (the page translates them).
    expect(r.recipientLabels?.undertone ?? "Warm undertone estimate").toMatch(/undertone/);
  });

  it("giverLang 'pt' (not one of the ten) and no giverLang → English", async () => {
    setup();
    const pt = await completedReport("pt-BR");
    expect(pt.lang).toBe("en");
    expect(allText(pt)).toMatch(/\b(They|your)\b/);
    const none = await completedReport();
    expect(none.lang).toBe("en");
    expect(allText(none)).toBe(allText(pt));
  });

  it("asks the model for the giver's language, and the help-me-choose taste summary is localized", async () => {
    const seen: ExplainRequest[] = [];
    setup({
      model: "mock",
      explain: async (req) => {
        seen.push(req);
        return { items: req.items.map((i) => ({ skuId: i.skuId, reason1: "ご予算の範囲内です。", reason2: "記念日にぴったりです。", caution: "購入前にサイズをご確認ください。" })) };
      },
    });
    const r = await completedReport("ja-JP");
    expect(r.lang).toBe("ja");
    expect(seen[0].language).toEqual({ code: "ja", name: "Japanese" });
    expect(r.results![0].reasons).toEqual(["ご予算の範囲内です。", "記念日にぴったりです。"]);

    const help = await completedReport("de", { mode: "help_me_choose", shortlistIds: [], budgetMin: 50, budgetMax: 900 });
    expect(help.lang).toBe("de");
    expect(help.tasteSummary?.source).toBe("template");
    expect(help.tasteSummary?.text).toMatch(/Die Person/);
  });
});
