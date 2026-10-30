/**
 * "Run" on the landing's code window (owner: A4, P8.4): mounts the real giftfit.js on this page, the
 * same way a store would. Nothing loads before the first Run, so the landing's first paint stays light.
 *
 *   first Run            → inject one <script data-giftfit-landing> with the chosen attributes
 *   Run again, same opts → "reopened": the caller opens the chat (openChat) once the frame is ready
 *   Run with new opts    → GiftFit.destroy(), drop the old tag, inject a fresh one (still one tag)
 *   widget off           → remove what Run added; nothing to show on a page without a product
 */
export interface RunOptions {
  /** Absolute origin serving /giftfit.js. */
  origin: string;
  store: string;
  widget: boolean;
}

export type RunResult = "mounted" | "reopened" | "remounted" | "off";

interface GiftFitApi {
  openWidget?: () => void;
  destroy?: () => void;
}

type Win = Window & { GiftFit?: GiftFitApi };

const MARK = "data-giftfit-landing";

export function runKey(o: RunOptions): string {
  return `${o.origin}|${o.store}`;
}

function landingScript(doc: Document): HTMLScriptElement | null {
  return doc.querySelector<HTMLScriptElement>(`script[${MARK}]`);
}

function unmount(doc: Document, win: Win): void {
  try {
    win.GiftFit?.destroy?.();
  } catch {
    /* already gone */
  }
  landingScript(doc)?.remove();
  // The loader guards on window.GiftFit.loaded; clearing it lets a fresh tag run again.
  delete win.GiftFit;
}

function inject(doc: Document, o: RunOptions): void {
  const s = doc.createElement("script");
  s.src = `${o.origin}/giftfit.js`;
  s.async = true;
  s.setAttribute("data-store", o.store);
  // The landing has no product, so the v0.1 "Gift it right" button would never show here.
  s.setAttribute("data-button", "off");
  s.setAttribute(MARK, runKey(o));
  doc.body.appendChild(s);
}

/** True once the widget frame has said hello (the loader sets data-ready on its host element). */
export function widgetReady(doc: Document): boolean {
  return !!doc.querySelector("giftfit-widget[data-ready]");
}

export function widgetMounted(doc: Document): boolean {
  return !!doc.querySelector("giftfit-widget");
}

export function runWidget(o: RunOptions, doc: Document = document, win: Win = window as Win): RunResult {
  const current = landingScript(doc);
  if (!o.widget) {
    if (current) unmount(doc, win);
    return "off";
  }
  if (current && current.getAttribute(MARK) === runKey(o)) return "reopened";
  if (current) {
    unmount(doc, win);
    inject(doc, o);
    return "remounted";
  }
  inject(doc, o);
  return "mounted";
}

/** Opens the chat panel of a mounted, ready widget. */
export function openChat(win: Win = window as Win): void {
  win.GiftFit?.openWidget?.();
}

/**
 * Calls back once: true when the widget frame is ready, false when it went away (the loader removes a
 * frame that never says hello) or after `timeoutMs`. Returns a cancel function.
 */
export function whenReady(onDone: (ok: boolean) => void, { doc = document, intervalMs = 400, timeoutMs = 100_000 } = {}): () => void {
  const started = Date.now();
  let seen = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    if (widgetReady(doc)) return onDone(true);
    const mounted = widgetMounted(doc);
    if ((seen && !mounted) || Date.now() - started >= timeoutMs) return onDone(false);
    seen ||= mounted;
    timer = setTimeout(tick, intervalMs);
  };
  tick();
  return () => clearTimeout(timer);
}
