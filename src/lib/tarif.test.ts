/**
 * tarif.test.ts — run: `tsx src/lib/tarif.test.ts`
 *
 * Three gates:
 *  1. §32a-2023 reference points (values confirmed against the :12010 oracle).
 *  2. Structural invariants — zone continuity, splitting identity, Soli model.
 *  3. LIVE oracle: sweep :12010 (berechne_vollstaendige_steuer_v2), feed its
 *     reported zve back into the in-process engine, assert ESt + Soli match.
 *     (Skips gracefully if the MCP is unreachable.)
 *  + microbenchmark of the calculated core.
 */
import {
  SteuerfallEngine,
  tarifEinkommensteuer,
  splittingEinkommensteuer,
  einkommensteuer,
  solidaritaetszuschlag,
  grenzsteuersatz,
  steuerzone,
} from './tarif.ts';

let pass = 0;
let fail = 0;
const fails: string[] = [];
function ok(cond: boolean, label: string) {
  if (cond) { pass++; } else { fail++; fails.push(label); console.error('  ✗', label); }
}
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
function eqCents(actual: number, expected: number, label: string) {
  ok(near(actual, expected, 0.01), `${label}: got ${actual}, want ${expected}`);
}

const engine = new SteuerfallEngine();

// ── Gate 1: §32a-2023 reference points (oracle-confirmed) ───────────────────
console.log('§32a-2023 Grundtarif reference points:');
eqCents(tarifEinkommensteuer(10734), 0, 'zone1 zvE 10734');
eqCents(tarifEinkommensteuer(10908), 0, 'GFB boundary zvE 10908');
eqCents(tarifEinkommensteuer(18734), 1636.52, 'zone3 zvE 18734');
eqCents(tarifEinkommensteuer(38734), 7411.57, 'zone3 zvE 38734');
eqCents(tarifEinkommensteuer(68734), 18895.30, 'zone4 zvE 68734');
eqCents(tarifEinkommensteuer(118734), 39895.30, 'zone4 zvE 118734');
eqCents(tarifEinkommensteuer(318734), 125122.57, 'zone5 zvE 318734');

ok(steuerzone(10000) === 1 && steuerzone(15000) === 2 && steuerzone(40000) === 3 &&
   steuerzone(100000) === 4 && steuerzone(300000) === 5, 'steuerzone classification');

// ── Gate 2: structural invariants ───────────────────────────────────────────
console.log('Structural invariants:');
// Zone continuity — no jump > 1€ across any boundary.
for (const b of [10908, 15999, 62809, 277825]) {
  const lo = tarifEinkommensteuer(b);
  const hi = tarifEinkommensteuer(b + 1);
  ok(hi - lo >= 0 && hi - lo < 1, `continuity at ${b} (Δ=${(hi - lo).toFixed(4)})`);
}
// Monotonic increasing.
let prev = -1, mono = true;
for (let z = 0; z <= 320000; z += 1000) { const e = tarifEinkommensteuer(z); if (e < prev) mono = false; prev = e; }
ok(mono, 'tariff monotonic non-decreasing');

// Splitting identity: 2·Grundtarif(x) == Splitting(2x).
eqCents(splittingEinkommensteuer(77468), 2 * tarifEinkommensteuer(38734), 'splitting identity 2×38734');
eqCents(einkommensteuer(120000, 'zusammen'), 2 * tarifEinkommensteuer(60000), 'splitting identity zvE 120000');

// Soli model (matches :12010 — Freibetrag, not Milderungszone).
eqCents(solidaritaetszuschlag(16722, 'einzel'), 0, 'soli below Freigrenze → 0');
eqCents(solidaritaetszuschlag(18895.30, 'einzel'), 74.38, 'soli single 18895.30');
eqCents(solidaritaetszuschlag(39895.30, 'einzel'), 1229.38, 'soli single 39895.30');
eqCents(solidaritaetszuschlag(125122.57, 'einzel'), 5916.88, 'soli single 125122.57');

