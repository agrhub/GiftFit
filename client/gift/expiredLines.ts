"use client";
/**
 * The second-language line on the "this preview has expired" states of the recipient page and the
 * giver's report (owner: A17, ADR-057). The pages are English; this line used to be Vietnamese only.
 * It now follows the visitor's browser language when that is one of the ten widget languages (other
 * than English), and stays Vietnamese otherwise. ja, ko, zh, th, id, es, fr and de are machine-translated,
 * not yet reviewed by native speakers.
 */
import { useEffect, useState } from "react";
import { normalizeLocale, type Locale } from "@/server/i18n";

type SecondLocale = Exclude<Locale, "en">;

interface ExpiredLines {
  /** Recipient page: the store preview is gone, so the pieces can't be shown. */
  recipient: string;
  /** Giver report: lead sentence, then "saved before it expired" or "can't be scored any more". */
  reportLead: string;
  reportSaved: string;
  reportGone: string;
}

const LINES: Record<SecondLocale, ExpiredLines> = {
  vi: {
    recipient: "Bản xem trước của cửa hàng này đã hết hạn, nên không thể hiển thị các món quà nữa.",
    reportLead: "Bản xem trước của cửa hàng này đã hết hạn.",
    reportSaved: "Báo cáo bên dưới đã được lưu trước khi hết hạn.",
    reportGone: "Không thể chấm điểm các món này nữa.",
  },
  ja: {
    recipient: "このストアのプレビューは期限切れのため、ギフトのアイテムを表示できません。",
    reportLead: "このストアのプレビューは期限切れです。",
    reportSaved: "下のレポートは期限切れになる前に保存されたものです。",
    reportGone: "これらのアイテムはもう採点できません。",
  },
  ko: {
    recipient: "이 매장 미리보기가 만료되어 선물 제품을 더 이상 표시할 수 없어요.",
    reportLead: "이 매장 미리보기가 만료되었어요.",
    reportSaved: "아래 보고서는 만료 전에 저장되었어요.",
    reportGone: "이 제품들은 더 이상 점수를 매길 수 없어요.",
  },
  zh: {
    recipient: "该店铺预览已过期，因此无法再显示这些礼物。",
    reportLead: "该店铺预览已过期。",
    reportSaved: "下面的报告已在过期前保存。",
    reportGone: "这些饰品无法再评分。",
  },
  th: {
    recipient: "ตัวอย่างร้านนี้หมดอายุแล้ว จึงไม่สามารถแสดงของขวัญได้อีก",
    reportLead: "ตัวอย่างร้านนี้หมดอายุแล้ว",
    reportSaved: "รายงานด้านล่างถูกบันทึกไว้ก่อนหมดอายุ",
    reportGone: "ไม่สามารถให้คะแนนชิ้นเหล่านี้ได้อีก",
  },
  id: {
    recipient: "Pratinjau toko ini sudah kedaluwarsa, jadi perhiasannya tidak dapat ditampilkan lagi.",
    reportLead: "Pratinjau toko ini sudah kedaluwarsa.",
    reportSaved: "Laporan di bawah disimpan sebelum kedaluwarsa.",
    reportGone: "Perhiasan ini tidak dapat dinilai lagi.",
  },
  es: {
    recipient: "La vista previa de esta tienda ha caducado, así que ya no se pueden mostrar las piezas.",
    reportLead: "La vista previa de esta tienda ha caducado.",
    reportSaved: "El informe de abajo se guardó antes de que caducara.",
    reportGone: "Ya no se pueden puntuar estas piezas.",
  },
  fr: {
    recipient: "L'aperçu de cette boutique a expiré : les pièces ne peuvent plus être affichées.",
    reportLead: "L'aperçu de cette boutique a expiré.",
    reportSaved: "Le rapport ci-dessous a été enregistré avant l'expiration.",
    reportGone: "Ces pièces ne peuvent plus être notées.",
  },
  de: {
    recipient: "Die Vorschau dieses Shops ist abgelaufen, daher können die Stücke nicht mehr angezeigt werden.",
    reportLead: "Die Vorschau dieses Shops ist abgelaufen.",
    reportSaved: "Der Bericht unten wurde vor dem Ablauf gespeichert.",
    reportGone: "Diese Stücke können nicht mehr bewertet werden.",
  },
};

/** The second language for these lines: the first browser language that is one of the ten (not en), else vi. */
export function secondLocale(languages: readonly string[]): SecondLocale {
  for (const tag of languages) {
    const l = normalizeLocale(tag);
    if (l) return l === "en" ? "vi" : l;
  }
  return "vi";
}

export function expiredLines(l: SecondLocale): ExpiredLines {
  return LINES[l];
}

/** Vietnamese on the server and first render; the browser's language after mount. */
export function useExpiredLines(): { lang: SecondLocale; lines: ExpiredLines } {
  const [lang, setLang] = useState<SecondLocale>("vi");
  useEffect(() => {
    setLang(secondLocale(navigator.languages?.length ? navigator.languages : [navigator.language]));
  }, []);
  return { lang, lines: LINES[lang] };
}
