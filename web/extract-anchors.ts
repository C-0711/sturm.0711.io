#!/usr/bin/env -S npx tsx
/**
 * extract-anchors — der EINKOMMENS-Pfad des Mastercase.
 *
 * Der Rust-/extract windowed die Bank-Steuerbescheinigungen falsch (Layout-Profil
 * „steuererklaerung" → no_records_in_window), aber das volle, positionierte OCR
 * liegt in lane_two_pending[].page_records. Hier holen wir die KAP-Werte über die
 * „Zeile X Anlage KAP"-Anker (+ Label-Fallback) und mappen sie über die bestehende
 * SPEC (extractor-anlage-zeilen) auf die E19-Codes — deterministisch, bbox-genau.
 *
 *   page_records → Anker „Zeile N Anlage KAP" / KAP-Label → SPEC[KAP:N] → eCode
 *                → Wert = rechtester Currency-Record im selben Zeilen-Band
 *                → Person = Adressat („(Gläubiger)"-Block, Roster-Name)
 *
 * Lauf:  npx tsx web/extract-anchors.ts [ex_b4.json …]
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ExtractOutput, PageRecord } from './extract-client.ts';
import type { Household } from './mastercase-harmonize.ts';
import { ANLAGE_ZEILE_TO_FIELD } from '../src/workflows/elster/lib/field-mapper/extractor-anlage-zeilen.ts';

export interface IncomeFact {
  person: 'A' | 'B'; eCode: string; anlage: string; zeile: string;
  label: string; value: string; document: string; page: number;
}

/** KAP-Label → Zeile (Fallback ohne Anker). OCR-tolerant (ä→a, ö→o); KiSt VOR
 *  KapErtSt, weil „Kirchensteuer zur Kapitalertragsteuer" auch „kapitalertragsteuer" enthält. */
const KAP_LABEL_ZEILE: Array<[RegExp, string]> = [
  [/h(?:ö|o)he der kapitalertr/i, '7'],
  [/sparer-?pauschbetr/i, '17'],
  [/kirchensteuer zur kapitalertrag/i, '39'],
  [/solidarit(?:ä|a)tszuschlag/i, '38'],
  [/kapitalertrag(?:s)?steuer/i, '37'],
];
const ANCHOR_RE = /zeile\s*(\d+)\s*anlage\s*kap/i;
// Geld: „11,25" / „36,00" / „0,00" / „293" / „1.602,00" — mind. 1 Ziffer, kein reiner Zeilen-Index.
const CURRENCY_RE = /^\d{1,3}(?:\.\d{3})*(?:,\d{2})$|^\d+,\d{2}$/;

const cx = (r: PageRecord) => r.bbox?.[0] ?? 0;
const cy = (r: PageRecord) => r.bbox?.[1] ?? 0;
const isMoney = (s: string) => CURRENCY_RE.test((s || '').trim());

