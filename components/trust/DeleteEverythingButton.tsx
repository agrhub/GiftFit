"use client";
/**
 * One-tap "Delete everything" (owner: A5). Calls POST /api/recipient/delete, which removes photos,
 * try-on images, YouCam tasks and cached results, the profile, hearts and report, and ends the link.
 */
import { useState } from "react";

export interface DeleteEverythingButtonProps {
  endpoint?: string;
  /** Bearer token if the session cookie is not used. */
  sessionToken?: string;
  onDeleted?: () => void;
  className?: string;
}

type State = "idle" | "deleting" | "done" | "error";

export function DeleteEverythingButton({ endpoint = "/api/recipient/delete", sessionToken, onDeleted, className = "" }: DeleteEverythingButtonProps) {
  const [state, setState] = useState<State>("idle");

  async function run() {
    setState("deleting");
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: sessionToken ? { Authorization: `Bearer ${sessionToken}` } : undefined,
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean };
      if (!res.ok || body.ok !== true) throw new Error(String(res.status));
      setState("done");
      onDeleted?.();
    } catch {
      setState("error");
    }
  }

  return (
    <div className={className}>
      <button
        type="button"
        onClick={run}
        disabled={state === "deleting" || state === "done"}
        className="min-h-11 w-full rounded-xl bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-800 focus:outline-2 focus:outline-offset-2 focus:outline-red-800 disabled:cursor-not-allowed disabled:bg-stone-500"
      >
        {state === "deleting" ? "Deleting…" : state === "done" ? "Deleted" : "Delete everything"}
      </button>
      <p aria-live="polite" role="status" className="mt-2 min-h-5 text-sm text-stone-700 dark:text-stone-300">
        {state === "done"
          ? "Done. Your photos, try-ons, estimates and hearts are deleted, and this link no longer works."
          : state === "error"
            ? "Something went wrong and nothing was confirmed as deleted. Please try again."
            : "Removes your photos, try-ons, estimates and hearts right now. This cannot be undone."}
      </p>
    </div>
  );
}
