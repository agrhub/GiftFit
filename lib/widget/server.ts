/**
 * Widget server logic (owner: A6, ADR-046/047): send the gift card by e-mail, remember where to send
 * "your Fit Report is ready", and send that note when the recipient taps Done. Server-only.
 *
 *   POST /api/widget/send-card  { giverToken, recipientToken, to, lang, message?, giverName? }
 *        200 { sent: true, delivery: "sent" | "logged" }    ("logged" = console provider, nothing left)
 *        400 { error: "invalid_request" | "invalid_email" }  404 { error: "not_found" }
 *        410 { error: "expired" }  429 { error: "rate_limited" } + Retry-After  502 { error: "send_failed" }
 *   POST /api/widget/notify     { giverToken, email, lang, giverName? }
 *        200 { saved: true } | { saved: false, ready: true }  (already completed: open the report instead)
 *        400 / 404 / 410 / 429 as above
 *
 * Auth is the giver token (body only). send-card also needs the recipient token of the SAME request
 * (the link it e-mails), checked against the stored hash. Unknown, malformed and foreign tokens all
 * answer 404 not_found, so neither route is a token oracle. Every response goes through giverJson and
 * never contains an address, a token or an id.
 */
import { z } from "zod";
import { appBaseUrl, assertEmailRate, EmailRateLimitError, EmailValidationError, fitReportReadyEmail, getEmailSender, giftCardEmail, isValidAddress, type EmailSender } from "@/lib/email";
import { clientKey } from "@/lib/privacy/client-ip";
import { giverJson } from "@/lib/privacy/giver-guard";
import { giverRateLimit } from "@/lib/privacy/rate-limit";
import type { FitRequestRecord, PrivacyRepos } from "@/lib/privacy/repos/types";
import { CLOSED_STATUSES } from "@/lib/privacy/repos/types";
import { getPrivacyDeps } from "@/lib/privacy/runtime";
import { hashToken, looksLikeToken, safeEqual } from "@/lib/privacy/tokens";
import { getContactStore, newContactRecord, openContact, type WidgetContactStore } from "./contacts";
import { widgetEmailLimiter } from "./email-limits";
import { cleanMessage, cleanName, MAX_CARD_MESSAGE, MAX_GIVER_NAME } from "./share";
import { isPreviewStoreId } from "./preview-key";
import { giftOffersTryOn } from "@/lib/privacy/tryon-mode";
import type { EmailRateLimiter } from "@/lib/email/rate-limit";

/** At most this many recipient_card records per request (older ones are dropped first). */
export const MAX_CARD_CONTACTS = 5;

export interface WidgetServerDeps {
  repos: () => Promise<PrivacyRepos>;
  contacts: () => WidgetContactStore;
  sender: () => EmailSender;
  limiter: () => EmailRateLimiter;
  now: () => Date;
}

export const defaultWidgetDeps: WidgetServerDeps = {
  repos: async () => (await getPrivacyDeps()).repos,
  contacts: getContactStore,
  sender: getEmailSender,
  limiter: widgetEmailLimiter,
  now: () => new Date(),
};

const Lang = z.enum(["en", "vi"]).catch("en");
const Token = z.string().max(128);
const SendCardBody = z.object({
  giverToken: Token,
  recipientToken: Token,
  to: z.string().max(254),
  lang: Lang,
  message: z.string().max(MAX_CARD_MESSAGE * 2).optional(),
  giverName: z.string().max(MAX_GIVER_NAME * 2).optional(),
});
const NotifyBody = z.object({
  giverToken: Token,
  email: z.string().max(254),
  lang: Lang,
  giverName: z.string().max(MAX_GIVER_NAME * 2).optional(),
});

type Found = { ok: true; request: FitRequestRecord } | { ok: false; res: Response };

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

/** The giver's open request, or the response to send instead (same 404 for every unknown token). */
async function findOpenRequest(deps: WidgetServerDeps, giverToken: string): Promise<Found> {
  if (!looksLikeToken(giverToken)) return { ok: false, res: giverJson({ error: "not_found" }, { status: 404 }) };
  const repos = await deps.repos();
  const request = await repos.fitRequests.findByGiverTokenHash(hashToken(giverToken));
  if (!request) return { ok: false, res: giverJson({ error: "not_found" }, { status: 404 }) };
  if (CLOSED_STATUSES.includes(request.status) || request.expiresAt.getTime() <= deps.now().getTime()) return { ok: false, res: giverJson({ error: "expired" }, { status: 410 }) };
  return { ok: true, request };
}

function rateLimited(retryAfterSec: number): Response {
  return giverJson({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(retryAfterSec) } });
}

