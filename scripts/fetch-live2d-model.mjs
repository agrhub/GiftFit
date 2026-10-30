#!/usr/bin/env node
/**
 * Fetches the one Live2D model the widget uses (Mark-kun, a Live2D Original Character sample) from
 * Live2D's own repository at a pinned tag into public/live2d/models/Mark/ (git-ignored), verifying
 * every file against the sha256 manifest below, and copies the Cubism Web Framework's WebGL shaders
 * from the client/vendor/CubismWebFramework submodule into public/live2d/shaders/WebGL/ (also git-ignored).
 *
 * ADR-050: the model and Core are never committed; no sound files; the model is not modified. Core
 * (public/live2d/core/live2dcubismcore.min.js) is placed by hand after accepting Live2D's licence;
 * this script only checks that it is there. Usage: `npm run live2d:fetch` (idempotent; offline once
 * the files are present and verified).
 *
 * Terms: Free Material License Agreement v1.6 and Terms of Use for Live2D Cubism Sample Data v1.7
 * (https://www.live2d.com/eula/live2d-sample-model-terms_en.html). See docs/LICENSES.md.
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TAG = "5-r.5"; // matches the client/vendor/CubismWebFramework submodule and the Core build
const BASE = `https://raw.githubusercontent.com/Live2D/CubismWebSamples/${TAG}/Samples/Resources/Mark/`;
const OUT = path.join(ROOT, "public", "live2d", "models", "Mark");
const SHADERS_SRC = path.join(ROOT, "client", "vendor", "CubismWebFramework", "Shaders", "WebGL");
const SHADERS_OUT = path.join(ROOT, "public", "live2d", "shaders", "WebGL");
const CORE = path.join(ROOT, "public", "live2d", "core", "live2dcubismcore.min.js");

/** Every file of Mark-kun at CubismWebSamples@5-r.5 (he has no sounds/). */
export const MARK_MANIFEST = {
  "Mark.model3.json": "143b23ff339c01fd963d82c5bcc102aa0b4b11bd6baf4adeba4e84fde04ff6b6",
  "Mark.moc3": "f6351429bd3dd655ac95d1027e463ae415e99e2b1b43431a9662fcd316373e9e",
  "Mark.physics3.json": "6324414044835687b8bcc358a1add196e622b007115087b8ce512de28e7050df",
  "Mark.cdi3.json": "f66a52b92b7e9aceca0a81e2ba21babce95a56adb7d86642bb256f56b71e0899",
  "Mark.userdata3.json": "0999d1b734818f9990a7d435c0dcf1ec76353db4864fb0071b8fdaae478fb4b9",
  "Mark.2048/texture_00.png": "2d1190a596f202423b005075e15816013544b456f78e029e18b5fde45329785c",
  "motions/mark_m01.motion3.json": "0a8e5ecea2d7de5ccedd968ad8ebc7011a9ef39de8b3cac68a6f3e0131458748",
  "motions/mark_m02.motion3.json": "c292927418fb3f1af2ed7bfc8a5cf93d21e73ca425550c44ae3818bc1c095c19",
  "motions/mark_m03.motion3.json": "df2d18c1d0c0ec35068c2ec662665048ec0d9ba879ac42207e8b991af3c88c2b",
  "motions/mark_m04.motion3.json": "e191085176c05074f8762ce4a46c35a21d5a7fe8176af2a4dcf2e028fb37c018",
  "motions/mark_m05.motion3.json": "a681213b1c6f72eb97cd019d9571caec0d8520f32f7a8e45902c2ff6438e5d1e",
  "motions/mark_m06.motion3.json": "11189f96fd1505199a8442675f4538c401d73ac0c63679dfed6e744e6278c17d",
};

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function fileHash(p) {
  try {
    return sha256(await readFile(p));
  } catch {
    return null;
  }
}

async function fetchVerified(rel, want) {
  const dest = path.join(OUT, rel);
  if ((await fileHash(dest)) === want) return "kept";
  const res = await fetch(BASE + rel, { redirect: "follow" });
  if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== want) throw new Error(`${rel}: sha256 mismatch (got ${got}, want ${want}); refusing to write it`);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  return "fetched";
}

async function copyShaders() {
  let names;
  try {
    names = (await readdir(SHADERS_SRC)).filter((n) => /\.(vert|frag)$/.test(n));
  } catch {
    throw new Error("client/vendor/CubismWebFramework is missing: run `git submodule update --init client/vendor/CubismWebFramework`");
  }
  await mkdir(SHADERS_OUT, { recursive: true });
  for (const n of names) await copyFile(path.join(SHADERS_SRC, n), path.join(SHADERS_OUT, n));
  return names.length;
}

async function main() {
  let fetched = 0;
  for (const [rel, want] of Object.entries(MARK_MANIFEST)) {
    if ((await fetchVerified(rel, want)) === "fetched") fetched++;
  }
  const shaders = await copyShaders();
  console.log(`live2d: Mark-kun ${Object.keys(MARK_MANIFEST).length} files verified (${fetched} fetched) → public/live2d/models/Mark/`);
  console.log(`live2d: ${shaders} WebGL shaders copied → public/live2d/shaders/WebGL/`);
  const core = await stat(CORE).catch(() => null);
  if (!core) {
    console.warn(
      "live2d: public/live2d/core/live2dcubismcore.min.js is missing. Download the Cubism SDK for Web 5-r.5 from live2d.com, " +
        "accept its licence, and copy Core/live2dcubismcore.min.js there unmodified. Until then the widget shows the SVG mascot.",
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`live2d: ${err.message}`);
    process.exit(1);
  });
}
