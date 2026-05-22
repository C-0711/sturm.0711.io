/**
 * BRIDGE: KPI → eCode für Hildburgs 18 Belege.
 *
 * Pipeline:
 *   1. Sammle alle KPIs aus den meta/*.json der Belege
 *   2. Embedd jeden KPI-Key (mit Belegtyp-Kontext)
 *   3. Top-1 Match gegen den 2219-eCode-Container (BMF-active)
 *   4. Build canonical_layer { ecode: { value, source_kpi, source_doc, score } }
 *   5. Schreib ein Hildburg-Aggregat-File: alle eCodes konsolidiert
 *
 * Liefert: real measurement der durch-die-Pipeline-gehenden eCode-Coverage.
 */
import { readFile, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ExactFp32Index } from "../src/lib/quantum-index.ts";
import { embedBatch, formatQuery, EMBEDDINGGEMMA_DIM } from "../src/lib/gemma-embed.ts";

const META_DIR  = "/home/christoph.bertsch/0711/0711-STURM/workspaces/haubrich-koch-hildburg-2024/meta";
const ATOMS     = "/home/christoph.bertsch/0711-STURM-polar/src/verticals/elster-v3/data/atoms.json";
const EMBEDS    = "/home/christoph.bertsch/0711-STURM-polar/src/verticals/elster-v3/data/embeddings.gemma4.fp32.bin";
const OUTPUT    = "/tmp/hildburg-canonical-layer.json";

interface KPI {
  doc: string;
  belegtyp: string;
  page: number;
  key: string;
  value: any;
  citation?: any;
}
interface Atom {
  field_name: string; // eCode
  value: string;      // Drucktext
  metadata: { anlage: string; vordruckzeile?: string; datentyp?: string; pflicht?: boolean };
}

async function loadIndex() {
  const atoms: Atom[] = JSON.parse(await readFile(ATOMS, "utf-8"));
  const raw = await readFile(EMBEDS);
  const view = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const index = new ExactFp32Index(EMBEDDINGGEMMA_DIM, view, atoms.length);
  return { atoms, index };
}

async function collectKpis(): Promise<KPI[]> {
  const out: KPI[] = [];
  for (const fn of readdirSync(META_DIR)) {
    if (!fn.endsWith(".json")) continue;
    const d = JSON.parse(await readFile(join(META_DIR, fn), "utf-8"));
    if (!d.originalFilename) continue;
    const belegtyp = d.classification?.label ?? "";
    for (const k of d.classification?.kpis ?? []) {
      out.push({
        doc: d.originalFilename,
        belegtyp,
        page: k.citation?.page ?? 0,
        key: k.key ?? "",
        value: k.value,
        citation: k.citation,
      });
    }
  }
  return out;
}

function buildQuery(k: KPI): string {
  // Belegtyp-Kontext + KPI-key + Wert (typed hint) hilft Embedding-Match
  const wert = typeof k.value === "string" ? k.value.slice(0, 40) : String(k.value).slice(0, 40);
  return formatQuery(`[${k.belegtyp}] ${k.key} = ${wert}`);
}

