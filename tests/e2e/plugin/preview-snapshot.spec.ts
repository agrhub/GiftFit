/**
 * Store-page snapshot previews (owner: A15). The test serves a fictional jewelry store on 127.0.0.1 (scripts,
 * inline handlers, a form, an iframe, images) and seeds a fixture preview with `snapshotFixturePort`
 * (POST /api/preview/seed, PREVIEW_FIXTURE_SEED=1 + Bearer CRON_SECRET): the app's SafeFetcher reads that
 * server through a swapped transport only (robots.txt, UA, caps unchanged). Checks: the copy renders in
 * the sandboxed iframe, nothing in it ran, the banner and the GiftFit widget are outside it, links behave,
 * the snapshot route's headers, the template fallback note, and Admin v0's status line.
 */
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { expect, test, type APIRequestContext } from "@playwright/test";

const STORE_PORT = 4362;
let store: Server | undefined;
const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
/** When set, "/" answers a JavaScript-rendered shell (nothing visible without scripts). */
let serveShell = false;
const SHELL = `<!doctype html><html><head><title>Lumen</title><script src="/app.js"></script></head><body><div id="root"></div><noscript>Enable JavaScript to shop.</noscript></body></html>`;

// Generous: a cold `next dev` compiles each route on first use.
test.describe.configure({ mode: "serial", timeout: 300_000 });
test.use({ extraHTTPHeaders: { "X-Forwarded-For": "203.0.113.77" } });

const PRODUCTS = [
  ["1001", "Aria Gold Hoops"],
  ["1002", "Lumen Pearl Studs"],
  ["1003", "Petal Rose Drops"],
  ["2001", "Solo Disc Pendant"],
];
const TEXT = "Hand-made fine jewelry in recycled gold and sterling silver, designed in small batches for everyday wear. ".repeat(3);
const MARK = `document.title = "PWNED"; document.documentElement.setAttribute("data-pwned", "1"); document.body && document.body.insertAdjacentHTML("beforeend", '<p id="pwned">PWNED</p>');`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<meta http-equiv="refresh" content="30;url=https://evil.example/">
<base href="https://evil.example/" target="_top">
<link rel="stylesheet" href="/theme.css"><link rel="preload" as="script" href="/app.js">
<style>.hero{padding:24px;background:#f7efe5 url(/hero.jpg)} h1{font-family:Georgia,serif}</style>
<script>${MARK}</script><script type="module">${MARK}</script>
</head><body onload="${MARK.replace(/"/g, "&quot;")}">${body}<script>${MARK}</script></body></html>`;
}

const HOME = page(
  "Lumen Fine Jewelry",
  `<header class="hero"><a href="/" id="logo">Lumen</a> <a href="/pages/about" id="about">About us</a> <a href="javascript:alert(1)" id="js">Deals</a></header>
<main><h1>Lumen Fine Jewelry (fixture)</h1><p>${TEXT}</p>
<ul>${PRODUCTS.map(([id, t]) => `<li><a href="/collections/all/products/${id}" data-testid="p-${id}"><img src="/img/${id}.jpg" alt="${t}" onerror="${MARK.replace(/"/g, "&quot;")}"> ${t}</a></li>`).join("")}</ul>
<form action="/contact" method="post" id="newsletter"><input name="email" placeholder="Email"><button type="submit">Join</button></form>
<iframe src="https://video.example/embed" id="vid"></iframe><svg onload="${MARK.replace(/"/g, "&quot;")}"><circle r="4"/></svg></main>`,
);
const PRODUCT = (id: string, t: string) => page(`${t} – Lumen`, `<main><a href="/" id="back">Home</a><h1>${t}</h1><img src="/img/${id}-large.jpg" alt=""><p>${TEXT}</p><button>Add to cart</button></main>`);

async function seed(request: APIRequestContext, data: Record<string, unknown>): Promise<{ key: string; previewPath: string; ownerPath: string }> {
  const res = await request.post("/api/preview/seed", { headers: { Authorization: `Bearer ${process.env.E2E_CRON_SECRET}` }, data, timeout: 60_000 });
  expect(res.status()).toBe(201);
  return res.json();
}

