import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetJobs, waitForJob } from "@/server/ingest/worker/jobs";
import { GET as getJob } from "../[jobId]/route";
import { GET, POST } from "../route";

vi.setConfig({ testTimeout: 60_000 });

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/ingest", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const ctx = (jobId: string) => ({ params: Promise.resolve({ jobId }) });

beforeEach(() => {
  resetJobs();
  vi.stubEnv("INGEST_FIXTURE", "1");
  vi.stubEnv("INGEST_ADMIN_TOKEN", "");
  vi.stubEnv("DATABASE_URL", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetJobs();
});

describe("POST/GET /api/ingest", () => {
  it("starts a job, reports progress and finishes with the SKU count", async () => {
    const res = await POST(post({ url: "https://aurum-fixture.test/" }));
    expect(res.status).toBe(202);
    const { jobId, statusUrl } = (await res.json()) as { jobId: string; statusUrl: string };
    expect(statusUrl).toBe(`/api/ingest/${jobId}`);
    await waitForJob(jobId);
    const job = (await (await getJob(new Request(`http://localhost${statusUrl}`), ctx(jobId))).json()) as Record<string, unknown>;
    expect(job).toMatchObject({ status: "done", tier: 3, platform: "render", skuCount: 20, coverage: { withAll3: 17 } });
    const list = (await (await GET(new Request("http://localhost/api/ingest"))).json()) as { jobs: { id: string }[] };
    expect(list.jobs.map((j) => j.id)).toContain(jobId);
  });

  it("returns the running job instead of starting a second one for the same host", async () => {
    const a = (await (await POST(post({ url: "https://aurum-fixture.test/" }))).json()) as { jobId: string };
    const second = await POST(post({ url: "https://aurum-fixture.test/shop" }));
    expect(second.status).toBe(200);
    expect(((await second.json()) as { jobId: string; reused: boolean }).jobId).toBe(a.jobId);
    await waitForJob(a.jobId);
  });

  it("rejects bad bodies, disallowed hosts and missing tokens", async () => {
    expect((await POST(post({ link: "x" }))).status).toBe(400);
    expect((await POST(post({ url: "https://www.example.com/" }))).status).toBe(403);
    expect((await POST(post({ url: "http://127.0.0.1:5432/" }))).status).toBe(403);
    vi.stubEnv("INGEST_ADMIN_TOKEN", "s3cret");
    expect((await POST(post({ url: "https://aurum-fixture.test/" }))).status).toBe(401);
    expect((await GET(new Request("http://localhost/api/ingest"))).status).toBe(401);
    const ok = await POST(post({ url: "https://jsonld-fixture.test/" }, { authorization: "Bearer s3cret" }));
    expect(ok.status).toBe(202);
    await waitForJob(((await ok.json()) as { jobId: string }).jobId);
  });

  it("404s an unknown job", async () => {
    expect((await getJob(new Request("http://localhost/api/ingest/nope"), ctx("nope"))).status).toBe(404);
  });
});
