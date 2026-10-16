#!/usr/bin/env node
/**
 * Static cross-origin host for the script-tag demo (owner: A6). No dependencies.
 *
 *   GIFTFIT_ORIGIN=http://localhost:3000 node packages/plugin/demo/serve-host.mjs [port]
 *
 * Serves plugin-host.html on http://127.0.0.1:<port>/ (default 4310), a different origin from the
 * app. Query: ?sku=AUR-EAR-028 (default) and ?name=..., so a test can load a product that is not
 * in the catalog. Values are HTML-escaped before they reach the page.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const port = Number(process.argv[2] ?? process.env.PLUGIN_HOST_PORT ?? 4310);
const origin = (process.env.GIFTFIT_ORIGIN ?? "http://localhost:3000").replace(/\/$/, "");
const template = readFileSync(fileURLToPath(new URL("./plugin-host.html", import.meta.url)), "utf8");
const esc = (s) => String(s).replace(/[&<>"'\\]/g, (c) => `&#${c.charCodeAt(0)};`);

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname !== "/") {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
    return;
  }
  const html = template
    .replaceAll("{{ORIGIN}}", esc(origin))
    .replaceAll("{{SKU}}", esc(url.searchParams.get("sku") ?? "AUR-EAR-028"))
    .replaceAll("{{NAME}}", esc(url.searchParams.get("name") ?? "Halo Drop Earrings"));
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(html);
});

server.listen(port, "127.0.0.1", () => console.log(`plugin host on http://127.0.0.1:${port}/ (app ${origin})`));
