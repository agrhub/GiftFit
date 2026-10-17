/**
 * Cold-start survival check (owner: R0, ADR-044). Proves a seeded demo link and its hearts outlive the
 * server process, i.e. state lives in Firestore rather than memory. 0 YouCam units (seeded demo).
 *
 *   node scripts/cold-start-check.mjs seed  <baseUrl> <stateFile>   # seed, open, heart one item
 *   (restart the server, or let Cloud Run scale to zero)
 *   node scripts/cold-start-check.mjs check <baseUrl> <stateFile>   # same link, same heart?
 *
 * Prints status codes, counts and timings only; tokens stay in the state file.
 */
import { readFileSync, writeFileSync } from "node:fs";

const [phase, base, stateFile] = process.argv.slice(2);
if (!["seed", "check"].includes(phase) || !base || !stateFile) {
  console.error("usage: node scripts/cold-start-check.mjs seed|check <baseUrl> <stateFile>");
  process.exit(2);
}

async function call(method, path, { token, body } = {}) {
  const t0 = Date.now();
  const res = await fetch(new URL(path, base), {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, ms: Date.now() - t0, json };
}

const tokenOf = (path) => path.split("/").pop();

if (phase === "seed") {
  const seed = await call("POST", "/api/demo/seed", { body: {} });
  console.log(`seed ${seed.status} ${seed.ms}ms`);
  if (seed.status !== 201) process.exit(1);
  const recipientToken = tokenOf(seed.json.recipientPath);
  const giverToken = tokenOf(seed.json.giverReportPath);
  const session = await call("POST", "/api/recipient/session", { token: recipientToken, body: {} });
  const items = session.json?.items ?? [];
  console.log(`session ${session.status} items=${items.length}`);
  const heartId = items[0]?.itemId;
  const hearts = await call("POST", "/api/recipient/hearts", { token: recipientToken, body: { itemIds: heartId ? [heartId] : [] } });
  console.log(`hearts ${hearts.status} hearted=${hearts.json?.hearted?.length ?? "?"}`);
  writeFileSync(stateFile, JSON.stringify({ recipientToken, giverToken, heartId, items: items.length }));
  process.exit(session.status === 200 && hearts.status === 200 ? 0 : 1);
}

const st = JSON.parse(readFileSync(stateFile, "utf8"));
const health = await call("GET", "/api/health");
console.log(`health ${health.status} ${health.ms}ms (first request after restart) version=${health.json?.version}`);
const session = await call("POST", "/api/recipient/session", { token: st.recipientToken, body: {} });
const items = session.json?.items ?? [];
console.log(`session ${session.status} items=${items.length} (before: ${st.items})`);
const tryons = await call("GET", "/api/recipient/tryons", { token: st.recipientToken });
console.log(`tryons ${tryons.status}`);
// Done, then the giver's report: the heart set before the restart must be in it.
const done = await call("POST", "/api/recipient/done", { token: st.recipientToken, body: {} });
console.log(`done ${done.status}`);
const report = await call("POST", "/api/fit/report", { body: { giverToken: st.giverToken } });
// heartedShortlistIds counts hearts on real picks only (a heart on a decoy is not reported).
console.log(`giver report ${report.status} results=${report.json?.results?.length ?? "?"} heartedShortlistIds=${report.json?.heartedShortlistIds?.length ?? "?"}`);
const ok = session.status === 200 && items.length === st.items && tryons.status === 200 && report.status === 200;
console.log(ok ? "COLD-START CHECK: PASS" : "COLD-START CHECK: FAIL");
process.exit(ok ? 0 : 1);
