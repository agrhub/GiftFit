/**
 * Who is offered the in-browser "natural voice" (owner: A4, P8.3): desktop browsers with a WebGPU
 * adapter only. Phones and tablets never are (a ~400 MB model is not reasonable there), and the WASM
 * execution provider is only a fallback inside the engine, on desktop, when WebGPU session creation
 * fails after the shopper opted in.
 */

interface NavLike {
  userAgent?: string;
  maxTouchPoints?: number;
  userAgentData?: { mobile?: boolean };
  gpu?: { requestAdapter(): Promise<unknown> };
}

export function isDesktop(nav: NavLike | undefined = typeof navigator !== "undefined" ? (navigator as NavLike) : undefined): boolean {
  if (!nav) return false;
  if (nav.userAgentData && typeof nav.userAgentData.mobile === "boolean") return !nav.userAgentData.mobile;
  const ua = nav.userAgent ?? "";
  if (/Mobi|Android|iPhone|iPad|iPod|Silk|Kindle|Opera Mini/i.test(ua)) return false;
  // iPadOS reports a Mac user agent; a Mac with a multi-touch screen is an iPad.
  if (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1) return false;
  return true;
}

/** Desktop + a WebGPU adapter. Never throws; false while unknown. */
export async function naturalVoiceAvailable(nav: NavLike | undefined = typeof navigator !== "undefined" ? (navigator as NavLike) : undefined): Promise<boolean> {
  if (!nav || !isDesktop(nav) || !nav.gpu || typeof nav.gpu.requestAdapter !== "function") return false;
  try {
    const adapter = await Promise.race([nav.gpu.requestAdapter(), new Promise((r) => setTimeout(() => r(null), 3000))]);
    return Boolean(adapter);
  } catch {
    return false;
  }
}
