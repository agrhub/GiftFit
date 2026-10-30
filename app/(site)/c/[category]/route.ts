/** /c/<category>: the old Aurum category page, now on the demo store (308; server/site/config.ts). */
import { storeRedirect } from "@/server/site/config";

type Ctx = { params: Promise<{ category: string }> };

export async function GET(_req: Request, { params }: Ctx): Promise<Response> {
  return storeRedirect("category", (await params).category);
}
export const HEAD = GET;
