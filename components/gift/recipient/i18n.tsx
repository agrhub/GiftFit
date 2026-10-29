"use client";
/**
 * The recipient page's locale (owner: A21): chosen on the server (Accept-Language + the giver's language,
 * lib/i18n/recipient recipientLocale), provided once by RecipientFlow, read by every step. English
 * outside a provider, so components rendered alone (tests, the judge demo) keep their English copy.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { Locale } from "@/lib/i18n";
import { recipientTranslator, type RecipientT } from "@/lib/i18n/recipient";
import { ApiError } from "../api";

const EN = recipientTranslator("en");
const RecipientI18n = createContext<RecipientT>(EN);

export function RecipientLocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const t = useMemo(() => (locale === "en" ? EN : recipientTranslator(locale)), [locale]);
  return <RecipientI18n.Provider value={t}>{children}</RecipientI18n.Provider>;
}

export function useRt(): RecipientT {
  return useContext(RecipientI18n);
}

/**
 * A recipient API error in the page's language, from its status and code (the routes answer codes only;
 * components/gift/api friendlyError is the giver pages' English equivalent).
 */
export function recipientErrorMessage(t: RecipientT, err: unknown): string {
  if (!(err instanceof ApiError)) return t("error.generic");
  if (err.routeMissing) return t("error.routeMissing");
  if (err.status === 0) return t("error.network");
  if (err.status === 410 || err.code === "link_expired") return t("error.linkExpired");
  if (err.status === 413 || /_too_large$/.test(err.code)) return t("error.tooLarge");
  if (err.status === 415 || /_must_be_jpeg_or_png$/.test(err.code)) return t("error.photoType");
  if (err.status === 429 || err.code === "rate_limited") return t("error.rateLimited");
  if (err.code === "daily_cap_reached") return t("error.dailyCap");
  if (err.code === "face_angle") return t("error.faceAngle");
  if (err.code === "face_not_found") return t("error.faceNotFound");
  if (err.code === "photo_quality") return t("error.photoQuality");
  if (err.code === "analysis_failed") return t("error.analysisFailed");
  if (err.code === "link_not_valid" || err.code === "missing_token") return t("error.linkInvalid");
  return err.status >= 500 ? t("error.server") : t("error.generic");
}
