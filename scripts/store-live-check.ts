/**
 * Live check of the GCP-native store (A11). MANUAL ONLY: not part of vitest/CI.
 *
 *   npx tsx scripts/store-live-check.ts
 *
 * Talks to Firestore database `giftfit-db` and bucket `gcp-project-405602-giftfit-photos` ONLY (both are
 * validated by lib/store/config.ts: a non-giftfit database or bucket is refused), with Application
 * Default Credentials (`gcloud auth application-default login`). Everything it writes uses a unique
 * `livecheck-` id and is deleted at the end, also on failure.
 *
 * Steps: create a Fit Request with profile, try-on row, hearts, a wish and a report; put a generated
 * PNG; read everything back through NEW clients (a simulated cold start); serve the PNG through the
 * app's signed, session-bound route (200), then "Delete my photo now" and check the same URL is 404;
 * reserve a daily counter twice and check the cap refuses the third; check a durable rate limit; write
 * an audit row; delete the request's data and photos and check 0 rows and 404 objects; clean up.
 * Prints ids and counts only (never a token, a key or a secret).
 */
import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { GET as tryonGET } from "@/app/api/recipient/tryon/[id]/route";
import { POST as deletePhotoPOST } from "@/app/api/recipient/delete-photo/route";
import { aurumCatalogSource } from "@/lib/privacy/catalog";
import { deleteEverything } from "@/lib/privacy/delete-everything";
import type { PrivacyDeps } from "@/lib/privacy/deps";
import { GcsPhotoStore, gcsObjectApi } from "@/lib/privacy/photo-store-gcs";
import { FirestoreRateLimitStore } from "@/lib/privacy/rate-limit-firestore";
import { FirestorePrivacyRepos } from "@/lib/privacy/repos/firestore";
import { setPrivacyDeps } from "@/lib/privacy/runtime";
import { RECIPIENT_COOKIE } from "@/lib/privacy/session";
import { signTryOnUrl } from "@/lib/privacy/signed-url";
import { newFitRequestTokens } from "@/lib/privacy/tokens";
import { firestoreDatabaseId, gcsPhotoBucket } from "@/lib/store/config";
import { FirestoreDailyCounterStore } from "@/lib/store/daily-counter";
import { COLLECTIONS, type FsDb } from "@/lib/store/firestore-types";
import { newFirestoreDb, newGcsBucket, type GcsBucketLike } from "@/lib/store/gcp-clients";
import { FirestoreAuditSink } from "@/lib/youcam/audit";

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT?.trim() || "gcp-project-405602";
const DATABASE_ID = firestoreDatabaseId({ FIRESTORE_DATABASE_ID: process.env.FIRESTORE_DATABASE_ID || "giftfit-db" });
const BUCKET = gcsPhotoBucket({ GCS_PHOTO_BUCKET: process.env.GCS_PHOTO_BUCKET || "gcp-project-405602-giftfit-photos" });

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

/** A small valid PNG (16x16 gradient), generated in memory. */
function makePng(): Uint8Array {
  const w = 16;
  const h = 16;
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) raw.set([x * 16, y * 16, 128], y * (w * 3 + 1) + 1 + x * 3);
  }
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

async function objectExists(bucket: GcsBucketLike, name: string): Promise<boolean> {
  try {
    await bucket.file(name).getMetadata();
    return true;
  } catch (err) {
    if ((err as { code?: unknown }).code === 404) return false;
    throw err;
  }
}

