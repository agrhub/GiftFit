"use client";
/** The one-line install (owner: A6): the tag with this deployment's origin, copy, and the demos. */
import { useEffect, useState } from "react";
import { Card, HowCalculated } from "./ui";

export function ScriptTagCard({ storeKey, demoSlug }: { storeKey: string; demoSlug: string }) {
  const [origin, setOrigin] = useState("https://your-giftfit-app");
  const [copied, setCopied] = useState(false);
  useEffect(() => setOrigin(window.location.origin), []);
  const tag = `<script src="${origin}/giftfit.js" data-store="${storeKey}" async></script>`;

  return (
    <Card id="script-tag" eyebrow="Script tag" title="Add Gift it right to any product page" testId="script-tag-card">
      <p className="text-sm text-ink-soft">One line before &lt;/body&gt;. The button appears only on pages whose product is in your ingested catalog.</p>
      <pre className="mt-4 overflow-x-auto rounded-lg border border-night-700 bg-night-950 p-4 text-[0.8rem] leading-6 text-fog-100" data-testid="script-tag">
        <code>{tag}</code>
      </pre>
      <div className="mt-3 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(tag).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
          className="min-h-11 rounded-full border border-ink px-5 text-sm text-ink hover:bg-ink hover:text-ivory"
        >
          {copied ? "Copied" : "Copy tag"}
        </button>
        {/* 308 to the demo store's page for this design (app/(retailer)/plugin-demo/[id]/route.ts). */}
        <a href={`/plugin-demo/${demoSlug}`} className="inline-flex min-h-11 items-center gf-cta rounded-full bg-ink px-5 text-sm text-ivory hover:bg-ink-soft">
          See it on the demo store
        </a>
      </div>
      <p aria-live="polite" className="sr-only">
        {copied ? "Script tag copied" : ""}
      </p>
      <HowCalculated>
        <p>
          The script finds the product (data-giftfit-sku, JSON-LD Product or Open Graph), asks <code>/api/retailer/lookup</code> whether it is in the catalog, then adds the button in a
          shadow root so the store&apos;s CSS and ours never mix. The Giver Panel opens in an iframe from this app; the two talk only through origin-checked postMessage, and no token,
          request id or recipient data crosses the frame.
        </p>
        <p>Cross-origin demo: <code>GIFTFIT_ORIGIN={origin} node client/plugin/demo/serve-host.mjs</code>, then open http://127.0.0.1:4310/.</p>
      </HowCalculated>
    </Card>
  );
}
