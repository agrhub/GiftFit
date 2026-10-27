/** /cart: the old Aurum bag; the demo store has no cart, so its home (308; lib/site/config.ts). */
import { storeRedirect } from "@/lib/site/config";

export function GET(): Response {
  return storeRedirect("home");
}
export const HEAD = GET;
