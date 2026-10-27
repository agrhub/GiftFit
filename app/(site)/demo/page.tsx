import type { Metadata } from "next";
import { JudgeDemo } from "@/components/gift/JudgeDemo";
import { demoStoreUrl } from "@/lib/site/config";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Judge demo",
  description:
    "Try GiftFit in under a minute with pre-recorded try-ons of AI-generated models. No selfie, no cost.",
};

const STEPS = [
  "Pick a demo recipient (each is an AI-generated model) and tap Try the judge demo.",
  "Open the recipient view, ideally on a phone: six pieces as AI previews, with metal swatches. Heart a few and finish.",
  "Open the giver's Fit Report: scores, short reasons and the hearted metal and price. No photos, ever.",
];

export default function DemoPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-gold-deep">
        For judges
      </p>
      <h1 className="mt-3 font-display text-5xl leading-tight text-ink">
        Try GiftFit in a minute
      </h1>
      <ol className="mt-6 space-y-2 text-sm leading-6 text-ink-soft">
        {STEPS.map((s, i) => (
          <li key={s} className="flex gap-3">
            <span className="font-display text-xl text-gold-deep">{i + 1}</span>
            {s}
          </li>
        ))}
      </ol>
      <div className="mt-8 rounded-2xl border border-line bg-cream/70 p-6">
        <JudgeDemo />
      </div>
      <p className="mt-6 text-sm text-ink-soft">
        Want the full giver flow instead? Open{" "}
        <a
          href={`${demoStoreUrl()}/p/halo-drop-earrings`}
          className="text-ink underline decoration-gold underline-offset-4"
        >
          Halo Drop Earrings in the demo store
        </a>{" "}
        and ask the gift assistant, or tap Gift it right. A real try-on with
        your own selfie uses live YouCam calls.
      </p>
    </div>
  );
}
