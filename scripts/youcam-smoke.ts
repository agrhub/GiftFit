/**
 * GiftFit first-real-call smoke (docs/hackathon/first_real_calls.md): one consenting selfie
 * through Facial Color Tones (20) + Face Attributes with exactly 5 features (10) + earring VTO
 * (1) + necklace VTO (1) = 32 units, hard stop at 40 (YOUCAM_MAX_UNITS_PER_RUN).
 *
 * Sequence: 1 credit check -> 2/3 one upload request for 4 files + 4 PUTs -> 4 tones ->
 * 5 face-attr -> 6 earring (body variant A; B then C only on HTTP 400 InvalidParameters) ->
 * 7 necklace (variant that worked) -> 8 credit-history reconciliation -> 9 task delete.
 *
 *   # mock (0 units, no network): the only mode allowed until the 1,000-unit code is redeemed
 *   YOUCAM_MOCK=1 npx tsx scripts/youcam-smoke.ts fixtures/youcam/images/placeholder-selfie.png
 *   # preflight: free GETs only (balance + live feature cost) and the cost-guard decision
 *   YOUCAM_MOCK=0 npx tsx scripts/youcam-smoke.ts selfie-full.jpg --preflight
 *   # real run (balance >= 1,000 only): 32 units
 *   YOUCAM_MOCK=0 YOUCAM_ALLOW_PAID=1 npx tsx scripts/youcam-smoke.ts selfie-full.jpg \
 *     --face-crop selfie-face.jpg --earring earring.png --necklace necklace.png
 *
 * Options:
 *   --face-crop <file>       face crop for tones/face-attr (default: the full frame)
 *   --earring <file|url>     earring product image (default: self-made placeholder)
 *   --necklace <file|url>    necklace product image (default: self-made placeholder)
 *   --variant A|B|C          first jewelry body variant to try (default YOUCAM_JEWELRY_BODY_VARIANT or A)
 *   --min-balance <n>        abort the real run below this balance (default 1000)
 *   --keep-tasks             skip step 9 (task delete)
 *   --preflight              stop after step 1
 *   --out <file>             also write the summary JSON to a file
 *
 * Real runs write raw results, credit history and the downloaded try-on images to
 * fixtures/youcam/real/ (gitignored: a real face and its hex values never go into git).
 * Photos are read locally and uploaded only to YouCam; nothing here logs them.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import { jsonlAuditPath } from "../lib/youcam/audit";
import { createYoucamClient } from "../lib/youcam/client";
import { JEWELRY_BODY_VARIANTS, type JewelryBodyVariant } from "../lib/youcam/config";
import { YoucamApiError } from "../lib/youcam/errors";
import { fixtureName } from "../lib/youcam/features";
import { analyzeRecipient, fitRequestPlan, runTryOns, type TryOnItem, type TryOnResult } from "../lib/youcam/fit-request";
import type { ImageContentType, ImageInput } from "../lib/youcam/types";

const IMAGES = path.join("fixtures", "youcam", "images");

export interface SmokeArgs {
  image?: string;
  faceCrop?: string;
  earring: string;
  necklace: string;
  variant?: JewelryBodyVariant;
  minBalance: number;
  keepTasks: boolean;
  preflight: boolean;
  out?: string;
}

export function parseArgs(argv: string[]): SmokeArgs {
  const args: SmokeArgs = {
    earring: path.join(IMAGES, "product-earring.png"),
    necklace: path.join(IMAGES, "product-necklace.png"),
    minBalance: 1000,
    keepTasks: false,
    preflight: false,
  };
  const value = (i: number, flag: string) => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--face-crop") args.faceCrop = value(++i, a);
    else if (a === "--earring") args.earring = value(++i, a);
    else if (a === "--necklace") args.necklace = value(++i, a);
    else if (a === "--variant") {
      const v = value(++i, a).toUpperCase();
      if (!(JEWELRY_BODY_VARIANTS as readonly string[]).includes(v)) throw new Error("--variant must be A, B or C");
      args.variant = v as JewelryBodyVariant;
    } else if (a === "--min-balance") {
      args.minBalance = Number(value(++i, a));
      if (!Number.isFinite(args.minBalance)) throw new Error("--min-balance must be a number");
    } else if (a === "--keep-tasks") args.keepTasks = true;
    else if (a === "--preflight") args.preflight = true;
    else if (a === "--out") args.out = value(++i, a);
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else args.image = a;
  }
  return args;
}

export function sniffContentType(bytes: Uint8Array): ImageContentType | undefined {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return undefined;
}

export async function readImage(source: string, name: string): Promise<ImageInput> {
  if (/^https?:\/\//.test(source)) return { url: source };
  const bytes = new Uint8Array(await fs.readFile(source));
  const contentType = sniffContentType(bytes);
  if (!contentType) throw new Error(`${source}: image must be a JPEG or PNG`);
  return { bytes, contentType, fileName: `${name}.${contentType === "image/png" ? "png" : "jpg"}` };
}

/** Variant order for step 6: the configured one first, then the rest in A, B, C order. */
export function variantOrder(first: JewelryBodyVariant): JewelryBodyVariant[] {
  return [first, ...JEWELRY_BODY_VARIANTS.filter((v) => v !== first)];
}

