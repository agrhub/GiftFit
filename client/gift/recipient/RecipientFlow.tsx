"use client";
/**
 * Recipient flow (owner: A4), mobile-first: consent → selfie → optional hand photo → progress →
 * 6-item carousel with hearts → undertone estimate with override → done. The timer runs from
 * link open to hearts sent (target < 60 s on a real run).
 *
 * Every visible string comes from server/i18n/recipient in `locale` (A21): the page picks it on the server
 * from Accept-Language and the giver's language, and it is corrected here only when navigator.languages
 * disagrees. Product titles stay as the store wrote them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t as widgetT, type Locale } from "@/server/i18n";
import { faceShapeText, metalInline, recipientLocale, recipientTranslator, type RecipientT } from "@/server/i18n/recipient";
import type {
  CaptureResponse,
  CarouselItem,
  RecipientSessionResponse,
} from "@/server/contracts/api";
import { DeleteEverythingButton } from "@/client/trust/DeleteEverythingButton";
import { Disclaimer } from "@/client/trust/Disclaimer";
import { RecipientTransparencyCard } from "@/client/trust/TransparencyCard";
import type { UndertoneValue } from "@/client/trust/UndertoneEstimateCard";
import { ApiError, type GiftApi, loadGiftApi } from "../api";
import { useExpiredLines } from "../expiredLines";
import { setGiftLocale } from "../giftLocale";
import { setGiftStoreName, storeNameFor } from "../giftStore";
import { HandIcon, HeartIcon, ShieldIcon } from "../icons";
import { AiModelBadge } from "./AiModelBadge";
import { RecipientLocaleProvider, recipientErrorMessage } from "./i18n";
import type { RetakeKind } from "./tryOnFailures";
import {
  type CardState,
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
    import("@/client/trust/UndertoneEstimateCard").then(
      (m) => m.UndertoneEstimateCard,
    ),
  { ssr: false },
);

type Step =
  | { kind: "loading" }
  // The message is rendered from `err` in the current locale ("invalid": link not valid / deleted).
  | { kind: "error"; err?: unknown; invalid?: boolean; retry: boolean }
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
  /** The page's locale, decided on the server (default English). */
  locale?: Locale;
  /**
   * The giver's conversation language, for the client-side correction: the browser's language when it is
   * one of the ten, else this (null = none stored). Undefined = keep `locale` as given.
   */
  giverLang?: string | null;
}

const primary =
  "flex min-h-12 w-full items-center justify-center gap-2 gf-cta rounded-full bg-ink px-6 text-sm font-medium text-ivory transition-colors hover:bg-ink-soft disabled:cursor-wait disabled:opacity-70";

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
  t,
}: {
  note?: RecipientSessionResponse["tryOnNote"];
  where: "consent" | "tryon";
  t: RecipientT;
}) {
  if (note === "demo_mode")
    return (
      <>
        {t("noTryOn.demoLead")}{" "}
        {where === "consent"
          ? t("noTryOn.demoConsent")
          : t("noTryOn.demoTryOn")}{" "}
        <a
          href="/demo"
          data-testid="judge-demo-link"
          className="font-medium text-ink underline decoration-gold underline-offset-2"
        >
          {t("noTryOn.demoLink")}
        </a>
      </>
    );
  if (note === "no_eligible")
    return where === "consent"
      ? t("noTryOn.noEligibleConsent")
      : t("noTryOn.noEligibleTryOn");
  return where === "consent"
    ? t("noTryOn.previewConsent")
    : t("noTryOn.previewTryOn");
}

function PrivacyDetails({
  token,
  hasHandPhoto,
  expiresAt,
  onDeleted,
  tryOn = true,
  t,
}: {
  token: string;
  hasHandPhoto?: boolean;
  expiresAt?: string;
  onDeleted: () => void;
  tryOn?: boolean;
  t: RecipientT;
}) {
  return (
    <details className="group mt-8 rounded-2xl border border-line bg-white">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-2 px-4 text-sm font-medium text-ink">
        <span className="flex items-center gap-2">
          <ShieldIcon className="h-4 w-4 shrink-0 text-sage" />{" "}
          {t("privacy.summary")}
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
          locale={t.locale}
          className="border-0 p-0 shadow-none"
        />
        <div data-testid="delete-everything">
          <DeleteEverythingButton
            sessionToken={token}
            onDeleted={onDeleted}
            locale={t.locale}
          />
        </div>
      </div>
    </details>
  );
}

