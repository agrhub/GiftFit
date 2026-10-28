"use client";
/**
 * Recipient flow (owner: A4), mobile-first: consent → selfie → optional hand photo → progress →
 * 6-item carousel with hearts → undertone estimate with override → done. The timer runs from
 * link open to hearts sent (target < 60 s on a real run).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CaptureResponse,
  CarouselItem,
  RecipientSessionResponse,
} from "@/lib/contracts/api";
import { DeleteEverythingButton } from "@/components/trust/DeleteEverythingButton";
import { Disclaimer } from "@/components/trust/Disclaimer";
import { RecipientTransparencyCard } from "@/components/trust/TransparencyCard";
import type { UndertoneValue } from "@/components/trust/UndertoneEstimateCard";
import { OCCASION_LABELS } from "@/components/store/format";
import { ApiError, type GiftApi, friendlyError, loadGiftApi } from "../api";
import { setGiftStoreName, storeNameFor } from "../giftStore";
import { HandIcon, HeartIcon, ShieldIcon } from "../icons";
import { AiModelBadge } from "./AiModelBadge";
import type { RetakeKind } from "./tryOnFailures";
import {
  CAP_NOTE,
  type CardState,
  PHOTO_DELETED_NOTE,
  PHOTO_RETENTION,
  type TryOnRender,
  defaultSwatch,
  heartKey,
} from "./variants";
import dynamic from "next/dynamic";

// Later steps load on demand, so the consent screen ships only what it renders (Lighthouse, A8 pass 2).
const loadCapture = () => import("./CaptureStep");
const CaptureStep = dynamic(() => loadCapture().then((m) => m.CaptureStep), {
  ssr: false,
});
const TryOnCarousel = dynamic(
  () => import("./TryOnCarousel").then((m) => m.TryOnCarousel),
  { ssr: false },
);
const ProcessingStep = dynamic(
  () => import("./ProcessingStep").then((m) => m.ProcessingStep),
  { ssr: false },
);
const DoneScreen = dynamic(
  () => import("./DoneScreen").then((m) => m.DoneScreen),
  { ssr: false },
);
const UndertoneEstimateCard = dynamic(
  () =>
    import("@/components/trust/UndertoneEstimateCard").then(
      (m) => m.UndertoneEstimateCard,
    ),
  { ssr: false },
);

type Step =
  | { kind: "loading" }
  | { kind: "error"; message: string; retry: boolean }
  | { kind: "expired"; preview?: boolean }
  | { kind: "consent" }
  | { kind: "declined" }
  | { kind: "selfie"; retake?: RetakeKind }
  | { kind: "hand" }
  | { kind: "processing"; startedAt: number }
  | { kind: "tryon"; readOnly?: boolean }
  | { kind: "undertone" }
  | { kind: "done"; alreadyDone?: boolean }
  | { kind: "deleted" };

/** The capture view without any image URL (try-ons are face-derived, ADR-036). */
function stripImages(c: CaptureResponse): CaptureResponse {
  return {
    ...c,
    tryons: c.tryons.map((t) => ({
      itemId: t.itemId,
      swatchId: t.swatchId,
      status: t.status,
      failureReason: t.failureReason,
    })),
  };
}

export interface RecipientFlowProps {
  token: string;
  api?: GiftApi;
}

const primary =
  "flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-ink px-6 text-sm font-medium text-ivory transition-colors hover:bg-ink-soft disabled:cursor-wait disabled:opacity-70";

/** Thumb-reachable action bar pinned to the bottom of the screen. */
function ActionBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="sticky bottom-0 -mx-4 mt-6 border-t border-line bg-ivory/95 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur">
      {children}
    </div>
  );
}

/**
 * Why this recipient gets no try-on (A16, session `tryOnNote`). The public site spends 0 YouCam units: the
 * demo store points to the pre-recorded judge demo; previews say try-on is off for them right now.
 */
function NoTryOnCopy({
  note,
  where,
}: {
  note?: RecipientSessionResponse["tryOnNote"];
  where: "consent" | "tryon";
}) {
  if (note === "demo_mode")
    return (
      <>
        Demo mode: try-ons are pre-recorded and no photo is sent.{" "}
        {where === "consent"
          ? "You'll just heart the pieces you like."
          : "Heart the pieces you like from the store's photos."}{" "}
        <a
          href="/demo"
          data-testid="judge-demo-link"
          className="font-medium text-ink underline decoration-gold underline-offset-2"
        >
          See pre-recorded try-ons on an AI-generated model
        </a>
      </>
    );
  if (note === "no_eligible")
    return where === "consent" ? (
      <>
        The store&apos;s photos of these pieces can&apos;t be used for try-on,
        so no photo is needed. You&apos;ll just heart the pieces you like.
      </>
    ) : (
      <>
        These photos can&apos;t be used for try-on. Heart the pieces you like
        from the store&apos;s photos.
      </>
    );
  return where === "consent" ? (
    <>
      This gift comes from a store preview: try-on isn&apos;t enabled for
      previews, so no photo is needed. You&apos;ll just heart the pieces you
      like.
    </>
  ) : (
    <>
      Try-on isn&apos;t enabled for previews. Heart the pieces you like from the
      store&apos;s photos.
    </>
  );
}