/** Only a body rejection (HTTP 400 InvalidParameters, 0 units) justifies trying the next variant. */
export function isBodyRejection(r: TryOnResult): boolean {
  return !r.ok && r.code === "InvalidParameters";
}

async function writeReal(dir: string, file: string, data: string | Uint8Array) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, file), data);
  console.error(`    saved ${path.relative(process.cwd(), path.join(dir, file))}`);
}

const fixtureBody = (feature: string, taskId: string, results: unknown) =>
  JSON.stringify(
    {
      _synthetic: false,
      _source: `scripts/youcam-smoke.ts real run ${new Date().toISOString()} (task ${taskId})`,
      feature,
      response: { status: 200, data: { task_status: "success", error: null, results } },
    },
    null,
    2,
  ) + "\n";

/** Step 6/7 helper: the downloaded image is the only copy that outlives YouCam's 2 h URL. */
async function downloadResult(url: string, dir: string, name: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${name} failed: ${res.status}`);
  const ext = (res.headers.get("content-type") ?? "").includes("png") ? "png" : "jpg";
  await writeReal(dir, `${name}.${ext}`, new Uint8Array(await res.arrayBuffer()));
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });
  let args: SmokeArgs;
  try {
    args = parseArgs(argv);
    if (!args.image) throw new Error("missing selfie path");
  } catch (err) {
    console.error(
      `${(err as Error).message}\nusage: npx tsx scripts/youcam-smoke.ts <selfie-full.jpg|png> [--face-crop f] [--earring f|url] [--necklace f|url] [--variant A|B|C] [--min-balance n] [--keep-tasks] [--preflight] [--out f]`,
    );
    return 2;
  }
  let full: ImageInput, crop: ImageInput, earring: ImageInput, necklace: ImageInput;
  try {
    full = await readImage(args.image, "full-frame");
    crop = args.faceCrop ? await readImage(args.faceCrop, "face-crop") : { ...full, fileName: "face-crop.png" };
    if ("url" in full || "url" in crop) throw new Error("selfies must be local files (never send faces by URL)");
    earring = await readImage(args.earring, "earring");
    necklace = await readImage(args.necklace, "necklace");
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }

  // Poll every 5 s, max 20 polls (first_real_calls.md step 4) unless the env says otherwise.
  const client = createYoucamClient({
    config: {
      ...(process.env.YOUCAM_POLL_INTERVAL_MS ? {} : { pollIntervalMs: 5_000 }),
      ...(process.env.YOUCAM_MAX_POLLS ? {} : { maxPolls: 20 }),
    },
  });
  const cfg = client.config;
  const realDir = path.join(cfg.fixturesDir, "real");
  const real = client.mode === "real";
  const items: TryOnItem[] = [
    { id: "smoke-earring", kind: "earring", product: earring },
    { id: "smoke-necklace", kind: "necklace", product: necklace },
  ];
  const plan = fitRequestPlan(items);
  const estimate = plan.reduce((sum, p) => sum + (client.estimateUnits(p.feature, p.params as never) ?? NaN), 0);
  console.error(`[smoke] mode=${client.mode} allowPaid=${cfg.allowPaid} plan=${plan.map((p) => p.feature).join(" + ")}`);
  console.error(`[smoke] expected ${estimate} units (snapshot 2026-10-15); hard stop ${cfg.maxUnitsPerRun}/run, reserve ${cfg.reserveUnits}`);
  console.error(`[smoke] audit -> ${client.audit.kind === "jsonl" ? path.relative(process.cwd(), jsonlAuditPath(cfg.dataDir)) : client.audit.kind}`);

  // 1. Credit check
  let balanceBefore: number | undefined;
  if (real) {
    balanceBefore = (await client.getBalance()).units;
    const d = await client.preflight(plan);
    console.error(`[1] balance ${balanceBefore}; guard ${d.allowed ? "ALLOWED" : `REFUSED (${d.reason})`}: ${d.message}`);
    if (balanceBefore < args.minBalance) {
      console.error(`[1] abort: balance ${balanceBefore} < --min-balance ${args.minBalance} (redeem the 1,000-unit code first)`);
      return 3;
    }
    if (args.preflight) return d.allowed ? 0 : 3;
    if (!d.allowed) return 3;
  } else {
    if (args.preflight) {
      console.error("[smoke] --preflight needs real mode (YOUCAM_MOCK=0); nothing to check in mock mode");
      return 2;
    }
    console.error("[1] credit check skipped (mock)");
  }

  // 2-3. One upload request for the 4 files, then a PUT per presigned URL
  [crop, full, earring, necklace] = await client.uploadImages([crop, full, earring, necklace]);
  const uploaded = [crop, full, earring, necklace].filter((i) => "fileId" in i && i.fileId).length;
  console.error(`[2-3] ${uploaded} file(s) uploaded in one request${real ? "" : " (mock ids)"}`);

  // 4-5. Facial Color Tones (strictness high) + Face Attributes (exactly 5 features)
  const recipient = await analyzeRecipient(client, crop);
  console.error(`[4] skin-tone-analysis task ${recipient.taskIds.tones}`);
  console.error(`[5] face-attr-analysis task ${recipient.taskIds.faceAttributes}`);
  if (real) {
    await writeReal(realDir, "skin-tone-analysis.json", fixtureBody("skin-tone-analysis", recipient.taskIds.tones, { color: recipient.colors, face_quality: recipient.faceQuality }));
    await writeReal(realDir, "face-attr-analysis.json", fixtureBody("face-attr-analysis", recipient.taskIds.faceAttributes, recipient.faceAttributes));
  }

  // 6. Earring: variant A first; B, C only after a 400 InvalidParameters (0 units)
  const tried: { variant: JewelryBodyVariant; outcome: string }[] = [];
  let earringResult: TryOnResult | undefined;
  let variant: JewelryBodyVariant = args.variant ?? cfg.jewelryBodyVariant;
  for (const v of variantOrder(variant)) {
    variant = v;
    [earringResult] = await runTryOns(client, { face: full }, [{ ...items[0], product: earring }], { jewelryBodyVariant: v });
    tried.push({ variant: v, outcome: earringResult.ok ? "accepted" : `${earringResult.code ?? "error"}: ${earringResult.error}` });
    console.error(`[6] earring variant ${v}: ${tried[tried.length - 1].outcome}`);
    if (!isBodyRejection(earringResult)) break;
  }
  const bodyResolved = earringResult!.ok;

  // 7. Necklace with the variant that worked (skipped if every variant was rejected)
  let necklaceResult: TryOnResult | undefined;
  if (bodyResolved || !isBodyRejection(earringResult!)) {
    [necklaceResult] = await runTryOns(client, { face: full }, [{ ...items[1], product: necklace }], { jewelryBodyVariant: variant });
    console.error(`[7] necklace variant ${variant}: ${necklaceResult.ok ? "accepted" : `${necklaceResult.code ?? "error"}: ${necklaceResult.error}`}`);
  } else {
    console.error("[7] necklace skipped: no body variant accepted");
  }
  const tryOns = [earringResult!, ...(necklaceResult ? [necklaceResult] : [])];
  if (real) {
    for (const t of tryOns) {
      if (!t.ok) continue;
      await writeReal(realDir, `${fixtureName(`2d-vto/${t.kind}`)}.json`, fixtureBody(`2d-vto/${t.kind}`, t.taskId, { url: t.url }));
      await downloadResult(t.url, realDir, `2d-vto-${t.kind}-result`).catch((e) => console.error(`    ${(e as Error).message}`));
    }
  }

  // 8. Credit history reconciliation
  const taskIds: Record<string, string> = {
    "skin-tone-analysis": recipient.taskIds.tones,
    "face-attr-analysis": recipient.taskIds.faceAttributes,
    ...Object.fromEntries(tryOns.filter((t) => t.ok).map((t) => [`2d-vto/${t.kind}`, (t as { taskId: string }).taskId])),
  };
  const reconciliation: Record<string, { taskId: string; historyEntries: number }> = {};
  if (real) {
    const history = await client.getCreditHistory(10);
    await writeReal(realDir, "credit-history.json", JSON.stringify(history, null, 2) + "\n");
    for (const [feature, id] of Object.entries(taskIds)) {
      reconciliation[feature] = { taskId: id, historyEntries: history.filter((h) => h.target_id === id).length };
    }
    console.error(`[8] credit history: ${history.length} entries saved; per-task matches ${JSON.stringify(reconciliation)}`);
  } else {
    console.error("[8] credit history skipped (mock)");
  }

  // 9. Delete every task (privacy "delete everything" path)
  if (!args.keepTasks) {
    for (const id of Object.values(taskIds)) await client.deleteTask(id);
    console.error(`[9] deleted ${Object.keys(taskIds).length} task(s)${real ? "" : " (mock: nothing to delete)"}`);
  }

  const summary = {
    mode: client.mode,
    synthetic: recipient.source.synthetic,
    balanceBefore: balanceBefore ?? null,
    recipient: {
      faceShape: recipient.faceShape ?? null,
      // Raw hex for the operator's check only; GiftFit stores an undertone estimate, never the hex.
      colors: recipient.colors,
      faceQuality: recipient.faceQuality ?? null,
    },
    tryOns: tryOns.map((t) => (t.ok ? { kind: t.kind, ok: true, url: t.url, taskId: t.taskId } : { kind: t.kind, ok: false, code: t.code })),
    jewelryBody: { variant, verified: real && bodyResolved, tried },
    taskIds,
    reconciliation,
    units: { expected: estimate, charged: client.guard.unitsCharged },
  };
  const json = JSON.stringify(summary, null, 2);
  if (args.out) await fs.writeFile(args.out, json + "\n", "utf8");
  console.log(json);
  console.error(
    `[smoke] done: ${tryOns.filter((t) => t.ok).length}/2 try-ons, body variant ${variant}${real && bodyResolved ? ` (verified: set YOUCAM_JEWELRY_BODY_VARIANT=${variant})` : " (not verified)"}; units charged this run: ${client.guard.unitsCharged}`,
  );
  return tryOns.length === 2 && tryOns.every((t) => t.ok) ? 0 : 1;
}

/* c8 ignore start */
if (process.argv[1] && /youcam-smoke\.ts$/.test(process.argv[1])) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`[smoke] failed: ${err instanceof YoucamApiError ? `${err.message} (${err.status})` : (err as Error).message}`);
      process.exit(1);
    },
  );
}
/* c8 ignore stop */