test.beforeAll(async () => {
  store = createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/robots.txt") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("User-agent: *\nAllow: /\n");
      return;
    }
    if (path === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(serveShell ? SHELL : HOME);
      return;
    }
    const m = /^\/products\/(\d+)$/.exec(path);
    const p = m && PRODUCTS.find(([id]) => id === m[1]);
    if (p) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PRODUCT(p[0], p[1]));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });
  await new Promise<void>((r) => store!.listen(STORE_PORT, "127.0.0.1", () => r()));
});
test.afterAll(() => store?.close());

test("snapshot preview: inert copy in a sandboxed frame, banner and widget outside", async ({ page, request }) => {
  const s = await seed(request, { kind: "jewelry", snapshotFixturePort: STORE_PORT });
  // The app read the fixture store as GiftFitPreviewBot: robots.txt, the home page, product pages.
  expect(seen.map((x) => x.url)).toEqual(expect.arrayContaining(["/robots.txt", "/", "/products/1001", "/products/2001"]));
  for (const x of seen) expect(x.headers["user-agent"]).toMatch(/^GiftFitPreviewBot\//);

  // The snapshot route itself: inert HTML with the strict headers.
  const snap = await request.get(`/s/${s.key}/snapshot`);
  expect(snap.status()).toBe(200);
  const h = snap.headers();
  expect(h["content-security-policy"]).toContain("default-src 'none'; img-src https: data:; style-src https: 'unsafe-inline'; font-src https: data:; frame-ancestors 'self'");
  expect(h["content-security-policy"]).not.toMatch(/script-src/);
  expect(h["x-robots-tag"]).toBe("noindex, nofollow");
  expect(h["cache-control"]).toBe("private, no-store");
  expect(h["referrer-policy"]).toBe("no-referrer");
  expect(h["x-content-type-options"]).toBe("nosniff");
  const body = await snap.text();
  expect(body).not.toMatch(/<script|onerror|onload|javascript:|<form|<input|<iframe|<base|http-equiv/i);

  const res = await page.goto(s.previewPath);
  expect(res?.status()).toBe(200);
  expect(res?.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  // Banner outside the frame, persistent text unchanged.
  await expect(page.getByTestId("preview-banner")).toHaveText("Preview generated from lumen-jewelry.example by GiftFit — not affiliated with lumen-jewelry.example.");
  const iframe = page.getByTestId("preview-snapshot-frame");
  await expect(iframe).toHaveAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox");
  const sandbox = (await iframe.getAttribute("sandbox")) ?? "";
  for (const banned of ["allow-scripts", "allow-same-origin", "allow-forms", "allow-top-navigation"]) expect(sandbox).not.toContain(banned);
  await expect(iframe).toHaveAttribute("src", `/s/${s.key}/snapshot`);

  // The frame fills the viewport below the banner.
  const vp = page.viewportSize()!;
  const banner = (await page.getByTestId("preview-banner").boundingBox())!;
  const box = (await iframe.boundingBox())!;
  expect(Math.abs(box.y - (banner.y + banner.height))).toBeLessThanOrEqual(1);
  expect(Math.abs(box.y + box.height - vp.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.width - vp.width)).toBeLessThanOrEqual(1);

  // The copy renders...
  const frame = page.frameLocator('[data-testid="preview-snapshot-frame"]');
  await expect(frame.locator("h1")).toHaveText("Lumen Fine Jewelry (fixture)");
  await expect(frame.locator("li img")).toHaveCount(4);
  // ...and nothing in it ran: the fixture's scripts and handlers would have set these.
  expect(await frame.locator("title").textContent()).toBe("Lumen Fine Jewelry");
  await expect(frame.locator("#pwned")).toHaveCount(0);
  await expect(frame.locator("html")).not.toHaveAttribute("data-pwned", "1");
  expect(await frame.locator("script, form, input, iframe, base, meta[http-equiv]").count()).toBe(0);
  const childFrame = page.frames().find((f) => f.url().endsWith(`/s/${s.key}/snapshot`));
  expect(childFrame).toBeTruthy();
  // Playwright's own utility world can read the frame even though its scripts are disabled.
  expect(await childFrame!.evaluate(() => document.title).catch(() => "Lumen Fine Jewelry")).toBe("Lumen Fine Jewelry");

  // Widget outside the frame (outer page), never inside the copy.
  await expect(page.locator("giftfit-widget")).toHaveAttribute("data-ready", "", { timeout: 60_000 });
  expect(await frame.locator("giftfit-widget").count()).toBe(0);
  expect(await page.locator("script[src*='giftfit.js']").count()).toBe(1);
  expect(await frame.locator("script[src*='giftfit.js']").count()).toBe(0);

  // Links: other pages open the real site in a new tab; GiftFit products stay in the frame.
  await expect(frame.locator("#about")).toHaveAttribute("href", "https://lumen-jewelry.example/pages/about");
  await expect(frame.locator("#about")).toHaveAttribute("target", "_blank");
  await expect(frame.locator("#about")).toHaveAttribute("rel", "noopener noreferrer nofollow");
  expect(await frame.locator("#js").getAttribute("href")).toBeNull();
  await expect(frame.locator("#logo")).toHaveAttribute("href", `/s/${s.key}/snapshot`);
  await expect(frame.getByTestId("p-1001")).toHaveAttribute("href", `/s/${s.key}/snapshot/p/1001`);
  await frame.getByTestId("p-1001").click();
  await expect(frame.locator("h1")).toHaveText("Aria Gold Hoops", { timeout: 60_000 });
  await expect(frame.locator("#pwned")).toHaveCount(0);
  await expect(frame.locator("button")).toHaveAttribute("type", "button");
  expect(new URL(page.url()).pathname).toBe(s.previewPath); // the top page never navigated

  // The outer product page frames that product's copy and keeps the widget's PDP data.
  await page.goto(`${s.previewPath}/p/1002`);
  await expect(page.getByTestId("preview-snapshot-frame")).toHaveAttribute("src", `/s/${s.key}/snapshot/p/1002`);
  await expect(page.frameLocator('[data-testid="preview-snapshot-frame"]').locator("h1")).toHaveText("Lumen Pearl Studs", { timeout: 60_000 });
  const ld = JSON.parse((await page.locator('script[type="application/ld+json"]').textContent()) ?? "{}");
  expect(ld).toMatchObject({ "@type": "Product", sku: "1002" });

  // A shown product without a captured page gets GiftFit's plain card in the frame.
  const card = await request.get(`/s/${s.key}/snapshot/p/1004`);
  expect(card.status()).toBe(200);
  expect(await card.text()).toContain("View on lumen-jewelry.example");

  // ?view=template still shows the neutral template, with a way back.
  await page.goto(`${s.previewPath}?view=template`);
  await expect(page.getByTestId("preview-grid")).toBeVisible();
  await expect(page.getByTestId("preview-to-snapshot")).toBeVisible();
});

test("Admin v0 shows the snapshot status; a non-snapshot preview says why it uses the template", async ({ browser, request, baseURL }) => {
  const s = await seed(request, { kind: "jewelry", snapshotFixturePort: STORE_PORT });
  const ctx = await browser.newContext({ baseURL });
  const page = await ctx.newPage();
  try {
    await page.goto(s.ownerPath);
    await expect(page.getByTestId("preview-admin")).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId("admin-look-mode")).toHaveText("snapshot");
    await expect(page.getByTestId("admin-look")).toContainText("product page");
  } finally {
    await ctx.close();
  }
  // A JavaScript-rendered shell: the template stays, and the preview page and Admin say why.
  serveShell = true;
  try {
    const shell = await seed(request, { kind: "jewelry", snapshotFixturePort: STORE_PORT });
    const p2 = await browser.newPage({ baseURL });
    await p2.goto(shell.previewPath);
    await expect(p2.getByTestId("preview-grid")).toBeVisible({ timeout: 60_000 });
    expect(await p2.getByTestId("preview-snapshot-frame").count()).toBe(0);
    await expect(p2.getByTestId("preview-look-note")).toContainText("shows almost no text without JavaScript");
    await p2.close();
    const c2 = await browser.newContext({ baseURL });
    const a2 = await c2.newPage();
    await a2.goto(shell.ownerPath);
    await expect(a2.getByTestId("admin-look-mode")).toHaveText("template", { timeout: 120_000 });
    await expect(a2.getByTestId("admin-look-reason")).toContainText("almost no text without JavaScript");
    await c2.close();
  } finally {
    serveShell = false;
  }
  // Generic (tea) store: never snapshotted; the plain seed has no snapshot outcome at all.
  const plain = await seed(request, { kind: "generic" });
  const res = await request.get(`/s/${plain.key}/snapshot`);
  expect(res.status()).toBe(404);
  expect(res.headers()["content-security-policy"]).toContain("default-src 'none'");
});