export function RecipientFlow({
  token,
  api: apiProp,
  locale: serverLocale = "en",
  giverLang,
}: RecipientFlowProps) {
  const [locale, setLocale] = useState<Locale>(serverLocale);
  // The server read Accept-Language; navigator.languages is the same list in practice, so this rarely changes.
  useEffect(() => {
    if (giverLang === undefined) return;
    const langs = navigator.languages?.length
      ? navigator.languages
      : [navigator.language];
    setLocale(recipientLocale({ browserLanguages: langs, giverLang }));
  }, [giverLang]);
  useEffect(() => {
    document.documentElement.lang = locale;
    setGiftLocale(locale);
  }, [locale]);
  const t = useMemo(() => recipientTranslator(locale), [locale]);
  const expired = useExpiredLines();
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
  /** "deleted": server photo deleted; "local": deleted from this device before upload. */
  const [photoNote, setPhotoNote] = useState<"deleted" | "local" | null>(null);
  const [deletingPhoto, setDeletingPhoto] = useState(false);
  /** Remounts the capture step (discarding its photo). */
  const [captureKey, setCaptureKey] = useState(0);
  const [busy, setBusy] = useState(false);
  /** The last step's failure (an ApiError or any error), shown in the current locale; null = none. */
  const [stepError, setStepError] = useState<{ err: unknown } | null>(null);
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
      setStep({ kind: "error", invalid: true, retry: false });
    else setStep({ kind: "error", err, retry: true });
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
    setPhotoNote(deleted ? "deleted" : null);
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
    setPhotoNote("deleted");
    setAnnounce(t("photo.deletedNote"));
  }
  // Earring try-ons need visible earlobes (engine error "2", ADR-026).
  const needsEars = triable.some((i) => i.category === "earring");
  /** New selfie after a fixable failure (e.g. hidden earlobes). Hearts live in state and are kept. */
  const retake = (kind: RetakeKind) => {
    setStepError(null);
    setStep({ kind: "selfie", retake: kind });
  };
  const handCount = triable.filter((i) => i.needsHandPhoto).length;
  const occasion = session?.occasion
    ? widgetT(locale, `occasion.${session.occasion}`)
    : null;
  /** "Halo Drop Earrings in rose gold" (the store's title, the metal in the page's language). */
  const named = (title: string, metal?: string) =>
    metal
      ? t("piece.inMetal", { title, metal: metalInline(locale, metal) })
      : title;
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
        t.count(
          "tryon.ready",
          res.tryons.filter((r) => r.status === "ready").length,
        ),
      );
      setStep({ kind: "tryon" });
    } catch (err) {
      if (
        err instanceof ApiError &&
        (err.status === 410 || (err.status === 404 && !err.routeMissing))
      )
        return fail(err);
      setStepError({ err });
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
        t(next.has(key) ? "tryon.hearted" : "tryon.unhearted", {
          name: named(item?.title ?? t("piece.fallback"), metal),
          count: next.size,
        }),
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
        setAnnounce(t("card.capNote"));
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
            t("tryon.metalReady", { name: named(item.title, metal) }),
          );
      }
    } catch (err) {
      setShown((m) => ({ ...m, [itemId]: previous ?? swatchId }));
      setToast(
        err instanceof ApiError && err.status === 410
          ? t("error.linkExpired")
          : t("tryon.metalFailed"),
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
      setToast(t("tryon.wishNoted"));
    } catch {
      setWished((s) => {
        const n = new Set(s);
        n.delete(itemId);
        return n;
      });
      setToast(t("tryon.wishFailed"));
    }
  }

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(timer);
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
      setPhotoNote("local");
      setAnnounce(t("photo.deletedLocal"));
      return;
    }
    setDeletingPhoto(true);
    try {
      await (await api()).deletePhoto(token);
      forgetFaceImages();
    } catch (err) {
      setToast(
        err instanceof ApiError && err.status === 410
          ? t("error.linkExpired")
          : t("photo.deleteFailed"),
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
      setStepError({ err });
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
      setStepError({ err });
    } finally {
      setBusy(false);
    }
  }

  const h1 =
    "font-display text-[2rem] leading-tight text-ink focus:outline-none";
  const stepErrorText = stepError ? recipientErrorMessage(t, stepError.err) : null;

  return (
    <RecipientLocaleProvider locale={locale}>
    <div
      lang={locale}
      className={`flex min-h-[calc(100dvh-4rem)] flex-col ${WRAP[locale] ?? ""}`}
    >
      {isDemo || showPhotoBar ? (
        <div className="sticky top-0 z-30 -mx-4 mb-3 border-b border-line bg-cream/95 px-4 py-2 backdrop-blur">
          {isDemo ? (
            <p
              className="flex items-center gap-2 py-1 text-xs text-ink-soft"
              role="note"
            >
              <AiModelBadge />
              <span>{t("demo.bar")}</span>
            </p>
          ) : null}
          {showPhotoBar ? (
            <div data-testid="photo-bar">
              {photoKept ? (
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs leading-5 text-ink-soft">
                    {capture || step.kind === "processing"
                      ? t("photo.kept")
                      : t("photo.local")}
                  </p>
                  <button
                    type="button"
                    onClick={deletePhotoNow}
                    disabled={deletingPhoto}
                    data-testid="delete-photo-now"
                    className="min-h-11 max-w-[50%] shrink-0 rounded-full border border-rose px-3 py-1 text-xs font-semibold leading-4 text-rose hover:bg-blush disabled:cursor-wait disabled:opacity-70"
                  >
                    {deletingPhoto ? t("photo.deleting") : t("photo.delete")}
                  </button>
                </div>
              ) : (
                <p
                  className="flex min-h-11 items-center text-xs leading-5 text-sage"
                  role="status"
                  data-testid="photo-deleted-note"
                >
                  {photoNote === "local"
                    ? t("photo.deletedLocal")
                    : photoNote
                      ? t("photo.deletedNote")
                      : null}
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
            {t("error.title")}
          </h1>
          <p className="mt-3 text-ink-soft">
            {step.invalid
              ? t("error.linkInvalid")
              : recipientErrorMessage(t, step.err)}
          </p>
          {step.retry ? (
            <button
              type="button"
              onClick={() => void open()}
              className={`${primary} mt-8`}
            >
              {t("error.retry")}
            </button>
          ) : null}
        </div>
      ) : null}

      {step.kind === "expired" && step.preview ? (
        <div className="pt-10 text-center" data-testid="preview-expired-screen">
          <h1 ref={headingRef} tabIndex={-1} className={h1}>
            {t("previewExpired.title")}
          </h1>
          <p className="mt-3 text-ink-soft">{t("previewExpired.body")}</p>
          {/* A17's second-language line (ADR-057) only while the page is English: otherwise the line above
              is already in the reader's language. */}
          {locale === "en" ? (
            <p className="mt-3 text-ink-soft" lang={expired.lang}>
              {expired.lines.recipient}
            </p>
          ) : null}
          <PrivacyDetails
            tryOn={!noTryOn}
            token={token}
            expiresAt={session?.expiresAt}
            onDeleted={onDeleted}
            t={t}
          />
        </div>
      ) : null}

      {step.kind === "expired" && !step.preview ? (
        <div className="pt-10 text-center" data-testid="expired-screen">
          <h1 ref={headingRef} tabIndex={-1} className={h1}>
            {t("expired.title")}
          </h1>
          <p className="mt-3 text-ink-soft">{t("expired.body")}</p>
        </div>
      ) : null}

      {step.kind === "deleted" ? (
        <div className="pt-10 text-center" data-testid="deleted-screen">
          <h1 ref={headingRef} tabIndex={-1} className={h1}>
            {t("deleted.title")}
          </h1>
          <p className="mt-3 text-ink-soft">{t("deleted.body")}</p>
        </div>
      ) : null}

      {step.kind === "declined" ? (
        <div className="flex flex-1 flex-col pt-10 text-center">
          <h1 ref={headingRef} tabIndex={-1} className={h1}>
            {t("declined.title")}
          </h1>
          <p className="mt-3 text-ink-soft">{t("declined.body")}</p>
          <button
            type="button"
            onClick={() => setStep({ kind: "consent" })}
            className="mt-8 min-h-12 text-sm text-ink underline underline-offset-4"
          >
            {t("declined.back")}
          </button>
          <PrivacyDetails
            tryOn={!noTryOn}
            token={token}
            expiresAt={session?.expiresAt}
            onDeleted={onDeleted}
            t={t}
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
                ? t("intro.eyebrowGiftOccasion", { occasion })
                : t("intro.eyebrowGift")
              : occasion
                ? t("intro.eyebrowTryOnOccasion", { occasion })
                : t("intro.eyebrowTryOn")}
          </p>
          <h1 ref={headingRef} tabIndex={-1} className={`${h1} mt-3`}>
            {t("intro.title")}
          </h1>
          {noTryOn ? (
            <p className="mt-4 text-base leading-7 text-ink-soft">
              {t("intro.lookThrough", { count: items.length || 6 })}{" "}
              <strong className="font-semibold text-ink">
                {t("intro.noPhoto")}
              </strong>
            </p>
          ) : (
            <>
              <p className="mt-4 text-base leading-7 text-ink-soft">
                {mixed
                  ? t("intro.tryOnMixed", {
                      triable: triable.length,
                      count: items.length,
                    })
                  : t("intro.tryOn", { count: items.length || 6 })}{" "}
                <strong className="font-semibold text-ink">
                  {t("intro.neverSee")}
                </strong>
              </p>
              <p
                className="mt-2 text-sm leading-6 text-ink-soft"
                data-testid="photo-retention"
              >
                {t("intro.retention")}
              </p>
            </>
          )}
          {step.kind === "loading" ? (
            <div className="mt-6 space-y-3" aria-label={t("intro.opening")}>
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
                  <NoTryOnCopy note={tryOnNote} where="consent" t={t} />
                </p>
              ) : null}
              {!noTryOn && mixed ? (
                <p
                  className="mt-6 rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink-soft"
                  data-testid="mixed-tryon-consent"
                >
                  {t("consent.mixed", {
                    triable: triable.length,
                    count: items.length,
                  })}
                </p>
              ) : null}
              <ul
                className={`mt-6 space-y-3 text-sm text-ink-soft ${noTryOn ? "hidden" : ""}`}
              >
                <li className="flex gap-3 rounded-xl border border-line bg-white p-3">
                  <span className="font-display text-xl text-gold-deep">1</span>{" "}
                  {needsHand ? t("consent.step1Hand") : t("consent.step1")}
                </li>
                <li className="flex gap-3 rounded-xl border border-line bg-white p-3">
                  <span className="font-display text-xl text-gold-deep">2</span>{" "}
                  {t("consent.step2")}
                </li>
                <li className="flex gap-3 rounded-xl border border-line bg-white p-3">
                  <span className="font-display text-xl text-gold-deep">3</span>{" "}
                  {t("consent.step3")}
                </li>
              </ul>
              <PrivacyDetails
                tryOn={!noTryOn}
                token={token}
                expiresAt={session?.expiresAt}
                onDeleted={onDeleted}
                t={t}
              />
              <ActionBar>
                <button
                  type="button"
                  onClick={accept}
                  disabled={busy}
                  data-testid="consent-accept"
                  className={primary}
                >
                  {busy ? t("consent.busy") : t("consent.accept")}
                </button>
                <button
                  type="button"
                  onClick={() => setStep({ kind: "declined" })}
                  data-testid="consent-decline"
                  className="mt-1 min-h-11 w-full text-sm text-ink-soft underline underline-offset-4"
                >
                  {t("consent.decline")}
                </button>
                <p className="mt-1 text-center text-[0.7rem] leading-4 text-muted">
                  {noTryOn ? t("consent.agreeNoTryOn") : t("consent.agree")}
                </p>
              </ActionBar>
            </>
          )}
        </div>
      ) : null}

      {step.kind === "selfie" ? (
        <div className="flex flex-1 flex-col pt-2">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">
            {t("selfie.step", { total: needsHand ? 3 : 2 })}
          </p>
          <h1 ref={headingRef} tabIndex={-1} className={`${h1} mt-2`}>
            {step.retake ? t("selfie.retakeTitle") : t("selfie.title")}
          </h1>
          <p className="mb-5 mt-1 text-sm text-ink-soft">
            {step.retake === "ears"
              ? t("selfie.retakeEars")
              : step.retake === "wrist"
                ? t("selfie.retakeWrist")
                : needsEars
                  ? t("selfie.hintEars")
                  : t("selfie.hint")}
          </p>
          {step.retake && capture ? (
            <button
              type="button"
              onClick={() => setStep({ kind: "tryon" })}
              data-testid="back-to-previews"
              className="mb-4 min-h-11 self-start text-sm text-ink underline decoration-gold underline-offset-4"
            >
              {t("selfie.backToPreviews")}
            </button>
          ) : null}
          <CaptureStep
            key={`selfie-${captureKey}`}
            onPhotoChange={setLocalPhoto}
            mode="selfie"
            needsEars={needsEars}
            error={stepErrorText}
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
            {t("hand.step")}
          </p>
          <h1 ref={headingRef} tabIndex={-1} className={`${h1} mt-2`}>
            {t("hand.title")}
          </h1>
          <p className="mb-5 mt-1 flex items-start gap-2 text-sm text-ink-soft">
            <HandIcon className="mt-0.5 h-4 w-4 shrink-0" />{" "}
            {t.count("hand.body", handCount)}
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
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">
                {needsHand ? t("tryon.step3") : t("tryon.step2")}
              </p>
              <h1 ref={headingRef} tabIndex={-1} className={`${h1} mt-2`}>
                {step.readOnly ? t("tryon.titleReadOnly") : t("tryon.title")}
              </h1>
            </div>
            {step.readOnly ? null : (
              <p
                className="flex shrink-0 items-center gap-1 rounded-full bg-blush px-3 py-1.5 text-sm text-rose"
                aria-label={t("tryon.heartedCount", { count: hearted.size })}
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
              <NoTryOnCopy note={tryOnNote} where="tryon" t={t} />
            ) : mixed ? (
              t("tryon.noteMixed")
            ) : (
              t("tryon.note")
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
          <Disclaimer className="mt-4" locale={locale} />
          {capture && capture.processingSeconds > 0 ? (
            <p className="mt-1 text-xs text-muted">
              {/* The photo is kept up to 1 h for other metals (ADR-036; the photo bar says so) until Done or
                  "Delete my photo now": only claim deletion when it happened. */}
              {t("tryon.madeIn", {
                seconds: Math.round(capture.processingSeconds),
              })}
              {photoDeleted ? ` ${t("tryon.photoDeleted")}` : ""}
            </p>
          ) : null}
          <PrivacyDetails
            tryOn={!noTryOn}
            token={token}
            hasHandPhoto={capture?.tryons.some(
              (r) =>
                r.status === "ready" &&
                items.find((i) => i.itemId === r.itemId)?.needsHandPhoto,
            )}
            expiresAt={session?.expiresAt}
            onDeleted={onDeleted}
            t={t}
          />
          <ActionBar>
            {stepErrorText ? (
              <p role="alert" className="mb-2 text-sm text-rose">
                {stepErrorText}
              </p>
            ) : null}
            {step.readOnly ? (
              <button
                type="button"
                onClick={() => setStep({ kind: "done", alreadyDone: true })}
                className={primary}
              >
                {t("tryon.back")}
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
                  ? t("tryon.sending")
                  : hearted.size
                    ? t("tryon.send", { count: hearted.size })
                    : t("tryon.none")}
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
            {t("undertone.title")}
          </h1>
          <p className="mb-5 mt-1 text-sm text-ink-soft">
            {t("undertone.body")}
          </p>
          {capture ? (
            <UndertoneEstimateCard
              estimate={capture.undertone.estimate as UndertoneValue}
              confidence={capture.undertone.confidence}
              override={capture.undertone.override as UndertoneValue | null}
              sessionToken={token}
              locale={locale}
              onChange={async (v) => (await api()).setUndertone(token, v)}
            />
          ) : (
            <p className="rounded-xl border border-line bg-white p-4 text-sm text-ink-soft">
              {t("undertone.none")}
            </p>
          )}
          {capture?.faceShapeLabel ? (
            <p className="mt-3 rounded-xl border border-line bg-white px-4 py-3 text-sm text-ink-soft">
              <span className="text-xs uppercase tracking-[0.14em] text-muted">
                {t("undertone.faceShape")}
              </span>
              <br />
              <strong className="font-semibold text-ink">
                {faceShapeText(locale, capture.faceShapeLabel)}
              </strong>
            </p>
          ) : null}
          <Disclaimer className="mt-4" locale={locale} />
          <ActionBar>
            {stepErrorText ? (
              <p role="alert" className="mb-2 text-sm text-rose">
                {stepErrorText}
              </p>
            ) : null}
            <button
              type="button"
              onClick={finish}
              disabled={busy}
              data-testid="finish"
              className={primary}
            >
              {busy ? t("undertone.finishing") : t("undertone.finish")}
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
    </RecipientLocaleProvider>
  );
}

/**
 * Line breaking per script: Japanese breaks at phrase boundaries (Chrome; elsewhere the default),
 * Korean keeps words whole, German hyphenates its long compounds (needs the `lang` above). The
 * letter-spaced small caps of the Latin design pull Thai marks and CJK glyphs apart: no tracking there.
 */
const NO_TRACKING = "[&_[class*=tracking-]]:tracking-normal";
const WRAP: Partial<Record<Locale, string>> = {
  ja: `[word-break:auto-phrase] ${NO_TRACKING}`,
  ko: `[word-break:keep-all] ${NO_TRACKING}`,
  zh: NO_TRACKING,
  th: NO_TRACKING,
  de: "hyphens-auto",
};
