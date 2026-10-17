import type { GcsBucketLike } from "../gcp-clients";

/** In-process stand-in for a private bucket, behind the adapter's own GcsBucketLike surface. */
export function fakeBucket(name = "gcp-project-405602-giftfit-photos") {
  const objects = new Map<string, { body: Buffer; meta: { contentType?: string; cacheControl?: string; metadata?: Record<string, unknown> } }>();
  const saves: Array<{ name: string; opts: Record<string, unknown> }> = [];
  const notFound = () => Object.assign(new Error("No such object"), { code: 404 });
  const bucket: GcsBucketLike = {
    name,
    file: (n: string) => ({
      save: async (data: Buffer, opts: Record<string, unknown>) => {
        saves.push({ name: n, opts });
        const pre = (opts.preconditionOpts as { ifGenerationMatch?: number } | undefined)?.ifGenerationMatch;
        if (pre === 0 && objects.has(n)) throw Object.assign(new Error("precondition failed"), { code: 412 });
        objects.set(n, { body: Buffer.from(data), meta: opts.metadata as never });
      },
      download: async () => {
        const o = objects.get(n);
        if (!o) throw notFound();
        return [Buffer.from(o.body)] as [Buffer];
      },
      getMetadata: async () => {
        const o = objects.get(n);
        if (!o) throw notFound();
        return [o.meta] as [typeof o.meta];
      },
      delete: async (opts?: Record<string, unknown>) => {
        if (!objects.has(n) && !opts?.ignoreNotFound) throw notFound();
        objects.delete(n);
      },
    }),
    getFiles: async (q: Record<string, unknown>) => [[...objects.keys()].filter((k) => k.startsWith(String(q.prefix ?? ""))).sort().map((k) => ({ name: k }))],
  };
  return { bucket, objects, saves };
}
