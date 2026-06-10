#!/usr/bin/env -S npx tsx
/**
 * mastercase — baut aus der DETERMINISTISCHEN ctax-Ingestion (lane-1 Parse:
 * belege/fields/household/veranlagungsart) den harmonisierten Mastercase und
 * mappt ihn DANACH einmal gegen den Katalog.
 *
 *   Ingestion (deterministisch) → Mastercase (Entitäten·Profil·Fakten)
 *                               → map-once (Anlage,Person→kontextPath,Zeile,drucktext)
 *
 * Die Ingestion liefert Person A/B, Anlage und (für KAP) die Zeile bereits im
 * Label — der A/B-Split, der pro Dokument mehrdeutig wäre, ist hier durch das
 * person-Attribut getrennt. Der Mastercase macht daraus eine entitäts-zentrierte,
 * ELSTER-agnostische Sicht; das Mapping verifiziert/konsolidiert die E-Codes.
 *
 * Lauf:  npx tsx src/server/mastercase.ts [pfad/zu/ctax-case-data.json]
 *        npx tsx src/server/mastercase.ts --v1 [pfad]   → fall/v1 + mastercase/v1 als JSON
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadCandidates, buildIndex, type Candidate, type MapperIndex } from './harmonize.ts';
import { jahresFormZuV1 } from '../schemas/v1/adapter.ts';

const DEFAULT_INPUT = '/tmp/stricker-mastercase-input.json';

// ── Eingabe-Form (ctax case.data, deterministische lane-1 Ingestion) ──
interface InField { eCode: string; anlage?: string; person?: string; label?: string; wert?: string; method?: string; zeile?: string | null; kontextPath?: string | null; }
interface InBeleg { belegTyp?: string; person?: string; anlage?: string; method?: string; felder?: number; source?: string; }
interface CtaxCase {
  label?: string; vz?: number; veranlagungsart?: string;
  household?: { personA?: Record<string, string>; personB?: Record<string, string> };
  calcs?: Array<Record<string, unknown>>;
  belege?: InBeleg[]; fields?: InField[];
}

// ── Mastercase-Form (ELSTER-agnostisch oben, E-Code als gemappte Schicht) ──
export interface Entity { person: 'A' | 'B'; idnr?: string; name?: string; profil: string[]; anlagen: string[]; }
export interface MasterFact {
  person: 'A' | 'B'; anlage: string; label: string; wert: string;
  zeile: string | null; kontextPath: string | null; eCodeParse: string;  // Struktur-Schlüssel + Ingestion-eCode
  eCodeMap: string | null; mapHow: string;             // aus map-once
  quelle: 'beleg' | 'household';                       // beleg-extrahiert oder aus household ergänzt
  belegTyp?: string;
}
export interface Mastercase {
  label: string; vz: number; veranlagungsart: string;
  entitaeten: Entity[];
  fakten: MasterFact[];
  ergebnis: { erstattung?: number; zve?: number; gesamtsteuer?: number } | null;
}

const PROFIL_REGELN: Array<{ wenn: (anl: Set<string>, typ: Set<string>) => boolean; profil: string }> = [
  { wenn: (a, t) => a.has('N') || t.has('VaSt_LStB'), profil: 'Arbeitnehmer' },
  { wenn: (a) => a.has('KAP'), profil: 'Kapitalanleger' },
  { wenn: (a) => a.has('R'), profil: 'Rentner' },
  { wenn: (a) => a.has('VOR'), profil: 'Vorsorge' },
  { wenn: (a) => a.has('G') || a.has('S'), profil: 'Selbständig/Gewerbe' },
  { wenn: (a) => a.has('V'), profil: 'Vermietung' },
];

/** Stammdaten-Zielcodes je Person — aus household ergänzt, falls aus keinem Beleg extrahiert. */
const STAMM: Record<'A' | 'B', Array<{ attr: 'idnr' | 'vorname' | 'nachname'; eCode: string }>> = {
  A: [{ attr: 'idnr', eCode: 'E0100081' }, { attr: 'vorname', eCode: 'E0100301' }, { attr: 'nachname', eCode: 'E0100201' }],
  B: [{ attr: 'idnr', eCode: 'E0100082' }, { attr: 'vorname', eCode: 'E0100801' }, { attr: 'nachname', eCode: 'E0100901' }],
};