/** page_records je Seite aus lane_two_pending bündeln + dedupen (wiederholen sich). */
function pageRecordsOf(out: ExtractOutput): Map<number, PageRecord[]> {
  const byPage = new Map<number, PageRecord[]>();
  const seen = new Set<string>();
  for (const p of out.lane_two_pending ?? []) {
    for (const r of p.page_records ?? []) {
      const k = `${p.page}|${r.text}|${(r.bbox ?? []).join(',')}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const arr = byPage.get(p.page) ?? byPage.set(p.page, []).get(p.page)!;
      arr.push(r);
    }
  }
  return byPage;
}

/** Person = Adressat: erster Roster-Name (voll, sonst Vorname) in den records. */
function belegPerson(records: PageRecord[], hh: Household): 'A' | 'B' | null {
  const full: Array<['A' | 'B', string]> = [];
  const vor: Array<['A' | 'B', string]> = [];
  const add = (p: 'A' | 'B', r?: Household['personA']) => {
    if (r?.vorname && r?.nachname) full.push([p, `${r.vorname} ${r.nachname}`.toLowerCase()]);
    if (r?.vorname) vor.push([p, r.vorname.toLowerCase()]);
  };
  add('A', hh.personA); add('B', hh.personB);
  for (const r of records) { const t = (r.text || '').toLowerCase(); for (const [p, nm] of full) if (t.includes(nm)) return p; }
  for (const r of records) { const t = (r.text || '').toLowerCase(); for (const [p, vn] of vor) if (t.includes(vn)) return p; }
  return null;
}

/** Aus EINEM /extract-Output die KAP-Einkommensfakten über Label+Anker ziehen.
 *  Der WERT wird an die LABEL-Zeile geankert (Label & Betrag stehen auf gleicher
 *  Höhe, rechte Wertspalte); der „Zeile N Anlage KAP"-Anker (knapp DARUNTER)
 *  liefert nur die Zeilennummer — sonst greift der Label-Default. */
export function extractAnchoredIncome(out: ExtractOutput, hh: Household): IncomeFact[] {
  const byPage = pageRecordsOf(out);
  const person = belegPerson([...byPage.values()].flat(), hh) ?? 'A';
  const facts: IncomeFact[] = [];
  const seen = new Set<string>();                            // KAP:zeile nur einmal je Beleg

  for (const [page, recs] of byPage) {
    if (!recs.some((r) => /anlage\s*kap/i.test(r.text))) continue;   // KAP-Kontext nötig
    // eindeutige Zeilen-Anker (mehrdeutige „16 oder 17" überspringen → Label-Default).
    const anchors = recs.flatMap((r) => {
      if (/\boder\b/i.test(r.text)) return [];
      const m = ANCHOR_RE.exec(r.text); return m ? [{ zeile: m[1], y: cy(r) }] : [];
    });
    // Wert auf der LABEL-Zeile: Currency-Record in y±24, rechte Spalte (x>400), rechtester.
    const valueOnLine = (y: number): string | null => {
      const cand = recs.filter((r) => Math.abs(cy(r) - y) <= 24 && cx(r) > 400 && isMoney(r.text));
      if (!cand.length) return null;
      cand.sort((a, b) => cx(b) - cx(a));
      return cand[0].text.trim();
    };
    for (const r of recs) {
      let def: string | null = null;
      for (const [re, z] of KAP_LABEL_ZEILE) if (re.test(r.text)) { def = z; break; }
      if (!def) continue;
      const v = valueOnLine(cy(r));
      if (v == null) continue;
      const near = anchors.find((a) => a.y >= cy(r) - 6 && a.y <= cy(r) + 42);  // Anker knapp unter dem Label
      const zeile = near?.zeile ?? def;
      const ref = `KAP:${zeile}`;
      const spec = ANLAGE_ZEILE_TO_FIELD[ref];
      if (!spec || seen.has(ref)) continue;
      seen.add(ref);
      facts.push({ person, eCode: spec.eCode, anlage: 'KAP', zeile, label: spec.label, value: v, document: out.document_sha256, page });
    }
  }
  return facts;
}

// ── Probe ───────────────────────────────────────────────────────────────
const STRICKER: Household = {
  personA: { idnr: '85236749007', vorname: 'Rainer', nachname: 'Stricker' },
  personB: { idnr: '54129386608', vorname: 'Maria Ute', nachname: 'Stricker' },
};
function main(): void {
  const dir = process.env.MC_SAMPLES ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'var', 'extract-samples');
  const files = process.argv.slice(2).length ? process.argv.slice(2) : ['ex_b4', 'ex_b5', 'ex_b6', 'ex_b7', 'ex_b8'].map((n) => join(dir, `${n}.json`));
  for (const f of files) {
    if (!existsSync(f)) { console.error(`fehlt: ${f}`); continue; }
    const out = JSON.parse(readFileSync(f, 'utf8')) as ExtractOutput;
    const inc = extractAnchoredIncome(out, STRICKER);
    console.log(`\n── ${f.split('/').pop()} ──`);
    for (const x of inc) console.log(`  Person ${x.person}  ${x.eCode}  KAP Z${x.zeile.padEnd(2)} ${x.label.slice(0, 34).padEnd(35)} = ${x.value}`);
    if (!inc.length) console.log('  (keine KAP-Anker gefunden)');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
