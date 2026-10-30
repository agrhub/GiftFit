/**
 * Landing labels (owner: A4, P8.4). Client islands get only the strings they render, picked on the
 * server, so the full widget catalogs (lib/i18n) never ship in the landing's client bundle.
 * Shared module (no "use client"): server components read the key lists, client components the types.
 */
import type { MessageKey } from "@/lib/i18n";

export const CODE_KEYS = [
  "landing.codeOptions",
  "landing.codeLang",
  "landing.codeLangAuto",
  "landing.codeWidget",
  "landing.codeOn",
  "landing.codeOff",
  "landing.codeRun",
  "landing.runLoading",
  "landing.runReady",
  "landing.runOpened",
  "landing.runFailed",
  "landing.runOff",
  "site.copy",
  "site.copied",
] as const satisfies readonly MessageKey[];

export const DOCS_KEYS = [
  "landing.docsTabs",
  "landing.docsHtml",
  "landing.docsAttr",
  "landing.docsMeaning",
  "landing.attrStore",
  "landing.attrLang",
  "landing.attrLangs",
  "landing.attrWidget",
  "landing.attrButton",
  "landing.docsShopify",
  "landing.docsWoo",
  "landing.docsWooNote",
  "landing.docsGtm",
  "site.copy",
  "site.copied",
] as const satisfies readonly MessageKey[];

export const PREVIEW_KEYS = [
  "landing.tryLabel",
  "landing.tryPlaceholder",
  "landing.tryButton",
  "landing.tryBusy",
  "landing.tryHttps",
  "landing.tryInvalid",
  "landing.tryBlocked",
  "landing.tryRateLimited",
  "landing.tryDailyCap",
  "landing.tryNetwork",
  "landing.tryQueued",
  "landing.tryCrawling",
  "landing.tryReady",
  "landing.tryOpen",
  "landing.tryManage",
  "landing.tryOwnerNote",
  "landing.tryCopyOwner",
  "landing.tryRefused",
  "landing.tryFailed",
  "landing.tryRobots",
  "landing.trySiteBlocked",
  "landing.tryPaused",
  "landing.tryUnreachable",
  "landing.tryTimeout",
  "landing.tryMock",
  "site.copied",
] as const satisfies readonly MessageKey[];

export type Labels<K extends readonly MessageKey[]> = Record<K[number], string>;
export type CodeLabels = Labels<typeof CODE_KEYS>;
export type DocsLabels = Labels<typeof DOCS_KEYS>;
export type PreviewLabels = Labels<typeof PREVIEW_KEYS>;

/** Picks `keys` from a translator: `pick(tr, CODE_KEYS)`. */
export function pick<K extends readonly MessageKey[]>(tr: (key: MessageKey) => string, keys: K): Labels<K> {
  return Object.fromEntries(keys.map((k) => [k, tr(k)])) as Labels<K>;
}

/** {name} interpolation (same rule as lib/i18n format, without importing the catalogs). */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}
