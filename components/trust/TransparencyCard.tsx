/**
 * Transparency Cards (owner: A5): what was used, what is kept, and what the other side sees.
 * Server- and client-safe (no hooks). The giver card never receives recipient data at all, so it
 * cannot render a photo, a hex value or a face attribute.
 */
import { useId, type ReactNode } from "react";

export interface TransparencySection {
  heading: string;
  items: ReactNode[];
}

export function TransparencyCard({ title, intro, sections, className = "" }: { title: string; intro?: ReactNode; sections: TransparencySection[]; className?: string }) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className={`rounded-2xl border border-stone-200 bg-white p-5 text-stone-900 shadow-sm dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 ${className}`}
    >
      <h2 id={id} className="text-base font-semibold">
        {title}
      </h2>
      {intro ? <p className="mt-1 text-sm text-stone-700 dark:text-stone-300">{intro}</p> : null}
      <div className="mt-4 space-y-4">
        {sections.map((s) => (
          <div key={s.heading}>
            <h3 className="text-sm font-semibold text-stone-800 dark:text-stone-200">{s.heading}</h3>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm leading-6 text-stone-700 dark:text-stone-300">
              {s.items.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function formatExpiry(expiresAt: Date | string | undefined): string | undefined {
  if (!expiresAt) return undefined;
  const d = typeof expiresAt === "string" ? new Date(expiresAt) : expiresAt;
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";
}

export interface RecipientTransparencyCardProps {
  /** The recipient added a back-of-hand photo (unlocks rings, bracelets, watches). */
  hasHandPhoto?: boolean;
  /** When the Fit Request link expires (72 h after it was sent). */
  expiresAt?: Date | string;
  className?: string;
}

export function RecipientTransparencyCard({ hasHandPhoto = false, expiresAt, className }: RecipientTransparencyCardProps) {
  const expiry = formatExpiry(expiresAt);
  return (
    <TransparencyCard
      className={className}
      title="Your privacy"
      intro="Here is exactly what happens with your photos and answers."
      sections={[
        {
          heading: "What we use",
          items: [
            "1 selfie, to estimate your undertone and face shape and to show you the try-ons.",
            hasHandPhoto
              ? "1 back-of-hand photo, for rings, bracelets and watches."
              : "Optional: 1 back-of-hand photo, only if you want to try rings, bracelets or watches.",
          ],
        },
        {
          heading: "What we keep",
          items: [
            "Your photo is kept for at most 1 hour, only so you can try other metals. It is deleted when you tap Done. “Delete my photo now” removes your selfie, hand photo and every try-on image right away; your picks are kept until Done. If nothing comes in another metal, your photo is deleted as soon as your try-ons are made.",
            "Your try-on images are shown only to you, through links that stop working within 15 minutes, and are deleted within 1 hour.",
            "We keep estimates only: undertone (warm, neutral or cool) and face shape, plus the pieces you heart.",
            expiry ? `Everything is deleted when this link expires (${expiry}), or sooner if you tap Delete everything.` : "Everything is deleted when this link expires after 72 hours, or sooner if you tap Delete everything.",
          ],
        },
        {
          heading: "What the person choosing your gift sees",
          items: [
            "Fit scores, short reasons, and which of their picks you hearted.",
            "Never your photo, your try-on images, your skin color values or your face measurements.",
            "Some pieces are similar alternatives mixed in with their picks, so you won't know which one they plan to buy.",
          ],
        },
        {
          heading: "Who else processes your photo",
          items: [
            "YouCam (Perfect Corp.) analyzes your selfie and renders the try-ons. We ask YouCam to delete those tasks when you delete everything or the link expires; YouCam keeps results for at most 24 hours.",
          ],
        },
      ]}
    />
  );
}

export interface GiverTransparencyCardProps {
  expiresAt?: Date | string;
  className?: string;
}

export function GiverTransparencyCard({ expiresAt, className }: GiverTransparencyCardProps) {
  const expiry = formatExpiry(expiresAt);
  return (
    <TransparencyCard
      className={className}
      title="What you will and won't see"
      intro="The surprise stays a surprise, and their privacy stays theirs."
      sections={[
        {
          heading: "You will see",
          items: [
            "A Fit Score from 0 to 100 for each piece you shortlisted, with a short breakdown.",
            "Two short reasons and one caution per piece.",
            "Which of your pieces they hearted.",
          ],
        },
        {
          heading: "You won't see",
          items: [
            "Their photos or any try-on image.",
            "Skin color values, face measurements or any other face data.",
            "Which other pieces they were shown (your picks are mixed with similar decoys).",
          ],
        },
        {
          heading: "Good to know",
          items: [
            "Undertone and face shape in the reasons are AI estimates, which they can correct.",
            expiry ? `Your link expires on ${expiry}.` : "Your link expires 72 hours after you send it.",
            "They can delete everything at any time; the report then disappears too.",
          ],
        },
      ]}
    />
  );
}
