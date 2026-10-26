#!/usr/bin/env node
/**
 * Fetches the Supertonic 3 text-to-speech weights for the widget's IN-BROWSER voice engine (owner: A13,
 * ADR-052 as revised: Supertonic runs in the shopper's browser for en and vi; the GiftFit origin only
 * serves the files). Source: Hugging Face `supertone-oss-archive/supertonic-3` at the pinned final
 * revision below (the project was archived by Supertone Inc. on 2026-09-09; no further revisions).
 *
 * Every file is verified against the sha256 manifest committed here, then written SPLIT into parts of
 * at most 16 MiB (Cloud Run refuses non-streamed responses over 32 MiB) under
 *
 *   public/voice/supertonic/aafc6e32/            (git-ignored, never committed: Open RAIL-M weights)
 *     manifest.json   {"revision","files":[{"path","size","sha256","parts":[{"path","size","sha256"}]}]}
 *     LICENSE         the BigScience Open RAIL-M licence shipped with the weights (verified, unmodified)
 *     NOTICE          attribution, source, revision, use restrictions
 *     onnx/vector_estimator.onnx.part000 ...      (part paths are relative to this folder)
 *     onnx/tts.json                                (a small file is its own single part)
 *
 * The weights are not modified (only cut into byte ranges; the browser concatenates the parts and checks
 * the whole-file sha256). Idempotent: files already present and verified are kept (no network). Run it in
 * the Docker build stage (network is available in Cloud Build) and once locally; never commit the output.
 *
 *   node scripts/fetch-supertonic.mjs            fetch what is missing, verify everything, write manifest
 *   node scripts/fetch-supertonic.mjs --check    verify only (exit 1 if anything is missing or wrong)
 *   SUPERTONIC_VOICES=M1,F1 node scripts/...     stock voice styles to ship (default M1; see VOICE_STYLES)
 *
 * Licence: weights under the BigScience Open RAIL-M License (2022-08-18); use restrictions in its
 * Attachment A bind every user of the voice feature (data/LICENSES.md, widget terms).
 */
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO = "supertone-oss-archive/supertonic-3";
export const REVISION = "aafc6e32416a594460b32413efc49d7fe4ce6d46";
export const SHORT_REV = REVISION.slice(0, 8);
export const OUT = path.join(ROOT, "public", "voice", "supertonic", SHORT_REV);
export const PART_SIZE = 16 * 1024 * 1024;
const BASE = `https://huggingface.co/${REPO}/resolve/${REVISION}/`;

/** Model files (sha256 = Git LFS oid for the .onnx files; size and hash read from the HF API at the revision). */
export const MODEL_FILES = {
  "onnx/duration_predictor.onnx": { size: 3_700_147, sha256: "c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db" },
  "onnx/text_encoder.onnx": { size: 36_416_150, sha256: "c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff" },
  "onnx/vector_estimator.onnx": { size: 256_534_781, sha256: "883ac868ea0275ef0e991524dc64f16b3c0376efd7c320af6b53f5b780d7c61c" },
  "onnx/vocoder.onnx": { size: 101_424_195, sha256: "085de76dd8e8d5836d6ca66826601f615939218f90e519f70ee8a36ed2a4c4ba" },
  "onnx/tts.json": { size: 8_253, sha256: "42078d3aef1cd43ab43021f3c54f47d2d75ceb4e75f627f118890128b06a0d09" },
  "onnx/unicode_indexer.json": { size: 277_676, sha256: "9bf7346e43883a81f8645c81224f786d43c5b57f3641f6e7671a7d6c493cb24f" },
};

/** The ten stock voice styles (cross-lingual). Only stock voices: no cloning (Attachment A(g)). */
export const VOICE_STYLES = {
  F1: { size: 292_046, sha256: "bbdec6ee00231c2c742ad05483df5334cab3b52fda3ba38e6a07059c4563dbc2" },
  F2: { size: 292_423, sha256: "7c722c6a72707b1a77f035d67f0d1351ba187738e06f7683e8c72b1df3477fc6" },
  F3: { size: 290_794, sha256: "12f6ef2573baa2defa1128069cb59f203e3ab67c92af77b42df8a0e3a2f7c6ab" },
  F4: { size: 291_808, sha256: "c2fa764c1225a76dfc3e2c73e8aa4f70d9ee48793860eb34c295fff01c2e032b" },
  F5: { size: 291_479, sha256: "45966e73316415626cf41a7d1c6f3b4c70dbc1ba2bee5c1978ef0ce33244fc8d" },
  M1: { size: 291_748, sha256: "e35604687f5d23694b8e91593a93eec0e4eca6c0b02bb8ed69139ab2ea6b0a5b" },
  M2: { size: 292_055, sha256: "b76cbf62bac707c710cf0ae5aba5e31eea1a6339a9734bfae33ab98499534a50" },
  M3: { size: 290_198, sha256: "ea1ac35ccb91b0d7ecad533a2fbd0eec10c91513d8951e3b25fbba99954e159b" },
  M4: { size: 291_522, sha256: "ca8eefad4fcd989c9379032ff3e50738adc547eeb5e221b82593a6d7b3bac303" },
  M5: { size: 291_469, sha256: "dd22b92740314321f8ae11c5e87f8dd60d060f15dd3a632b5adf77f471f77af2" },
};

