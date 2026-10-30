/**
 * Next.js boot hook. A16: one structured log line at server start saying whether paid YouCam calls are
 * possible (owner recording switch, server/youcam/recording.ts). No secrets, no request data.
 *
 * Node-only code stays behind the documented `NEXT_RUNTIME === "nodejs"` branch with a dynamic import: Next
 * replaces the variable at build time, so the edge build drops the branch (and node:crypto) entirely.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