export async function handleSendCard(req: Request, deps: WidgetServerDeps = defaultWidgetDeps): Promise<Response> {
  const parsed = SendCardBody.safeParse(await readJson(req));
  if (!parsed.success) return giverJson({ error: "invalid_request" }, { status: 400 });
  const body = parsed.data;
  const to = body.to.trim();
  if (!isValidAddress(to)) return giverJson({ error: "invalid_email" }, { status: 400 });

  const found = await findOpenRequest(deps, body.giverToken);
  if (!found.ok) return found.res;
  const { request } = found;
  if (!looksLikeToken(body.recipientToken) || !safeEqual(hashToken(body.recipientToken), request.recipientTokenHash)) return giverJson({ error: "not_found" }, { status: 404 });

  try {
    await assertEmailRate({ giverKey: request.giverTokenHash, ipKey: clientKey(req, "email") }, deps.now().getTime(), deps.limiter());
  } catch (err) {
    if (err instanceof EmailRateLimitError) return rateLimited(err.retryAfterSec);
    throw err;
  }

  const sender = deps.sender();
  const giverName = cleanName(body.giverName);
  const mail = giftCardEmail({
    occasion: request.occasion,
    lang: body.lang,
    giverName,
    message: cleanMessage(body.message),
    recipientToken: body.recipientToken,
    baseUrl: appBaseUrl(req),
    // No "phone camera" copy when the recipient won't be offered a try-on (A16: the public site spends 0 YouCam
    // units; a preview with no usable photo). The owner's recording session and mock mode keep it.
    ...((await giftOffersTryOn(await getPrivacyDeps(), request, req)) ? {} : { tryOn: false }),
  });
  try {
    await sender.send({ to, ...mail, tags: [{ name: "type", value: "gift_card" }] });
  } catch (err) {
    if (err instanceof EmailValidationError) return giverJson({ error: "invalid_email" }, { status: 400 });
    console.error("[widget] gift card e-mail failed:", (err as { code?: string }).code ?? (err as Error).name);
    return giverJson({ error: "send_failed" }, { status: 502 });
  }

  // Durable record of the address, sealed, for the request lifetime only.
  const store = deps.contacts();
  const now = deps.now();
  try {
    await store.put(newContactRecord({ fitRequestId: request.id, kind: "recipient_card", payload: { email: to, lang: body.lang }, now, expiresAt: request.expiresAt }));
    const cards = await store.list(request.id, now, "recipient_card");
    for (const old of cards.slice(0, Math.max(0, cards.length - MAX_CARD_CONTACTS))) await store.delete(old.id);
  } catch (err) {
    console.error("[widget] contact record failed:", (err as Error).message);
  }
  return giverJson({ sent: true, delivery: sender.provider === "console" ? "logged" : "sent" });
}

export async function handleNotifyMe(req: Request, deps: WidgetServerDeps = defaultWidgetDeps): Promise<Response> {
  const limited = await giverRateLimit(req, "widget_notify");
  if (limited) return limited;
  const parsed = NotifyBody.safeParse(await readJson(req));
  if (!parsed.success) return giverJson({ error: "invalid_request" }, { status: 400 });
  const body = parsed.data;
  const email = body.email.trim();
  if (!isValidAddress(email)) return giverJson({ error: "invalid_email" }, { status: 400 });

  const found = await findOpenRequest(deps, body.giverToken);
  if (!found.ok) return found.res;
  const { request } = found;
  if (request.status === "completed") return giverJson({ saved: false, ready: true });

  const store = deps.contacts();
  const now = deps.now();
  // One notify address per request: the latest one wins.
  for (const old of await store.list(request.id, now, "giver_notify")) await store.delete(old.id);
  await store.put(
    newContactRecord({
      fitRequestId: request.id,
      kind: "giver_notify",
      payload: { email, lang: body.lang, giverToken: body.giverToken, ...(cleanName(body.giverName) ? { giverName: cleanName(body.giverName) } : {}) },
      now,
      expiresAt: request.expiresAt,
    }),
  );
  return giverJson({ saved: true });
}

/**
 * Called by POST /api/recipient/done after doneFlow succeeded: sends "your Fit Report is ready" to the
 * address the giver left (if any), then deletes that record whatever the outcome. Never throws and
 * never changes the Done response; at most one e-mail per request (the record is gone afterwards).
 */
export async function notifyGiverReportReady(
  request: Pick<FitRequestRecord, "id" | "occasion"> & Partial<Pick<FitRequestRecord, "storeId">>,
  req: Request,
  deps: Pick<WidgetServerDeps, "contacts" | "sender" | "now"> = defaultWidgetDeps,
  /** A16: whether a try-on happened (absent = previews had none, Aurum did: the pre-A16 rule). */
  opts: { tryOn?: boolean } = {},
): Promise<number> {
  const noTryOn = opts.tryOn === undefined ? isPreviewStoreId(request.storeId) : !opts.tryOn;
  let sent = 0;
  try {
    const store = deps.contacts();
    const rows = await store.list(request.id, deps.now(), "giver_notify");
    for (const row of rows) {
      const p = openContact(row.sealed);
      try {
        if (p?.giverToken && isValidAddress(p.email)) {
          const mail = fitReportReadyEmail({ lang: p.lang, giverName: p.giverName, giverToken: p.giverToken, occasion: request.occasion, baseUrl: appBaseUrl(req), ...(noTryOn ? { tryOn: false } : {}) });
          await deps.sender().send({ to: p.email, ...mail, tags: [{ name: "type", value: "fit_report_ready" }] });
          sent++;
        }
      } catch (err) {
        console.error("[widget] report-ready e-mail failed:", (err as { code?: string }).code ?? (err as Error).name);
      } finally {
        await store.delete(row.id);
      }
    }
  } catch (err) {
    console.error("[widget] report-ready notification skipped:", (err as Error).message);
  }
  return sent;
}
