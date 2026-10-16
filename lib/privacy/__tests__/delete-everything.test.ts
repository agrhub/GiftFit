import { describe, expect, it, vi } from "vitest";
import { MemoryAuditSink } from "@/lib/youcam/audit";
import { MemoryResultCache } from "@/lib/youcam/cache";
import { createYoucamClient } from "@/lib/youcam/client";
import { deleteEverything, purgeExpired } from "../delete-everything";
import { FIT_REQUEST_TTL_MS } from "../tokens";
import { makeStack, seedFullRequest } from "./helpers";

const EMPTY = { recipient_profiles: 0, tryons: 0, hearts: 0, metal_wishes: 0, fit_reports: 0 };

describe("deleteEverything (in-memory stack)", () => {
  it("leaves no DB rows, no blobs and no cache entries for the request, and deletes the YouCam tasks", async () => {
    const stack = makeStack();
    const cache = new MemoryResultCache();
    stack.deps.youcam.deleteCachedResult = (k) => cache.delete(k);
    const a = await seedFullRequest(stack, "a");
    const b = await seedFullRequest(stack, "b");
    const rows = await stack.repos.tryons.listForRequest(a.request.id);
    for (const r of rows) await cache.set(r.cacheKey, { feature: r.feature, taskId: r.taskId!, result: { color: { skin_color: "#c68e6b" } }, unitsCharged: 0, createdAt: "x" });

    expect(await stack.repos.countForRequest(a.request.id)).toEqual({ recipient_profiles: 1, tryons: 4, hearts: 2, metal_wishes: 0, fit_reports: 1 });
    expect(await stack.photos.listForRequest(a.request.id)).toHaveLength(3);

    const receipt = await deleteEverything(stack.deps, a.request.id);

    // DB rows
    expect(await stack.repos.countForRequest(a.request.id)).toEqual(EMPTY);
    expect(receipt.deleted.rows).toEqual({ recipient_profiles: 1, tryons: 4, hearts: 2, metal_wishes: 0, fit_reports: 1 });
    // Blobs (renders + the stray selfie)
    expect(await stack.photos.listForRequest(a.request.id)).toEqual([]);
    expect(receipt.deleted.blobs).toBe(3);
    // Result cache
    for (const r of rows) expect(await cache.get(r.cacheKey)).toBeUndefined();
    expect(receipt.deleted.cacheEntries).toBe(4);
    // YouCam tasks (task/delete for every analysis and render task)
    expect(stack.deletedTasks.sort()).toEqual(rows.map((r) => r.taskId).sort());
    expect(receipt.deleted.youcamTasks).toBe(4);
    // Both links are dead; only the giver's own input remains on the request row.
    const req = await stack.repos.fitRequests.findById(a.request.id);
    expect(req?.status).toBe("deleted");
    expect(receipt.verified).toBe(true);
    expect(receipt.youcamTasksPending).toEqual([]);

    // The other request is untouched.
    expect(await stack.repos.countForRequest(b.request.id)).toEqual({ recipient_profiles: 1, tryons: 4, hearts: 2, metal_wishes: 0, fit_reports: 1 });
    expect(await stack.photos.listForRequest(b.request.id)).toHaveLength(3);
  });

  it("still deletes everything locally when YouCam task delete fails, and reports the pending tasks", async () => {
    const stack = makeStack();
    const a = await seedFullRequest(stack);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stack.deps.youcam.deleteTask = vi.fn(async (id: string) => {
      if (id.includes("vto-1")) throw new Error("OperationInvalid");
    });
    const receipt = await deleteEverything(stack.deps, a.request.id);
    expect(receipt.verified).toBe(true);
    expect(receipt.youcamTasksPending).toEqual(["task-a-vto-1"]);
    expect(await stack.repos.countForRequest(a.request.id)).toEqual(EMPTY);
    expect(warn).toHaveBeenCalled();
  });

  it("is idempotent", async () => {
    const stack = makeStack();
    const a = await seedFullRequest(stack);
    await deleteEverything(stack.deps, a.request.id);
    const again = await deleteEverything(stack.deps, a.request.id);
    expect(again.verified).toBe(true);
    expect(again.deleted.rows).toEqual(EMPTY);
    expect(again.deleted.blobs).toBe(0);
  });
});

