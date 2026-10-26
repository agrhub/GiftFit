"use client";
/**
 * Voice measurement panel (owner: A4, P8.3), shown with `?voicebench=1` on /w (or in development):
 * natural-voice download/verify time, ORT session creation time (per model, execution provider), and
 * per-sentence synthesis latency for en and vi, so the real GPU can be measured in a real browser.
 * Results are also printed with console.info / console.table. English only (a tool, not shopper UI).
 */
import { useState } from "react";
import type { Locale } from "@/lib/i18n";
import type { Voice } from "./useVoice";

export const BENCH_SENTENCES: Array<{ lang: Locale; text: string }> = [
  { lang: "en", text: "Here are three ideas she might love." },
  { lang: "en", text: "These minimal gold hoops are light enough for every day, and they sit well within your three hundred dollar budget." },
  { lang: "vi", text: "Đây là ba gợi ý cô ấy có thể thích." },
  { lang: "vi", text: "Đôi khuyên tai vàng tối giản này nhẹ để đeo hằng ngày và vẫn nằm trong ngân sách ba trăm đô la của bạn." },
];

export function benchEnabled(search: string | undefined = typeof location !== "undefined" ? location.search : undefined): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  return new URLSearchParams(search ?? "").get("voicebench") === "1";
}

export function VoiceBench({ voice }: { voice: Voice }) {
  const [rows, setRows] = useState<Array<{ lang: Locale; chars: number; ms: number | null }>>([]);
  const [running, setRunning] = useState(false);
  const r = voice.ready;

  async function run() {
    setRunning(true);
    const out: typeof rows = [];
    for (let round = 0; round < 2; round++)
      for (const s of BENCH_SENTENCES) {
        const ms = await voice.benchLocal(s.text, s.lang).catch(() => null);
        out.push({ lang: s.lang, chars: s.text.length, ms: ms === null ? null : Math.round(ms) });
        setRows([...out]);
      }
    console.table(out);
    setRunning(false);
  }

  return (
    <details className="border-t border-line bg-white px-3 py-2 font-mono text-[11px] text-ink" data-testid="voice-bench">
      <summary className="cursor-pointer">voice bench</summary>
      <p>natural: {voice.natural.available ? voice.natural.status.kind : "unavailable (needs desktop + WebGPU)"}</p>
      {r && (
        <p>
          ep={r.ep} weights={r.weightsMs}ms ({(r.downloaded / 1e6).toFixed(1)} MB from network) sessions={r.sessionMs}ms warmup={r.warmupMs}ms [
          {Object.entries(r.perModelMs)
            .map(([k, v]) => `${k} ${v}`)
            .join(", ")}
          ]
        </p>
      )}
      <button type="button" disabled={running || !r} onClick={() => void run()} className="my-1 rounded border border-line-strong px-2 py-1 disabled:opacity-50">
        run en/vi synthesis ×2
      </button>
      <ul>
        {rows.map((x, i) => (
          <li key={i}>
            local {x.lang} {x.chars} chars: {x.ms ?? "failed"} ms
          </li>
        ))}
        {voice.timings.map((t, i) => (
          <li key={`t${i}`}>
            reply {t.engine} {t.lang} {t.chars} chars: {Math.round(t.ms)} ms
          </li>
        ))}
      </ul>
    </details>
  );
}
