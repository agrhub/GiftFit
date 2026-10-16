/**
 * Builds the client-rendered Aurum fixture store (fixtures/ingest/aurum-sample/site/) from rows.json.
 * Server HTML = empty #root + JSON data blob + /assets/app.js, so only a JS renderer sees products.
 *
 *   npx tsx workers/ingest/fixture-site.ts
 */
import { promises as fs } from "node:fs";
import path from "node:path";

interface Row {
  slug: string;
  title: string;
  crumb: string | null;
  price: string | null;
  compare?: string;
  metal: string | null;
  stone: string | null;
  length: string | null;
  sku: string | null;
  template: "A" | "B" | "C";
  images: number;
  description: string;
  related: string[];
}

export const SITE_DIR = path.join(process.cwd(), "fixtures", "ingest", "aurum-sample", "site");
const PAGE_SIZE = 12;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** JSON inside <script>: escape "<" so the blob can never close the tag. */
const blob = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

function page(title: string, data: unknown): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | Aurum Jewelry (fixture)</title>
</head>
<body>
<div id="root"></div>
<script id="__AURUM_DATA__" type="application/json">${blob(data)}</script>
<script src="/assets/app.js"></script>
</body>
</html>
`;
}

/** Metal shown on a related-product card: the stated metal, or the phrase from a prose description. */
const cardMetal = (r: Row) => r.metal ?? /\b(\d{2}k (?:yellow|white|rose) gold|sterling silver|platinum)\b/i.exec(r.description)?.[1] ?? null;

export async function buildFixtureSite(dir = SITE_DIR): Promise<string[]> {
  const rows = (JSON.parse(await fs.readFile(path.join(dir, "..", "rows.json"), "utf8")) as { rows: Row[] }).rows;
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const written: string[] = [];
  const write = async (rel: string, body: string) => {
    const file = path.join(dir, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
    written.push(rel);
  };
  await write("robots.txt", "User-agent: *\nDisallow: /cart\nDisallow: /account\n");
  const listing = rows.map((r) => ({ slug: r.slug, title: r.title, price: r.price }));
  await write("index.html", page("All jewelry", { listing: listing.slice(0, PAGE_SIZE), next: "/shop/page/2" }));
  await write("shop/page/2.html", page("All jewelry, page 2", { listing: listing.slice(PAGE_SIZE), prev: "/" }));
  for (const r of rows) {
    const related = r.related.map((s) => bySlug.get(s)!).map((x) => ({ slug: x.slug, title: x.title, price: x.price, metal: cardMetal(x) }));
    await write(`products/${r.slug}.html`, page(r.title, { product: r, related }));
  }
  return written;
}

if (process.argv[1] && /fixture-site\.ts$/.test(process.argv[1])) {
  buildFixtureSite().then((w) => console.log(`wrote ${w.length} files to ${SITE_DIR}`));
}
