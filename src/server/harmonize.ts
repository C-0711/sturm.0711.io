#!/usr/bin/env -S npx tsx
/**
 * harmonize — Proof-of-Concept der Pipeline-Inversion „erst mergen, dann mappen".
 *
 * Heute mappt die Pipeline pro Dokument auf E-Codes und merged danach (aggregation.ts).
 * Das ist ohne Fallkontext mehrdeutig — am Stricker-Fall: 19 Split-Artefakte
 * (derselbe Beleg-Text → mehrere E-Codes, meist Person A/B oder Form-Sektion).
 *
 * Inversion: rohe Fakten ELSTER-frei mergen, DANACH einmal deterministisch mappen:
 *
 *   map-once = (Anlage, Vordruckzeile, kontextPath) einengen → drucktext-Pick im Bucket
 *
 * Kein Embedding nötig. Der Quantum-Container ist optionaler Reranker IM Bucket
 * (≤24 Kandidaten), NICHT der Primär-Mapper — semantisches NN über alle 2287 Atome
 * reproduziert die Zuordnung nur zu 3 %.
 *
 * Lauf:  npx tsx src/server/harmonize.ts [pfad/zu/master.json]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ATOMS_PATH = resolve(process.cwd(), 'src/verticals/elster-v3/data/atoms.json');
const DEFAULT_MASTER = resolve(process.cwd(), 'reports/abrechnung-kpi-2026-05-18T13-34-48/master.json');

export interface Candidate {
  eCode: string; anlage: string; zeile: string; kontextPath: string;
  drucktext: string; datentyp: string;
}
export interface Fact { anlage: string; zeile: string; kontextPath?: string; label: string; value?: string; }
export interface MapResult { eCode: string | null; how: string; bucket: number; }

const norm = (s: string) => s.toLowerCase().replace(/[^a-zäöüß0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const kpKey = (kp?: string[] | string) => (Array.isArray(kp) ? [...kp].sort().join('|') : (kp ?? ''));
const toks = (s: string) => new Set(norm(s).split(' ').filter((w) => w.length > 2));
function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0; for (const t of a) if (b.has(t)) n++;
  return n / Math.max(a.size, b.size);
}

export function loadCandidates(): Candidate[] {
  const raw = JSON.parse(readFileSync(ATOMS_PATH, 'utf8')) as { atoms?: unknown[] } | unknown[];
  const atoms = (Array.isArray(raw) ? raw : (raw.atoms ?? [])) as Array<{ field_name?: string; metadata?: Record<string, unknown> }>;
  const out: Candidate[] = [];
  for (const a of atoms) {
    const md = a.metadata ?? {}; const ec = String(a.field_name ?? '');
    if (!/^E\d/.test(ec)) continue;
    out.push({
      eCode: ec, anlage: String(md.anlage ?? '').toUpperCase(), zeile: String(md.vordruckzeile ?? ''),
      kontextPath: kpKey(md.kontextPaths as string[] | undefined), drucktext: String(md.drucktext ?? ''), datentyp: String(md.datentyp ?? ''),
    });
  }
  return out;
}

export interface MapperIndex { strict: Map<string, Candidate[]>; loose: Map<string, Candidate[]>; byECode: Map<string, Candidate>; }
const add = (m: Map<string, Candidate[]>, k: string, c: Candidate) => { const b = m.get(k); if (b) b.push(c); else m.set(k, [c]); };
export function buildIndex(cands: Candidate[]): MapperIndex {
  const strict = new Map<string, Candidate[]>(), loose = new Map<string, Candidate[]>(), byECode = new Map<string, Candidate>();
  for (const c of cands) {
    byECode.set(c.eCode, c);
    if (!c.anlage || !c.zeile) continue;
    add(strict, `${c.anlage}|${c.zeile}|${c.kontextPath}`, c);
    add(loose, `${c.anlage}|${c.zeile}`, c);
  }
  return { strict, loose, byECode };
}

/** map-once: (anlage,zeile,kontextPath) einengen → drucktext-Pick im Bucket. */
export function mapFact(f: Fact, idx: MapperIndex): MapResult {
  const A = f.anlage.toUpperCase();
  let bucket: Candidate[] | undefined; let how = 'strict';
  if (f.kontextPath != null) bucket = idx.strict.get(`${A}|${f.zeile}|${kpKey(f.kontextPath)}`);
  if (!bucket?.length) { bucket = idx.loose.get(`${A}|${f.zeile}`); how = 'loose'; }
  if (!bucket?.length) return { eCode: null, how: 'miss', bucket: 0 };
  if (bucket.length === 1) return { eCode: bucket[0].eCode, how: `${how}-unique`, bucket: 1 };
  const ft = toks(f.label); let best = bucket[0], bestS = -1;
  for (const c of bucket) { const s = overlap(ft, toks(c.drucktext)); if (s > bestS) { bestS = s; best = c; } }
  return { eCode: best.eCode, how: `${how}-pick`, bucket: bucket.length };
}

