/**
 * Minimal JSON-over-fetch transport with exponential backoff on HTTP 429
 * (and, for idempotent requests, on 5xx/network errors).
 */
import { YoucamApiError } from "./errors";
import { youcamState } from "./global-state";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface RetryPolicy {
  /** Retries after the first attempt. */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxRetries: 5, baseDelayMs: 1_000, maxDelayMs: 30_000 };

export interface RequestOptions {
  method: "GET" | "POST" | "PUT";
  url: string;
  headers?: Record<string, string>;
  json?: unknown;
  body?: BodyInit;
  /** Safe to retry on 5xx / network errors (GET, PUT to presigned URL). POST /task is not. */
  idempotent: boolean;
  /** Label used in errors, never the full URL (presigned URLs carry credentials). */
  endpoint: string;
  /** false for requests that do not hit the YouCam API (presigned storage PUT). */
  rateLimited?: boolean;
}

/**
 * Client-side token bucket for the YouCam rate limit (250 requests / 300 s per IP
 * and per token, docs develop/rate_limit). Capacity + refill over one window never
 * exceeds the limit, so a full burst followed by steady polling stays under it.
 * Every API request (polls included) takes a token; presigned S3 PUTs do not.
 */
export class RateLimiter {
  private tokens: number;
  private last: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly limit = 250,
    readonly windowMs = 300_000,
    private readonly now: () => number = Date.now,
    burst = 20,
  ) {
    this.capacity = Math.max(1, Math.min(burst, limit));
    this.refillPerMs = Math.max(limit - this.capacity, 1) / windowMs;
    this.tokens = this.capacity;
    this.last = now();
  }

  private refill() {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + (t - this.last) * this.refillPerMs);
    this.last = t;
  }

  /** Waits (FIFO) until a token is available, then takes it. */
  acquire(sleep: Sleep): Promise<void> {
    const next = this.queue.then(async () => {
      this.refill();
      while (this.tokens < 1) {
        await sleep(Math.ceil((1 - this.tokens) / this.refillPerMs));
        this.refill();
      }
      this.tokens -= 1;
    });
    this.queue = next.catch(() => {});
    return next;
  }
}

/**
 * The process-wide limiter (kept on globalThis, ADR-023): the YouCam limit applies to the API
 * key and the server IP, not per client or per Next.js route bundle.
 */
export function sharedRateLimiter(): RateLimiter {
  return (youcamState().rateLimiter ??= new RateLimiter());
}

export interface Transport {
  fetch: FetchLike;
  sleep: Sleep;
  retry: RetryPolicy;
  random?: () => number;
  /** When set, every request through this transport takes a token first. */
  limiter?: RateLimiter;
}

/** Delay before retry n (0-based): exponential with full jitter, or Retry-After when given. */
export function backoffDelay(attempt: number, policy: RetryPolicy, retryAfter: string | null, random = Math.random) {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, policy.maxDelayMs);
  }
  const cap = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  return Math.round(cap / 2 + (random() * cap) / 2);
}

async function errorFrom(res: Response, endpoint: string): Promise<YoucamApiError> {
  let message = `${res.status} ${res.statusText}`.trim();
  let code: string | undefined;
  try {
    const body = (await res.json()) as { error?: string; error_code?: string; message?: string };
    message = body.error || body.message || message;
    code = body.error_code;
  } catch {
    // non-JSON error body; keep the status line
  }
  return new YoucamApiError(`YouCam ${endpoint} failed: ${message}`, res.status, code, endpoint);
}

/** Sends a request and returns the raw Response for 2xx; throws YoucamApiError otherwise. */
export async function send(t: Transport, opts: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body = opts.body;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  }
  for (let attempt = 0; ; attempt++) {
    if (opts.rateLimited !== false) await t.limiter?.acquire(t.sleep);
    let res: Response;
    try {
      res = await t.fetch(opts.url, { method: opts.method, headers, body });
    } catch (err) {
      if (opts.idempotent && attempt < t.retry.maxRetries) {
        await t.sleep(backoffDelay(attempt, t.retry, null, t.random));
        continue;
      }
      throw new YoucamApiError(`YouCam ${opts.endpoint} network error: ${(err as Error).message}`, 0, undefined, opts.endpoint);
    }
    if (res.ok) return res;
    const retryable = res.status === 429 || (opts.idempotent && res.status >= 500);
    if (retryable && attempt < t.retry.maxRetries) {
      await t.sleep(backoffDelay(attempt, t.retry, res.headers.get("retry-after"), t.random));
      continue;
    }
    throw await errorFrom(res, opts.endpoint);
  }
}

export async function sendJson<T>(t: Transport, opts: RequestOptions): Promise<T> {
  const res = await send(t, opts);
  return (await res.json()) as T;
}
