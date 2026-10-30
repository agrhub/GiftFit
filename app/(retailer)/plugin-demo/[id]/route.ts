/**
 * /plugin-demo/<slug> (owner: A6): the script-tag demo used to be an Aurum PDP on this origin. Every
 * demo-store product page now carries the one-line snippet, so this answers 308 to that page.
 */
import { storeRedirect } from "@/server/site/config";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx): Promise<Response> {
  return storeRedirect("product", (await params).id);
}
export const HEAD = GET;