function PrivacyDetails({
  token,
  hasHandPhoto,
  expiresAt,
  onDeleted,
  tryOn = true,
}: {
  token: string;
  hasHandPhoto?: boolean;
  expiresAt?: string;
  onDeleted: () => void;
  tryOn?: boolean;
}) {
  return (
    <details className="group mt-8 rounded-2xl border border-line bg-white">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-2 px-4 text-sm font-medium text-ink">
        <span className="flex items-center gap-2">
          <ShieldIcon className="h-4 w-4 text-sage" /> Your privacy and Delete
          everything
        </span>
        <span
          aria-hidden="true"
          className="text-muted transition-transform group-open:rotate-45"
        >
          +
        </span>
      </summary>
      <div className="space-y-4 px-4 pb-4">
        <RecipientTransparencyCard
          hasHandPhoto={hasHandPhoto}
          expiresAt={expiresAt}
          tryOn={tryOn}
          className="border-0 p-0 shadow-none"
        />
        <div data-testid="delete-everything">
          <DeleteEverythingButton sessionToken={token} onDeleted={onDeleted} />
        </div>
      </div>
    </details>
  );
}

export function RecipientFlow({ token, api: apiProp }: RecipientFlowProps) {
  const [step, setStep] = useState<Step>({ kind: "loading" });
  const [session, setSession] = useState<RecipientSessionResponse | null>(null);
  const [capture, setCapture] = useState<CaptureResponse | null>(null);
  /** Hearts as "<itemId>|<swatchId>": a heart is on the metal shown when it was tapped (ADR-032). */
  const [hearted, setHearted] = useState<Set<string>>(new Set());
  /** Swatch shown per design (absent = the default swatch). */
  const [shown, setShown] = useState<Record<string, string>>({});
  /** Renders per "<itemId>|<swatchId>". */
  const [renders, setRenders] = useState<Record<string, TryOnRender>>({});
  const [loadingItems, setLoadingItems] = useState<Set<string>>(new Set());
  const [capNotes, setCapNotes] = useState<Set<string>>(new Set());
  const [wished, setWished] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  /** A photo exists on this device (review, or taken and not yet uploaded). */
  const [localPhoto, setLocalPhoto] = useState(false);
  /** "Delete my photo now" done (ADR-036): previews and hearts stay, no more metal renders. */
  const [photoDeleted, setPhotoDeleted] = useState(false);
  const [photoNote, setPhotoNote] = useState<string | null>(null);
  const [deletingPhoto, setDeletingPhoto] = useState(false);
  /** Remounts the capture step (discarding its photo). */
  const [captureKey, setCaptureKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [stepError, setStepError] = useState<string | null>(null);
  const [heartsSeconds, setHeartsSeconds] = useState<number | undefined>();
  const [announce, setAnnounce] = useState("");
  const apiRef = useRef<GiftApi | null>(apiProp ?? null);
  const selfieRef = useRef<Blob | null>(null);
  const handRef = useRef<Blob | null>(null);
  const openedAt = useRef<number>(0);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const api = useCallback(
    async () => (apiRef.current ??= await loadGiftApi()),
    [],
  );

  const fail = useCallback((err: unknown) => {
    if (err instanceof ApiError && err.status === 410)
      setStep({ kind: "expired" });
    else if (
      err instanceof ApiError &&
      (err.status === 404 || err.status === 401) &&
      !err.routeMissing
    )
      setStep({
        kind: "error",
        message: "This link isn't valid, or everything was already deleted.",
        retry: false,
      });
    else setStep({ kind: "error", message: friendlyError(err), retry: true });
  }, []);

  const open = useCallback(async () => {
    openedAt.current = Date.now();
    setStep({ kind: "loading" });
    try {
      const client = await api();
      const s = await client.openSession(token);
      setSession(s);
      // The header names this request's store: a preview's own name, never "Aurum" for a preview.
      setGiftStoreName(
        storeNameFor({
          storeName: s.storeName,
          preview: Boolean(s.preview || s.storeName),
        }),
      );
      // A reload after capture restores the carousel (GET /api/recipient/capture, fresh signed URLs).
      const resumed =
        s.status === "trying_on" || s.status === "completed"
          ? await client.resumeCapture(token).catch(() => null)
          : null;
      if (resumed) applyCapture(resumed, s.items);
      setStep(
        s.status === "expired"
          ? { kind: "expired" }
          : s.previewExpired && s.status !== "completed"
            ? { kind: "expired", preview: true }
            : s.status === "completed"
              ? { kind: "done", alreadyDone: true }
              : s.status === "awaiting_consent"
                ? { kind: "consent" }
                : s.tryOn === false
                  ? { kind: "tryon" }
                  : s.status === "awaiting_capture" ||
                      (s.status === "trying_on" && !resumed)
                    ? { kind: "selfie" }
                    : { kind: "tryon" },
      );
    } catch (err) {
      fail(err);
    }
  }, [api, token, fail]);

  useEffect(() => {
    void open();
  }, [open]);

  // Warm the camera step while the recipient reads the consent screen.
  useEffect(() => {
    if (step.kind === "consent") void loadCapture();
  }, [step.kind]);

  // Move focus to each step's heading so screen readers hear the new screen. The first screen after
  // load keeps the browser's natural focus (no forced layout during hydration; the intro is already
  // at the top of the page).
  const prevKind = useRef<Step["kind"]>("loading");
  useEffect(() => {
    const first = prevKind.current === "loading";
    prevKind.current = step.kind;
    if (!first && step.kind !== "loading" && step.kind !== "done")
      headingRef.current?.focus();
  }, [step.kind]);

  const items = session?.items ?? [];
  // A16: pieces whose store photo can't be tried on are hearts-only (and never ask for a hand photo).
  const triable = items.filter((i) => i.tryOn !== false);
  const mixed = triable.length > 0 && triable.length < items.length;
  const needsHand = triable.some((i) => i.needsHandPhoto);
  // Seeded judge demo (ADR-038): the recipient is an AI-generated model.
  const isDemo = Boolean(session?.demo || capture?.demo);
  // No try-on for this recipient (A16: the public site spends 0 YouCam units; a preview with no usable photo):
  // the recipient hearts pieces from the product photos. `tryOnNote` says why.
  const noTryOn = session?.tryOn === false;
  const tryOnNote = session?.tryOnNote ?? (noTryOn ? "preview_off" : undefined);
  const shownSwatch = (item: CarouselItem) =>
    shown[item.itemId] ?? defaultSwatch(item);

  /** Seed renders and shown swatches from a capture (or a resumed one). Hearts are kept. */
  function applyCapture(res: CaptureResponse, list: CarouselItem[]) {
    // After "Delete my photo now" the server returns no try-on images (ADR-036, clarified).
    const deleted = res.tryons.some((t) => t.failureReason === "photo_deleted");
    setPhotoDeleted(deleted);
    setPhotoNote(deleted ? PHOTO_DELETED_NOTE : null);
    const r: Record<string, TryOnRender> = {};
    const sh: Record<string, string> = {};
    for (const t of res.tryons) {
      const item = list.find((i) => i.itemId === t.itemId);
      const swatchId = t.swatchId ?? (item ? defaultSwatch(item) : undefined);
      if (!deleted)
        r[heartKey(t.itemId, swatchId)] = {
          status: t.status,
          imageUrl: t.imageUrl,
          failureReason: t.failureReason,
        };
      if (swatchId) sh[t.itemId] = swatchId;
    }
    setCapture(deleted ? stripImages(res) : res);
    setRenders(r);
    setShown(sh);
    setCapNotes(new Set());
  }

  /**
   * Forget every face-derived image on this page (selfie, hand photo, try-on URLs): the carousel
   * falls back to product photos, hearts and wishes stay, extra metals are off.
   */
  function forgetFaceImages() {
    selfieRef.current = null;
    handRef.current = null;
    setLocalPhoto(false);
    setRenders({});
    setCapture((c) => (c ? stripImages(c) : c));
    setPhotoDeleted(true);
    setPhotoNote(PHOTO_DELETED_NOTE);
    setAnnounce(PHOTO_DELETED_NOTE);
  }
  // Earring try-ons need visible earlobes (engine error "2", ADR-026).
  const needsEars = triable.some((i) => i.category === "earring");
  /** New selfie after a fixable failure (e.g. hidden earlobes). Hearts live in state and are kept. */
  const retake = (kind: RetakeKind) => {
    setStepError(null);
    setStep({ kind: "selfie", retake: kind });
  };
  const handCount = triable.filter((i) => i.needsHandPhoto).length;
  const occasion = session?.occasion ? OCCASION_LABELS[session.occasion] : null;
  const onDeleted = () => setStep({ kind: "deleted" });

  async function accept() {
    setBusy(true);
    try {
      const s = await (await api()).consent(token);
      setSession((prev) => ({
        ...(prev ?? s),
        ...s,
        items: s.items?.length ? s.items : (prev?.items ?? []),
      }));
      // Store-URL previews (ADR-055) are hearts-only: no selfie, straight to the pieces.
      setStep(s.tryOn === false ? { kind: "tryon" } : { kind: "selfie" });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function runCapture() {
    const selfie = selfieRef.current;
    if (!selfie) return setStep({ kind: "selfie" });
    setStepError(null);
    setStep({ kind: "processing", startedAt: Date.now() });
    try {
      const res = await (
        await api()
      ).capture(token, { selfie, hand: handRef.current });
      applyCapture(res, items);
      setLocalPhoto(false);
      setAnnounce(
        `Your ${res.tryons.filter((t) => t.status === "ready").length} AI previews are ready.`,
      );
      setStep({ kind: "tryon" });
    } catch (err) {
      if (
        err instanceof ApiError &&
        (err.status === 410 || (err.status === 404 && !err.routeMissing))
      )
        return fail(err);
      setStepError(friendlyError(err));
      setStep({ kind: "selfie" });
    } finally {
      // The photos only lived in memory on this device; drop them either way.
      selfieRef.current = null;
      handRef.current = null;
    }
  }

  function toggleHeart(itemId: string) {
    const item = items.find((i) => i.itemId === itemId);
    const swatchId = item ? shownSwatch(item) : undefined;
    const key = heartKey(itemId, swatchId);
    const metal = item?.swatches?.find(
      (x) => x.swatchId === swatchId,
    )?.metalLabel;
    setHearted((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setAnnounce(
        `${item?.title ?? "Piece"}${metal ? ` in ${metal.toLowerCase()}` : ""} ${next.has(key) ? "hearted" : "unhearted"}. ${next.size} hearted.`,
      );
      return next;
    });
  }

  /** Show another metal: cached render, else POST /api/recipient/swatch (this card only loads). */
  async function chooseSwatch(itemId: string, swatchId: string) {
    const item = items.find((i) => i.itemId === itemId);
    if (!item) return;
    const previous = shownSwatch(item);
    setShown((m) => ({ ...m, [itemId]: swatchId }));
    if (renders[heartKey(itemId, swatchId)]) return;
    // A16: a piece that is never tried on just shows another metal (the store's photo stays, no render).
    if (item.tryOn === false) return;
    if (photoDeleted) {
      setShown((m) => ({ ...m, [itemId]: previous ?? swatchId }));
      return;
    }
    setLoadingItems((s) => new Set(s).add(itemId));
    try {
      const res = await (await api()).trySwatch(token, itemId, swatchId);
      if (res.status === "failed" && res.failureReason === "photo_deleted") {
        setShown((m) => ({ ...m, [itemId]: previous ?? swatchId }));
        forgetFaceImages();
      } else if (res.status === "cap_reached") {
        setCapNotes((s) => new Set(s).add(itemId));
        setShown((m) => ({ ...m, [itemId]: previous ?? swatchId }));
        setAnnounce(CAP_NOTE);
      } else {
        setRenders((r) => ({
          ...r,
          [heartKey(itemId, swatchId)]: {
            status: res.status as TryOnRender["status"],
            imageUrl: res.imageUrl,
            failureReason: res.failureReason,
          },
        }));
        const metal = item.swatches?.find(
          (x) => x.swatchId === swatchId,
        )?.metalLabel;
        if (res.status === "ready")
          setAnnounce(
            `AI preview of ${item.title}${metal ? ` in ${metal.toLowerCase()}` : ""} is ready.`,
          );
      }
    } catch (err) {
      setShown((m) => ({ ...m, [itemId]: previous ?? swatchId }));
      setToast(
        err instanceof ApiError && err.status === 410
          ? "This link has expired."
          : "We couldn't load that metal. Please try again.",
      );
    } finally {
      setLoadingItems((s) => {
        const n = new Set(s);
        n.delete(itemId);
        return n;
      });
    }
  }

  /** "Love the style, wish it came in another metal": one tap, no render. */
  async function wishMetal(itemId: string) {
    setWished((s) => new Set(s).add(itemId));
    try {
      await (await api()).wishMetal(token, itemId);
      setToast(
        "Thanks, noted. They'll know you love the style in another metal.",
      );
    } catch {
      setWished((s) => {
        const n = new Set(s);
        n.delete(itemId);
        return n;
      });
      setToast("We couldn't send that. Please try again.");
    }
  }

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(t);
  }, [toast]);

  /** "Delete my photo now" (ADR-036): works at any point after a photo exists. */
  async function deletePhotoNow() {
    if (!capture && (step.kind === "selfie" || step.kind === "hand")) {
      // Not uploaded yet: the photo only lives on this device.
      selfieRef.current = null;
      handRef.current = null;
      setLocalPhoto(false);
      setCaptureKey((k) => k + 1);
      setStep({ kind: "selfie" });
      setPhotoNote("Photo deleted from this device. Nothing was uploaded.");
      setAnnounce("Photo deleted from this device. Nothing was uploaded.");
      return;
    }
    setDeletingPhoto(true);
    try {
      await (await api()).deletePhoto(token);
      forgetFaceImages();
    } catch (err) {
      setToast(
        err instanceof ApiError && err.status === 410
          ? "This link has expired."
          : "We couldn't delete your photo. Please try again.",
      );
    } finally {
      setDeletingPhoto(false);
    }
  }

  const photoKept =
    !photoDeleted &&
    (localPhoto || Boolean(capture) || step.kind === "processing");
  const photoBarSteps: Step["kind"][] = [
    "selfie",
    "hand",
    "processing",
    "tryon",
    "undertone",
  ];
  const showPhotoBar =
    photoBarSteps.includes(step.kind) &&
    !(step.kind === "tryon" && step.readOnly) &&
    (photoKept || Boolean(photoNote));

  const cards: Record<string, CardState> = {};
  for (const item of items) {
    const swatchId = shownSwatch(item);
    cards[item.itemId] = {
      swatchId,
      render: renders[heartKey(item.itemId, swatchId)],
      loading: loadingItems.has(item.itemId),
      hearted: hearted.has(heartKey(item.itemId, swatchId)),
      wished: wished.has(item.itemId),
      capNote: capNotes.has(item.itemId),
      rendersOff: photoDeleted || noTryOn,
      noTryOn,
      notTriable: !noTryOn && item.tryOn === false,
      renderedSwatchIds: (item.swatches ?? [])
        .map((x) => x.swatchId)
        .filter((id) => Boolean(renders[heartKey(item.itemId, id)])),
    };
  }

  async function sendHearts() {
    setBusy(true);
    setStepError(null);
    try {
      await (
        await api()
      ).saveHearts(
        token,
        [...hearted].map((k) => {
          const [itemId, swatchId] = k.split("|");
          return { itemId, swatchId: swatchId || undefined };
        }),
      );
      setHeartsSeconds((Date.now() - openedAt.current) / 1000);
      if (noTryOn) {
        // No undertone to check without a selfie: finish right away.
        await (await api()).finish(token);
        setStep({ kind: "done" });
        return;
      }
      setStep({ kind: "undertone" });
    } catch (err) {
      setStepError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    setBusy(true);
    setStepError(null);
    try {
      await (await api()).finish(token);
      setStep({ kind: "done" });
    } catch (err) {
      setStepError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  const h1 =
    "font-display text-[2rem] leading-tight text-ink focus:outline-none";

  return (
    <div className="flex min-h-[calc(100dvh-4rem)] flex-col">
      {isDemo || showPhotoBar ? (
        <div className="sticky top-0 z-30 -mx-4 mb-3 border-b border-line bg-cream/95 px-4 py-2 backdrop-blur">
          {isDemo ? (
            <p
              className="flex items-center gap-2 py-1 text-xs text-ink-soft"
              role="note"
            >
              <AiModelBadge />
              <span>
                Pre-recorded try-ons of an AI-generated model. No real person,
                no cost.
              </span>
            </p>
          ) : null}
          {showPhotoBar ? (
            <div data-testid="photo-bar">
              {photoKept ? (
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs leading-5 text-ink-soft">
                    {capture || step.kind === "processing"
                      ? "Your photo is kept for up to 1 hour, only for trying other metals."
                      : "Your photo is only on this device."}
                  </p>
                  <button
                    type="button"
                    onClick={deletePhotoNow}
                    disabled={deletingPhoto}
                    data-testid="delete-photo-now"
                    className="min-h-11 shrink-0 rounded-full border border-rose px-3 text-xs font-semibold text-rose hover:bg-blush disabled:cursor-wait disabled:opacity-70"
                  >
                    {deletingPhoto ? "Deleting…" : "Delete my photo now"}
                  </button>
                </div>
              ) : (
                <p
                  className="flex min-h-11 items-center text-xs leading-5 text-sage"
                  role="status"
                  data-testid="photo-deleted-note"
                >
                  {photoNote}
                </p>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
      <p aria-live="polite" className="sr-only">
        {announce}
      </p>
      <div
        aria-live="polite"
        role="status"
        className="pointer-events-none fixed inset-x-0 bottom-28 z-40 flex justify-center px-4"
      >
        {toast ? (
          <p
            className="gf-fade-in max-w-sm rounded-full bg-ink px-4 py-2.5 text-center text-sm text-ivory shadow-lg"
            data-testid="toast"
          >
            {toast}
          </p>
        ) : null}
      </div>

      {step.kind === "error" ? (
        <div className="pt-10 text-center" role="alert">
          <h1 ref={headingRef} tabIndex={-1} className={h1}>
            We hit a snag
          </h1>
          <p className="mt-3 text-ink-soft">{step.message}</p>
          {step.retry ? (
            <button
              type="button"
              onClick={() => void open()}
              className={`${primary} mt-8`}
            >
              Try again
            </button>
          ) : null}
        </div>
      ) : null}

      {step.kind === "expired" && step.preview ? (
        <div className="pt-10 text-center" data-testid="preview-expired-screen">
          <h1 ref={headingRef} tabIndex={-1} className={h1}>
            This preview has expired
          </h1>
          <p className="mt-3 text-ink-soft">
            This gift came from a store preview, which is no longer available,
            so its pieces can&apos;t be shown.
          </p>
          <p className="mt-3 text-ink-soft" lang="vi">
            Bản xem trước của cửa hàng này đã hết hạn, nên không thể hiển thị
            các món quà nữa.
          </p>
          <PrivacyDetails
            tryOn={!noTryOn}
            token={token}
            expiresAt={session?.expiresAt}
            onDeleted={onDeleted}
          />
        </div>
      ) : null}

      {step.kind === "expired" && !step.preview ? (
        <div className="pt-10 text-center" data-testid="expired-screen">
          <h1 ref={headingRef} tabIndex={-1} className={h1}>
            This link has expired
          </h1>
          <p className="mt-3 text-ink-soft">
            Gift links last 72 hours. Everything connected to it has been
            deleted.
          </p>
        </div>
      ) : null}

      {step.kind === "deleted" ? (
        <div className="pt-10 text-center" data-testid="deleted-screen">
          <h1 ref={headingRef} tabIndex={-1} className={h1}>
            Everything is deleted
          </h1>
          <p className="mt-3 text-ink-soft">
            Your photos, try-ons, estimates and hearts are gone, and this link
            no longer works.
          </p>
        </div>
      ) : null}

      {step.kind === "declined" ? (
        <div className="flex flex-1 flex-col pt-10 text-center">
          <h1 ref={headingRef} tabIndex={-1} className={h1}>
            No problem
          </h1>
          <p className="mt-3 text-ink-soft">
            Nothing was shared and no photo was taken. If you change your mind,
            open the link again while it&apos;s valid.
          </p>
          <button
            type="button"
            onClick={() => setStep({ kind: "consent" })}
            className="mt-8 min-h-12 text-sm text-ink underline underline-offset-4"
          >
            Go back
          </button>
          <PrivacyDetails
            tryOn={!noTryOn}
            token={token}
            expiresAt={session?.expiresAt}
            onDeleted={onDeleted}
          />
        </div>
      ) : null}

      {/* The intro renders on the server (initial "loading" state) and stays the same DOM node into the
          consent step, so the LCP text paints without waiting for the session request. */}
      {step.kind === "loading" || step.kind === "consent" ? (
        <div
          className="flex flex-1 flex-col pt-4"
          data-testid={
            step.kind === "consent" ? "consent-screen" : "recipient-loading"
          }
          aria-busy={step.kind === "loading" ? true : undefined}
        >
          <p className="min-h-4 text-xs font-semibold uppercase tracking-[0.24em] text-gold-deep">
            {noTryOn
              ? occasion
                ? `A private gift · ${occasion}`
                : "A private gift"
              : occasion
                ? `A private try-on · ${occasion}`
                : "A private try-on"}
          </p>
          <h1 ref={headingRef} tabIndex={-1} className={`${h1} mt-3`}>
            Someone who cares about you is choosing a gift.
          </h1>
          {noTryOn ? (
            <p className="mt-4 text-base leading-7 text-ink-soft">
              Look through {items.length || 6} pieces and heart the ones you
              love.{" "}
              <strong className="font-semibold text-ink">
                No photo is needed.
              </strong>
            </p>
          ) : (
            <>
              <p className="mt-4 text-base leading-7 text-ink-soft">
                {mixed
                  ? `Try on ${triable.length} of ${items.length} pieces and heart the ones you love.`
                  : `Try on ${items.length || 6} pieces and heart the ones you love.`}{" "}
                <strong className="font-semibold text-ink">
                  They will never see your photos.
                </strong>
              </p>
              <p
                className="mt-2 text-sm leading-6 text-ink-soft"
                data-testid="photo-retention"
              >
                {PHOTO_RETENTION}
              </p>
            </>
          )}
          {step.kind === "loading" ? (
            <div
              className="mt-6 space-y-3"
              aria-label="Opening your private link"
            >
              <div className="gf-shimmer h-14 rounded-xl" />
              <div className="gf-shimmer h-14 rounded-xl" />
              <div className="gf-shimmer h-14 rounded-xl" />
            </div>
          ) : (
            <>
              {noTryOn ? (
                <p
                  className="mt-6 rounded-xl border border-gold/60 bg-cream px-3 py-2 text-sm text-ink"
                  data-testid="no-tryon-consent"
                  data-note={tryOnNote}
                >
                  <NoTryOnCopy note={tryOnNote} where="consent" />
                </p>
              ) : null}
              {!noTryOn && mixed ? (
                <p
                  className="mt-6 rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink-soft"
                  data-testid="mixed-tryon-consent"
                >
                  {triable.length} of {items.length} pieces can be tried on.
                  The store&apos;s photos of the others can&apos;t be used for
                  try-on, so you&apos;ll heart those from the photos.
                </p>
              ) : null}
              <ul
                className={`mt-6 space-y-3 text-sm text-ink-soft ${noTryOn ? "hidden" : ""}`}
              >
                <li className="flex gap-3 rounded-xl border border-line bg-white p-3">
                  <span className="font-display text-xl text-gold-deep">1</span>{" "}
                  One selfie
                  {needsHand
                    ? ", plus an optional photo of the back of your hand"
                    : ""}
                  . Takes about a minute.
                </li>
                <li className="flex gap-3 rounded-xl border border-line bg-white p-3">
                  <span className="font-display text-xl text-gold-deep">2</span>{" "}
                  Your photos are deleted as soon as your previews are made.
                </li>
                <li className="flex gap-3 rounded-xl border border-line bg-white p-3">
                  <span className="font-display text-xl text-gold-deep">3</span>{" "}
                  They see fit scores only, and not which pieces you were shown.
                </li>
              </ul>
              <PrivacyDetails
                tryOn={!noTryOn}
                token={token}
                expiresAt={session?.expiresAt}
                onDeleted={onDeleted}
              />
              <ActionBar>
                <button
                  type="button"
                  onClick={accept}
                  disabled={busy}
                  data-testid="consent-accept"
                  className={primary}
                >
                  {busy ? "One moment…" : "I'm in. Let's start"}
                </button>
                <button
                  type="button"
                  onClick={() => setStep({ kind: "declined" })}
                  data-testid="consent-decline"
                  className="mt-1 min-h-11 w-full text-sm text-ink-soft underline underline-offset-4"
                >
                  No thanks
                </button>
                <p className="mt-1 text-center text-[0.7rem] leading-4 text-muted">
                  {noTryOn
                    ? "By starting, you agree that the pieces you heart are shared with the person choosing your gift."
                    : "By starting, you agree that your selfie is used to estimate undertone and face shape and to make AI previews."}
                </p>
              </ActionBar>
            </>
          )}
        </div>
      ) : null}

      {step.kind === "selfie" ? (
        <div className="flex flex-1 flex-col pt-2">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">
            Step 1 of {needsHand ? 3 : 2}
          </p>
          <h1 ref={headingRef} tabIndex={-1} className={`${h1} mt-2`}>
            {step.retake ? "Retake your selfie" : "Take a selfie"}
          </h1>
          <p className="mb-5 mt-1 text-sm text-ink-soft">
            {step.retake === "ears"
              ? "Tuck your hair behind your ears and face the light. Your hearts are kept."
              : step.retake === "wrist"
                ? "A new selfie first, then a hand photo with your whole wrist in the middle and a little forearm showing. Your hearts are kept."
                : needsEars
                  ? "Hair behind your ears, face the light, neck in view."
                  : "Face the light, with your neck in view for necklaces."}
          </p>
          {step.retake && capture ? (
            <button
              type="button"
              onClick={() => setStep({ kind: "tryon" })}
              data-testid="back-to-previews"
              className="mb-4 min-h-11 self-start text-sm text-ink underline decoration-gold underline-offset-4"
            >
              Back to my previews
            </button>
          ) : null}
          <CaptureStep
            key={`selfie-${captureKey}`}
            onPhotoChange={setLocalPhoto}
            mode="selfie"
            needsEars={needsEars}
            error={stepError}
            onConfirm={(blob) => {
              selfieRef.current = blob;
              setLocalPhoto(true);
              setPhotoNote(null);
              setStepError(null);
              if (needsHand) setStep({ kind: "hand" });
              else void runCapture();
            }}
          />
        </div>
      ) : null}

      {step.kind === "hand" ? (
        <div className="flex flex-1 flex-col pt-2">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">
            Step 2 of 3 · optional
          </p>
          <h1 ref={headingRef} tabIndex={-1} className={`${h1} mt-2`}>
            Add your hand?
          </h1>
          <p className="mb-5 mt-1 flex items-start gap-2 text-sm text-ink-soft">
            <HandIcon className="mt-0.5 h-4 w-4 shrink-0" />{" "}
            {handCount === 1 ? "1 piece is" : `${handCount} pieces are`} worn on
            the hand or wrist. A photo of the back of your hand lets you try{" "}
            {handCount === 1 ? "it" : "them"} on too.
          </p>
          <CaptureStep
            key={`hand-${captureKey}`}
            mode="hand"
            onConfirm={(blob) => {
              handRef.current = blob;
              void runCapture();
            }}
            onSkip={() => {
              handRef.current = null;
              void runCapture();
            }}
          />
        </div>
      ) : null}

      {step.kind === "processing" ? (
        <ProcessingStep startedAt={step.startedAt} />
      ) : null}

      {step.kind === "tryon" ? (
        <div
          className="gf-fade-in flex flex-1 flex-col pt-2"
          data-testid="tryon-screen"
        >
          <div className="flex items-end justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">
                {needsHand ? "Step 3 of 3" : "Step 2 of 2"}
              </p>
              <h1 ref={headingRef} tabIndex={-1} className={`${h1} mt-2`}>
                {step.readOnly ? "Your previews" : "Heart the ones you love"}
              </h1>
            </div>
            {step.readOnly ? null : (
              <p
                className="flex shrink-0 items-center gap-1 rounded-full bg-blush px-3 py-1.5 text-sm text-rose"
                aria-label={`${hearted.size} hearted`}
              >
                <HeartIcon filled className="h-4 w-4" /> {hearted.size}
              </p>
            )}
          </div>
          <p
            className="mb-4 mt-1 text-sm text-ink-soft"
            data-testid={noTryOn ? "no-tryon-note" : undefined}
          >
            {noTryOn ? (
              <NoTryOnCopy note={tryOnNote} where="tryon" />
            ) : mixed ? (
              "AI previews are made from your selfie, for you only. Pieces marked \"Not tried on\" show the store's photo."
            ) : (
              "Every image is an AI preview made from your selfie, for you only."
            )}
          </p>
          <TryOnCarousel
            items={items}
            cards={cards}
            onSwatch={chooseSwatch}
            onToggleHeart={toggleHeart}
            onWish={wishMetal}
            readOnly={step.readOnly}
            onRetake={retake}
            demo={isDemo}
          />
          <Disclaimer className="mt-4" />
          {capture && capture.processingSeconds > 0 ? (
            <p className="mt-1 text-xs text-muted">
              {/* The photo is kept up to 1 h for other metals (ADR-036; the photo bar says so) until Done or
                  "Delete my photo now": only claim deletion when it happened. */}
              Previews made in {Math.round(capture.processingSeconds)} s.
              {photoDeleted ? " Your photo is deleted." : ""}
            </p>
          ) : null}
          <PrivacyDetails
            tryOn={!noTryOn}
            token={token}
            hasHandPhoto={capture?.tryons.some(
              (t) =>
                t.status === "ready" &&
                items.find((i) => i.itemId === t.itemId)?.needsHandPhoto,
            )}
            expiresAt={session?.expiresAt}
            onDeleted={onDeleted}
          />
          <ActionBar>
            {stepError ? (
              <p role="alert" className="mb-2 text-sm text-rose">
                {stepError}
              </p>
            ) : null}
            {step.readOnly ? (
              <button
                type="button"
                onClick={() => setStep({ kind: "done", alreadyDone: true })}
                className={primary}
              >
                Back
              </button>
            ) : (
              <button
                type="button"
                onClick={sendHearts}
                disabled={busy}
                data-testid="send-hearts"
                className={primary}
              >
                <HeartIcon filled className="h-4 w-4" />
                {busy
                  ? "Sending…"
                  : hearted.size
                    ? `Send my hearts (${hearted.size})`
                    : "None of these are me"}
              </button>
            )}
          </ActionBar>
        </div>
      ) : null}

      {step.kind === "undertone" ? (
        <div
          className="gf-fade-in flex flex-1 flex-col pt-2"
          data-testid="undertone-screen"
        >
          <h1 ref={headingRef} tabIndex={-1} className={h1}>
            One last check
          </h1>
          <p className="mb-5 mt-1 text-sm text-ink-soft">
            Hearts sent. This estimate only nudges the metal a little; your
            hearts matter most. Correct it if it&apos;s off.
          </p>
          {capture ? (
            <UndertoneEstimateCard
              estimate={capture.undertone.estimate as UndertoneValue}
              confidence={capture.undertone.confidence}
              override={capture.undertone.override as UndertoneValue | null}
              sessionToken={token}
              onChange={async (v) => (await api()).setUndertone(token, v)}
            />
          ) : (
            <p className="rounded-xl border border-line bg-white p-4 text-sm text-ink-soft">
              No estimate this time. Your hearts carry the most weight anyway.
            </p>
          )}
          {capture?.faceShapeLabel ? (
            <p className="mt-3 rounded-xl border border-line bg-white px-4 py-3 text-sm text-ink-soft">
              <span className="text-xs uppercase tracking-[0.14em] text-muted">
                Face shape
              </span>
              <br />
              <strong className="font-semibold text-ink">
                {capture.faceShapeLabel}
              </strong>
            </p>
          ) : null}
          <Disclaimer className="mt-4" />
          <ActionBar>
            {stepError ? (
              <p role="alert" className="mb-2 text-sm text-rose">
                {stepError}
              </p>
            ) : null}
            <button
              type="button"
              onClick={finish}
              disabled={busy}
              data-testid="finish"
              className={primary}
            >
              {busy ? "Finishing…" : "Finish"}
            </button>
          </ActionBar>
        </div>
      ) : null}

      {step.kind === "done" ? (
        <DoneScreen
          token={token}
          noTryOn={noTryOn}
          seconds={heartsSeconds}
          heartCount={step.alreadyDone ? undefined : hearted.size}
          alreadyDone={step.alreadyDone}
          onDeleted={onDeleted}
          onViewPreviews={
            step.alreadyDone && capture
              ? () => setStep({ kind: "tryon", readOnly: true })
              : undefined
          }
        />
      ) : null}
    </div>
  );
}
