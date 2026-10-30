"use client";
/** A read-only snippet with a Copy button (owner: A6, Admin v0). */
import { useState } from "react";

export function CopyText({ text, testId }: { text: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
      <pre className="min-w-0 flex-1 overflow-x-auto rounded-xl border border-line bg-white p-3 text-xs leading-5 text-ink" data-testid={testId}>
        <code>{text}</code>
      </pre>
      <button
        type="button"
        onClick={() =>
          void navigator.clipboard?.writeText(text).then(
            () => setCopied(true),
            () => setCopied(false),
          )
        }
        className="min-h-11 shrink-0 rounded-full border border-ink px-5 text-sm text-ink hover:bg-ink hover:text-ivory"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
