"use client";
/** "Gift it right" trigger (PDP and bag). The panel and the catalog load only when needed. */
import dynamic from "next/dynamic";
import { useState } from "react";
import type { GiftPiece } from "./giverDraft";
import { GiftIcon } from "./icons";

const loadPanel = () => import("./GiverPanel");
const GiverPanel = dynamic(loadPanel, { ssr: false });

export function GiftItRightButton({ pieces, className = "", variant = "outline" }: { pieces: GiftPiece[]; className?: string; variant?: "outline" | "solid" }) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const prefetch = () => {
    void loadPanel();
    void import("@/components/store/catalog");
  };
  return (
    <>
      <button
        type="button"
        data-testid="gift-it-right"
        aria-haspopup="dialog"
        onPointerEnter={prefetch}
        onFocus={prefetch}
        onClick={() => {
          setMounted(true);
          setOpen(true);
        }}
        className={`group inline-flex min-h-12 items-center justify-center gap-2 rounded-full px-7 text-sm font-medium transition-colors ${
          variant === "solid" ? "bg-ink text-ivory hover:bg-ink-soft" : "border border-ink bg-transparent text-ink hover:bg-ink hover:text-ivory"
        } ${className}`}
      >
        <GiftIcon className="h-5 w-5 transition-transform duration-300 group-hover:-rotate-6" />
        Gift it right
      </button>
      {mounted ? <GiverPanel open={open} onClose={() => setOpen(false)} initialPieces={pieces} /> : null}
    </>
  );
}
