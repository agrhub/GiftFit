/**
 * NDJSON framing for Gift Concierge events (owner: A7). Server-only. Each event is checked by the giver
 * guard (assertGiverSafe, product images allowed) before it is written; a blocked event is replaced by
 * an `error` event and the stream ends, so recipient data could never reach the shopper even if a bug
 * put it there.
 */
import { assertGiverSafe } from "@/server/privacy/giver-guard";
import type { ConciergeEvent } from "./types";

export const NDJSON_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";

export function conciergeNdjson(events: AsyncIterable<ConciergeEvent>, signal?: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = events[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done || signal?.aborted) {
          controller.close();
          return;
        }
        let line: string;
        try {
          line = JSON.stringify(assertGiverSafe(value, { allowProductImages: true }));
        } catch {
          console.error("[concierge] blocked an unsafe event:", value.type);
          controller.enqueue(encoder.encode(`${JSON.stringify({ type: "error", error: "internal_error" } satisfies ConciergeEvent)}\n`));
          controller.close();
          await iterator.return?.(undefined);
          return;
        }
        controller.enqueue(encoder.encode(`${line}\n`));
      } catch (err) {
        console.error("[concierge] stream failed:", (err as Error).message);
        controller.enqueue(encoder.encode(`${JSON.stringify({ type: "error", error: "internal_error" } satisfies ConciergeEvent)}\n`));
        controller.close();
      }
    },
    async cancel() {
      await iterator.return?.(undefined);
    },
  });
}