const personOf = (p?: string): 'A' | 'B' => (String(p).toUpperCase() === 'B' ? 'B' : 'A');
const zeileFromLabel = (label?: string): string | null => {
  const m = /Z\.?\s*(\d+)/.exec(label ?? ''); return m ? m[1] : null;
};
const norm = (s: string) => s.toLowerCase().replace(/[^a-zäöüß0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const toks = (s: string) => new Set(norm(s).split(' ').filter((w) => w.length > 2));
function overlap(a: Set<string>, b: Set<string>): number { if (!a.size || !b.size) return 0; let n = 0; for (const t of a) if (b.has(t)) n++; return n / Math.max(a.size, b.size); }

/** map-once aus dem Mastercase-Kontext: Anlage + (Person→kontextPath für ESt1A) + Zeile + drucktext-Pick. */
function mapInContext(f: { anlage: string; person: 'A' | 'B'; zeile: string | null; kontextPath: string | null; label: string }, idx: MapperIndex, cands: Candidate[]): { eCode: string | null; how: string } {
  const A = f.anlage.toUpperCase();
  let pool: Candidate[] | undefined;
  // 1. strenger Schlüssel direkt aus der Ingestion (Anlage, Zeile, kontextPath)
  if (f.zeile && f.kontextPath != null) pool = idx.strict.get(`${A}|${f.zeile}|${f.kontextPath}`);
  // 2. nur (Anlage, Zeile)
  if (!pool?.length && f.zeile) pool = idx.loose.get(`${A}|${f.zeile}`);
  // 3. ohne Zeile: über Anlage (+ kontextPath / ESt1A-Person)
  if (!pool?.length) {
    const kp = f.kontextPath || (A === 'EST1A' ? `Allg/${f.person}` : null);
    pool = cands.filter((c) => c.anlage === A && (!kp || c.kontextPath === kp || c.kontextPath.includes(kp)));
  }
  if (!pool?.length) return { eCode: null, how: 'miss' };
  if (pool.length === 1) return { eCode: pool[0].eCode, how: 'unique' };
  const lt = toks(f.label); let best = pool[0], bestS = -1;
  for (const c of pool) { const s = overlap(lt, toks(c.drucktext)); if (s > bestS) { bestS = s; best = c; } }
  return { eCode: best.eCode, how: `pick/${pool.length}` };
}

export function buildMastercase(c: CtaxCase, idx: MapperIndex, cands: Candidate[]): Mastercase {
  // Entitäten + Profil
  const anlByPerson: Record<'A' | 'B', Set<string>> = { A: new Set(), B: new Set() };
  const typByPerson: Record<'A' | 'B', Set<string>> = { A: new Set(), B: new Set() };
  for (const f of c.fields ?? []) if (f.anlage) anlByPerson[personOf(f.person)].add(f.anlage.toUpperCase());
  for (const b of c.belege ?? []) if (b.belegTyp) typByPerson[personOf(b.person)].add(b.belegTyp);

  const mkEntity = (p: 'A' | 'B', h?: Record<string, string>): Entity => {
    const profil = PROFIL_REGELN.filter((r) => r.wenn(anlByPerson[p], typByPerson[p])).map((r) => r.profil);
    return { person: p, idnr: h?.idnr, name: [h?.vorname, h?.nachname].filter(Boolean).join(' ') || undefined,
      profil: profil.length ? profil : ['—'], anlagen: [...anlByPerson[p]].sort() };
  };
  const entitaeten: Entity[] = [mkEntity('A', c.household?.personA)];
  if (c.veranlagungsart === 'zusammen' || (c.fields ?? []).some((f) => personOf(f.person) === 'B'))
    entitaeten.push(mkEntity('B', c.household?.personB));

  // Fakten: aus der Ingestion, map-once verifiziert
  const fakten: MasterFact[] = (c.fields ?? []).map((f) => {
    const person = personOf(f.person); const anlage = String(f.anlage ?? ''); const label = String(f.label ?? '');
    const zeile = f.zeile ?? zeileFromLabel(label);            // jetzt first-class aus der Ingestion
    const kontextPath = f.kontextPath ?? null;
    const m = mapInContext({ anlage, person, zeile, kontextPath, label }, idx, cands);
    return { person, anlage, label, wert: String(f.wert ?? ''), zeile, kontextPath, eCodeParse: f.eCode, eCodeMap: m.eCode, mapHow: m.how, quelle: 'beleg' as const };
  });

  // Stammdaten aus household als mappbare Fakten ergänzen (z.B. Person B Vor-/Nachname,
  // die in household stehen, aber aus keinem Beleg extrahiert wurden) — sonst kein ELSTER-Mapping.
  const haveECode = new Set(fakten.map((f) => `${f.person}|${f.eCodeParse}`));
  const hh: Record<'A' | 'B', Record<string, string> | undefined> = { A: c.household?.personA, B: c.household?.personB };
  for (const p of ['A', 'B'] as const) {
    if (!entitaeten.some((e) => e.person === p)) continue;
    for (const { attr, eCode } of STAMM[p]) {
      const wert = hh[p]?.[attr];
      if (!wert || haveECode.has(`${p}|${eCode}`)) continue;
      const cat = idx.byECode.get(eCode);
      fakten.push({ person: p, anlage: 'ESt1A', label: cat?.drucktext || attr, wert: String(wert),
        zeile: cat?.zeile ?? null, kontextPath: cat?.kontextPath ?? null,
        eCodeParse: eCode, eCodeMap: eCode, mapHow: 'household', quelle: 'household' });
    }
  }

  const calc = (c.calcs ?? [])[0] as { erstattung?: number; bindend?: { zve?: number; gesamtsteuer?: number } } | undefined;
  return {
    label: c.label ?? '', vz: Number(c.vz) || 0, veranlagungsart: c.veranlagungsart ?? '',
    entitaeten, fakten,
    ergebnis: calc ? { erstattung: calc.erstattung, zve: calc.bindend?.zve, gesamtsteuer: calc.bindend?.gesamtsteuer } : null,
  };
}

// ── Lauf ──────────────────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2);
  const v1Mode = argv.includes('--v1');
  const rest = argv.filter((a) => a !== '--v1');
  const inputPath = rest[0] ? resolve(rest[0]) : DEFAULT_INPUT;
  const c = JSON.parse(readFileSync(inputPath, 'utf8')) as CtaxCase;
  const cands = loadCandidates(); const idx = buildIndex(cands);
  const mc = buildMastercase(c, idx, cands);

  if (v1Mode) {
    // v1-Vertrags-Ausgabe (fall/v1 + mastercase/v1) statt Pretty-Print —
    // maschinenlesbar für Downstream (Engine-Gateway, Validierung).
    const v1 = jahresFormZuV1(mc, { quelle: inputPath });
    console.log(JSON.stringify(v1, null, 2));
    return;
  }

  console.log(`\n╔══ MASTERCASE (vor Mapping) · ${mc.label} · VZ ${mc.vz} ══`);
  console.log(`veranlagung : ${mc.veranlagungsart}`);
  if (mc.ergebnis) console.log(`ergebnis    : Erstattung ${mc.ergebnis.erstattung} € · zvE ${mc.ergebnis.zve} · Gesamtsteuer ${mc.ergebnis.gesamtsteuer}`);
  console.log(`\nENTITÄTEN`);
  for (const e of mc.entitaeten)
    console.log(`  Person ${e.person} · ${e.name ?? '?'} · IdNr ${e.idnr ?? '?'}\n     profil  : ${e.profil.join(', ')}\n     anlagen : ${e.anlagen.join(', ')}`);

  console.log(`\nFAKTEN  (Anlage · Zeile · kontextPath · Wert — ⊕ = aus household ergänzt; eCode = Mapping-Ausgabe, hier weggelassen)`);
  const ORDER = ['ESt1A', 'N', 'VOR', 'KAP'];
  const num = (z: string | null) => (z && /^\d+$/.test(z) ? parseInt(z, 10) : 999);
  for (const p of ['A', 'B'] as const) {
    const rows = mc.fakten.filter((f) => f.person === p); if (!rows.length) continue;
    console.log(`\n  ▸ Person ${p}`);
    for (const a of ORDER) {
      const ar = rows.filter((f) => f.anlage.toUpperCase() === a.toUpperCase()).sort((x, y) => num(x.zeile) - num(y.zeile));
      if (!ar.length) continue;
      console.log(`    ${a}`);
      for (const f of ar)
        console.log(`     ${f.quelle === 'household' ? '⊕' : ' '} ${('Z' + (f.zeile ?? '—')).padEnd(5)} ${(f.kontextPath ?? '∅').slice(0, 30).padEnd(31)} ${f.label.slice(0, 34).padEnd(35)} = ${f.wert}`);
    }
  }
  const hhN = mc.fakten.filter((f) => f.quelle === 'household').length;
  const aN = mc.fakten.filter((f) => f.person === 'A').length, bN = mc.fakten.filter((f) => f.person === 'B').length;
  const uniq = mc.fakten.filter((f) => f.mapHow === 'unique').length;
  const agree = mc.fakten.filter((f) => f.eCodeMap === f.eCodeParse).length;
  console.log(`\n── ${mc.fakten.length} Fakten · A: ${aN} · B: ${bN} · davon ${hhN} aus household ergänzt (⊕) ──`);
  console.log(`── map-once danach: ${uniq}/${mc.fakten.length} eindeutig · ${agree}/${mc.fakten.length} konsistent (Schlüssel aus Ingestion + household) ──`);
}

main();
