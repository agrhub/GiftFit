#!/usr/bin/env node
/**
 * GiftFit demo store (owner: A6, ADR-046): a plain static shop on its own origin that embeds the
 * GiftFit widget with one script tag. No dependencies.
 *
 *   GIFTFIT_ORIGIN=https://giftfit-xyz.a.run.app PORT=8080 node server/demo-store/server.mjs
 *
 * Serves server/demo-store/public. In .html files, {{GIFTFIT_ORIGIN}} becomes the GiftFit origin (default
 * http://localhost:3000). Unknown paths 404; no directory listing; no path traversal.
 */
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
const ORIGIN = (() => {
  try {
    return new URL(process.env.GIFTFIT_ORIGIN ?? "http://localhost:3000").origin;
  } catch {
    return "http://localhost:3000";
  }
})();
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://store.local");
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith("/")) rel += "index.html";
  if (!path.extname(rel)) rel += ".html";
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep)) return void res.writeHead(400).end();
  try {
    let body = await readFile(file);
    const ext = path.extname(file);
    if (ext === ".html") body = Buffer.from(body.toString("utf8").replaceAll("{{GIFTFIT_ORIGIN}}", ORIGIN));
    res.writeHead(200, { "Content-Type": TYPES[ext] ?? "application/octet-stream", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin" }).end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }
}).listen(PORT, HOST, () => console.log(`demo store on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}/ (GiftFit ${ORIGIN})`));
