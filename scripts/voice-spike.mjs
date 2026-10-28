#!/usr/bin/env node
/**
 * Server-side Supertonic 3 spike (owner: A13, ADR-057). Run against a no-traffic Cloud Run candidate
 * deployed with VOICE_SPIKE=1 and CRON_SECRET set (VOICE_SERVER_SUPERTONIC may stay off: forced requests
 * use the engine anyway). Measures, from this machine:
 *
 *   - the first request's latency (/api/health; on a fresh instance this includes Cloud Run's cold start)
 *   - cold model load: the first forced Supertonic request after a fresh instance (wall time) and the
 *     engine's own load time from /api/voice/metrics
 *   - per-sentence latency for en, vi, ja, es (14 sentences each, 40–160 characters; one sentence per
 *     request, which is how the widget asks for a reply's first sentence): wall time = first-audio
 *     latency, plus the server's queue/synthesis time, audio length and real-time factor; p50/p95
 *   - peak RSS and the engine's numbers from /api/voice/metrics
 *
 * No Google money by default: every TTS request carries `x-voice-engine-force: supertonic` (honoured
 * only with VOICE_SPIKE=1 and the bearer secret). `--with-google` adds ONE normal (unforced) request on
 * the cold instance to confirm Google covers the load; `--burst` adds 4 concurrent unforced requests to
 * see the queue fallback (some go to Google). Text and audio are never printed or saved.
 *
 *   CRON_SECRET=... node scripts/voice-spike.mjs https://candidate---giftfit-xxxx.a.run.app [--with-google] [--burst] [--rounds 2] [--json out.json]
 *
 * Budget (ADR-057, set before measuring): first audio ≤ 2.5 s p50 and ≤ 4 s p95 warm; cold load ≤ 20 s.
 */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SENTENCES = {
  en: [
    "These silver hoops are light enough to wear every day.",
    "She likes simple pieces, so a thin gold chain would suit her well.",
    "This pair comes in a gift box with a handwritten card.",
    "If you are not sure about her size, earrings are the safest choice.",
    "Rose gold looks warm and soft next to most skin tones.",
    "The pendant is small, but the stone catches the light beautifully.",
    "You can return it within thirty days if it does not fit her style.",
    "For an anniversary, a matching pair of rings is a lovely surprise.",
    "Pearls never go out of fashion, and they work with any outfit.",
    "I found three options under two hundred dollars for you to compare.",
    "Would you like me to send her a short link so she can try them on?",
    "Engraving takes two extra days, so order by Friday to be safe.",
    "If she mostly wears silver and prefers small, quiet pieces, I would start with the studs, then the thin hoops, and keep the pendant as a backup.",
    "Your budget covers all three, and each one ships tomorrow in a gift box, so you still have time to add a short personal message before Friday.",
  ],
  vi: [
    "Đôi bông tai bạc này nhẹ, đeo hằng ngày rất thoải mái.",
    "Cô ấy thích kiểu đơn giản, nên một sợi dây chuyền vàng mảnh sẽ hợp.",
    "Món quà này có sẵn hộp đẹp và một tấm thiệp viết tay.",
    "Nếu bạn chưa biết cỡ nhẫn, bông tai là lựa chọn an toàn nhất.",
    "Vàng hồng trông ấm áp và dịu dàng trên hầu hết các tông da.",
    "Mặt dây chuyền nhỏ nhưng viên đá bắt sáng rất lung linh.",
    "Bạn có thể đổi trả trong ba mươi ngày nếu cô ấy không thích.",
    "Cho ngày kỷ niệm, một cặp nhẫn đôi sẽ là bất ngờ dễ thương.",
    "Ngọc trai không bao giờ lỗi mốt và hợp với mọi bộ trang phục.",
    "Mình đã tìm được ba lựa chọn dưới năm triệu đồng để bạn so sánh.",
    "Bạn có muốn gửi cho cô ấy một đường dẫn để thử trước không?",
    "Khắc chữ mất thêm hai ngày, nên hãy đặt trước thứ Sáu nhé.",
    "Nếu cô ấy hay đeo bạc và thích món nhỏ nhắn, mình gợi ý bắt đầu với đôi bông tai nụ, sau đó là khuyên tròn mảnh, còn mặt dây chuyền để dự phòng.",
    "Ngân sách của bạn đủ cho cả ba món, và món nào cũng được giao ngày mai trong hộp quà, nên bạn vẫn kịp thêm một lời nhắn riêng trước thứ Sáu.",
  ],
  ja: [
    "このシルバーのピアスはとても軽いので、毎日の通勤やお出かけにも気軽につけていただけます。",
    "シンプルなデザインがお好きなら、細いゴールドのネックレスがきっと彼女によく似合うと思います。",
    "こちらの商品はすてきなギフトボックスに入っていて、手書きのメッセージカードも付けられます。",
    "指輪のサイズが分からない場合は、サイズを気にしなくてよいピアスがいちばん安心な選択です。",
    "ローズゴールドは温かみのある色合いで、どんな肌の色にもやさしくなじむので人気があります。",
    "小さなペンダントですが、中央の石がきれいに光を反射して、顔まわりを明るく見せてくれます。",
    "もし彼女の好みに合わなかった場合でも、三十日以内であれば返品や交換を受け付けています。",
    "結婚記念日のプレゼントには、おそろいのペアリングがとてもすてきなサプライズになります。",
    "パールは流行に左右されない定番のアクセサリーで、どんな服装にも合わせやすいのが魅力です。",
    "ご予算の二万円以下で比べられる候補を三つ見つけましたので、順番にご紹介させてください。",
    "試着用のリンクを彼女に送って、実際に似合うかどうかを先に確かめてもらうこともできます。",
    "名前の刻印には二日ほど余分にかかりますので、間に合わせるには金曜日までにご注文ください。",
    "彼女がふだんシルバーを身につけていて、控えめで小ぶりなものが好きなら、まず一粒ピアスから見て、次に細いフープ、ペンダントは予備の候補にしておくのがおすすめです。",
    "ご予算で三つとも購入でき、どれも明日ギフトボックスに入れて発送されますので、金曜日までに短いメッセージを添える時間も十分にあります。",
  ],
  es: [
    "Estos aros de plata son tan ligeros que puede llevarlos todos los días.",
    "Le gustan las piezas sencillas, así que una cadena fina de oro le quedaría bien.",
    "El regalo viene en una caja bonita con una tarjeta escrita a mano.",
    "Si no conoces su talla, los pendientes son la opción más segura.",
    "El oro rosa se ve cálido y suave con casi todos los tonos de piel.",
    "El colgante es pequeño, pero la piedra refleja la luz de maravilla.",
    "Puedes devolverlo en treinta días si no le gusta su estilo.",
    "Para un aniversario, unos anillos a juego son una sorpresa preciosa.",
    "Las perlas nunca pasan de moda y combinan con cualquier ropa.",
    "Encontré tres opciones por menos de doscientos euros para comparar.",
    "¿Quieres que le envíe un enlace corto para que se los pruebe?",
    "El grabado tarda dos días más, así que pide antes del viernes.",
    "Si ella suele llevar plata y prefiere piezas pequeñas, yo empezaría por los pendientes de botón, luego los aros finos, y dejaría el colgante de reserva.",
    "Tu presupuesto alcanza para los tres y cada uno sale mañana en caja de regalo, así que aún puedes añadir un mensaje personal antes del viernes.",
  ],
};

