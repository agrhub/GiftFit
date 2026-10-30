"use client";
/**
 * Guided capture (owner: A4): live camera with a guide overlay and on-device checks, or a file
 * upload fallback. Nothing is uploaded here; the parent sends the chosen photo on confirm.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  type CheckResult,
  allOk,
  handChecks,
  selfieChecks,
} from "./captureChecks";
import {
  type Still,
  detectFace,
  fileToStill,
  sampleStats,
  toStill,
} from "./imageTools";
import { fromEnglish } from "@/server/i18n/recipient";
import { AlertIcon, CameraIcon, CheckIcon, UploadIcon } from "../icons";
import { useRt } from "./i18n";

export type CaptureMode = "selfie" | "hand";

export interface CaptureStepProps {
  mode: CaptureMode;
  onConfirm: (photo: Blob) => void;
  /** Hand step only: continue without a hand photo. */
  onSkip?: () => void;
  /** Error from a previous upload attempt, shown above the controls. */
  error?: string | null;
  /** The carousel has earrings: ask for hair behind the ears and show the ear guides. */
  needsEars?: boolean;
  /** Tells the flow whether a photo exists on this step (review), for "Delete my photo now". */
  onPhotoChange?: (hasPhoto: boolean) => void;
}

type Phase = "start" | "live" | "review";

function hasCamera(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function"
  );
}

async function checksFor(
  mode: CaptureMode,
  source: CanvasImageSource,
  w: number,
  h: number,
  needsEars = false,
): Promise<CheckResult[]> {
  const stats = sampleStats(source, w, h);
  if (!stats) return [];
  if (mode === "hand") return handChecks(stats);
  const face = await detectFace(source);
  return selfieChecks({
    stats,
    frame: { width: w, height: h },
    face,
    needsEars,
  });
}

