/**
 * Widget settings a preview owner sets in Admin v0 (owner: A6, ADR-055). Pure and browser-safe.
 * Stored in `preview_stores/<key>.settings` (lib/preview/repo.ts PreviewSettings) and applied by the
 * widget for `data-store="preview:<key>"`.
 *
 *   character        "mark-kun" (Live2D, the one fixed model; SVG mascot as its fallback) | "mascot" (SVG only)
 *   languages        allowed UI languages ⊆ en, vi (≥ 1); defaultLanguage ∈ languages
 *   accentColor      #rrggbb whose contrast with white text is ≥ 4.5:1 (WCAG AA for the buttons)
 *   greeting         ≤ 140 chars of plain text (control characters, tags and URLs are refused)
 */
import { LOCALES, type Locale } from "@/lib/i18n";

export const MAX_GREETING = 140;
export const MIN_ACCENT_CONTRAST = 4.5;

export interface WidgetStoreSettings {
  character: "mark-kun" | "mascot";
  languages: Locale[];
  defaultLanguage: Locale;
  accentColor?: string;
  greeting?: string;
}

export const DEFAULT_WIDGET_SETTINGS: WidgetStoreSettings = { character: "mark-kun", languages: [...LOCALES], defaultLanguage: "en" };

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of #rrggbb. */
export function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** Contrast ratio between two #rrggbb colours. */
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

export type SettingsError = "character" | "languages" | "defaultLanguage" | "accentColor" | "accentContrast" | "greeting";

export interface SettingsInput {
  character?: unknown;
  languages?: unknown;
  defaultLanguage?: unknown;
  accentColor?: unknown;
  greeting?: unknown;
}

/** Validates owner input; returns the clean settings or the fields that are wrong. */
export function validateSettings(input: SettingsInput): { ok: true; settings: WidgetStoreSettings } | { ok: false; errors: SettingsError[] } {
  const errors: SettingsError[] = [];
  const character = input.character === undefined || input.character === "" ? "mark-kun" : input.character;
  if (character !== "mark-kun" && character !== "mascot") errors.push("character");

  const rawLangs = Array.isArray(input.languages) ? input.languages : typeof input.languages === "string" ? input.languages.split(/[\s,]+/) : [...LOCALES];
  const languages = [...new Set(rawLangs.filter((l): l is Locale => typeof l === "string" && (LOCALES as readonly string[]).includes(l)))];
  if (!languages.length || languages.length !== new Set(rawLangs.filter(Boolean)).size) errors.push("languages");
  const defaultLanguage = (typeof input.defaultLanguage === "string" && input.defaultLanguage ? input.defaultLanguage : languages[0]) as Locale;
  if (!languages.includes(defaultLanguage)) errors.push("defaultLanguage");

  let accentColor: string | undefined;
  if (typeof input.accentColor === "string" && input.accentColor.trim()) {
    const c = input.accentColor.trim().toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(c)) errors.push("accentColor");
    else if (contrastRatio(c, "#ffffff") < MIN_ACCENT_CONTRAST) errors.push("accentContrast");
    else accentColor = c;
  } else if (input.accentColor !== undefined && input.accentColor !== "" && input.accentColor !== null) errors.push("accentColor");

  let greeting: string | undefined;
  if (typeof input.greeting === "string" && input.greeting.trim()) {
    const g = input.greeting.replace(/\s+/g, " ").trim();
    if (g.length > MAX_GREETING || /[\u0000-\u001f\u007f<>]|https?:\/\/|www\./i.test(g)) errors.push("greeting");
    else greeting = g;
  } else if (input.greeting !== undefined && input.greeting !== "" && input.greeting !== null) errors.push("greeting");

  if (errors.length) return { ok: false, errors };
  return { ok: true, settings: { character: character as WidgetStoreSettings["character"], languages, defaultLanguage, ...(accentColor ? { accentColor } : {}), ...(greeting ? { greeting } : {}) } };
}

/** Settings as stored (untrusted shape) → what the widget applies; anything invalid falls back to defaults. */
export function widgetSettingsFrom(stored: SettingsInput | null | undefined): WidgetStoreSettings {
  if (!stored) return { ...DEFAULT_WIDGET_SETTINGS };
  const pick = <K extends keyof SettingsInput>(k: K): SettingsInput => {
    const v = validateSettings({ [k]: stored[k], ...(k === "defaultLanguage" ? { languages: stored.languages } : {}) });
    return v.ok ? (v.settings as SettingsInput) : {};
  };
  const langs = validateSettings({ languages: stored.languages, defaultLanguage: stored.defaultLanguage });
  return {
    character: (pick("character").character as WidgetStoreSettings["character"]) ?? "mark-kun",
    ...(langs.ok ? { languages: langs.settings.languages, defaultLanguage: langs.settings.defaultLanguage } : { languages: [...LOCALES], defaultLanguage: "en" as Locale }),
    ...(pick("accentColor").accentColor ? { accentColor: pick("accentColor").accentColor as string } : {}),
    ...(pick("greeting").greeting ? { greeting: pick("greeting").greeting as string } : {}),
  };
}
