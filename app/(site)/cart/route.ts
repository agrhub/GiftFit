/** /cart: the old Aurum bag; the demo store has no cart, so its home (308; server/site/config.ts). */
import { storeRedirect } from "@/server/site/config";

export function GET(): Response {
  return storeRedirect("home");
}
export const HEAD = GET;
