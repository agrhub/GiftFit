import type { Metadata } from "next";
import { GiverReport } from "@/components/gift/report/GiverReport";

export const metadata: Metadata = { title: "Your Fit Report" };

export default async function GiverReportPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <div className="pt-4">
      <GiverReport token={token} />
    </div>
  );
}