export function CheckList({
  checks,
  live = false,
}: {
  checks: CheckResult[];
  live?: boolean;
}) {
  const t = useRt();
  if (!checks.length) return null;
  // captureChecks.ts speaks English; each label and hint has the same English text in the catalog.
  const local = (text: string) => fromEnglish(t.locale, "check.", text);
  return (
    <ul
      className="space-y-1.5"
      aria-label={live ? t("capture.checksLive") : t("capture.checks")}
      data-testid="capture-checks"
    >
      {checks.map((c) => (
        <li
          key={c.id}
          className="flex items-start gap-2 text-sm"
          data-state={c.state}
        >
          <span
            className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full ${c.state === "ok" ? "bg-sage text-white" : c.state === "warn" ? "bg-gold-deep text-white" : "border border-line-strong text-muted"}`}
          >
            {c.state === "warn" ? (
              <AlertIcon className="h-3.5 w-3.5" />
            ) : (
              <CheckIcon className="h-3 w-3" />
            )}
          </span>
          <span>
            <span className="font-medium text-ink">{local(c.label)}</span>
            {c.state !== "ok" && c.hint ? (
              <span className="text-ink-soft"> · {local(c.hint)}</span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Guide overlay: an oval with shoulders for selfies, a hand outline for the back-of-hand photo. */
function Guide({
  mode,
  good,
  ears = false,
}: {
  mode: CaptureMode;
  good: boolean;
  ears?: boolean;
}) {
  const t = useRt();
  const stroke = good ? "#7fc4a4" : "#ffffff";
  return (
    <svg
      viewBox="0 0 300 400"
      preserveAspectRatio="xMidYMid slice"
      className="pointer-events-none absolute inset-0 h-full w-full"
      aria-hidden="true"
    >
      {mode === "selfie" ? (
        <>
          <defs>
            <mask id="gf-oval-mask">
              <rect width="300" height="400" fill="white" />
              <ellipse cx="150" cy="150" rx="82" ry="108" fill="black" />
            </mask>
          </defs>
          <rect
            width="300"
            height="400"
            fill="rgba(20,16,14,0.42)"
            mask="url(#gf-oval-mask)"
          />
          <ellipse
            cx="150"
            cy="150"
            rx="82"
            ry="108"
            fill="none"
            stroke={stroke}
            strokeWidth="2.5"
            strokeDasharray={good ? "0" : "6 6"}
            style={{ transition: "stroke 300ms" }}
          />
          <path
            d="M60 400c4-58 40-92 90-100 50 8 86 42 90 100"
            fill="none"
            stroke={stroke}
            strokeOpacity="0.7"
            strokeWidth="2"
            strokeDasharray="4 6"
          />
          {ears ? (
            <g fill="none" stroke="#f3d9a4" strokeWidth="2.5">
              {/* Ear guides: earlobes must show for the earring try-on. */}
              <path d="M70 128c-12 0-17 12-15 26s9 30 19 30" />
              <path d="M230 128c12 0 17 12 15 26s-9 30-19 30" />
              <text
                x="44"
                y="204"
                fill="#f3d9a4"
                stroke="none"
                fontSize="11"
                fontFamily="sans-serif"
              >
                {t("capture.guideEar")}
              </text>
              <text
                x="236"
                y="204"
                fill="#f3d9a4"
                stroke="none"
                fontSize="11"
                fontFamily="sans-serif"
              >
                {t("capture.guideEar")}
              </text>
            </g>
          ) : null}
        </>
      ) : (
        // Hand outline scaled so the wrist sits in the centre, with forearm below: the bracelet/watch
        // engine rejects photos cut off at the wrist (code 4, "Wrist position should be in the center.").
        <g
          fill="none"
          stroke={stroke}
          strokeWidth="2.5"
          strokeDasharray={good ? "0" : "6 6"}
          strokeLinejoin="round"
        >
          <path
            transform="translate(150 200) scale(0.7) translate(-146 -335)"
            d="M118 360v-90c-22-20-40-48-44-78-2-14 14-18 22-6l20 30V96c0-14 22-14 22 0v84-104c0-14 22-14 22 0v104-92c0-14 22-14 22 0v100-70c0-14 22-14 22 0v118c0 34-12 58-30 74v50"
            fill="rgba(255,255,255,0.08)"
            strokeWidth={2.5 / 0.7}
          />
          <path d="M130 218 122 400M170 218 180 400" />
          <path
            d="M118 205h64"
            stroke="#f3d9a4"
            strokeDasharray="3 4"
            strokeWidth="2"
          />
          <text
            x="188"
            y="209"
            fill="#f3d9a4"
            stroke="none"
            fontSize="11"
            fontFamily="sans-serif"
          >
            {t("capture.guideWrist")}
          </text>
        </g>
      )}
    </svg>
  );
}

export function CaptureStep({
  mode,
  onConfirm,
  onSkip,
  error,
  needsEars = false,
  onPhotoChange,
}: CaptureStepProps) {
  const t = useRt();
  const [phase, setPhase] = useState<Phase>("start");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [liveChecks, setLiveChecks] = useState<CheckResult[]>([]);
  const [still, setStill] = useState<Still | null>(null);
  const [stillChecks, setStillChecks] = useState<CheckResult[]>([]);
  const [busy, setBusy] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const reviewRef = useRef<HTMLHeadingElement>(null);
  const inputId = useId();
  const [cameraAvailable, setCameraAvailable] = useState(false);

  useEffect(() => setCameraAvailable(hasCamera()), []);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => stopCamera, [stopCamera]);
  useEffect(
    () => () => {
      if (still) URL.revokeObjectURL(still.url);
    },
    [still],
  );

  async function startCamera() {
    setCameraError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: mode === "selfie" ? "user" : "environment",
          width: { ideal: 1280 },
          height: { ideal: 1600 },
        },
        audio: false,
      });
      streamRef.current = stream;
      setPhase("live");
    } catch {
      setCameraError(t("capture.cameraError"));
    }
  }

  // Attach the stream once the <video> exists, and run live checks a few times a second.
  useEffect(() => {
    if (phase !== "live") return;
    const v = videoRef.current;
    if (!v || !streamRef.current) return;
    v.srcObject = streamRef.current;
    void v.play().catch(() => undefined);
    let alive = true;
    let running = false;
    const timer = window.setInterval(async () => {
      if (!alive || running || v.readyState < 2 || !v.videoWidth) return;
      running = true;
      try {
        const checks = await checksFor(
          mode,
          v,
          v.videoWidth,
          v.videoHeight,
          needsEars,
        );
        if (alive) setLiveChecks(checks);
      } finally {
        running = false;
      }
    }, 450);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [phase, mode, needsEars]);

  async function review(s: Still) {
    setStill(s);
    setStillChecks(
      await checksFor(mode, s.canvas, s.frame.width, s.frame.height, needsEars),
    );
    setPhase("review");
    onPhotoChange?.(true);
    requestAnimationFrame(() => reviewRef.current?.focus());
  }

  async function shoot() {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    setBusy(true);
    try {
      const s = await toStill(v, v.videoWidth, v.videoHeight);
      stopCamera();
      await review(s);
    } finally {
      setBusy(false);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    setCameraError(null);
    try {
      stopCamera();
      await review(await fileToStill(file));
    } catch {
      setCameraError(t("capture.readError"));
    } finally {
      setBusy(false);
    }
  }

  function retake() {
    onPhotoChange?.(false);
    if (still) URL.revokeObjectURL(still.url);
    setStill(null);
    setStillChecks([]);
    setPhase("start");
  }

  const isSelfie = mode === "selfie";
  const liveGood =
    liveChecks.length > 0 && liveChecks.every((c) => c.state === "ok");
  const uploadInput = (
    <input
      ref={fileRef}
      id={inputId}
      type="file"
      accept="image/jpeg,image/png,image/heic,image/heif,image/*"
      capture={isSelfie ? "user" : "environment"}
      onChange={onFile}
      data-testid={isSelfie ? "selfie-input" : "hand-input"}
      className="sr-only"
    />
  );

  return (
    <div className="flex flex-1 flex-col">
      {error ? (
        <p
          role="alert"
          className="mb-4 rounded-lg bg-blush px-3 py-2 text-sm text-rose"
        >
          {error}
        </p>
      ) : null}

      {phase === "live" ? (
        <div className="gf-fade-in flex flex-1 flex-col">
          <div
            className="relative overflow-hidden rounded-2xl bg-night-950"
            style={{ aspectRatio: "3 / 4" }}
          >
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              className={`h-full w-full object-cover ${isSelfie ? "-scale-x-100" : ""}`}
              aria-label={
                isSelfie
                  ? t("capture.cameraPreview")
                  : t("capture.cameraPreviewHand")
              }
            />
            <Guide mode={mode} good={liveGood} ears={isSelfie && needsEars} />
            <p className="absolute inset-x-0 top-3 text-center text-xs font-medium text-paper drop-shadow">
              {isSelfie
                ? needsEars
                  ? t("capture.overlayEars")
                  : t("capture.overlay")
                : t("capture.overlayHand")}
            </p>
          </div>
          <div className="mt-4 min-h-24" aria-live="polite">
            <CheckList checks={liveChecks} live />
          </div>
          <div className="mt-auto flex items-center justify-between gap-4 pb-2 pt-4">
            <label
              htmlFor={inputId}
              className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm text-ink-soft underline underline-offset-4"
            >
              {t("capture.uploadInstead")}
            </label>
            {uploadInput}
            <button
              type="button"
              onClick={shoot}
              disabled={busy}
              data-testid="shutter"
              className="grid h-[4.5rem] w-[4.5rem] place-items-center rounded-full border-4 border-ink bg-white shadow-lg transition-transform active:scale-95 disabled:opacity-60"
              aria-label={
                isSelfie ? t("capture.shutterSelfie") : t("capture.shutterHand")
              }
            >
              <span
                className={`block h-12 w-12 rounded-full ${liveGood ? "bg-sage" : "bg-ink"} transition-colors`}
              />
            </button>
            <button
              type="button"
              onClick={() => {
                stopCamera();
                setPhase("start");
              }}
              className="min-h-11 text-sm text-ink-soft underline underline-offset-4"
            >
              {t("capture.cancel")}
            </button>
          </div>
        </div>
      ) : phase === "review" && still ? (
        <div className="gf-fade-in flex flex-1 flex-col">
          <h2
            ref={reviewRef}
            tabIndex={-1}
            className="font-display text-2xl text-ink focus:outline-none"
          >
            {allOk(stillChecks)
              ? t("capture.lookingGood")
              : t("capture.almostThere")}
          </h2>
          <p className="mt-1 text-sm text-ink-soft">
            {t("capture.onlyYou")}
          </p>
          <div
            className="relative mx-auto mt-4 max-w-full overflow-hidden rounded-2xl bg-cream"
            style={{
              aspectRatio: `${still.frame.width} / ${still.frame.height}`,
              height: "42dvh",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- local object URL of the recipient's own photo */}
            <img
              src={still.url}
              alt={isSelfie ? t("capture.altSelfie") : t("capture.altHand")}
              className="h-full w-full object-contain"
            />
          </div>
          <div className="mt-4">
            <CheckList checks={stillChecks} />
          </div>
          {!allOk(stillChecks) ? (
            <p className="mt-3 text-sm text-ink-soft">
              {t("capture.retakeAdvice")}
            </p>
          ) : null}
          <div className="mt-auto grid grid-cols-2 gap-3 pb-2 pt-6">
            <button
              type="button"
              onClick={retake}
              className="min-h-12 rounded-full border border-ink text-sm font-medium text-ink hover:bg-cream"
            >
              {t("capture.retake")}
            </button>
            <button
              type="button"
              onClick={() => onConfirm(still.blob)}
              data-testid={isSelfie ? "use-selfie" : "use-hand"}
              className="min-h-12 gf-cta rounded-full bg-ink text-sm font-medium text-ivory hover:bg-ink-soft"
            >
              {t("capture.use")}
            </button>
          </div>
        </div>
      ) : (
        <div className="gf-fade-in flex flex-1 flex-col">
          <div
            className="relative mx-auto w-full max-w-[16rem] overflow-hidden rounded-2xl border border-line bg-cream"
            style={{ aspectRatio: "3 / 4" }}
          >
            <Guide mode={mode} good={false} ears={isSelfie && needsEars} />
          </div>
          <ul className="mt-6 space-y-2 text-sm text-ink-soft">
            {isSelfie ? (
              <>
                {needsEars ? (
                  <li className="font-medium text-ink" data-testid="ears-tip">
                    {t("capture.tipEars")}
                  </li>
                ) : null}
                <li>{t("capture.tipLight")}</li>
                <li>{t("capture.tipEyeLevel")}</li>
                <li>{t("capture.tipBackground")}</li>
              </>
            ) : (
              <>
                <li>{t("capture.tipHandBack")}</li>
                <li className="font-medium text-ink" data-testid="wrist-tip">
                  {t("capture.tipWrist")}
                </li>
                <li>{t("capture.tipFingers")}</li>
                <li>{t("capture.tipHandLight")}</li>
              </>
            )}
          </ul>
          {cameraError ? (
            <p role="alert" className="mt-4 text-sm text-rose">
              {cameraError}
            </p>
          ) : null}
          <div className="mt-auto space-y-3 pb-2 pt-6">
            {cameraAvailable ? (
              <button
                type="button"
                onClick={startCamera}
                disabled={busy}
                data-testid={isSelfie ? "open-camera" : "open-hand-camera"}
                className="flex min-h-12 w-full items-center justify-center gap-2 gf-cta rounded-full bg-ink text-sm font-medium text-ivory hover:bg-ink-soft"
              >
                <CameraIcon />{" "}
                {isSelfie
                  ? t("capture.openCamera")
                  : t("capture.openHandCamera")}
              </button>
            ) : null}
            <label
              htmlFor={inputId}
              className={`flex min-h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-full text-sm font-medium focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ink ${
                cameraAvailable
                  ? "border border-ink text-ink hover:bg-cream"
                  : "bg-ink text-ivory hover:bg-ink-soft"
              }`}
            >
              <UploadIcon /> {busy ? t("capture.reading") : t("capture.upload")}
              {uploadInput}
            </label>
            {onSkip ? (
              <button
                type="button"
                onClick={onSkip}
                data-testid="skip-hand"
                className="min-h-12 w-full text-sm text-ink-soft underline underline-offset-4 hover:text-ink"
              >
                {t("capture.skipHand")}
              </button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
