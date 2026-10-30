/**
 * Records one real Gift Concierge conversation into fixtures/concierge/<name>.json (owner: A7).
 * Uses ANTHROPIC_API_KEY from .env.local (never printed). Real Claude calls are counted in a local
 * ledger and refused beyond CONCIERGE_RECORD_MAX_CALLS (default 8) across all runs.
 *
 *   npx tsx scripts/concierge-record.ts --name anniversary-en --match "anniversary,wife" --message "…"
 *
 * The fixture keeps only the model's tool calls, its reply text (not text from turns that call a tool)
 * and token usage: no thinking signatures, no request ids, no secrets. Review it before committing.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { loadEnvConfig } from "@next/env";
import { usageCostUsd } from "@/server/anthropic/budget";
import { CONCIERGE_MAX_TOKENS, runConcierge, type ConciergeLlm } from "@/server/concierge/engine";
import type { ConciergeFixture, FixtureBlock } from "@/server/concierge/mock";

loadEnvConfig(process.cwd());

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const name = arg("name");
const message = arg("message");
const match = (arg("match") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (!name || !/^[a-z0-9-]+$/.test(name) || !message) {
  console.error('usage: tsx scripts/concierge-record.ts --name <slug> --match "k1,k2" --message "<user message>"');
  process.exit(2);
}
if (!process.env.ANTHROPIC_API_KEY?.trim()) {
  console.error("ANTHROPIC_API_KEY is not set (.env.local).");
  process.exit(2);
}

const ledgerPath = process.env.CONCIERGE_RECORD_LEDGER ?? path.join(os.tmpdir(), "giftfit-concierge-record-ledger.json");
const maxCalls = Number(process.env.CONCIERGE_RECORD_MAX_CALLS ?? 8);
type Ledger = { calls: number; usage: Array<{ name: string; model: string; usage: Anthropic.Usage }> };
const ledger: Ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : { calls: 0, usage: [] };
const saveLedger = () => writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));

const client = new Anthropic({ maxRetries: 0, timeout: 60_000 });
const recording: ConciergeLlm = {
  stream(params, opts) {
    if (ledger.calls >= maxCalls) throw new Error(`call budget reached (${ledger.calls}/${maxCalls}); refusing a real Claude call`);
    if (params.max_tokens > CONCIERGE_MAX_TOKENS) throw new Error("max_tokens above the cap");
    ledger.calls++;
    saveLedger();
    return client.messages.stream(params, { signal: opts?.signal });
  },
};

/** Sonnet 5.5 list prices (claude-api reference, 2026-10): $2 in, $10 out, cache read 0.1x, write 1.25x. */
const listCost = (u: Anthropic.Usage) => ((u.input_tokens ?? 0) * 2 + (u.cache_creation_input_tokens ?? 0) * 2.5 + (u.cache_read_input_tokens ?? 0) * 0.2 + (u.output_tokens ?? 0) * 10) / 1e6;

async function main() {
  const turns: ConciergeFixture["turns"] = [];
  let model = "";
  const messages = [{ role: "user" as const, content: message! }];
  for await (const ev of runConcierge(messages, {
    llm: recording,
    // Recording: no daily-cap reservation needed (the ledger above caps real calls).
    reserve: async () => ({ ok: true, settle: async () => undefined }),
    onTurn: (m) => {
      model = m.model;
      ledger.usage.push({ name: name!, model: m.model, usage: m.usage });
      saveLedger();
      turns.push({
        // Text in a turn that calls a tool is narration the engine never shows: keep it out of fixtures.
        content: m.content.flatMap((b): FixtureBlock[] =>
          b.type === "text" && !m.content.some((x) => x.type === "tool_use") ? [{ type: "text", text: b.text }] : b.type === "tool_use" ? [{ type: "tool_use", id: b.id, name: b.name, input: b.input }] : [],
        ),
        stop_reason: (m.stop_reason ?? "end_turn") as ConciergeFixture["turns"][number]["stop_reason"],
        usage: {
          input_tokens: m.usage.input_tokens,
          output_tokens: m.usage.output_tokens,
          cache_creation_input_tokens: m.usage.cache_creation_input_tokens,
          cache_read_input_tokens: m.usage.cache_read_input_tokens,
        },
      });
    },
  })) {
    if (ev.type === "text") process.stdout.write(ev.delta);
    else if (ev.type === "tool") console.log(`\n  [tool] ${ev.name}: ${ev.summary}`);
    else if (ev.type === "final") console.log(`\n\n[final] ${JSON.stringify(ev, null, 2)}`);
    else console.log(`\n[${ev.type}]`, JSON.stringify(ev));
  }
  const fixture: ConciergeFixture = { name: name!, recordedAt: new Date().toISOString(), model, match, messages, turns };
  const out = path.join(process.cwd(), "fixtures", "concierge", `${name}.json`);
  if (turns.length > 0) writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`\nturns: ${turns.length}, written: ${turns.length > 0 ? out : "(nothing, no Claude turn)"}`);
  for (const t of turns) console.log("  usage", JSON.stringify(t.usage), `list $${listCost(t.usage as Anthropic.Usage).toFixed(5)}`, `cap-ledger $${usageCostUsd(model, t.usage).toFixed(5)}`);
  const all = ledger.usage.reduce((s, x) => s + listCost(x.usage), 0);
  console.log(`ledger: ${ledger.calls}/${maxCalls} real calls, total list cost $${all.toFixed(5)}`);
}

main().catch((err) => {
  console.error("record failed:", err instanceof Anthropic.APIError ? `${err.status} ${err.message}` : (err as Error).message);
  process.exit(1);
});
