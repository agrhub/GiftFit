"use client";
/**
 * The draggable "Try it on your live site" bookmarklet (owner: A6, ADR-055). React refuses `javascript:`
 * hrefs, so the server-built URL is set as an attribute after mount; a plain click does nothing on
 * this page (the bookmark is meant to be dragged to the bookmarks bar and used on the merchant's site).
 */
import { useEffect, useRef } from "react";

export function BookmarkletLink({ href, label }: { href: string; label: string }) {
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    ref.current?.setAttribute("href", href);
  }, [href]);
  return (
    <a
      ref={ref}
      onClick={(e) => e.preventDefault()}
      draggable
      data-testid="bookmarklet"
      className="inline-flex min-h-11 cursor-grab items-center rounded-full border-2 border-dashed border-ink bg-white px-5 text-sm font-medium text-ink"
    >
      {label}
    </a>
  );
}
