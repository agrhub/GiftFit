"use client";
/**
 * The Giver Panel inside the script tag's iframe (owner: A6). GiverPanel (A4) is imported as is.
 * postMessage both ways is origin-checked: we post only to `parentOrigin`, and accept only
 * { type: "giftfit:close" } from it.
 */
import { useCallback, useEffect, useState } from "react";
import { GiverPanel } from "@/components/gift/GiverPanel";
import type { GiftPiece } from "@/components/gift/giverDraft";

type Outgoing = "giftfit:ready" | "giftfit:sent" | "giftfit:close";

export function EmbedPanel({ piece, parentOrigin }: { piece: GiftPiece | null; parentOrigin: string | null }) {
  const [open, setOpen] = useState(true);
  const post = useCallback(
    (type: Outgoing) => {
      if (parentOrigin && window.parent !== window) window.parent.postMessage({ source: "giftfit", type }, parentOrigin);
    },
    [parentOrigin],
  );

  useEffect(() => {
    post("giftfit:ready");
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== parentOrigin || e.source !== window.parent) return;
      const msg = e.data as { source?: string; type?: string } | null;
      if (msg?.source === "giftfit" && msg.type === "giftfit:close") setOpen(false);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [post, parentOrigin]);

  // Tell the host page once the Fit Request is sent (no token or id in the message).
  useEffect(() => {
    let sent = false;
    const mo = new MutationObserver(() => {
      if (!sent && document.querySelector('[data-testid="fit-request-sent"]')) {
        sent = true;
        post("giftfit:sent");
        mo.disconnect();
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [post]);

  // The giver's report link opens as a top-level tab, not inside the store's overlay.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[href^="/g/"]') as HTMLAnchorElement | null;
      if (!a) return;
      e.preventDefault();
      window.open(a.href, "_blank", "noopener,noreferrer");
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  const close = () => {
    setOpen(false);
    post("giftfit:close");
  };

  if (!piece) {
    return (
      <div role="alert" className="m-4 rounded-xl border border-line bg-white p-6 text-ink">
        <p>This piece isn&apos;t in the store&apos;s GiftFit catalog yet.</p>
        <button type="button" onClick={close} className="mt-4 min-h-11 rounded-full border border-ink px-5 text-sm">
          Close
        </button>
      </div>
    );
  }

  return (
    <>
      <GiverPanel open={open} onClose={close} initialPieces={[piece]} />
      {!open && !parentOrigin ? (
        <button type="button" onClick={() => setOpen(true)} className="m-4 min-h-11 rounded-full bg-ink px-6 text-sm text-ivory">
          Gift it right
        </button>
      ) : null}
    </>
  );
}