const BUDGET = { p50: 2500, p95: 4000, coldLoad: 20_000 };

function args(argv) {
  const o = { base: "", withGoogle: false, burst: false, rounds: 1, json: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--with-google") o.withGoogle = true;
    else if (a === "--burst") o.burst = true;
    else if (a === "--rounds") o.rounds = Math.max(1, Number(argv[++i]) || 1);
    else if (a === "--json") o.json = argv[++i] ?? "";
    else if (!o.base) o.base = a.replace(/\/+$/, "");
  }
  return o;
}

export function pct(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

async function main() {
  const o = args(process.argv.slice(2));
  const secret = process.env.CRON_SECRET?.trim();
  if (!o.base || !/^https?:\/\//.test(o.base)) throw new Error("usage: CRON_SECRET=... node scripts/voice-spike.mjs <baseUrl> [--with-google] [--burst] [--rounds N] [--json file]");
  if (!secret) throw new Error("CRON_SECRET is not set (the candidate's value)");
  const auth = { authorization: `Bearer ${secret}` };

  const metrics = async () => {
    const r = await fetch(`${o.base}/api/voice/metrics`, { headers: auth });
    if (!r.ok) throw new Error(`/api/voice/metrics: HTTP ${r.status} (is CRON_SECRET right?)`);
    return r.json();
  };
  const tts = async (text, lang, force) => {
    const t0 = performance.now();
    const r = await fetch(`${o.base}/api/voice/tts`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-voice-session": randomUUID(), ...(force ? { ...auth, "x-voice-engine-force": force } : {}) },
      body: JSON.stringify({ text, lang }),
    });
    const bytes = (await r.arrayBuffer()).byteLength;
    const h = (k) => (r.headers.get(k) === null ? null : Number(r.headers.get(k)));
    return { status: r.status, engine: r.headers.get("x-voice-engine"), wallMs: Math.round(performance.now() - t0), queueMs: h("x-voice-queue-ms"), synthMs: h("x-voice-synth-ms"), audioMs: h("x-voice-audio-ms"), bytes, chars: [...text].length };
  };

  const out = { base: o.base, at: new Date().toISOString() };
  let t0 = performance.now();
  const health = await fetch(`${o.base}/api/health`);
  out.firstRequestMs = Math.round(performance.now() - t0);
  out.healthStatus = health.status;
  const before = await metrics();
  out.before = { rssMb: before.process.rssMb, uptimeS: before.process.uptimeS, engineState: before.supertonic.engine.state, enabled: before.supertonic.enabled, spike: before.supertonic.spike };
  console.log(`first request ${out.firstRequestMs} ms (uptime ${before.process.uptimeS} s, rss ${before.process.rssMb} MB, engine ${before.supertonic.engine.state})`);
  if (!before.supertonic.spike) throw new Error("the service does not have VOICE_SPIKE=1");
  if (before.supertonic.engine.state !== "idle") console.warn("warning: the engine is already loaded; this is not a cold measurement (deploy a fresh revision for one)");

  if (o.withGoogle) {
    const g = await tts(SENTENCES.en[0], "en", null);
    out.coldUnforced = { engine: g.engine, wallMs: g.wallMs, status: g.status };
    console.log(`cold, unforced: ${g.engine} in ${g.wallMs} ms (should be google while the model loads)`);
  }

  t0 = performance.now();
  const cold = await tts(SENTENCES.en[1], "en", "supertonic");
  out.cold = { ...cold, wallIncludingLoadMs: Math.round(performance.now() - t0) };
  const afterLoad = await metrics();
  out.coldLoadMs = afterLoad.supertonic.engine.loadMs;
  console.log(`cold model load ${out.coldLoadMs} ms (engine); first forced reply ${cold.wallMs} ms wall, status ${cold.status}, engine ${cold.engine}`);
  if (cold.status !== 200) throw new Error(`forced Supertonic failed (HTTP ${cold.status}); engine state ${afterLoad.supertonic.engine.state}, code ${afterLoad.supertonic.engine.lastErrorCode}`);

  out.langs = {};
  for (const [lang, list] of Object.entries(SENTENCES)) {
    const rows = [];
    for (let r = 0; r < o.rounds; r++) for (const s of list) rows.push(await tts(s, lang, "supertonic"));
    const ok = rows.filter((x) => x.status === 200 && x.engine === "supertonic-server");
    const wall = ok.map((x) => x.wallMs);
    const synth = ok.map((x) => x.synthMs ?? 0);
    const rtf = ok.filter((x) => x.audioMs).map((x) => (x.synthMs ?? 0) / x.audioMs);
    out.langs[lang] = {
      n: rows.length,
      ok: ok.length,
      wallMs: { p50: pct(wall, 50), p95: pct(wall, 95), max: pct(wall, 100) },
      synthMs: { p50: pct(synth, 50), p95: pct(synth, 95) },
      rtf: { p50: pct(rtf, 50), p95: pct(rtf, 95) },
      audioMs: { p50: pct(ok.map((x) => x.audioMs ?? 0), 50) },
      chars: { min: Math.min(...rows.map((x) => x.chars)), max: Math.max(...rows.map((x) => x.chars)) },
      bytes: { p50: pct(ok.map((x) => x.bytes), 50) },
    };
    const L = out.langs[lang];
    console.log(`${lang}: ${L.ok}/${L.n} ok; first-audio p50 ${L.wallMs.p50} ms, p95 ${L.wallMs.p95} ms; synth p50 ${L.synthMs.p50} ms; RTF p50 ${L.rtf.p50?.toFixed(2)}; audio p50 ${L.audioMs.p50} ms`);
  }

  if (o.burst) {
    const burst = await Promise.all([0, 1, 2, 3].map((i) => tts(SENTENCES.en[2 + i], "en", null)));
    out.burst = burst.map((b) => ({ engine: b.engine, wallMs: b.wallMs, status: b.status }));
    console.log(`burst of 4 unforced: ${out.burst.map((b) => `${b.engine} ${b.wallMs} ms`).join(", ")}`);
  }

  const end = await metrics();
  out.after = { rssMb: end.process.rssMb, peakRssMb: end.process.peakRssMb, engine: end.supertonic.engine };
  const allWall = Object.values(out.langs).flatMap((l) => [l.wallMs.p50, l.wallMs.p95]);
  const warmP50 = Math.max(...Object.values(out.langs).map((l) => l.wallMs.p50 ?? Infinity));
  const warmP95 = Math.max(...Object.values(out.langs).map((l) => l.wallMs.p95 ?? Infinity));
  out.verdict = {
    worstLangP50Ms: warmP50,
    worstLangP95Ms: warmP95,
    coldLoadMs: out.coldLoadMs,
    pass: warmP50 <= BUDGET.p50 && warmP95 <= BUDGET.p95 && (out.coldLoadMs ?? Infinity) <= BUDGET.coldLoad && allWall.every((v) => v !== null),
    budget: BUDGET,
  };
  console.log(`peak RSS ${out.after.peakRssMb} MB (now ${out.after.rssMb} MB); threads ${end.supertonic.engine.threads}, steps ${end.supertonic.engine.steps}`);
  console.log(`verdict: ${out.verdict.pass ? "PASS" : "FAIL"} (worst p50 ${warmP50} ms ≤ ${BUDGET.p50}, worst p95 ${warmP95} ms ≤ ${BUDGET.p95}, cold load ${out.coldLoadMs} ms ≤ ${BUDGET.coldLoad})`);
  if (o.json) await writeFile(o.json, JSON.stringify(out, null, 2) + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[voice-spike] ${err.message}`);
    process.exit(1);
  });
}
