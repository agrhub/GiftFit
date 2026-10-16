import type { Metadata } from "next";
import { CartView } from "@/components/store/CartView";

export const metadata: Metadata = { title: "Your bag", robots: { index: false } };

export default async function CartPage({ searchParams }: { searchParams: Promise<{ add?: string; metal?: string }> }) {
  const { add, metal } = await searchParams;
  return <CartView addId={typeof add === "string" ? add : undefined} addMetal={typeof metal === "string" ? metal : undefined} />;
}