async function main() {
  const t0 = performance.now();
  console.log("Loading PolarQuant container (2219 BMF-active atoms)…");
  const { atoms, index } = await loadIndex();
  console.log(`  ${atoms.length} atoms loaded`);

  console.log("\nCollecting KPIs from Hildburg meta-files…");
  const kpis = await collectKpis();
  console.log(`  ${kpis.length} KPIs across ${new Set(kpis.map(k=>k.doc)).size} docs`);

  console.log("\nEmbedding KPI queries (batch)…");
  const tEmb0 = performance.now();
  const queries = kpis.map(buildQuery);
  const embeddings = await embedBatch(queries, { provider: "ollama" });
  const tEmb = performance.now() - tEmb0;
  console.log(`  ${embeddings.length} vectors @ ${(tEmb/1000).toFixed(1)}s (${(tEmb/kpis.length).toFixed(0)} ms/kpi)`);

  console.log("\nTop-K eCode matching…");
  const matches: Array<{
    kpi: KPI;
    matches: Array<{ ecode: string; anlage: string; drucktext: string; score: number; vordruckzeile?: string }>;
  }> = [];
  const tMatch0 = performance.now();
  for (let i = 0; i < kpis.length; i++) {
    const top = index.rerank(embeddings[i], Array.from({length: atoms.length}, (_,j)=>j), 3);
    matches.push({
      kpi: kpis[i],
      matches: top.map(s => ({
        ecode: atoms[s.idx].field_name,
        anlage: atoms[s.idx].metadata.anlage,
        drucktext: atoms[s.idx].value,
        score: s.score,
        vordruckzeile: atoms[s.idx].metadata.vordruckzeile,
      })),
    });
  }
  const tMatch = performance.now() - tMatch0;
  console.log(`  Matched ${kpis.length} KPIs @ ${tMatch.toFixed(0)} ms total (${(tMatch/kpis.length).toFixed(1)} ms/kpi)`);

  // Confidence buckets
  const HIGH = 0.60, MED = 0.45;
  const high = matches.filter(m => m.matches[0]?.score >= HIGH);
  const med  = matches.filter(m => m.matches[0]?.score >= MED && m.matches[0]?.score < HIGH);
  const low  = matches.filter(m => m.matches[0]?.score < MED);
  console.log(`\n  ✅ High (≥${HIGH}):  ${high.length}  → auto-accept`);
  console.log(`  ⚠️  Med (≥${MED}):   ${med.length}  → Tier-2 LLM-Review`);
  console.log(`  ❌ Low:           ${low.length}  → manual/reject`);

  // Build canonical_layer  (ecode → consolidated value)
  const canonical: Record<string, any> = {};
  for (const m of matches) {
    if (m.matches[0]?.score < HIGH) continue;
    const ec = m.matches[0].ecode;
    if (!canonical[ec]) {
      canonical[ec] = {
        ecode: ec,
        anlage: m.matches[0].anlage,
        drucktext: m.matches[0].drucktext,
        vordruckzeile: m.matches[0].vordruckzeile,
        values: [],
      };
    }
    canonical[ec].values.push({
      value: m.kpi.value,
      source_doc: m.kpi.doc,
      source_belegtyp: m.kpi.belegtyp,
      source_kpi_key: m.kpi.key,
      score: m.matches[0].score,
    });
  }

  const ecodes = Object.keys(canonical);
  console.log(`\n  → canonical_layer: ${ecodes.length} unique eCodes belegt`);
  const byAnlage: Record<string, number> = {};
  for (const ec of ecodes) byAnlage[canonical[ec].anlage] = (byAnlage[canonical[ec].anlage] || 0) + 1;
  console.log("  Pro Anlage:");
  for (const [a, n] of Object.entries(byAnlage).sort((x,y) => y[1]-x[1])) {
    console.log(`    ${a.padEnd(30)} ${n}`);
  }

  // Conflicts: same eCode from multiple docs with different values
  const conflicts = ecodes.filter(ec => {
    const vals = canonical[ec].values;
    if (vals.length < 2) return false;
    const distinct = new Set(vals.map((v:any) => String(v.value).trim()));
    return distinct.size > 1;
  });
  console.log(`\n  ⚔️  Konflikte (eCode mit verschiedenen Werten aus mehreren Belegen): ${conflicts.length}`);
  for (const ec of conflicts.slice(0, 5)) {
    console.log(`    ${ec} [${canonical[ec].anlage}] ${canonical[ec].drucktext.slice(0,40)}`);
    for (const v of canonical[ec].values) {
      console.log(`      = "${String(v.value).slice(0,40)}" from ${v.source_doc.slice(0,45)} (${v.score.toFixed(3)})`);
    }
  }

  const total = performance.now() - t0;
  console.log(`\n⏱  TOTAL Pipeline-Zeit: ${(total/1000).toFixed(2)}s`);
  console.log(`   (Embed: ${(tEmb/1000).toFixed(2)}s, Match: ${(tMatch/1000).toFixed(2)}s, I/O+Other: ${((total-tEmb-tMatch)/1000).toFixed(2)}s)`);

  await writeFile(OUTPUT, JSON.stringify({
    mandant: "haubrich-koch-hildburg-2024",
    veranlagungsjahr: 2024,
    generated_at: new Date().toISOString(),
    pipeline_ms: total,
    stats: {
      kpis_total: kpis.length,
      docs_total: new Set(kpis.map(k=>k.doc)).size,
      ecodes_unique: ecodes.length,
      auto_accepted: high.length,
      needs_review: med.length,
      rejected: low.length,
      conflicts: conflicts.length,
    },
    canonical_layer: canonical,
    full_matches: matches,
  }, null, 2));
  console.log(`\n→ ${OUTPUT} (${ecodes.length} canonical eCodes)`);
}

main().catch(e => { console.error(e); process.exit(1); });
