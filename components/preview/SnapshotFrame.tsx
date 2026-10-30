/**
 * The merchant-page copy inside a preview (owner: A15). Server component. The copy is served by
 * /s/<key>/snapshot[/p/<id>] with a no-script CSP and shown here in a sandboxed iframe that fills the
 * viewport below the "not affiliated" banner; GiftFit's widget stays in THIS page (never in the copy).
 * Sandbox tokens and why: lib/preview/page-snapshot-http.ts (SNAPSHOT_IFRAME_SANDBOX).
 */
import { SNAPSHOT_IFRAME_SANDBOX } from "@/lib/preview/page-snapshot-http";

export function SnapshotFrame({ src, title, children }: { src: string; title: string; children: React.ReactNode }) {
  return (
    <div className="flex h-dvh flex-col" data-testid="preview-snapshot">
      {children}
      <iframe
        src={src}
        title={title}
        // No allow-scripts / allow-same-origin / allow-forms: see SNAPSHOT_IFRAME_SANDBOX.
        sandbox={SNAPSHOT_IFRAME_SANDBOX}
        referrerPolicy="no-referrer"
        className="block min-h-0 w-full flex-1 border-0 bg-paper"
        data-testid="preview-snapshot-frame"
      />
    </div>
  );
}