/** The licence file shipped with the weights (BigScience Open RAIL-M License, dated 2022-08-18). */
export const LICENSE_FILE = { size: 15_007, sha256: "0d944a9110fed9a9602d60e0423a272903e7bd21ab060490774efc77c2275e9f" };

export const DEFAULT_VOICES = ["M1"];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Part paths for a file of `size` bytes: the file itself when it fits in one part, else `.partNNN`. */
export function partPaths(rel, size, partSize = PART_SIZE) {
  if (size <= partSize) return [rel];
  const n = Math.ceil(size / partSize);
  return Array.from({ length: n }, (_, i) => `${rel}.part${String(i).padStart(3, "0")}`);
}

export function selectedVoices(env = process.env) {
  const raw = env.SUPERTONIC_VOICES?.trim();
  const list = raw ? raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) : DEFAULT_VOICES;
  for (const v of list) if (!(v in VOICE_STYLES)) throw new Error(`unknown Supertonic voice "${v}" (stock voices: ${Object.keys(VOICE_STYLES).join(", ")})`);
  return [...new Set(list)];
}

/** Every file this run ships, path → {size, sha256}. */
export function wantedFiles(env = process.env) {
  const files = { ...MODEL_FILES };
  for (const v of selectedVoices(env)) files[`voice_styles/${v}.json`] = VOICE_STYLES[v];
  return files;
}

/** Re-hash the parts on disk: returns the manifest entry when the whole file verifies, else null. */
async function verifyOnDisk(rel, want) {
  const whole = createHash("sha256");
  const parts = [];
  let total = 0;
  for (const p of partPaths(rel, want.size)) {
    let buf;
    try {
      buf = await readFile(path.join(OUT, p));
    } catch {
      return null;
    }
    whole.update(buf);
    total += buf.length;
    parts.push({ path: p, size: buf.length, sha256: sha256(buf) });
  }
  if (total !== want.size || whole.digest("hex") !== want.sha256) return null;
  return { path: rel, size: want.size, sha256: want.sha256, parts };
}

/** Streams one file from HF into parts, hashing as it goes; a mismatch removes every part written. */
async function download(rel, want) {
  const res = await fetch(BASE + rel, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`${rel}: HTTP ${res.status}`);
  const names = partPaths(rel, want.size);
  const whole = createHash("sha256");
  const parts = [];
  let idx = 0;
  let handle = null;
  let partHash = null;
  let partLen = 0;
  let total = 0;
  const tmp = (i) => path.join(OUT, `${names[i]}.tmp`);
  const closePart = async () => {
    if (!handle) return;
    await handle.close();
    handle = null;
    parts.push({ path: names[idx], size: partLen, sha256: partHash.digest("hex") });
    idx += 1;
  };
  try {
    for await (const chunk of res.body) {
      let buf = Buffer.from(chunk);
      while (buf.length > 0) {
        if (!handle) {
          if (idx >= names.length) throw new Error(`${rel}: larger than the manifest says (${want.size} bytes)`);
          await mkdir(path.dirname(tmp(idx)), { recursive: true });
          handle = await open(tmp(idx), "w");
          partHash = createHash("sha256");
          partLen = 0;
        }
        const take = Math.min(buf.length, PART_SIZE - partLen);
        const slice = buf.subarray(0, take);
        await handle.write(slice);
        partHash.update(slice);
        whole.update(slice);
        partLen += take;
        total += take;
        buf = buf.subarray(take);
        if (partLen === PART_SIZE) await closePart();
      }
    }
    await closePart();
    const got = whole.digest("hex");
    if (total !== want.size || got !== want.sha256) throw new Error(`${rel}: sha256/size mismatch (got ${got}, ${total} bytes; want ${want.sha256}, ${want.size}); refusing to keep it`);
    for (let i = 0; i < names.length; i += 1) await rename(tmp(i), path.join(OUT, names[i]));
    return { path: rel, size: want.size, sha256: want.sha256, parts };
  } catch (err) {
    if (handle) await handle.close().catch(() => undefined);
    for (let i = 0; i < names.length; i += 1) await rm(tmp(i), { force: true });
    throw err;
  }
}

