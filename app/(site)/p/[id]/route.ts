/** /p/<id | slug | sku>: the old Aurum product page, now on the demo store (308; server/site/config.ts). */
import { storeRedirect } from "@/server/site/config";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx): Promise<Response> {
  return storeRedirect("product", (await params).id);
}
export const HEAD = GET;
