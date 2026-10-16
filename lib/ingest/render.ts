/**
 * Tier 3 rendering. `PlaywrightRenderer` loads a client-rendered page in headless Chromium, politely:
 * each navigation takes a slot from the shared `PoliteFetcher` (robots, ≤ 1 navigation / s / host,
 * page cap). Images, fonts and media are blocked (we only need image URLs, not bytes) and so are
 * requests to other hosts (analytics, ads). `SnapshotRenderer` serves the post-JS HTML saved under
 * fixtures/ingest/<site>/rendered/ for INGEST_FIXTURE=1 and tests. Both go through `pageFromHtml`.
 */
import { promises as fs } from "node:fs";
import type { Browser } from "playwright";
import { pageFromHtml, type RenderedPage } from "./html";
import { snapshotPath } from "./fixtures";
import type { PoliteFetcher } from "./politeness";

export interface Renderer {
  readonly name: string;
  render(url: string): Promise<RenderedPage>;
  close(): Promise<void>;
}

export const RENDER_TIMEOUT_MS = 30_000;
const BLOCKED_TYPES = new Set(["image", "media", "font"]);

export class PlaywrightRenderer implements Renderer {
  readonly name = "playwright";
  private browser?: Browser;

  constructor(
    private readonly fetcher: PoliteFetcher,
    private readonly opts: { timeoutMs?: number; launch?: () => Promise<Browser> } = {},
  ) {}

  private async getBrowser(): Promise<Browser> {
    if (this.browser) return this.browser;
    if (this.opts.launch) this.browser = await this.opts.launch();
    else {
      const { chromium } = await import("playwright");
      this.browser = await chromium.launch({ headless: true });
    }
    return this.browser;
  }

  /** Render `url` and return the post-JavaScript DOM. `logicalUrl` overrides the URL links resolve against. */
  async render(url: string, logicalUrl = url): Promise<RenderedPage> {
    const release = await this.fetcher.acquire(url);
    const browser = await this.getBrowser();
    const context = await browser.newContext({ userAgent: this.fetcher.userAgent, javaScriptEnabled: true });
    try {
      const host = new URL(url).host;
      const page = await context.newPage();
      await page.route("**/*", (route) => {
        const req = route.request();
        let sameHost = false;
        try {
          sameHost = new URL(req.url()).host === host;
        } catch {
          /* data: or invalid */
        }
        if (BLOCKED_TYPES.has(req.resourceType()) || !sameHost) return route.abort();
        return route.continue();
      });
      const res = await page.goto(url, { waitUntil: "networkidle", timeout: this.opts.timeoutMs ?? RENDER_TIMEOUT_MS });
      if (res && res.status() >= 400) throw new Error(`render ${url}: HTTP ${res.status()}`);
      return pageFromHtml(await page.content(), logicalUrl);
    } finally {
      release();
      await context.close();
    }
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = undefined;
  }
}

export class SnapshotRenderer implements Renderer {
  readonly name = "snapshot";
  constructor(private readonly root?: string) {}

  async render(url: string): Promise<RenderedPage> {
    const file = snapshotPath(url, this.root);
    let html: string;
    try {
      html = await fs.readFile(file, "utf8");
    } catch {
      throw new Error(`no rendered snapshot for ${url} (run workers/ingest/snapshot.ts)`);
    }
    return pageFromHtml(html, url);
  }

  async close(): Promise<void> {}
}
