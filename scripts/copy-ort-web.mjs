#!/usr/bin/env node
/**
 * Copies the onnxruntime-web runtime the widget's in-browser voice engine loads (owner: A13; the engine
 * itself is A4's, components/widget/voice/**) from node_modules into public/voice/ort/<version>/, so it
 * is served from the GiftFit origin and never bundled by webpack. Git-ignored (/public/voice/); run in the
 * Docker build stage after `npm ci`, and locally after an install. No network.
 *
 * Copied: ort.webgpu.min.mjs and every ort-wasm-simd-threaded*.mjs / *.wasm (plain, jsep, jspi, asyncify),
 * plus a LICENSE (onnxruntime-web is MIT, Copyright (c) Microsoft Corporation; the npm package carries
 * the licence only in its file headers and package.json, so the standard MIT text is written here).
 * Every file must stay under Cloud Run's 32 MiB response cap; the script fails otherwise.
 *
 *   node scripts/copy-ort-web.mjs           copy (idempotent: unchanged files are kept)
 *   node scripts/copy-ort-web.mjs --check   verify the copy only (exit 1 when missing or different)
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = path.join(ROOT, "node_modules", "onnxruntime-web");
export const EXPECTED_VERSION = "1.30.0";
export const CLOUD_RUN_RESPONSE_CAP = 32 * 1024 * 1024;

export const ORT_MIT_LICENSE = `MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---
onnxruntime-web ${EXPECTED_VERSION} (https://github.com/microsoft/onnxruntime), files copied unmodified
from the npm package's dist/ folder.
`;

/** dist/ files the engine may load (the browser picks the WASM flavour at runtime). */
export function isRuntimeFile(name) {
  return name === "ort.webgpu.min.mjs" || /^ort-wasm-simd-threaded(\.[a-z]+)?\.(mjs|wasm)$/.test(name);
}

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

async function main() {
  const check = process.argv.includes("--check");
  let pkg;
  try {
    pkg = JSON.parse(await readFile(path.join(PKG, "package.json"), "utf8"));
  } catch {
    throw new Error("node_modules/onnxruntime-web is missing: run npm ci");
  }
  if (pkg.version !== EXPECTED_VERSION) throw new Error(`onnxruntime-web ${pkg.version} installed, expected exactly ${EXPECTED_VERSION} (the widget loads /voice/ort/${EXPECTED_VERSION}/)`);
  const out = path.join(ROOT, "public", "voice", "ort", EXPECTED_VERSION);
  const names = (await readdir(path.join(PKG, "dist"))).filter(isRuntimeFile).sort();
  if (!names.includes("ort.webgpu.min.mjs") || !names.some((n) => n.endsWith(".wasm"))) throw new Error("onnxruntime-web dist/ is missing ort.webgpu.min.mjs or the .wasm files");
  await mkdir(out, { recursive: true });
  let largest = { name: "", size: 0 };
  let copied = 0;
  for (const n of names) {
    const src = await readFile(path.join(PKG, "dist", n));
    if (src.length >= CLOUD_RUN_RESPONSE_CAP) throw new Error(`${n} is ${src.length} bytes: over Cloud Run's 32 MiB response cap`);
    if (src.length > largest.size) largest = { name: n, size: src.length };
    const dest = path.join(out, n);
    const existing = await readFile(dest).catch(() => null);
    if (existing && sha(existing) === sha(src)) continue;
    if (check) throw new Error(`${n} missing or different in ${path.relative(ROOT, out)}`);
    await copyFile(path.join(PKG, "dist", n), dest);
    copied += 1;
  }
  const lic = path.join(out, "LICENSE");
  if ((await readFile(lic, "utf8").catch(() => "")) !== ORT_MIT_LICENSE) {
    if (check) throw new Error("LICENSE missing or different");
    await writeFile(lic, ORT_MIT_LICENSE);
  }
  console.log(`[ort] ok: ${names.length} files (${copied} copied) + LICENSE → ${path.relative(ROOT, out)}; largest ${largest.name} ${(largest.size / 1048576).toFixed(2)} MiB`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[ort] ${err.message}`);
    process.exit(1);
  });
}