describe("purgeExpired (72 h)", () => {
  it("purges only requests past expiry and sweeps overdue blobs", async () => {
    const stack = makeStack();
    const old = await seedFullRequest(stack, "o");
    stack.clock.advance(FIT_REQUEST_TTL_MS / 2);
    const fresh = await seedFullRequest(stack, "f");
    stack.clock.advance(FIT_REQUEST_TTL_MS / 2); // old is exactly 72 h old now

    const summary = await purgeExpired(stack.deps);
    expect(summary.requests).toBe(1);
    expect(summary.receipts[0]).toMatchObject({ fitRequestId: old.request.id, reason: "expired", verified: true });
    expect((await stack.repos.fitRequests.findById(old.request.id))?.status).toBe("expired");
    expect(await stack.repos.countForRequest(old.request.id)).toEqual(EMPTY);
    // fresh keeps its rows, but its blobs (1 h TTL) were swept long ago.
    expect((await stack.repos.countForRequest(fresh.request.id)).recipient_profiles).toBe(1);
    expect(summary.sweptBlobs).toBe(3);
    expect(stack.photos.keys()).toEqual([]);
    // Nothing left to do on a second run.
    expect((await purgeExpired(stack.deps)).requests).toBe(0);
  });
});

describe("deleteEverything with A1's batch purge", () => {
  it("uses youcam.purge when present and reports failed tasks as pending", async () => {
    const stack = makeStack();
    const a = await seedFullRequest(stack);
    const purge = vi.fn(async (input: { cacheKeys: readonly string[]; taskIds: readonly string[] }) => ({
      cacheKeysPurged: input.cacheKeys.length,
      tasks: input.taskIds.map((taskId) => ({ taskId, ok: !taskId.includes("vto-2") })),
    }));
    stack.deps.youcam.purge = purge;
    const receipt = await deleteEverything(stack.deps, a.request.id);
    expect(purge).toHaveBeenCalledTimes(1);
    expect(purge.mock.calls[0][0].taskIds).toHaveLength(4);
    expect(stack.deleteTask).not.toHaveBeenCalled();
    expect(receipt.deleted).toMatchObject({ cacheEntries: 4, youcamTasks: 3 });
    expect(receipt.youcamTasksPending).toEqual(["task-a-vto-2"]);
    expect(receipt.verified).toBe(true);
  });

  it("falls back to per-key and per-task deletes when purge throws", async () => {
    const stack = makeStack();
    const a = await seedFullRequest(stack);
    vi.spyOn(console, "error").mockImplementation(() => {});
    stack.deps.youcam.purge = async () => Promise.reject(new Error("purge unavailable"));
    const receipt = await deleteEverything(stack.deps, a.request.id);
    expect(stack.deletedTasks).toHaveLength(4);
    expect(stack.purgedCacheKeys).toHaveLength(4);
    expect(receipt.verified).toBe(true);
  });

  it("works with the real lib/youcam client purge (mock mode): cache emptied, every task deleted, audited", async () => {
    const cache = new MemoryResultCache();
    const audit = new MemoryAuditSink();
    const client = createYoucamClient({ config: { mock: true, allowPaid: false }, cache, audit, limiter: null });
    const del = vi.spyOn(client, "deleteTask");
    const stack = makeStack();
    const a = await seedFullRequest(stack);
    const rows = await stack.repos.tryons.listForRequest(a.request.id);
    for (const r of rows) await cache.set(r.cacheKey, { feature: r.feature, taskId: r.taskId!, result: {}, unitsCharged: 0, createdAt: "x" });
    stack.deps.youcam.purge = (input) => client.purge(input);
    const receipt = await deleteEverything(stack.deps, a.request.id);
    expect(receipt.verified).toBe(true);
    expect(receipt.deleted).toMatchObject({ cacheEntries: 4, youcamTasks: 4 });
    for (const r of rows) expect(await cache.get(r.cacheKey)).toBeUndefined();
    expect(del.mock.calls.map((c) => c[0]).sort()).toEqual(rows.map((r) => r.taskId).sort());
    expect(stack.deleteTask).not.toHaveBeenCalled();
    expect(audit.events.some((e) => e.event === "youcam.purge")).toBe(true);
  });
});