async function fetchWithRetry(rel, want, attempts = 3) {
  let last;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await download(rel, want);
    } catch (err) {
      last = err;
      if (/mismatch|larger than/.test(String(err?.message))) break; // a wrong file will not get better
      if (i < attempts) console.warn(`[supertonic] ${rel}: attempt ${i} failed (${err.message}); retrying`);
    }
  }
  throw last;
}

async function ensureLicense(check) {
  const dest = path.join(OUT, "LICENSE");
  try {
    if (sha256(await readFile(dest)) === LICENSE_FILE.sha256) return "kept";
  } catch {
    /* missing */
  }
  if (check) throw new Error("LICENSE missing or modified");
  const res = await fetch(BASE + "LICENSE", { redirect: "follow" });
  if (!res.ok) throw new Error(`LICENSE: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha256(buf) !== LICENSE_FILE.sha256) throw new Error("LICENSE: sha256 mismatch; refusing to write it");
  await mkdir(OUT, { recursive: true });
  await writeFile(dest, buf);
  return "fetched";
}

export function noticeText(voices) {
  return [
    "Supertonic 3 text-to-speech model weights",
    "",
    "Copyright (c) Supertone Inc.",
    `Source: https://huggingface.co/${REPO} at revision ${REVISION}`,
    "(the project was archived by Supertone Inc. on 2026-09-09; this is its final revision).",
    "",
    "Licensed under the BigScience Open RAIL-M License, dated August 18, 2022: see LICENSE in this folder.",
    "The use-based restrictions in Attachment A of that licence apply to every use of this model and of",
    "the audio it produces, including: no impersonation of others (no voice cloning; only the stock voice",
    "styles are shipped), machine-generated speech must be disclosed as such (GiftFit labels it \"AI voice\"),",
    "no medical advice, no unlawful, harassing or discriminatory uses.",
    "",
    "Files: onnx/duration_predictor.onnx, onnx/text_encoder.onnx, onnx/vector_estimator.onnx, onnx/vocoder.onnx,",
    `onnx/tts.json, onnx/unicode_indexer.json, ${voices.map((v) => `voice_styles/${v}.json`).join(", ")}.`,
    "The files are NOT modified. Files over 16 MiB are served as consecutive byte ranges (\".partNNN\") for",
    "hosting limits only; concatenating the parts in order restores the original file (see manifest.json for",
    "the sha256 of every file and part).",
    "",
    "Served by GiftFit for its in-browser voice. GiftFit's own code is MIT licensed; that licence does not",
    "apply to these weights.",
    "",
  ].join("\n");
}

async function main() {
  const check = process.argv.includes("--check");
  const voices = selectedVoices();
  const files = wantedFiles();
  await mkdir(OUT, { recursive: true });
  const entries = [];
  let fetched = 0;
  for (const [rel, want] of Object.entries(files)) {
    let entry = await verifyOnDisk(rel, want);
    if (entry) {
      console.log(`[supertonic] kept     ${rel}`);
    } else if (check) {
      throw new Error(`${rel}: missing or does not verify`);
    } else {
      const t0 = Date.now();
      entry = await fetchWithRetry(rel, want);
      fetched += want.size;
      console.log(`[supertonic] fetched  ${rel} (${(want.size / 1048576).toFixed(1)} MiB, ${entry.parts.length} part(s), ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    }
    entries.push(entry);
  }
  console.log(`[supertonic] LICENSE ${await ensureLicense(check)}`);
  const manifest = { revision: REVISION, source: `https://huggingface.co/${REPO}`, license: "LICENSE", notice: "NOTICE", partSize: PART_SIZE, files: entries };
  const manifestText = JSON.stringify(manifest, null, 2) + "\n";
  const noticeBody = noticeText(voices);
  if (check) {
    const onDisk = await readFile(path.join(OUT, "manifest.json"), "utf8").catch(() => "");
    if (onDisk !== manifestText) throw new Error("manifest.json missing or stale");
  } else {
    await writeFile(path.join(OUT, "manifest.json"), manifestText);
    await writeFile(path.join(OUT, "NOTICE"), noticeBody);
  }
  let largest = 0;
  for (const e of entries) for (const p of e.parts) largest = Math.max(largest, (await stat(path.join(OUT, p.path))).size);
  const total = entries.reduce((s, e) => s + e.size, 0);
  console.log(`[supertonic] ok: ${entries.length} files, ${(total / 1048576).toFixed(1)} MiB (${(fetched / 1048576).toFixed(1)} MiB fetched), largest part ${(largest / 1048576).toFixed(2)} MiB, voices ${voices.join(",")} → ${path.relative(ROOT, OUT)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[supertonic] ${err.message}`);
    process.exit(1);
  });
}
