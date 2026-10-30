/** In-memory fake of the YouCam S2S API for unit tests. Never touches the network. */
import { FEATURE_COST_SNAPSHOT } from "../costs";
import type { FetchLike } from "../http";

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export interface FakeApiOptions {
  balance?: number;
  /** task GET responses before success. */
  runningPolls?: number;
  results?: Record<string, unknown>;
  taskStatus?: "success" | "error";
}

export class FakeYoucamApi {
  readonly calls: RecordedCall[] = [];
  balance: number;
  runningPolls: number;
  taskStatus: "success" | "error";
  results: Record<string, unknown>;
  /** Optional per-call override: return a Response to short-circuit the default behavior. */
  override?: (call: RecordedCall) => Response | undefined | Promise<Response | undefined>;
  private taskCounter = 0;
  private polls = new Map<string, number>();

  constructor(opts: FakeApiOptions = {}) {
    this.balance = opts.balance ?? 1000;
    this.runningPolls = opts.runningPolls ?? 1;
    this.taskStatus = opts.taskStatus ?? "success";
    this.results = opts.results ?? {};
  }

  callsTo(method: string, pattern: RegExp): RecordedCall[] {
    return this.calls.filter((c) => c.method === method && pattern.test(c.url));
  }

  readonly fetch: FetchLike = async (url, init) => {
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}));
    let body: unknown;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    else if (init?.body) body = "<bytes>";
    const call: RecordedCall = { method: init?.method ?? "GET", url, headers, body };
    this.calls.push(call);
    const o = await this.override?.(call);
    if (o) return o;
    const u = new URL(url);
    if (call.method === "PUT" && u.hostname === "upload.example") return new Response(null, { status: 200 });
    if (u.pathname === "/s2s/v1.0/client/credit") {
      return json({ status: 200, results: [{ type: "ApiPaygToken", amount: this.balance }, { type: "WebToken", amount: 5 }] });
    }
    if (u.pathname === "/s2s/v2.0/credit/feature-cost") {
      return json({
        status: 200,
        result: {
          skus: FEATURE_COST_SNAPSHOT.map((s) => ({
            description: s.description,
            amount: s.amount,
            unit: s.unit,
            proc_unit: s.proc_unit,
            run_task_url: `https://yce-api-01.makeupar.com/s2s/v2.0/task/${s.feature}`,
          })),
        },
      });
    }
    if (call.method === "POST" && /^\/s2s\/v2\.0\/file/.test(u.pathname)) {
      const n = this.callsTo("POST", /\/s2s\/v2\.0\/file/).length;
      return json({
        status: 200,
        data: {
          files: [
            {
              file_id: `file_${n}`,
              requests: [{ method: "PUT", url: `https://upload.example/put/${n}?sig=secret`, headers: { "Content-Type": "image/jpeg" } }],
            },
          ],
        },
      });
    }
    const task = /^\/s2s\/v2\.\d\/task\/(.+?)(?:\/([^/]+))?$/.exec(u.pathname);
    if (task && call.method === "POST") {
      this.taskCounter++;
      return json({ status: 200, data: { task_id: `task_${this.taskCounter}` } });
    }
    if (task && call.method === "GET") {
      const slugAndId = u.pathname.replace(/^\/s2s\/v2\.\d\/task\//, "");
      const id = slugAndId.split("/").pop()!;
      const slug = slugAndId.slice(0, -(id.length + 1));
      const seen = this.polls.get(id) ?? 0;
      this.polls.set(id, seen + 1);
      if (seen < this.runningPolls) return json({ status: 200, data: { task_status: "running" } });
      if (this.taskStatus === "error") {
        return json({ status: 200, data: { task_status: "error", error: "error_no_face", error_message: "No face" } });
      }
      return json({ status: 200, data: { task_status: "success", results: this.results[slug] ?? { url: "https://result.example/out.jpg" } } });
    }
    return json({ status: 404, error: "not found" }, 404);
  };
}
