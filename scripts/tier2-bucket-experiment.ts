/**
 * Experiment: Tier-2 alle KPIs mit score < 0.55 disambiguieren.
 * Misst pro Bucket: accepted_rate, average_score_of_accepted.
 */
import { readFile, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { embedBatch, formatQuery } from "../src/lib/gemma-embed.ts";

const META_DIR = "/home/christoph.bertsch/0711/0711-STURM/workspaces/haubrich-koch-hildburg-2024/meta";
const ATOMS    = "/home/christoph.bertsch/0711-STURM-polar/src/verticals/elster-v3/data/atoms.json";
const SIDECAR  = "http://localhost:7901/matmul-topk";
const VLLM     = "http://localhost:11435/v1/chat/completions";
const CONC = 24;

async function tier2(kpi: any, top3: any[]) {
  const candStr = top3.map((c: any, i: number) => `  ${String.fromCharCode(65+i)}) ${c.ecode} [${c.anlage}] "${c.drucktext}"`).join("\n");
  const prompt = `Beleg: ${kpi.belegtyp} | KPI: "${kpi.key}" = "${typeof kpi.value === "string" ? kpi.value.slice(0,60) : kpi.value}"
Kandidaten:
${candStr}
  N) NONE
Antworte mit einem Buchstaben (A/B/C/N) + ":" + Begründung in EINER Zeile.`;
  try {
    const r = await fetch(VLLM, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gemma4-mm", messages: [{ role: "user", content: prompt }], max_tokens: 50, temperature: 0 }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const out = (d.choices?.[0]?.message?.content ?? "").trim();
    const m = out.match(/^([ABCN])/);
    if (!m || m[1] === "N") return null;
    const idx = m[1].charCodeAt(0) - 65;
    return top3[idx]?.ecode ?? null;
  } catch { return null; }
}

async function main() {
  const files = readdirSync(META_DIR).filter(f => f.endsWith(".json"));
  const kpis: any[] = [];
  for (const f of files) {
    const meta = JSON.parse(await readFile(join(META_DIR, f), "utf-8"));
    for (const k of meta.classification?.kpis ?? []) {
      kpis.push({ doc: meta.originalFilename, belegtyp: meta.classification?.label, key: String(k.key), value: k.value });
    }
  }
  const atoms = JSON.parse(await readFile(ATOMS, "utf-8"));

  // Embed + match
  const vecs = await embedBatch(kpis.map(k => formatQuery(`${k.belegtyp}: ${k.key}`)));
  const resp = await fetch(SIDECAR, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ queries: vecs.map(v => Array.from(v)), top_k: 3 }) });
  const matchData = await resp.json() as any;

  // Build per-KPI top-3
  const enriched = kpis.map((kpi, i) => ({
    kpi,
    top3: matchData.topk[i].map((t: any) => ({
      ecode: atoms[t.idx].field_name,
      anlage: atoms[t.idx].metadata?.anlage,
      drucktext: atoms[t.idx].value,
      score: t.score,
    })),
  }));

  // Buckets
  const ranges = [
    { name: "0.50-0.55", lo: 0.50, hi: 0.55 },
    { name: "0.45-0.50", lo: 0.45, hi: 0.50 },
    { name: "0.40-0.45", lo: 0.40, hi: 0.45 },
    { name: "0.30-0.40", lo: 0.30, hi: 0.40 },
    { name: "<0.30",     lo: 0.00, hi: 0.30 },
  ];

  console.log("=".repeat(80));
  console.log("TIER-2 EXPERIMENT auf <0.55 Buckets");
  console.log("=".repeat(80));

  for (const r of ranges) {
    const inRange = enriched.filter(e => {
      const s = e.top3[0]?.score ?? 0;
      return s >= r.lo && s < r.hi;
    });
    if (inRange.length === 0) { console.log(`\n${r.name}: (leer)`); continue; }

    const tStart = performance.now();
    let next = 0;
    const results: { accepted: boolean; ecode: string | null }[] = new Array(inRange.length);
    await Promise.all(Array.from({ length: CONC }, async () => {
      while (true) {
        const idx = next++;
        if (idx >= inRange.length) return;
        const pick = await tier2(inRange[idx].kpi, inRange[idx].top3);
        results[idx] = { accepted: pick !== null, ecode: pick };
      }
    }));
    const dt = performance.now() - tStart;

    const accepted = results.filter(r => r.accepted).length;
    const acceptedRate = (accepted / results.length * 100).toFixed(0);
    console.log(`\n${r.name}  ${String(inRange.length).padStart(4)} KPIs · ${dt.toFixed(0)} ms · ${accepted} accepted (${acceptedRate}%)`);

    // Show a few examples
    const samples = inRange.slice(0, 3);
    for (let i = 0; i < samples.length; i++) {
      const e = samples[i];
      const r2 = results[i];
      const sym = r2.accepted ? "✅" : "⊘";
      console.log(`  ${sym} [${e.kpi.belegtyp.slice(0,16).padEnd(16)}] "${e.kpi.key.slice(0,30)}" (${e.top3[0].score.toFixed(2)}) → ${r2.ecode ?? "NONE"}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
