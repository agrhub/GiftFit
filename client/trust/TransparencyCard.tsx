/**
 * Transparency Cards (owner: A5): what was used, what is kept, and what the other side sees.
 * Server- and client-safe (no hooks). The giver card never receives recipient data at all, so it
 * cannot render a photo, a hex value or a face attribute.
 */
import { useId, type ReactNode } from "react";
import type { Locale } from "@/server/i18n";
import { formatExpiry as formatLocalExpiry, rt, type RecipientMessageKey } from "@/server/i18n/recipient";

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
  /** false for a gift without a try-on (store-URL previews, ADR-055): no photo is ever taken. */
  tryOn?: boolean;
  /** Recipient page locale (server/i18n/recipient, A21); default English. */
  locale?: Locale;
}

export function RecipientTransparencyCard({ hasHandPhoto = false, expiresAt, className, tryOn = true, locale = "en" }: RecipientTransparencyCardProps) {
  const t = (key: RecipientMessageKey, vars?: Record<string, string>) => rt(locale, key, vars);
  const expiry = formatLocalExpiry(locale, expiresAt);
  const expiryLine = expiry ? t("privacy.expiryAt", { date: expiry }) : t("privacy.expiry72");
  if (!tryOn) {
    return (
      <TransparencyCard
        className={className}
        title={t("privacy.title")}
        intro={t("privacy.introNoTryOn")}
        sections={[
          { heading: t("privacy.use"), items: [t("privacy.useNoTryOn")] },
          {
            heading: t("privacy.keep"),
            items: [t("privacy.keepHearts"), t("privacy.keepEmail"), expiryLine],
          },
          {
            heading: t("privacy.sees"),
            items: [t("privacy.seesHearts"), t("privacy.seesNothing")],
          },
        ]}
      />
    );
  }
  return (
    <TransparencyCard
      className={className}
      title={t("privacy.title")}
      intro={t("privacy.intro")}
      sections={[
        {
          heading: t("privacy.use"),
          items: [t("privacy.useSelfie"), hasHandPhoto ? t("privacy.useHand") : t("privacy.useHandOptional")],
        },
        {
          heading: t("privacy.keep"),
          items: [t("privacy.keepPhoto"), t("privacy.keepTryOns"), t("privacy.keepEstimates"), t("privacy.keepEmail"), expiryLine],
        },
        {
          heading: t("privacy.sees"),
          items: [t("privacy.seesScores"), t("privacy.seesNever"), t("privacy.seesDecoys")],
        },
        {
          heading: t("privacy.processor"),
          items: [t("privacy.processorBody")],
        },
      ]}
    />
  );
}

export interface GiverTransparencyCardProps {
  expiresAt?: Date | string;
  className?: string;
  /** "help_me_choose" (ADR-045) has no decoys: every piece is one GiftFit picked; absent = "i_have_ideas". */
  mode?: "help_me_choose" | "i_have_ideas";
  /** false for a gift without a try-on (store previews, ADR-055): no photo and no estimates exist. */
  tryOn?: boolean;
}

export function GiverTransparencyCard({ expiresAt, className, mode = "i_have_ideas", tryOn = true }: GiverTransparencyCardProps) {
  const expiry = formatExpiry(expiresAt);
  const help = mode === "help_me_choose";
  return (
    <TransparencyCard
      className={className}
      title="What you will and won't see"
      intro="The surprise stays a surprise, and their privacy stays theirs."
      sections={[
        {
          heading: "You will see",
          items: [
            help ? "A Fit Score from 0 to 100 for each piece GiftFit picked for them, with a short breakdown." : "A Fit Score from 0 to 100 for each piece you shortlisted, with a short breakdown.",
            "Two short reasons and one caution per piece.",
            help ? "Which pieces they hearted, a summary of their taste and a few similar pieces they haven't seen." : "Which of your pieces they hearted.",
          ],
        },
        {
          heading: "You won't see",
          items: [
            ...(tryOn
              ? ["Their photos or any try-on image.", "Skin color values, face measurements or any other face data."]
              : ["Any photo of them: none is taken. They heart pieces from the store's product photos."]),
            ...(help ? [] : ["Which other pieces they were shown (your picks are mixed with similar pieces)."]),
          ],
        },
        {
          heading: "Good to know",
          items: [
            ...(tryOn ? ["Undertone and face shape in the reasons are AI estimates, which they can correct."] : []),
            expiry ? `Your link expires on ${expiry}.` : "Your link expires 72 hours after you send it.",
            "They can delete everything at any time; the report then disappears too.",
            "Email addresses you give us (theirs for the gift card, yours for the “report ready” note) are used only for this gift, never shown to anyone, and deleted when the link expires (72 hours) at the latest.",
          ],
        },
      ]}
    />
  );
}
