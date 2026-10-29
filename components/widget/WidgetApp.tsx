"use client";
/**
 * The embeddable gift assistant (owner: A6, ADR-046), rendered at /w inside the iframe the script tag
 * (packages/plugin/giftfit.js) adds to a store page.
 *
 *   launcher  the character (CharacterSlot), optionally with a tip bubble ("Gift this?" on a product page,
 *             "your Fit Report is ready" on a later visit)
 *   panel     chat with the Gift Concierge → confirm the brief → Fit Request → e-card + share
 *
 * The frame asks the loader for one of three fixed sizes (launcher | tip | panel) and never learns or
 * posts anything else about the host page beyond the product facts the loader sends. Tokens stay in
 * this frame (localStorage of the GiftFit origin). Opened directly (no parent), it renders the panel
 * as a page, which is handy for development.
 *
 * Voice (A4, P8.3, components/widget/voice): push-to-talk in the chat, spoken replies (OFF until the
 * shopper turns them on or uses the mic; Google Cloud TTS, else the browser's own voice, ADR-059) with
 * the "AI voice" label. The character listens while recording, thinks while transcribing and talks, its
 * mouth following the audio, while a reply is spoken.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CreateFitRequestBody, CreateFitRequestResponse, GiftBrief } from "@/lib/contracts/api";
import type { ConciergePageContext } from "@/lib/concierge/types";
import { detectLanguage, detectLocale, translator, uiLocaleFor, type Locale } from "@/lib/i18n";
import { checkReadyReport, markAnnounced, saveGift, type KeyValueStore, type ReportStatus, type SavedGift } from "@/lib/widget/giver-store";
import { parentMatchesAncestor, type HostMessage, type PdpSummary } from "@/lib/widget/protocol";
import { ApiError, httpGiftApi } from "@/components/gift/api";
import { BriefConfirm, type MatchedProduct } from "./BriefConfirm";
import { CharacterSlot, type CharacterState } from "./CharacterSlot";
import { MarkAvatar } from "./character/MarkAvatar";
import { GiftCardStep } from "./GiftCardStep";
import { useHostBridge } from "./useHostBridge";
import { WidgetAbout } from "./WidgetAbout";
import { WidgetChat } from "./WidgetChat";
import type { MicPhase } from "./voice/MicButton";
import { SpeakingCharacter } from "./voice/SpeakingCharacter";
import { useVoice } from "./voice/useVoice";
import { AiVoiceLabel, VoiceToggle } from "./voice/VoiceControls";

/** One product of a store-URL preview, as the frame needs it (ADR-055). */
export interface WidgetPreviewProduct {
  id: string;
  title: string;
  url: string;
  price: number | null;
  currency: string | null;
  image?: string;
  /** Key-scoped SKU id when the product is giftable through a Fit Request (jewelry with a metal). */
  skuId?: string;
}

/** A ready store-URL preview (data-store="preview:<key>") and its owner's widget settings. */
export interface WidgetPreview {
  key: string;
  domain: string;
  storeName: string;
  /** Some products are jewelry with a metal: the gift flow (hearts only, no try-on) is available. */
  giftable: boolean;
  products: WidgetPreviewProduct[];
  settings: { character: "mark-kun" | "mascot"; accentColor?: string; greeting?: string };
}

export interface WidgetAppProps {
  store: string;
  /** Set for data-store="preview:<key>" (validated on the server: the preview exists and is ready). */
  preview?: WidgetPreview;
  /** A16: the recipient of a gift made here will be offered a try-on (server decision for this browser). */
  tryOn?: boolean;
  /** Exact origin of the store page (validated on the server), or null when opened directly. */
  parentOrigin: string | null;
  /** Store default UI language (`data-lang`). */
  preferredLang?: string;
  /** Store allow-list (`data-langs`). */
  allowedLangs: Locale[];
  /** Origin for shared links (APP_BASE_URL). */
  baseUrl: string;
  facebookAppId?: string;
}

type View = "chat" | "brief" | "card" | "about";
const PDP_TIP_MS = 20_000;

function storage(kind: "localStorage" | "sessionStorage"): KeyValueStore | null {
  try {
    return window[kind];
  } catch {
    return null;
  }
}

