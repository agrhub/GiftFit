/** Node-only boot work for instrumentation.ts (A16): the paid-mode log line. */
import { logPaidMode } from "./lib/youcam/recording";

try {
  logPaidMode("boot");
} catch (err) {
  console.error("[youcam] paid-mode boot log failed:", (err as Error).name);
}
