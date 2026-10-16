/**
 * Minimal static server for a fixture site directory, using the same URL → file mapping as
 * INGEST_FIXTURE=1 (lib/ingest/fixtures.ts). Binds 127.0.0.1 on a random port. Used to render fixture
 * pages with real Chromium (snapshot writer, Playwright integration test). Never serves outside `dir`.
 */
import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fixtureRelPath } from "@/lib/ingest/fixtures";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
};

export async function serveDir(dir: string): Promise<{ origin: string; close: () => Promise<void> }> {
  const root = path.resolve(dir);
  const server = http.createServer(async (req, res) => {
    try {
      const rel = fixtureRelPath(`http://fixture.local${req.url ?? "/"}`);
      const file = path.resolve(root, rel);
      if (!file.startsWith(root + path.sep)) throw new Error("outside root");
      const body = await fs.readFile(file);
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}
