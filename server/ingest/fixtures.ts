/**
 * INGEST_FIXTURE=1 support: serves the fixture sites in fixtures/ingest/ as if they were live hosts
 * (`*.test` names, never resolvable), with no network and no browser.
 *
 * URL → file mapping (shared by the fetch mock, the snapshot renderer and the snapshot writer):
 *   "/"                     → index.html
 *   "/a/b/"                 → a/b/index.html
 *   "/products/x"           → products/x.html          (no extension → .html)
 *   "/products.json?page=2" → products.q-page=2.json   (query sanitised into the name)
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { FetchLike, FetchLikeResponse } from "./politeness";

export const FIXTURES_ROOT = path.join(process.cwd(), "fixtures", "ingest");

/** Fixture host → directory under fixtures/ingest/. */
export const FIXTURE_SITES: Record<string, string> = {
  "aurum-fixture.test": "aurum-sample",
  "shopify-fixture.test": "shopify",
  "jsonld-fixture.test": "jsonld",
};

export function fixtureRelPath(rawUrl: string): string {
  const url = new URL(rawUrl);
  let p = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  if (p === "" || p.endsWith("/")) p += "index.html";
  else if (!path.posix.extname(p)) p += ".html";
  if (url.search.length > 1) {
    const q = url.search.slice(1).replace(/[^A-Za-z0-9=_-]/g, "_");
    const ext = path.posix.extname(p);
    p = `${p.slice(0, -ext.length)}.q-${q}${ext}`;
  }
  if (p.split("/").some((seg) => seg === "..")) throw new Error(`unsafe fixture path: ${rawUrl}`);
  return p;
}

export function fixtureSiteDir(host: string, root = FIXTURES_ROOT): string {
  const dir = FIXTURE_SITES[host];
  if (!dir) throw new Error(`no fixture site for host ${host}`);
  return path.join(root, dir);
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".xml": "application/xml",
  ".txt": "text/plain",
  ".js": "text/javascript",
};

const response = (status: number, url: string, body: string, contentType = "text/plain"): FetchLikeResponse => {
  const headers = new Headers({ "content-type": contentType });
  return { status, url, headers, text: async () => body };
};

/** FetchLike over `<site>/site/<path>`. Missing files are 404. */
export function createFixtureFetch(root = FIXTURES_ROOT): FetchLike {
  return async (rawUrl) => {
    const url = new URL(rawUrl);
    const file = path.join(fixtureSiteDir(url.host, root), "site", fixtureRelPath(rawUrl));
    try {
      const body = await fs.readFile(file, "utf8");
      return response(200, rawUrl, body, CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream");
    } catch {
      return response(404, rawUrl, "not found");
    }
  };
}

/** Path of the post-JavaScript snapshot of a fixture page (written by server/ingest/worker/snapshot.ts). */
export function snapshotPath(rawUrl: string, root = FIXTURES_ROOT): string {
  const url = new URL(rawUrl);
  return path.join(fixtureSiteDir(url.host, root), "rendered", fixtureRelPath(rawUrl));
}