/** ELSTER-freie Harmonisierung: Fakten nach Identität (anlage+label) clustern. */
export interface RawFact { anlage: string; label: string; value: string; eCodeCurrent?: string; }
export function harmonize(facts: RawFact[]): Map<string, RawFact[]> {
  const groups = new Map<string, RawFact[]>();
  for (const f of facts) {
    const key = `${f.anlage.toUpperCase()}|${norm(f.label).replace(/[^a-zäöüß0-9]/g, '').slice(0, 80)}`;
    const g = groups.get(key); if (g) g.push(f); else groups.set(key, [f]);
  }
  return groups;
}

// ── Proof ────────────────────────────────────────────────────────────
const cleanSnippet = (s: string) => s.replace(/<br>/g, ' ').replace(/\*\*/g, '').replace(/\|/g, ' ').replace(/\s+/g, ' ').trim();
function uniqStats(m: Map<string, Candidate[]>, name: string) {
  let uniq = 0, max = 0; for (const b of m.values()) { if (b.length === 1) uniq++; max = Math.max(max, b.length); }
  console.log(`  ${name}: ${m.size} keys | ${uniq} eindeutig (${Math.round(100 * uniq / m.size)}%) | max=${max}`);
}

function main() {
  const masterPath = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_MASTER;
  const cands = loadCandidates(); const idx = buildIndex(cands);
  console.log(`Katalog: ${cands.length} E-Code-Atome\n`);
  console.log('[1] Mapper-Schlüssel — Eindeutigkeit:');
  uniqStats(idx.strict, '(anlage,zeile,kontextPath)');
  uniqStats(idx.loose, ' (anlage,zeile)           ');

  const withSig = cands.filter((c) => c.anlage && c.zeile);
  let rt = 0; for (const c of withSig) { if (mapFact({ anlage: c.anlage, zeile: c.zeile, kontextPath: c.kontextPath, label: c.drucktext }, idx).eCode === c.eCode) rt++; }
  console.log(`\n[2] Index-Konsistenz (Atom via eigener Signatur): ${rt}/${withSig.length} = ${Math.round(100 * rt / withSig.length)}%`);

  const m = JSON.parse(readFileSync(masterPath, 'utf8')) as { merged_layer?: Record<string, { anlage?: string; value?: string; confirmed_by?: Array<{ snippet?: string }> }> };
  const ml = m.merged_layer ?? {};
  const facts: RawFact[] = [];
  for (const [ec, v] of Object.entries(ml)) {
    const snip = (v.confirmed_by ?? []).find((s) => s.snippet)?.snippet;
    if (!snip) continue;
    facts.push({ anlage: String(v.anlage ?? ''), label: cleanSnippet(snip), value: String(v.value ?? ''), eCodeCurrent: ec });
  }
  const groups = harmonize(facts);
  const splits = [...groups.values()].filter((g) => new Set(g.map((f) => f.eCodeCurrent)).size > 1);
  console.log(`\n[3] Stricker ELSTER-frei gemerged: ${facts.length} Fakten → ${groups.size} Identitäten; ${splits.length} Split-Gruppen`);
  let separable = 0;
  for (const g of splits) {
    const ecs = [...new Set(g.map((f) => f.eCodeCurrent!))];
    const sigs = new Set(ecs.map((e) => { const c = idx.byECode.get(e); return c ? `${c.zeile}|${c.kontextPath}` : '?'; }));
    if (sigs.size === ecs.length) separable++;
  }
  console.log(`    Split-Gruppen trennbar durch (zeile,kontextPath): ${separable}/${splits.length}`);

  let np = 0, npTot = 0, npMulti = 0, npMultiHit = 0;
  for (const f of facts) {
    const gt = idx.byECode.get(f.eCodeCurrent!); if (!gt || !gt.zeile) continue;
    npTot++;
    const bucket = idx.strict.get(`${gt.anlage}|${gt.zeile}|${gt.kontextPath}`) ?? [];
    const r = mapFact({ anlage: gt.anlage, zeile: gt.zeile, kontextPath: gt.kontextPath, label: f.label }, idx);
    if (r.eCode === f.eCodeCurrent) np++;
    if (bucket.length > 1) { npMulti++; if (r.eCode === f.eCodeCurrent) npMultiHit++; }
  }
  console.log(`\n[4] Noisy-Label-Pick (echtes OCR-Label + GT-Schlüssel): ${np}/${npTot} = ${Math.round(100 * np / npTot)}% Recovery`);
  console.log(`    davon Multi-Bucket (drucktext-Pick nötig): ${npMultiHit}/${npMulti} korrekt`);
}

main();