// Grenzsteuersatz vs oracle.
ok(near(grenzsteuersatz(18734, 'einzel'), 0.250234673, 1e-3), 'grenz zvE 18734 ≈ 0.2502');
ok(near(grenzsteuersatz(38734, 'einzel'), 0.327270673, 1e-3), 'grenz zvE 38734 ≈ 0.3273');
ok(grenzsteuersatz(68734, 'einzel') === 0.42, 'grenz zvE 68734 == 0.42');
ok(grenzsteuersatz(318734, 'einzel') === 0.45, 'grenz zvE 318734 == 0.45');

// ── Gate 3: live :12010 oracle ──────────────────────────────────────────────
const MCP = process.env.BMF_MCP_URL ?? 'http://192.168.145.10:12010/mcp';
async function callMcp(wage: number): Promise<{ zve: number; est: number; soli: number; grenz: number } | null> {
  const env = {
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'berechne_vollstaendige_steuer_v2', arguments: { parameters: { erklaerungsjahr: 2023, elster_felder: { E0200204: `${wage},00` } } } },
  };
  const res = await fetch(MCP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(env),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.text();
  const m = body.match(/^data:\s*(.+)$/m);
  if (!m) throw new Error('no SSE data frame');
  const d = JSON.parse(JSON.parse(m[1]).result.content[0].text).daten;
  return { zve: d.zve, est: d.einkommensteuer, soli: d.solidaritaetszuschlag, grenz: d.grenzsteuersatz ?? 0 };
}

async function liveGate() {
  console.log(`Live oracle ${MCP}:`);
  let reached = false;
  for (const wage of [12000, 20000, 40000, 70000, 120000, 320000]) {
    let ref: Awaited<ReturnType<typeof callMcp>>;
    try { ref = await callMcp(wage); } catch (e) {
      if (!reached) { console.log('  ⚠ MCP unreachable — skipping live gate:', String(e).slice(0, 80)); return; }
      ok(false, `MCP call wage ${wage}: ${String(e).slice(0, 60)}`); continue;
    }
    reached = true;
    if (!ref) continue;
    const r = engine.berechne({ zve: ref.zve, veranlagungsart: 'einzel', erklaerungsjahr: 2023 });
    eqCents(r.einkommensteuer, ref.est, `live ESt @ zvE ${ref.zve} (wage ${wage})`);
    eqCents(r.solidaritaetszuschlag, ref.soli, `live Soli @ zvE ${ref.zve}`);
    if (ref.grenz > 0) ok(near(r.grenzsteuersatz, ref.grenz, 2e-3), `live Grenz @ zvE ${ref.zve}: ${r.grenzsteuersatz.toFixed(6)} vs ${ref.grenz}`);
  }
}

// ── Benchmark ───────────────────────────────────────────────────────────────
function benchmark() {
  const N = 1_000_000;
  // warm
  for (let i = 0; i < 10000; i++) engine.berechne({ zve: 40000 + (i % 50000) });
  const t0 = process.hrtime.bigint();
  let sink = 0;
  for (let i = 0; i < N; i++) sink += engine.berechne({ zve: 12000 + ((i * 137) % 300000) }).gesamtsteuer;
  const ns = Number(process.hrtime.bigint() - t0);
  const perCall = ns / N;
  console.log(`\nBenchmark: ${N.toLocaleString()} full berechne() in ${(ns / 1e6).toFixed(1)} ms → ${perCall.toFixed(1)} ns/calc (${(1e9 / perCall / 1e6).toFixed(1)}M calc/s), sink=${sink.toFixed(0)}`);
  ok(perCall < 10_000_000, `<10ms per calc (actual ${(perCall / 1e6).toFixed(4)} ms)`);
}

(async () => {
  await liveGate();
  benchmark();
  console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'}: ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.error('Failed:', fails); process.exit(1); }
})();