async function main(): Promise<void> {
  console.log(`store live check: project ${PROJECT}, database ${DATABASE_ID}, bucket ${BUCKET}`);
  const suffix = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const id = `livecheck-${suffix}`;
  const counterKey = `livecheck-${suffix}`;
  const rateKey = `livecheck${randomBytes(6).toString("hex")}`;
  const now = () => new Date();
  const signingSecret = randomBytes(32).toString("base64url");

  const dbA = await newFirestoreDb({ databaseId: DATABASE_ID, projectId: PROJECT });
  const bucketA = await newGcsBucket({ bucket: BUCKET, projectId: PROJECT });
  const reposA = new FirestorePrivacyRepos(dbA);
  const photosA = new GcsPhotoStore(gcsObjectApi(bucketA));
  const cleanupDbs: FsDb[] = [dbA];
  const writtenKeys: string[] = [];

  try {
    // 1. Write.
    const tokens = newFitRequestTokens();
    const req = await reposA.fitRequests.create({
      id,
      storeId: null,
      giverTokenHash: tokens.giverTokenHash,
      recipientTokenHash: tokens.recipientTokenHash,
      occasion: "birthday",
      budgetMin: null,
      budgetMax: 300,
      currency: "USD",
      shortlistIds: ["livecheck-a", "livecheck-b"],
      decoyIds: ["livecheck-c"],
      status: "tried_on",
    });
    await reposA.profiles.upsert({ fitRequestId: id, undertoneEstimate: "warm", undertoneConfidence: 0.7, undertoneOverride: null, faceShape: "Oval", hasHandCapture: false, consentAt: now(), expiresAt: req.expiresAt });
    const png = makePng();
    const stored = await photosA.put({ fitRequestId: id, kind: "tryon", bytes: png, contentType: "image/png", ttlMs: 10 * 60_000 });
    writtenKeys.push(stored.key);
    const selfie = await photosA.put({ fitRequestId: id, kind: "selfie", bytes: png, contentType: "image/png", ttlMs: 5 * 60_000 });
    writtenKeys.push(selfie.key);
    const tryon = await reposA.tryons.insert({ fitRequestId: id, catalogId: "livecheck-a", feature: "2d-vto/earring", taskId: null, cacheKey: `livecheck-${suffix}`, resultRef: `store:${stored.key}`, status: "success", unitsCharged: 0, expiresAt: stored.expiresAt });
    await reposA.hearts.add(id, "livecheck-a");
    await reposA.hearts.add(id, { catalogId: "livecheck-b", variantId: "livecheck-b:gold" });
    await reposA.wishes.add(id, "livecheck-c");
    await reposA.reports.upsert({ fitRequestId: id, items: { fingerprint: "livecheck", items: [{ skuId: "livecheck-a", score: 90 }] } });
    console.log(`wrote fit request ${id} with profile, 1 try-on, 2 hearts, 1 wish, 1 report, 2 objects (${png.length} B PNG)`);

    // 2. Cold start: brand-new clients.
    const dbB = await newFirestoreDb({ databaseId: DATABASE_ID, projectId: PROJECT });
    cleanupDbs.push(dbB);
    const bucketB = await newGcsBucket({ bucket: BUCKET, projectId: PROJECT });
    const reposB = new FirestorePrivacyRepos(dbB);
    const photosB = new GcsPhotoStore(gcsObjectApi(bucketB));
    const found = await reposB.fitRequests.findByRecipientTokenHash(tokens.recipientTokenHash);
    check("cold start: request found by recipient token hash", found?.id === id && found.status === "tried_on" && found.expiresAt.getTime() === req.expiresAt.getTime());
    check("cold start: request found by giver token hash", (await reposB.fitRequests.findByGiverTokenHash(tokens.giverTokenHash))?.id === id);
    check("cold start: profile", (await reposB.profiles.get(id))?.undertoneEstimate === "warm");
    check("cold start: try-on row", (await reposB.tryons.get(tryon.id))?.resultRef === `store:${stored.key}`);
    const hearts = await reposB.hearts.list(id);
    check("cold start: hearts + wish rows", JSON.stringify(hearts) === JSON.stringify(["livecheck-a", "livecheck-b:gold", "wish:livecheck-c"]), hearts.join(","));
    check("cold start: report", JSON.stringify((await reposB.reports.get(id))?.items) === JSON.stringify({ fingerprint: "livecheck", items: [{ skuId: "livecheck-a", score: 90 }] }));
    const obj = await photosB.get(stored.key);
    check("cold start: PNG bytes", Boolean(obj) && Buffer.from(obj!.bytes).equals(Buffer.from(png)) && obj!.contentType === "image/png");
    const counts = await reposB.countForRequest(id);
    check("cold start: row counts", JSON.stringify(counts) === JSON.stringify({ recipient_profiles: 1, tryons: 1, hearts: 2, metal_wishes: 1, fit_reports: 1 }), JSON.stringify(counts));
    check("expiresAt TTL field is a Timestamp", typeof ((await dbB.collection(COLLECTIONS.hearts).where("fitRequestId", "==", id).get()).docs[0]?.data()?.expiresAt as { toDate?: unknown })?.toDate === "function");

    // 3. Serve through the app's signed, session-bound route; then "Delete my photo now".
    const deps: PrivacyDeps = {
      repos: reposB,
      photos: photosB,
      youcam: { deleteTask: async () => {}, deleteCachedResult: async () => {} },
      signingSecret,
      now,
      catalog: aurumCatalogSource(),
    };
    setPrivacyDeps(deps);
    const signed = signTryOnUrl({ tryOnId: tryon.id, sessionToken: tokens.recipientToken, secret: signingSecret });
    const fetchUrl = async () =>
      tryonGET(new Request(`http://localhost${signed.url}`, { headers: { cookie: `${RECIPIENT_COOKIE}=${tokens.recipientToken}` } }), { params: Promise.resolve({ id: tryon.id }) });
    const r1 = await fetchUrl();
    const served = Buffer.from(await r1.arrayBuffer());
    check("signed app URL serves the render", r1.status === 200 && served.equals(Buffer.from(png)), `status ${r1.status}, ttl ${signed.exp - Math.floor(Date.now() / 1000)} s`);
    const del = await deletePhotoPOST(new Request("http://localhost/api/recipient/delete-photo", { method: "POST", headers: { authorization: `Bearer ${tokens.recipientToken}` } }));
    check("delete-photo route", del.status === 200, `status ${del.status}`);
    const r2 = await fetchUrl();
    check("same signed URL after delete-photo is 404", r2.status === 404, `status ${r2.status}`);
    check("objects gone after delete-photo (GCS 404)", !(await objectExists(bucketB, stored.key)) && !(await objectExists(bucketB, selfie.key)));
    setPrivacyDeps(undefined);

    // 4. Durable counter: two reservations, the cap refuses the third.
    const counter = new FirestoreDailyCounterStore(async () => dbB);
    const c1 = await counter.tryReserve(counterKey, 1, 2);
    const c2 = await counter.tryReserve(counterKey, 1, 2);
    const c3 = await counter.tryReserve(counterKey, 1, 2);
    const counterAfterRestart = await new FirestoreDailyCounterStore(async () => dbA).get(counterKey);
    check("daily counter: +1, +1 allowed, cap 2 refuses the third", c1.ok && c2.ok && !c3.ok && c3.used === 2 && counterAfterRestart === 2, `used ${c3.used}`);
    check("daily counter refund", (await counter.refund(counterKey, 1)) === 1);

    // 5. Durable rate limit (scope "livecheck", limit 1/h).
    const limiter = new FirestoreRateLimitStore(async () => dbB);
    const rl1 = await limiter.take("livecheck", rateKey, Date.now(), [{ limit: 1, windowMs: 3600_000 }]);
    const rl2 = await new FirestoreRateLimitStore(async () => dbA).take("livecheck", rateKey, Date.now(), [{ limit: 1, windowMs: 3600_000 }]);
    check("rate limit: first allowed, second refused across clients", rl1.ok && !rl2.ok, `retry-after ${rl2.retryAfterSec} s`);

    // 6. Audit row.
    await new FirestoreAuditSink(async () => dbB).write({ ts: new Date().toISOString(), event: "youcam.purge", mode: "mock", taskId: id, detail: { livecheck: true } });
    const audit = await dbA.collection(COLLECTIONS.audit).where("taskId", "==", id).get();
    check("audit row written (no cacheKey)", audit.size === 1 && !("cacheKey" in (audit.docs[0].data() ?? {})));

    // 7. Delete everything for the request.
    const extra = await photosB.put({ fitRequestId: id, kind: "tryon", bytes: png, contentType: "image/png", ttlMs: 60_000 });
    writtenKeys.push(extra.key);
    const receipt = await deleteEverything({ ...deps, repos: reposB, photos: photosB }, id);
    const zero = JSON.stringify({ recipient_profiles: 0, tryons: 0, hearts: 0, metal_wishes: 0, fit_reports: 0 });
    const left = await new FirestorePrivacyRepos(dbA).countForRequest(id);
    check("deleteEverything verified", receipt.verified, `deleted rows ${JSON.stringify(receipt.deleted.rows)}, blobs ${receipt.deleted.blobs}`);
    check("row counts after delete are 0 (fresh client)", JSON.stringify(left) === zero, JSON.stringify(left));
    check("objects after delete are 404", !(await objectExists(bucketA, extra.key)) && (await photosA.listForRequest(id)).length === 0);
    check("request closed", (await reposB.fitRequests.findById(id))?.status === "deleted");
  } finally {
    // 8. Clean up everything this run wrote (idempotent).
    const db = dbA;
    await new FirestorePrivacyRepos(db).deleteRecipientData(id).catch(() => undefined);
    await db.collection(COLLECTIONS.fitRequests).doc(id).delete().catch(() => undefined);
    await db.collection(COLLECTIONS.dailyCounters).doc(counterKey).delete().catch(() => undefined);
    for (const d of (await db.collection(COLLECTIONS.rateLimits).where("scope", "==", "livecheck").get()).docs) {
      if (d.id.includes(rateKey)) await db.collection(COLLECTIONS.rateLimits).doc(d.id).delete();
    }
    for (const d of (await db.collection(COLLECTIONS.audit).where("taskId", "==", id).get()).docs) await db.collection(COLLECTIONS.audit).doc(d.id).delete();
    await photosA.deleteForRequest(id).catch(() => undefined);
    await photosA.delete(writtenKeys).catch(() => undefined);
    const leftDocs = [
      (await db.collection(COLLECTIONS.fitRequests).doc(id).get()).exists ? 1 : 0,
      (await db.collection(COLLECTIONS.dailyCounters).doc(counterKey).get()).exists ? 1 : 0,
      (await db.collection(COLLECTIONS.audit).where("taskId", "==", id).get()).size,
      (await db.collection(COLLECTIONS.rateLimits).where("scope", "==", "livecheck").get()).docs.filter((d) => d.id.includes(rateKey)).length,
    ].reduce((a, b) => a + b, 0);
    const leftObjects = (await photosA.listForRequest(id)).length;
    check("cleanup: no livecheck documents or objects left", leftDocs === 0 && leftObjects === 0, `docs ${leftDocs}, objects ${leftObjects}`);
    for (const d of cleanupDbs) await (d as unknown as { terminate?: () => Promise<void> }).terminate?.().catch(() => undefined);
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error("store live check aborted:", (err as Error).message);
  process.exitCode = 2;
});
