"use client";
/**
 * Dark root of the landing and /merchants (owner: A4, P8.4). Server-rendered children; on the client it
 *   - adds `gf-motion-reduce` when the visitor prefers reduced motion (CSS also honours the media query;
 *     the class covers motion started from script and keeps one switch for tests), and
 *   - sets <html lang> to the page language (the root layout says "en"), so screen readers and the
 *     widget's language detection see Vietnamese on /?lang=vi.
 */
import { useEffect, useState, type ReactNode } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

export function useReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const mq = typeof window.matchMedia === "function" ? window.matchMedia(QUERY) : null;
    if (!mq) return;
    setReduce(mq.matches);
    const on = (e: MediaQueryListEvent) => setReduce(e.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduce;
}

export function LandingRoot({ lang, children, testId = "landing" }: { lang: string; children: ReactNode; testId?: string }) {
  const reduce = useReducedMotion();
  useEffect(() => {
    const html = document.documentElement;
    const before = html.lang;
    html.lang = lang;
    return () => {
      html.lang = before;
    };
  }, [lang]);
  return (
    <div lang={lang} className={`gf-dark min-h-dvh overflow-x-clip ${reduce ? "gf-motion-reduce" : ""}`} data-testid={testId} data-motion={reduce ? "reduce" : "full"}>
      {children}
    </div>
  );
}
