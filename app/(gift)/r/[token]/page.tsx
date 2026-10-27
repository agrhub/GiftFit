import type { Metadata } from "next";
import { RecipientFlow } from "@/components/gift/recipient/RecipientFlow";

// Neutral title: store-URL preview gifts (ADR-055) have no try-on.
export const metadata: Metadata = { title: "A private gift" };

export default async function RecipientPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <div className="mx-auto w-full max-w-md md:max-w-3xl">
      <RecipientFlow token={token} />
    </div>
  );
}
