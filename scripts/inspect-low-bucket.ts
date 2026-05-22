/**
 * Inspect which KPIs fall into the LOW bucket (<0.50) and decide if Tier-2 should cover them.
 */
import { readFile, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { embedBatch, formatQuery, EMBEDDINGGEMMA_DIM } from "../src/lib/gemma-embed.ts";

const META_DIR = "/home/christoph.bertsch/0711/0711-STURM/workspaces/haubrich-koch-hildburg-2024/meta";
const ATOMS = "/home/christoph.bertsch/0711-STURM-polar/src/verticals/elster-v3/data/atoms.json";
const SIDECAR = "http://localhost:7901/matmul-topk";

async function main() {
  const files = readdirSync(META_DIR).filter(f => f.endsWith(".json"));
  const kpis: any[] = [];
  for (const f of files) {
    const meta = JSON.parse(await readFile(join(META_DIR, f), "utf-8"));
    const doc = meta.originalFilename ?? meta.uuid;
    const belegtyp = meta.classification?.label ?? "?";
    for (const k of meta.classification?.kpis ?? []) {
      kpis.push({ doc, belegtyp, key: String(k.key), value: k.value });
    }
  }
  const atoms = JSON.parse(await readFile(ATOMS, "utf-8"));

  const queries = kpis.map(k => formatQuery(`${k.belegtyp}: ${k.key}`));
  const vecs = await embedBatch(queries);

  const resp = await fetch(SIDECAR, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ queries: vecs.map(v => Array.from(v)), top_k: 3 }),
  });
  const data = await resp.json() as any;

  // Bucket KPIs by top-score
  const buckets: { name: string; predicate: (s: number) => boolean; items: any[] }[] = [
    { name: ">=0.60 (Tier-1 high)", predicate: s => s >= 0.60, items: [] },
    { name: "0.55-0.60",             predicate: s => s >= 0.55 && s < 0.60, items: [] },
    { name: "0.50-0.55",             predicate: s => s >= 0.50 && s < 0.55, items: [] },
    { name: "0.45-0.50",             predicate: s => s >= 0.45 && s < 0.50, items: [] },
    { name: "0.40-0.45",             predicate: s => s >= 0.40 && s < 0.45, items: [] },
    { name: "0.30-0.40",             predicate: s => s >= 0.30 && s < 0.40, items: [] },
    { name: "<0.30",                 predicate: s => s < 0.30, items: [] },
  ];

  for (let i = 0; i < kpis.length; i++) {
    const top = data.topk[i][0];
    const score = top.score;
    const bucket = buckets.find(b => b.predicate(score));
    if (bucket) bucket.items.push({
      kpi: kpis[i],
      ecode: atoms[top.idx].field_name,
      anlage: atoms[top.idx].metadata?.anlage,
      drucktext: atoms[top.idx].value,
      score,
    });
  }

  console.log("=".repeat(80));
  console.log("BUCKET-VERTEILUNG (601 KPIs aus Hildburg)");
  console.log("=".repeat(80));
  for (const b of buckets) {
    console.log(`  ${b.name.padEnd(25)} ${String(b.items.length).padStart(4)} KPIs`);
  }
  console.log();
  
  // Show samples from the LOW buckets
  for (const b of buckets) {
    if (b.name.startsWith(">=") || b.name.startsWith("0.55") || b.items.length === 0) continue;
    console.log(`\n──── ${b.name} (${b.items.length} KPIs) ────`);
    for (const it of b.items.slice(0, 6)) {
      const v = typeof it.kpi.value === "string" ? it.kpi.value.slice(0, 40) : String(it.kpi.value);
      console.log(`  [${it.kpi.belegtyp.slice(0,18).padEnd(18)}] "${it.kpi.key.slice(0,32).padEnd(32)}" = "${v.padEnd(20)}" → ${it.ecode} ${(it.score).toFixed(3)} | top: "${it.drucktext.slice(0,40)}"`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