async function reportStatus(giverToken: string): Promise<ReportStatus | null> {
  const res = await fetch("/api/fit/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ giverToken }), cache: "no-store" });
  if (!res.ok) return null;
  const j = (await res.json()) as { status?: ReportStatus };
  return j.status ?? null;
}

const norm = (s: string) => s.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
const pathOf = (u: string | undefined) => {
  try {
    return u ? new URL(u).pathname.replace(/\/+$/, "") : "";
  } catch {
    return "";
  }
};

/** Matches a page's product to a preview product: SKU = product id, same product URL path, or same title. */
export function matchPreviewProduct(preview: WidgetPreview, p: PdpSummary): MatchedProduct | null {
  const path = pathOf(p.url);
  const found =
    (p.sku ? preview.products.find((x) => x.id === p.sku) : undefined) ??
    (path ? preview.products.find((x) => pathOf(x.url) === path || path.endsWith(`/p/${encodeURIComponent(x.id)}`)) : undefined) ??
    preview.products.find((x) => norm(x.title) === norm(p.title));
  if (!found) return null;
  return { id: found.skuId ?? found.id, title: found.title, price: found.price ?? 0, currency: found.currency ?? "USD", image: found.image, giftable: Boolean(found.skuId) };
}

async function matchProduct(store: string, p: PdpSummary): Promise<MatchedProduct | null> {
  const q = new URLSearchParams({ store });
  if (p.sku) q.set("sku", p.sku);
  if (p.url) q.set("url", p.url);
  q.set("name", p.title);
  const res = await fetch(`/api/retailer/lookup?${q.toString()}`, { cache: "no-store" });
  if (!res.ok) return null;
  const j = (await res.json()) as { found?: boolean; product?: { id: string; title: string; price: number; currency: string } };
  if (!j.found || !j.product) return null;
  // Catalog image (public product photo) for the chat; the 161-SKU catalog loads only on a match.
  const { getProduct } = await import("@/components/store/catalog");
  return { id: j.product.id, title: j.product.title, price: j.product.price, currency: j.product.currency, image: getProduct(j.product.id)?.image };
}

export function WidgetApp(props: WidgetAppProps) {
  // Defence in depth: where the browser exposes it, the claimed parent must be our direct ancestor
  // (postMessage's targetOrigin and the inbound origin check already make a forged `parent` inert).
  const [verified, setVerified] = useState<boolean | null>(props.parentOrigin === null ? true : null);
  useEffect(() => {
    if (props.parentOrigin) setVerified(parentMatchesAncestor(props.parentOrigin, window.location.ancestorOrigins));
  }, [props.parentOrigin]);
  if (!verified) return null;
  return <Widget {...props} />;
}

function Widget({ store, preview, tryOn, parentOrigin, preferredLang, allowedLangs, baseUrl, facebookAppId }: WidgetAppProps) {
  const accent = preview?.settings.accentColor;
  const standalone = parentOrigin === null;
  const [open, setOpen] = useState(standalone);
  const [view, setView] = useState<View>("chat");
  const [hostLang, setHostLang] = useState<string | undefined>();
  const [navLangs, setNavLangs] = useState<readonly string[]>([]);
  const [textLocale, setTextLocale] = useState<Locale | undefined>();
  /** The conversation's language (any code, ADR-057): the newest message whose language was clear. */
  const [convLang, setConvLang] = useState<string | undefined>();
  const [reducedMotion, setReducedMotion] = useState(false);
  const [character, setCharacter] = useState<{ state: CharacterState; mouth: number }>({ state: "idle", mouth: 0 });
  const [product, setProduct] = useState<PdpSummary | null>(null);
  const [match, setMatch] = useState<MatchedProduct | null>(null);
  const [pdpTip, setPdpTip] = useState(false);
  const [ready, setReady] = useState<SavedGift | null>(null);
  const [brief, setBrief] = useState<{ brief: GiftBrief; titles: string[] } | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | undefined>();
  const [created, setCreated] = useState<{ result: CreateFitRequestResponse; occasion: string } | null>(null);
  const [chatKey, setChatKey] = useState(0);
  const [micPhase, setMicPhase] = useState<MicPhase>("idle");

  const locale = textLocale ?? detectLocale({ hostLang, navigatorLanguages: navLangs, preferred: preferredLang, allowed: allowedLangs });
  const tr = useMemo(() => translator(locale), [locale]);
  const voice = useVoice({ locale, conversationLang: convLang, open });

  useEffect(() => {
    setNavLangs(navigator.languages?.length ? navigator.languages : [navigator.language]);
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    setReducedMotion(Boolean(mq?.matches));
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq?.addEventListener?.("change", onChange);
    return () => mq?.removeEventListener?.("change", onChange);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const onHostMessage = useCallback(
    (msg: HostMessage) => {
      if (msg.type === "open") setOpen(true);
      else if (msg.type === "close") setOpen(false);
      else if (msg.type === "context") {
        setHostLang(msg.page.lang);
        setProduct(msg.product);
        setMatch(null);
        if (!msg.product) return setPdpTip(false);
        (preview ? Promise.resolve(matchPreviewProduct(preview, msg.product)) : matchProduct(store, msg.product))
          .then((m) => {
            setMatch(m);
            setPdpTip(Boolean(m));
          })
          .catch(() => setMatch(null));
      }
    },
    [store, preview],
  );
  const { post } = useHostBridge(parentOrigin, onHostMessage);

  // "Your Fit Report is ready": one lazy check per session (lib/widget/giver-store.ts).
  useEffect(() => {
    let alive = true;
    void checkReadyReport({ local: storage("localStorage"), session: storage("sessionStorage"), now: Date.now() }, reportStatus).then((g) => alive && setReady(g));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!pdpTip) return;
    const t = setTimeout(() => setPdpTip(false), PDP_TIP_MS);
    return () => clearTimeout(t);
  }, [pdpTip]);

  const tip = open ? undefined : ready ? tr("launcher.tipReady") : pdpTip ? tr("launcher.tipPdp") : undefined;
  const frameMode = open ? "panel" : tip ? "tip" : "launcher";
  useEffect(() => {
    post({ type: "resize", mode: frameMode });
  }, [frameMode, post]);

  const openPanel = useCallback(() => {
    setOpen(true);
    setPdpTip(false);
    if (ready) markAnnounced(storage("localStorage"), ready.giverToken, Date.now());
  }, [ready]);

  const closePanel = useCallback(() => {
    if (standalone) return;
    setOpen(false);
    post({ type: "close" });
  }, [post, standalone]);

  useEffect(() => {
    if (!open || standalone) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closePanel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, standalone, closePanel]);

  // Character: the mic and the voice override the chat's own activity.
  const speaking = voice.state.speaking;
  const charState: CharacterState = micPhase === "recording" || micPhase === "starting" ? "listening" : micPhase === "transcribing" ? "thinking" : speaking ? "talking" : character.state;
  // speechSynthesis can't be analysed: leave `mouth` undefined and the character uses its rhythm.
  const charMouth = speaking ? undefined : character.mouth;

  const context: ConciergePageContext | undefined = useMemo(() => {
    if (match) return { product: { ...(match.giftable !== false ? { catalogId: match.id } : {}), title: match.title, price: match.price, currency: match.currency } };
    if (product) return { product: { title: product.title, ...(product.price ? { price: product.price } : {}), ...(product.currency ? { currency: product.currency } : {}) } };
    return undefined;
  }, [match, product]);

  async function create(body: CreateFitRequestBody) {
    setCreating(true);
    setCreateError(undefined);
    try {
      // The recipient page and the Fit Report follow the giver's language: the conversation's, else the UI's.
      const result = await httpGiftApi.createFitRequest({ ...body, giverLang: body.giverLang ?? convLang ?? locale });
      const now = Date.now();
      saveGift(storage("localStorage"), { giverToken: result.giverToken, createdAt: new Date(now).toISOString(), expiresAt: result.expiresAt, occasion: body.occasion }, now);
      setCreated({ result, occasion: body.occasion });
      setView("card");
      post({ type: "sent" });
    } catch (err) {
      setCreateError(tr(err instanceof ApiError && err.status === 429 ? "brief.rateLimited" : "brief.error"));
    } finally {
      setCreating(false);
    }
  }

  function newGift() {
    setCreated(null);
    setBrief(null);
    setView("chat");
    setChatKey((k) => k + 1);
  }

  if (!open) {
    return (
      <div className="fixed inset-0 flex items-end justify-end p-2" data-testid="widget-launcher">
        <CharacterSlot state={character.state} mouth={character.mouth} tip={tip} onActivate={openPanel} reducedMotion={reducedMotion} label={tr("launcher.open")} dismissLabel={tr("tip.dismiss")} forceMascot={preview?.settings.character === "mascot"} />
      </div>
    );
  }

  return (
    <div role="dialog" aria-modal={!standalone} aria-label={tr("panel.title")} className={`flex flex-col overflow-hidden bg-ivory text-ink ${standalone ? "mx-auto h-dvh max-w-md border-x border-line" : "fixed inset-0 rounded-2xl border border-line shadow-2xl"}`} data-testid="widget-panel">
      <header className="flex items-center gap-1.5 border-b border-line bg-white px-3 py-2" style={accent ? { borderTop: `4px solid ${accent}` } : undefined} data-accent={accent}>
        <div className="h-14 w-14 shrink-0 overflow-hidden">
          <MarkAvatar
            mascot={preview?.settings.character === "mascot"}
            reducedMotion={reducedMotion}
            label={tr("panel.title")}
            onActivate={() => setView("chat")}
            fallback={
              <div className="origin-top-left scale-[0.7]">
                <SpeakingCharacter compact analyser={voice.analyser} state={charState} mouth={charMouth} onActivate={() => setView("chat")} reducedMotion={reducedMotion} label={tr("panel.title")} />
              </div>
            }
          />
        </div>
        {/* One line at the usual ~400 px panel: About is an icon (its full name is the accessible name and
            tooltip) and the subtitle is just "by GiftFit", so the title column keeps ~175 px (~150 px at
            375 px). Long titles (de "Geschenkassistent", th) still hyphenate or wrap rather than overflow;
            CJK and Thai titles are one step smaller (their glyphs run larger). */}
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-lg leading-tight hyphens-auto [overflow-wrap:anywhere] [:root:is(:lang(ja),:lang(ko),:lang(zh),:lang(th))_&]:text-base">{preview ? preview.storeName : tr("panel.title")}</h1>
          <div className="flex min-w-0 items-center gap-1.5">
            <p className="min-w-0 truncate text-xs text-muted">{preview ? tr("preview.subtitle", { domain: preview.domain }) : tr("panel.subtitle")}</p>
            {voice.on && <AiVoiceLabel tr={tr} speaking={speaking} engine={voice.state.engine} />}
          </div>
        </div>
        <VoiceToggle tr={tr} on={voice.on} onToggle={voice.toggle} />
        <button
          type="button"
          onClick={() => setView(view === "about" ? "chat" : "about")}
          aria-label={tr("about.open")}
          title={tr("about.open")}
          aria-pressed={view === "about"}
          data-testid="widget-about-open"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-ink hover:bg-ivory focus-visible:outline-2 focus-visible:outline-ink"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 11v5.5" />
            <circle cx="12" cy="7.8" r="0.6" fill="currentColor" />
          </svg>
        </button>
        {!standalone && (
          <button type="button" onClick={closePanel} aria-label={tr("panel.close")} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-2xl leading-none text-ink hover:bg-ivory" data-testid="widget-close">
            ×
          </button>
        )}
      </header>

      {ready && view === "chat" && (
        <a href={`${baseUrl}/g/${encodeURIComponent(ready.giverToken)}`} target="_blank" rel="noopener noreferrer" className="block border-b border-gold/60 bg-cream px-4 py-3 text-sm font-medium text-ink" data-testid="widget-ready">
          {tr("launcher.tipReady")} {tr("report.open")} →
        </a>
      )}

      {/* The chat stays mounted behind the other views so going back keeps the conversation. */}
      <div className={view === "chat" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        <WidgetChat
          key={chatKey}
          locale={locale}
          tr={tr}
          context={context}
          productTitle={match?.title}
          store={preview ? store : undefined}
          greeting={preview?.settings.greeting}
          accent={accent}
          giftable={preview ? preview.giftable : true}
          langHint={convLang || hostLang || navLangs[0] || locale}
          onUserMessage={(text, spokenLang) => {
            // Each clear message moves the UI to its language: one of the ten, else English (ADR-057);
            // unclear ones ("ok", "$150", a product name) leave it where it is. For the mic, the language
            // chirp_3 heard decides when the transcript alone is unclear.
            const l = detectLanguage(text) ?? spokenLang;
            if (!l) return;
            setConvLang(l);
            const ui = uiLocaleFor(l);
            if (allowedLangs.includes(ui)) setTextLocale(ui);
          }}
          onActivity={(state, mouth) => setCharacter({ state, mouth })}
          voice={{ lang: locale, sessionId: voice.sessionId, onMicStart: voice.onMicStart, onMicPhase: setMicPhase, onReply: voice.speak, onSend: voice.cancel }}
          onBrief={(b, titles) => {
            setBrief({ brief: b, titles });
            setCreateError(undefined);
            setView("brief");
          }}
        />
      </div>
      {view === "brief" && brief && (
        <BriefConfirm locale={locale} tr={tr} brief={brief.brief} match={match?.giftable === false ? null : match} previewKey={preview?.key} tryOn={tryOn} suggestionTitles={brief.titles} busy={creating} error={createError} onCreate={(b) => void create(b)} onBack={() => setView("chat")} />
      )}
      {view === "card" && created && <GiftCardStep locale={locale} tr={tr} result={created.result} occasion={created.occasion} baseUrl={baseUrl} facebookAppId={facebookAppId} onNewGift={newGift} />}
      {view === "about" && <WidgetAbout tr={tr} onBack={() => setView(created ? "card" : "chat")} />}
    </div>
  );
}
