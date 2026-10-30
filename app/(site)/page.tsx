/**
 * / : the GiftFit landing (owner: A4, P8.4, ADR-055; single storefront ADR-054). The only storefront is
 * the separate demo store (GIFTFIT_DEMO_STORE_URL); old storefront paths redirect there.
 * giftfit.js is NOT added here: the code window's Run button mounts it, so first paint stays light.
 * `?previewmock=1` runs the store-URL preview form against its in-memory mock.
 */
import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Landing } from "@/components/site/Landing";
import { demoStoreUrl } from "@/lib/site/config";
import { siteLocale } from "@/lib/site/locale";
import { siteOrigin } from "@/lib/site/snippet";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: { absolute: "GiftFit · The gift assistant for any store" },
  description: "GiftFit lets the person you're shopping for try jewelry on privately with an AI preview, so you buy the piece that suits them and the surprise stays a surprise. Add it to any store with one script tag.",
};
// No `colorScheme: "dark"` meta: it would make the widget iframe (a light document) paint opaque.
export const viewport: Viewport = { themeColor: "#090b11" };

type Search = Promise<{ previewmock?: string }>;

export default async function HomePage({ searchParams }: { searchParams: Search }) {
  const q = await searchParams;
  const locale = siteLocale((await headers()).get("accept-language"));
  return <Landing locale={locale} demoStoreUrl={demoStoreUrl()} origin={await siteOrigin()} previewMock={q.previewmock === "1"} />;
}
