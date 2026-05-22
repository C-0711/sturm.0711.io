/**
 * BRIDGE STAGE 2: Tier-2 Disambiguation mit vLLM gemma4-mm.
 */
import { readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const INPUT  = "/tmp/hildburg-canonical-layer.json";
const OUTPUT = "/tmp/hildburg-canonical-layer-v2.json";

const VLLM_URL = "http://localhost:11435/v1/chat/completions";
const MODEL = "gemma4-mm";

const HIGH = 0.60;
const MED  = 0.45;
const CONCURRENCY = 12;

async function tier2Decide(kpi: any, candidates: any[]): Promise<{ pick: string | null; reason: string; ms: number }> {
  const candStr = candidates.map((c: any, i: number) => `  ${String.fromCharCode(65+i)}) ${c.ecode} [${c.anlage}] "${c.drucktext}"`).join("\n");
  const userPrompt = `Du bist Tier-2-Disambiguator für ELSTER-eCode-Zuordnung in einer Einkommensteuererklärung.

Beleg-Typ: ${kpi.belegtyp}
KPI-Schlüssel: "${kpi.key}"
KPI-Wert: "${typeof kpi.value === "string" ? kpi.value.slice(0, 80) : kpi.value}"

Tier-1 schlägt diese eCode-Kandidaten vor:
${candStr}
  N) NONE — keiner passt zum KPI

Welcher eCode passt zum KPI? Antworte mit GENAU einem Buchstaben (A, B, C oder N), dann Doppelpunkt + kurze Begründung in einer Zeile.
Beispiel: "A: Sterbegeld matcht eCode E0201205 (Sterbegeld/Kapitalauszahlungen)"
oder: "N: KPI ist Metadaten (Transferticket), kein Steuerfeld"`;

  const t0 = performance.now();
  try {
    const resp = await fetch(VLLM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: userPrompt }],
        max_tokens: 120,
        temperature: 0,
      }),
    });
    const ms = performance.now() - t0;
    if (!resp.ok) return { pick: null, reason: `http ${resp.status}`, ms };
    const data = await resp.json();
    const out = (data.choices?.[0]?.message?.content ?? "").trim();
    const m = out.match(/^([ABCN])\b[:\.\)]?\s*(.*)/);
    if (!m) return { pick: null, reason: `unparseable: ${out.slice(0,80)}`, ms };
    const letter = m[1];
    const reason = m[2].trim();
    if (letter === "N") return { pick: null, reason, ms };
    const idx = letter.charCodeAt(0) - 65;
    return { pick: candidates[idx]?.ecode ?? null, reason, ms };
  } catch (e: any) {
    return { pick: null, reason: `error: ${e.message}`, ms: performance.now() - t0 };
  }
}

