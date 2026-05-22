import { readFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { embedBatch, formatQuery } from "../src/lib/gemma-embed.ts";

const META_DIR = "/home/christoph.bertsch/0711/0711-STURM/workspaces/haubrich-koch-hildburg-2024/meta";
const ATOMS = "/home/christoph.bertsch/0711-STURM-polar/src/verticals/elster-v3/data/atoms.json";
const SIDE_URL = process.env.MATMUL_URL ?? "http://localhost:7902/matmul-topk";
const HIGH = 0.50;

interface KPI { doc: string; belegtyp: string; key: string; value: any; }
interface MetaDoc {
  originalFilename?: string;
  uuid?: string;
  classification?: { label?: string; kpis?: any[] };
  ocr?: { markdown?: string; ms?: number; charCount?: number };
}

const BUDGET_DOCS = new Set(["elster_est1a", "elster_einkommensteuererkl_2023", "einkommensteuerbescheid", "steuerbescheid_einkommen"]);
const ADMIN_DOCS = new Set(["steuerkontoabfrage", "steuerkonto_stammdaten", "steuerkonto_transferticket", "religionszugehoerigkeit"]);
const DOCCLASS_TO_ANLAGEN: Record<string, string[]> = {
  lohnsteuerbescheinigung: ["N", "AV"],
  rentenbezugsmitteilung: ["R"],
  beitragsbescheinigung_kranken_p: ["VOR"],
  kapitalertragsbescheinigung: ["KAP", "KAP_I"],
  kapitalertragsteuerbeschein: ["KAP", "KAP_I"],
  steuerbescheinigung_kapitalertr: ["KAP", "KAP_I"],
  spendenquittung: ["SA"],
  haushaltsnahe_dienstleistungen: ["HA_35a"],
  zinsbescheinigung_wohndarlehen: ["V", "Zins"],
};

function norm(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

function deriveBudget(metas: MetaDoc[]) {
  const budgetDocs = metas.filter(m => BUDGET_DOCS.has(m.classification?.label ?? ""));
  const supportDocs = metas.filter(m => {
    const l = m.classification?.label ?? "";
    return !BUDGET_DOCS.has(l) && !ADMIN_DOCS.has(l);
  });
  const budgetText = budgetDocs.map(m => m.ocr?.markdown ?? "").join("\n\n");
  const t = norm(budgetText);
  const allowedAnlagen = new Set<string>(["ESt1A"]);
  if (t.includes("anlage sonderausgaben") || t.includes("zuwendungen") || t.includes("kirchensteuer")) allowedAnlagen.add("SA");
  if (t.includes("aussergewohnliche belastungen") || t.includes("außergewöhnliche belastungen")) allowedAnlagen.add("AgB");
  if (t.includes("haushaltsnahe") || t.includes("35a")) allowedAnlagen.add("HA_35a");
  if (t.includes("kapitalertr") || t.includes("abgeltungsteuer")) { allowedAnlagen.add("KAP"); allowedAnlagen.add("KAP_I"); }
  if (t.includes("wohnsitz") || t.includes("dba") || t.includes("ausland")) allowedAnlagen.add("WA_ESt");
  for (const m of supportDocs) {
    const label = m.classification?.label ?? "";
    for (const an of DOCCLASS_TO_ANLAGEN[label] ?? []) allowedAnlagen.add(an);
  }
  const singleAScope = t.includes("verwitwet") || !t.includes("person b");
  return { allowedAnlagen, budgetDocs, supportDocs, singleAScope };
}

function atomAllowed(atom: any, allowedAnlagen: Set<string>, singleAScope: boolean) {
  const anlage = atom?.metadata?.anlage;
  if (!allowedAnlagen.has(anlage)) return false;
  const blob = norm(JSON.stringify(atom));
  if (singleAScope && (blob.includes("person b") || blob.includes("ehefrau") || blob.includes("lebenspartner") && blob.includes(" b"))) return false;
  if (blob.includes("gemeinschaft / gesellschaft")) return false;
  return true;
}

async function load() {
  const files = readdirSync(META_DIR).filter(f => f.endsWith('.json'));
  const metas: MetaDoc[] = await Promise.all(files.map(async f => JSON.parse(await readFile(join(META_DIR, f), 'utf-8'))));
  const atoms = JSON.parse(await readFile(ATOMS, 'utf-8'));
  return { files, metas, atoms };
}

async function main() {
  const tStart = performance.now();
  const { files, metas, atoms } = await load();
  const { allowedAnlagen, budgetDocs, supportDocs, singleAScope } = deriveBudget(metas);

  const candidateIndices: number[] = [];
  atoms.forEach((a: any, i: number) => {
    if (atomAllowed(a, allowedAnlagen, singleAScope)) candidateIndices.push(i);
  });

  const kpis: KPI[] = [];
  for (const meta of supportDocs) {
    const doc = meta.originalFilename ?? meta.uuid ?? 'unknown';
    const belegtyp = meta.classification?.label ?? 'unknown';
    for (const kpi of meta.classification?.kpis ?? []) {
      kpis.push({ doc, belegtyp, key: String(kpi.key), value: kpi.value });
    }
  }

  const tEmbed0 = performance.now();
  const vectors = await embedBatch(kpis.map(k => formatQuery(`${k.belegtyp}: ${k.key}`)));
  const embedMs = performance.now() - tEmbed0;

  const tTier0 = performance.now();
  const resp = await fetch(SIDE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ queries: vectors.map(v => Array.from(v)), top_k: 3, candidate_indices: candidateIndices }),
  });
  if (!resp.ok) throw new Error(`sidecar ${resp.status}`);
  const data = await resp.json() as { topk: { idx: number; score: number }[][]; ms: number; candidate_atoms: number };
  const tierMs = performance.now() - tTier0;

  const canonical = new Set<string>();
  for (let i = 0; i < kpis.length; i++) {
    const top = data.topk[i]?.[0];
    if (top && top.score >= HIGH) canonical.add(atoms[top.idx].field_name);
  }

  const total = performance.now() - tStart;
  console.log(`BUDGET docs: ${budgetDocs.length} · SUPPORT docs: ${supportDocs.length}`);
  console.log(`Allowed Anlagen: ${Array.from(allowedAnlagen).sort().join(', ')}`);
  console.log(`Candidate atoms: ${candidateIndices.length} / ${atoms.length}`);
  console.log(`Support KPIs: ${kpis.length}`);
  console.log(`[Embed] ${embedMs.toFixed(0)} ms`);
  console.log(`[Tier1-budget] ${tierMs.toFixed(0)} ms (server ${data.ms.toFixed(1)} ms)`);
  console.log(`[Canonical] ${canonical.size} eCodes`);
  console.log(`TOTAL ${total.toFixed(0)} ms`);
}

main().catch(err => { console.error(err); process.exit(1); });