async function processBatch<T, R>(items: T[], fn: (t: T) => Promise<R>, concurrency: number, onProgress?: (done: number, total: number) => void): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0, done = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
      done++;
      if (onProgress && done % 25 === 0) onProgress(done, items.length);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const t0 = performance.now();
  const data = JSON.parse(await readFile(INPUT, "utf-8"));
  const full = data.full_matches;

  const med = full.filter((m: any) => {
    const s = m.matches[0]?.score ?? 0;
    return s >= MED && s < HIGH;
  });
  console.log(`Tier-2 Disambiguation: ${med.length} Med-Bucket KPIs (${MED}-${HIGH})`);
  console.log(`Model: ${MODEL} via vLLM @ ${VLLM_URL}`);
  console.log(`Concurrency: ${CONCURRENCY}\n`);

  // Warm-up
  await tier2Decide(med[0].kpi, med[0].matches);
  console.log("Warm-up done. Starting batch…\n");

  const tier2Results = await processBatch(med, async (m: any) => {
    const decision = await tier2Decide(m.kpi, m.matches);
    return { kpi: m.kpi, top: m.matches[0], decision };
  }, CONCURRENCY, (done, total) => {
    const elapsed = (performance.now() - t0) / 1000;
    const eta = (total - done) * (elapsed / done);
    console.log(`  Progress: ${done}/${total} (${elapsed.toFixed(1)}s elapsed, ~${eta.toFixed(1)}s remaining)`);
  });

  const accepted = tier2Results.filter((r: any) => r.decision.pick).length;
  const rejected = tier2Results.length - accepted;
  console.log(`\nTier-2 done: ${tier2Results.length} entschieden, ${accepted} akzeptiert, ${rejected} NONE`);

  // Sample 10 Tier-2 Entscheidungen
  console.log("\nSample Tier-2 Entscheidungen (erste 8):");
  for (const r of tier2Results.slice(0, 8) as any[]) {
    const ec = r.decision.pick ?? "NONE";
    const sym = r.decision.pick ? "✅" : "⊘";
    console.log(`  ${sym} [${r.kpi.belegtyp}] "${r.kpi.key.slice(0,42)}" → ${ec}`);
    console.log(`     ${r.decision.reason.slice(0,100)}`);
  }

  // Build erweiterte canonical_layer (Lookup für Anlage/Drucktext aus full_matches)
  const ecodeMeta: Record<string, any> = {};
  for (const m of full) {
    for (const c of m.matches) {
      if (!ecodeMeta[c.ecode]) ecodeMeta[c.ecode] = { anlage: c.anlage, drucktext: c.drucktext, vordruckzeile: c.vordruckzeile };
    }
  }

  const canonical: Record<string, any> = JSON.parse(JSON.stringify(data.canonical_layer));
  for (const r of tier2Results as any[]) {
    if (!r.decision.pick) continue;
    const ec = r.decision.pick;
    const meta = ecodeMeta[ec] ?? { anlage: "?", drucktext: "?" };
    if (!canonical[ec]) {
      canonical[ec] = {
        ecode: ec,
        anlage: meta.anlage,
        drucktext: meta.drucktext,
        vordruckzeile: meta.vordruckzeile,
        values: [],
      };
    }
    canonical[ec].values.push({
      value: r.kpi.value,
      source_doc: r.kpi.doc,
      source_belegtyp: r.kpi.belegtyp,
      source_kpi_key: r.kpi.key,
      score: r.top?.score ?? 0,
      tier: "tier2",
      tier2_reason: r.decision.reason,
    });
  }

  const ecodes = Object.keys(canonical);
  console.log(`\n📊 canonical_layer nach Tier-2:`);
  console.log(`  Tier-1 alone:        ${data.stats.ecodes_unique} eCodes`);
  console.log(`  Tier-1 + Tier-2:     ${ecodes.length} eCodes`);
  console.log(`  Gewinn durch Tier-2: +${ecodes.length - data.stats.ecodes_unique}`);

  const byAnlage: Record<string, number> = {};
  for (const ec of ecodes) byAnlage[canonical[ec].anlage] = (byAnlage[canonical[ec].anlage] || 0) + 1;
  console.log("\n  Pro Anlage:");
  for (const [a, n] of Object.entries(byAnlage).sort((x, y) => (y[1] as number) - (x[1] as number))) {
    console.log(`    ${a.padEnd(30)} ${n}`);
  }

  const total = performance.now() - t0;
  const avgMs = tier2Results.reduce((s: number, r: any) => s + r.decision.ms, 0) / tier2Results.length;
  console.log(`\n⏱  Tier-2 Wall-Clock: ${(total/1000).toFixed(1)}s | LLM-Avg: ${avgMs.toFixed(0)} ms/call (parallel x${CONCURRENCY})`);

  await writeFile(OUTPUT, JSON.stringify({
    ...data,
    pipeline_ms_v2: total,
    stats_v2: {
      tier1_ecodes: data.stats.ecodes_unique,
      tier2_processed: tier2Results.length,
      tier2_accepted: accepted,
      tier2_none: rejected,
      ecodes_total: ecodes.length,
      llm_model: MODEL,
      avg_ms_per_call: avgMs,
    },
    canonical_layer: canonical,
    tier2_decisions: tier2Results,
  }, null, 2));
  console.log(`\n→ ${OUTPUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
