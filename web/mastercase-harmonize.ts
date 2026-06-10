#!/usr/bin/env -S npx tsx
/**
 * web/mastercase-harmonize — der HARMONIZER über den ECHTEN deterministischen
 * Extraktor-Output (POST /api/v1/extract, pro Beleg). Reine Funktion, kein I/O
 * im Hot-Path; ein optionales main() (import.meta-Guard) lädt die lokalen
 * Real-Samples und druckt das Ergebnis.
 *
 * Pipeline (siehe ERKENNTNISSE Rollen/Person + bank_rauschen_erkennung):
 *   1) FLATTEN  — extracted[] (fast+gemma) + fields[] (windowed) → Fakten
 *      {e_code, belegfeld_id, value, source, page, bbox, lane}.
 *   2) ROLLE    — Bank/Gläubiger-Artefakte raus: name_steuerpflichtiger matcht
 *      eG/Bank/Sparkasse/Volksbank/Raiffeisen → Gläubiger (kein Person-Name);
 *      Identitätsfeld (PLZ/Ort/Straße) != Haushalts-Adresse → Bank-Sitz → drop.
 *   3) PERSON   — A/B-Split VALUE-getrieben über IdNr→Roster bzw. Name→Roster
 *      bzw. Seite (gleiche Seite = gleiche Person). NICHT über belegfeld_id.
 *   4) VOTE     — pro (person, e_code): Gewinner = von den meisten DISTINCT
 *      Belegen bestätigter normalisierter Wert; Konflikte markiert.
 *   5) OUTPUT   — {entitaeten[A,B], fakten[{person,e_code,value,confidence,sources,conflict?}]}.
 *
 * belegfeld_id kodiert NUR den Feld-TYP, NIE Rolle/Person. Rolle+Person kommen
 * aus value-Semantik (Roster) + bbox/page-Geometrie.
 *
 * Lauf:  npx tsx web/mastercase-harmonize.ts
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ExtractOutput, ExtractedField, WindowedField, PageRecord, BoxPx } from './extract-client.ts';
import { extractAnchoredIncome, extractLstbIncome, type IncomeFact } from './extract-anchors.ts';

// ── Roster (aus dem übergebenen Household) ──────────────────────────────
export interface RosterPerson { idnr?: string; vorname?: string; nachname?: string; }
export interface Household { personA?: RosterPerson; personB?: RosterPerson; }

// ── Mastercase-Form (entitäts-zentriert, ELSTER-E-Code als Schicht) ─────
export interface MasterEntity { person: 'A' | 'B'; idnr?: string; name?: string; }
export interface FactSource { document: string; page: number; lane: string; value: string; bbox: BoxPx | null; }
export interface MasterFact {
  person: 'A' | 'B';
  e_code: string;
  belegfeld_id: string;
  value: string;            // Gewinner-Wert (normalisierter Repräsentant, value_parsed bevorzugt)
  confidence: number;       // # DISTINCT Belege, die den Gewinner-Wert bestätigen
  sources: FactSource[];    // alle Belege/Seiten, die den Gewinner-Wert lieferten
  conflict?: { value: string; documents: string[] }[];  // konkurrierende, ebenfalls roster-konforme Werte
}
export interface Mastercase {
  entitaeten: MasterEntity[];
  fakten: MasterFact[];
  /** Was beim Rolle-Filter verworfen wurde — Audit-Spur (Bank-Namen/-Adressen, Müll). */
  verworfen: { e_code: string; belegfeld_id: string; value: string; document: string; page: number; grund: string }[];
}

// ── interne Flach-Form ──────────────────────────────────────────────────
interface RawFact {
  e_code: string;
  belegfeld_id: string;
  value: string;           // value_parsed ?? value_raw (als String)
  document: string;        // document_sha256 (Beleg-Id)
  page: number;
  bbox: BoxPx | null;      // value_window_px (Feld-Fenster)
  lane: string;
  records: PageRecord[];   // page_records DIESER Seite (Geometrie/Anker-Evidenz)
}

// ── Normalisierung / Roster-Helfer ──────────────────────────────────────
const digits = (s: string) => (s || '').replace(/\D/g, '');
const lc = (s: string) => (s || '').toLowerCase();
/** Adress-Vergleichsschlüssel: Kleinschreibung, ohne Satzzeichen/Whitespace,
 *  mit normalisierter Straßen-Abkürzung — so kollabiert „Kirchstraße 4"=="Kirchstr.4"
 *  (gleiche Haushaltsadresse, nur Abkürzung), während ein echter Bank-Sitz
 *  („Kirchplatz4", andere PLZ/Ort) weiter abweicht.
 *  ("Kirchstr.4"≈"Kirchstr. 4"; "57629Malberg"≈"57629 Malberg"). */
const addrKey = (s: string) =>
  lc(s)
    .replace(/stra(?:ß|ss|b)e/g, 'str')  // straße/strasse/straBe(OCR ß→B) → str (Abkürzung egalisieren)
    .replace(/[^a-zäöüß0-9]/g, '');

/** Identitätsfeld-eCodes, die das falsche Bank-Layout-Profil kapern kann. */
const NAME_ECODE = 'E0100201';                 // name_steuerpflichtiger
const ADDR_ECODES = new Set(['E0101104', 'E0100601', 'E0100602', 'E0101206']); // straße, plz, ort, hausnr
const IDNR_ECODE = 'E0100081';                 // identifikationsnummer

/** Bank-/Gläubiger-Namensmuster (stärkstes Rolle-Signal). */
const BANK_RE = /\b(?:eg|bank|sparkasse|volksbank|raiffeisen|kreditinstitut|gmbh|ag|kgaa)\b|e\.?\s?g\.?$/i;
const isBankName = (v: string) => BANK_RE.test(v);

/** value_parsed bevorzugt (typgenau), sonst value_raw; immer als getrimmter String. */
const pickVal = (parsed: unknown, raw: unknown): string => {
  const v = parsed !== null && parsed !== undefined && parsed !== '' ? parsed : raw;
  return v === null || v === undefined ? '' : String(v).trim();
};

/** Vote-Normalisierung: Zahlen über ihre Ziffern (293 == "293,75"→293),
 *  Adress-/Text-Werte über addrKey. So zählt „Kirchstr.4"=="Kirchstr. 4". */
function voteKey(e_code: string, value: string): string {
  const d = digits(value);
  // reine Zahl-/Betragsfelder (Arbeitslohn, Steuer, IdNr, PLZ): Ziffern-Identität
  if (d.length >= 2 && /^[\d.,\s/-]+$/.test(value)) return 'n:' + d;
  return 't:' + addrKey(value);
}

// ── Roster-Lookup: Person via IdNr / Name ───────────────────────────────
interface RosterIndex {
  byIdnr: Map<string, 'A' | 'B'>;
  byNachname: Map<string, 'A' | 'B'>;
  byVorname: Map<string, 'A' | 'B'>;
  byFullname: Map<string, 'A' | 'B'>;
  nachnamen: Set<string>;          // erlaubte Steuerpflichtigen-Nachnamen (Roster) → alles andere = noise
  personen: ('A' | 'B')[];
}
function buildRoster(hh: Household): RosterIndex {
  const byIdnr = new Map<string, 'A' | 'B'>();
  const byNachname = new Map<string, 'A' | 'B'>();
  const byVorname = new Map<string, 'A' | 'B'>();
  const byFullname = new Map<string, 'A' | 'B'>();
  const nachnamen = new Set<string>();
  const personen: ('A' | 'B')[] = [];
  const add = (p: 'A' | 'B', r?: RosterPerson) => {
    if (!r) return;
    personen.push(p);
    if (r.idnr) byIdnr.set(digits(r.idnr), p);
    if (r.nachname) { byNachname.set(lc(r.nachname), p); nachnamen.add(lc(r.nachname)); }
    if (r.vorname) byVorname.set(lc(r.vorname), p);
    if (r.vorname && r.nachname) byFullname.set(lc(`${r.vorname} ${r.nachname}`), p);
  };
  add('A', hh.personA);
  // Person B nur, wenn im Roster vorhanden (idnr ODER name) — sonst Einzelveranlagung.
  if (hh.personB && (hh.personB.idnr || hh.personB.nachname || hh.personB.vorname)) add('B', hh.personB);
  return { byIdnr, byNachname, byVorname, byFullname, nachnamen, personen };
}

/** Person eines Werts/Records: IdNr-Match → Name-Match (full/vor/nach). */
function personFromValue(value: string, e_code: string, roster: RosterIndex): 'A' | 'B' | null {
  const d = digits(value);
  if (e_code === IDNR_ECODE && d && roster.byIdnr.has(d)) return roster.byIdnr.get(d)!;
  const l = lc(value);
  if (roster.byFullname.has(l)) return roster.byFullname.get(l)!;
  if (roster.byNachname.has(l)) return roster.byNachname.get(l)!;
  if (roster.byVorname.has(l)) return roster.byVorname.get(l)!;
  // Teilstring (z.B. „Rainer Stricker" enthält Roster-Vorname „Rainer")
  for (const [vn, p] of roster.byVorname) if (l.includes(vn)) return p;
  for (const [nn, p] of roster.byNachname) if (l.includes(nn)) return p;
  return null;
}

/** Page-Anker: trägt diese Seite eine Roster-IdNr (→ Person der ganzen Seite)?
 *  In ex_vast tagged jede Seite genau eine IdNr ALLE Felder dieser Seite. */
function pagePerson(records: PageRecord[], roster: RosterIndex): 'A' | 'B' | null {
  let found: 'A' | 'B' | null = null;
  for (const r of records) {
    const d = digits(r.text);
    if (d.length >= 9) {                       // IdNr ist 11-stellig; tolerant ab 9
      for (const [idn, p] of roster.byIdnr) if (d === idn || d.includes(idn)) { if (found && found !== p) return null; found = p; }
    }
  }
  return found;
}

// ── Schritt 1: FLATTEN ──────────────────────────────────────────────────
function flatten(out: ExtractOutput): RawFact[] {
  // page_records je Seite aus lane_two_pending bündeln (Geometrie-Ground-Truth).
  const recsByPage = new Map<number, PageRecord[]>();
  for (const p of out.lane_two_pending ?? []) {
    if (!recsByPage.has(p.page) && Array.isArray(p.page_records) && p.page_records.length)
      recsByPage.set(p.page, p.page_records);
  }
  const facts: RawFact[] = [];
  const push = (e_code: string, belegfeld_id: string, value: string, page: number, bbox: BoxPx | null, lane: string) => {
    if (!value) return;
    facts.push({ e_code, belegfeld_id, value, document: out.document_sha256, page, bbox, lane, records: recsByPage.get(page) ?? [] });
  };
  for (const e of out.extracted ?? [] as ExtractedField[])
    push(e.e_code, e.belegfeld_id, pickVal(e.value_parsed, e.value_raw), e.page, e.value_window_px, e.lane);
  // fields[] hat meist value_raw=null (nur Template) → nur die mit echtem Wert übernehmen.
  for (const f of out.fields ?? [] as WindowedField[])
    if (f.value_raw != null && String(f.value_raw).trim())
      push(f.e_code, f.belegfeld_id, String(f.value_raw).trim(), f.page, f.value_window_px, 'windowed');
  return facts;
}

// ── Schritt 2: ROLLE — Bank/Gläubiger-Artefakte ausfiltern ──────────────
/** Haushalts-Adress-Roster aus den Identitätswerten ableiten: der je eCode am
 *  häufigsten von NICHT-Bank-Namen begleitete Adresswert ist die echte Adresse.
 *  Bank-Sitz (PLZ/Ort/Straße ≠ Haushalt) wird damit als Mismatch verworfen.
 *  Heuristik gegen den dokumentierten Fall: die linke Adressaten-Spalte (bbox
 *  x<200) trägt den Haushalt, der rechte Bank-Briefkopf (x>330) den Bank-Sitz. */
function buildAddressRoster(facts: RawFact[]): Map<string, Set<string>> {
  // pro Adress-eCode: addrKey → Score (links/Adressat zählt mehr als rechts/Briefkopf)
  const score = new Map<string, Map<string, number>>();
  for (const f of facts) {
    if (!ADDR_ECODES.has(f.e_code)) continue;
    const m = score.get(f.e_code) ?? new Map<string, number>();
    const k = addrKey(f.value);
    if (!k) continue;
    const x = f.bbox?.x ?? 0;
    // Geometrie: weiter links (kleineres x im rohen page_record-Raum) = Adressat.
    // value_window_px liegt im selben Raum; x<330 begünstigt den Haushalt.
    const w = x > 0 && x < 330 ? 2 : 1;
    m.set(k, (m.get(k) ?? 0) + w);
    score.set(f.e_code, m);
  }
  // Gewinner-addrKey je eCode = Haushalts-Wert.
  const roster = new Map<string, Set<string>>();
  for (const [ec, m] of score) {
    let best = '', bestS = -1;
    for (const [k, s] of m) if (s > bestS) { bestS = s; best = k; }
    roster.set(ec, new Set([best]));
  }
  return roster;
}

interface FilterResult { kept: RawFact[]; dropped: Mastercase['verworfen']; }
function filterRoles(facts: RawFact[], roster: RosterIndex): FilterResult {
  const addrRoster = buildAddressRoster(facts);
  const kept: RawFact[] = [];
  const dropped: Mastercase['verworfen'] = [];
  const drop = (f: RawFact, grund: string) => dropped.push({ e_code: f.e_code, belegfeld_id: f.belegfeld_id, value: f.value, document: f.document, page: f.page, grund });

  for (const f of facts) {
    // (0) Einkommens-eCodes RAUS aus dem Stammdaten-Pfad — KAP/N/VOR kommen verlässlich
    //     über die Anker (KAP) bzw. LStB-Label (N/VOR); die Rust-extracted[]-Einkommenswerte
    //     sind dort verrauscht (FSA-Beträge → bruttoarbeitslohn etc.).
    if (/^E0[23]|^E19|^E20/.test(f.e_code)) { drop(f, 'einkommen-via-anker'); continue; }
    // (a) name_steuerpflichtiger mit Bank-/Gläubiger-Pattern → kein Person-Name.
    if (f.e_code === NAME_ECODE) {
      if (isBankName(f.value)) { drop(f, 'bank-name-pattern'); continue; }
      // Roster-Gegencheck: erlaubte Nachnamen sind nur die des Haushalts.
      if (roster.nachnamen.size && !personFromValue(f.value, f.e_code, roster)) { drop(f, 'name-nicht-im-roster'); continue; }
    }
    // (b) Adress-Identitätsfeld, das nicht zur Haushalts-Adresse passt → Bank-Sitz.
    if (ADDR_ECODES.has(f.e_code)) {
      const allowed = addrRoster.get(f.e_code);
      if (allowed && allowed.size && !allowed.has(addrKey(f.value))) { drop(f, 'adresse-nicht-haushalt'); continue; }
    }
    kept.push(f);
  }
  return { kept, dropped };
}

// ── Schritt 3: PERSON — A/B-Split (value-getrieben, Seite als Tie-Break) ─
function assignPersons(facts: RawFact[], roster: RosterIndex): Map<RawFact, 'A' | 'B'> {
  const single: 'A' | 'B' | null = roster.personen.length === 1 ? roster.personen[0] : null;
  // Seiten-Person via IdNr-Anker vorab bestimmen (document|page → A/B).
  const pageKey = (f: RawFact) => `${f.document}|${f.page}`;
  const byPage = new Map<string, RawFact[]>();
  for (const f of facts) { const k = pageKey(f); (byPage.get(k) ?? byPage.set(k, []).get(k)!).push(f); }
  const pageOf = new Map<string, 'A' | 'B'>();
  const docOf = new Map<string, 'A' | 'B'>();   // document → eindeutige Person (Anker auf IRGENDEINER Seite)
  const docAmbig = new Set<string>();           // Dokument mit widersprüchlichen Seiten-Ankern → kein Dok-Fallback
  for (const [k, fs] of byPage) {
    // direkter IdNr-Wert auf der Seite?
    let p: 'A' | 'B' | null = null;
    for (const f of fs) if (f.e_code === IDNR_ECODE) { const d = digits(f.value); if (roster.byIdnr.has(d)) { p = roster.byIdnr.get(d)!; break; } }
    // sonst der Anker im rohen page_record ('Ehepartner: Identifikationsnummer' …)
    if (!p && fs[0]?.records.length) p = pagePerson(fs[0].records, roster);
    if (p) {
      pageOf.set(k, p);
      // Dokument-Anker: nur nutzen, wenn das ganze Dokument eindeutig EINER Person gehört.
      const doc = fs[0].document;
      if (docOf.has(doc) && docOf.get(doc) !== p) docAmbig.add(doc);
      else docOf.set(doc, p);
    }
  }
  const out = new Map<RawFact, 'A' | 'B'>();
  for (const f of facts) {
    // (1) Wert selbst trägt die Person (IdNr/Name)
    let p = personFromValue(f.value, f.e_code, roster);
    // (2) Seite trägt die Person (gleiche Seite = gleiche Person)
    if (!p) p = pageOf.get(pageKey(f)) ?? null;
    // (3) Dokument trägt die Person (andere Seite desselben Belegs war eindeutig geankert)
    if (!p && !docAmbig.has(f.document)) p = docOf.get(f.document) ?? null;
    // (4) Single-Mandant (genau eine IdNr/ein Name im Haushalt) → alles Person A.
    //     Zwei Personen, kein Anker → Default A (statt 'unknown' offen zu lassen).
    if (!p) p = single ?? 'A';
    out.set(f, p);
  }
  return out;
}

// ── Schritt 4: VOTE — pro (person,e_code) Mehr-Belege-Mehrheit ──────────
function voteFacts(facts: RawFact[], persons: Map<RawFact, 'A' | 'B'>): MasterFact[] {
  // Gruppieren nach person|e_code.
  const groups = new Map<string, RawFact[]>();
  for (const f of facts) { const k = `${persons.get(f)!}|${f.e_code}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(f); }

  const result: MasterFact[] = [];
  for (const [key, fs] of groups) {
    const [person, e_code] = key.split('|') as ['A' | 'B', string];
    // Kandidaten nach voteKey bündeln; Gewinn = # DISTINCT Belege.
    const cand = new Map<string, { docs: Set<string>; facts: RawFact[]; rep: string }>();
    for (const f of fs) {
      const vk = voteKey(e_code, f.value);
      const c = cand.get(vk) ?? { docs: new Set<string>(), facts: [], rep: f.value };
      c.docs.add(f.document); c.facts.push(f);
      // Repräsentant: bevorzugt einen 'fast'-Wert (deterministischer Treffer), sonst längsten.
      if (f.lane === 'fast' && c.rep !== f.value && c.facts.find((x) => x.lane === 'fast')) c.rep = f.value;
      cand.set(vk, c);
    }
    // Sieger = meiste DISTINCT Belege; Tie → mehr Einzel-Records; Tie → 'fast' dabei.
    const ranked = [...cand.values()].sort((a, b) =>
      b.docs.size - a.docs.size ||
      b.facts.length - a.facts.length ||
      (b.facts.some((f) => f.lane === 'fast') ? 1 : 0) - (a.facts.some((f) => f.lane === 'fast') ? 1 : 0));
    const win = ranked[0];
    const belegfeld_id = win.facts[0].belegfeld_id;
    const sources: FactSource[] = win.facts.map((f) => ({ document: f.document, page: f.page, lane: f.lane, value: f.value, bbox: f.bbox }));
    const fact: MasterFact = { person, e_code, belegfeld_id, value: win.rep, confidence: win.docs.size, sources };
    // Konflikte: weitere roster-konforme Kandidaten (≠ Gewinner) markieren.
    const conflict = ranked.slice(1).map((c) => ({ value: c.rep, documents: [...c.docs] }));
    if (conflict.length) fact.conflict = conflict;
    result.push(fact);
  }
  // Stabil sortieren: Person, dann e_code.
  result.sort((a, b) => (a.person < b.person ? -1 : a.person > b.person ? 1 : a.e_code < b.e_code ? -1 : 1));
  return result;
}

// ── Entitäten aus Roster + tatsächlich gesehenen Personen ───────────────
function buildEntities(roster: RosterIndex, seen: Set<'A' | 'B'>, hh: Household): MasterEntity[] {
  const mk = (p: 'A' | 'B', r?: RosterPerson): MasterEntity => ({
    person: p, idnr: r?.idnr ? digits(r.idnr) : undefined,
    name: [r?.vorname, r?.nachname].filter(Boolean).join(' ') || undefined,
  });
  const ents: MasterEntity[] = [mk('A', hh.personA)];
  if (seen.has('B') || (hh.personB && (hh.personB.idnr || hh.personB.nachname))) ents.push(mk('B', hh.personB));
  return ents;
}

// ── Schritt 4b: DOKUMENT-DEDUP — dasselbe Dokument zweimal (ELSTER-PDF ↔ Scan) ──
/** Versorgungsbezüge etc. dürfen nicht doppelt summiert werden, wenn derselbe
 *  Beleg zweimal vorliegt (z.B. „Witwen Pension.pdf" = gescanntes Original der
 *  LBV-LStB mit IDENTISCHEN Beträgen). Wir bilden je Beleg einen Fingerprint aus
 *  der GESAMTEN Feldmenge (eCode → normalisierter Betrag) und behandeln Belege
 *  mit (nahezu) identischem Fingerprint als EINE Quelle. Der Fingerprint stützt
 *  sich auf Feld-INHALTE, nicht auf den Dateinamen.
 *
 *  Schutz gegen Fehl-Merge zweier legitim verschiedener Belege mit zufällig
 *  gleichem Einzelwert: ein Treffer reicht NICHT — nötig sind ≥3 übereinstimmende
 *  eCode/Wert-Paare ODER ein dominanter (größter) Betrag, der bei BEIDEN Belegen
 *  der Spitzenwert ist und ≥50 % ihrer Felder mit-überlappt. */
function dedupeIncomeDocuments(income: IncomeFact[]): { kept: IncomeFact[]; dropped: Mastercase['verworfen'] } {
  const num = (s: string) => { const n = parseFloat((s || '').replace(/\./g, '').replace(',', '.')); return Number.isNaN(n) ? null : n; };
  // Reihenfolge der Dokumente stabil halten (erstes bleibt kanonisch).
  const order: string[] = [];
  const factsByDoc = new Map<string, IncomeFact[]>();
  for (const f of income) {
    if (!factsByDoc.has(f.document)) { factsByDoc.set(f.document, []); order.push(f.document); }
    factsByDoc.get(f.document)!.push(f);
  }
  // Fingerprint je Beleg: eCode → normalisierter Betrag (letzter Wert je eCode gewinnt).
  const fp = new Map<string, Map<string, number>>();
  for (const doc of order) {
    const m = new Map<string, number>();
    for (const f of factsByDoc.get(doc)!) { const v = num(f.value); if (v != null) m.set(f.eCode, v); }
    fp.set(doc, m);
  }
  const eq = (a: number, b: number) => Math.abs(a - b) <= 0.005 + 0.001 * Math.max(Math.abs(a), Math.abs(b)); // Cent-tolerant
  const maxVal = (m: Map<string, number>) => { let x = -Infinity; for (const v of m.values()) if (Math.abs(v) > Math.abs(x)) x = v; return x; };
  /** Sind zwei Belege dasselbe Dokument? Gesamte Feldmenge vergleichen. */
  const isDuplicate = (a: Map<string, number>, b: Map<string, number>): boolean => {
    if (!a.size || !b.size) return false;
    let matched = 0;
    for (const [ec, va] of a) { const vb = b.get(ec); if (vb != null && eq(va, vb)) matched++; }
    if (matched === 0) return false;
    const frac = matched / Math.min(a.size, b.size);
    if (matched >= 3) return true;                              // viele Paare → eindeutig derselbe Beleg
    if (matched >= 2 && frac >= 0.8) return true;               // hohe Überlappung
    // dominanter Betrag: Spitzenwert BEIDER Belege ist derselbe (+ ≥50 % Überlappung)
    const ma = maxVal(a), mb = maxVal(b);
    if (matched >= 1 && eq(ma, mb) && frac >= 0.5) return true;
    return false;
  };
  const kept: IncomeFact[] = [];
  const dropped: Mastercase['verworfen'] = [];
  const droppedDocs = new Set<string>();
  const canonicalDocs: string[] = [];                          // bereits akzeptierte Belege (Repräsentanten)
  for (const doc of order) {
    const dup = canonicalDocs.find((c) => isDuplicate(fp.get(doc)!, fp.get(c)!));
    if (dup) {
      droppedDocs.add(doc);
      for (const f of factsByDoc.get(doc)!)
        dropped.push({ e_code: f.eCode, belegfeld_id: f.label, value: f.value, document: f.document, page: f.page, grund: 'duplikat-dokument' });
    } else {
      canonicalDocs.push(doc);
    }
  }
  for (const f of income) if (!droppedDocs.has(f.document)) kept.push(f);
  return { kept, dropped };
}

// ── Schritt 5: orchestrieren ────────────────────────────────────────────
// ── Einkommens-Pfad: KAP-Werte aus den page_records über Anker (extract-anchors),
//    pro (Person, e_code) SUMMIERT über alle Belege (mehrere Banken → EINE Anlage KAP). ──
function sumIncome(income: IncomeFact[]): MasterFact[] {
  const parse = (s: string) => { const n = parseFloat(s.replace(/\./g, '').replace(',', '.')); return Number.isNaN(n) ? 0 : n; };
  const fmt = (n: number) => n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const g = new Map<string, IncomeFact[]>();
  for (const f of income) { const k = `${f.person}|${f.eCode}`; (g.get(k) ?? g.set(k, []).get(k)!).push(f); }
  const out: MasterFact[] = [];
  for (const [k, fs] of g) {
    const [person, e_code] = k.split('|') as ['A' | 'B', string];
    const summe = fs.reduce((a, f) => a + parse(f.value), 0);
    const docs = new Set(fs.map((f) => f.document));
    out.push({ person, e_code, belegfeld_id: fs[0].label, value: fmt(summe), confidence: docs.size,
      sources: fs.map((f) => ({ document: f.document, page: f.page, lane: 'rust-anchor', value: f.value, bbox: null })) });
  }
  return out;
}

export function harmonize(outputs: ExtractOutput[], household: Household): Mastercase {
  const roster = buildRoster(household);
  const raw = outputs.flatMap(flatten);
  const { kept, dropped } = filterRoles(raw, roster);
  const persons = assignPersons(kept, roster);
  const stammdaten = voteFacts(kept, persons);                                      // Stammdaten: Vote (stimmen überein)
  // Einkommens-Rohfakten ziehen, dann VOR der Summe Duplikat-Dokumente entfernen
  // (sonst würde z.B. eine doppelt vorliegende LStB die Versorgungsbezüge doppelt zählen).
  const incomeRaw = outputs.flatMap((o) => [...extractAnchoredIncome(o, household), ...extractLstbIncome(o, household)]);  // KAP (Bank) + N/VOR (VaSt-LStB)
  const { kept: incomeKept, dropped: incomeDup } = dedupeIncomeDocuments(incomeRaw);
  const einkommen = sumIncome(incomeKept);                                          // pro (Person, e_code) über DISTINCT Belege summiert
  const fakten = [...stammdaten, ...einkommen];
  const seen = new Set<'A' | 'B'>(fakten.map((f) => f.person));
  const entitaeten = buildEntities(roster, seen, household);
  return { entitaeten, fakten, verworfen: [...dropped, ...incomeDup] };
}

// ── Master Case aus den runLane1-FAKTEN (diagramm-konform) ──────────────
// Der Orchestrator (/api/v1/extract) ist die Lane-2-OCR-Engine für SCANS;
// digitale PDFs liest Lane 1 (pdftotext) bereits sauber. Statt jeden Beleg
// erneut (und verlustbehaftet) durch den Orchestrator zu jagen, konsolidiert
// der Master Case die Fakten, die runLane1 PRO BELEG schon erzeugt hat:
//   belege[].felderListe (eCode·Wert·Person; fremdjährige Belege ausgenommen)
//     → inhaltsgleiche Belege deduplizieren → pro (Person,eCode) über DISTINCT
//       Belege voten. Kein page_records/Geometrie nötig — runLane1 hat bereits
//       gemappt + Person zugeordnet.
export interface BelegFakt { eCode: string; label?: string; wert?: string; person?: string; anlage?: string }
export interface BelegLike { source?: string; vorjahr?: boolean; belegTyp?: string; felderListe?: BelegFakt[] }

export function harmonizeBelege(belege: BelegLike[], household: Household): Mastercase {
  const roster = buildRoster(household);
  interface RF { e_code: string; belegfeld_id: string; value: string; person: 'A' | 'B'; document: string }
  // FLATTEN — nur aktueller VZ (vorjahr-Belege gehören nicht in den Fall).
  const raw: RF[] = [];
  for (const b of belege ?? []) {
    if (b.vorjahr) continue;
    const document = String(b.source ?? '').split('#')[0];
    for (const f of b.felderListe ?? []) {
      const value = String(f.wert ?? '').trim();
      if (!value) continue;
      raw.push({ e_code: f.eCode, belegfeld_id: f.label ?? f.eCode, value, person: f.person === 'B' ? 'B' : 'A', document });
    }
  }
  // DEDUP — inhaltsgleiche Belege (z.B. derselbe Beleg doppelt hochgeladen) als
  // EINE Quelle behandeln, sonst verdoppeln sich Beträge (Bruttoarbeitslohn 2×).
  const order: string[] = [];
  const byDoc = new Map<string, RF[]>();
  for (const f of raw) { if (!byDoc.has(f.document)) { byDoc.set(f.document, []); order.push(f.document); } byDoc.get(f.document)!.push(f); }
  const fp = (fs: RF[]): Map<string, string> => { const m = new Map<string, string>(); for (const f of fs) m.set(`${f.person}|${f.e_code}`, f.value); return m; };
  const fps = new Map(order.map((d) => [d, fp(byDoc.get(d)!)] as const));
  const isDup = (a: Map<string, string>, b: Map<string, string>): boolean => {
    if (!a.size || !b.size) return false;
    let matched = 0; for (const [k, v] of a) if (b.get(k) === v) matched++;
    return matched >= 3 || (matched >= 2 && matched / Math.min(a.size, b.size) >= 0.8);
  };
  const canon: string[] = [];
  const keep = new Set<string>();
  for (const d of order) { if (canon.some((c) => isDup(fps.get(d)!, fps.get(c)!))) continue; canon.push(d); keep.add(d); }
  const kept = raw.filter((f) => keep.has(f.document));
  // VOTE — pro (Person,eCode): Gewinner = von den meisten DISTINCT Belegen bestätigt.
  const groups = new Map<string, RF[]>();
  for (const f of kept) { const k = `${f.person}|${f.e_code}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(f); }
  const fakten: MasterFact[] = [];
  for (const [key, fs] of groups) {
    const [person, e_code] = key.split('|') as ['A' | 'B', string];
    const cand = new Map<string, { docs: Set<string>; rep: string }>();
    for (const f of fs) { const vk = voteKey(e_code, f.value); const c = cand.get(vk) ?? { docs: new Set<string>(), rep: f.value }; c.docs.add(f.document); cand.set(vk, c); }
    const ranked = [...cand.entries()].sort((a, b) => b[1].docs.size - a[1].docs.size);
    const [winVk, win] = ranked[0];
    const sources: FactSource[] = fs.filter((f) => voteKey(e_code, f.value) === winVk).map((f) => ({ document: f.document, page: 0, lane: 'lane1', value: f.value, bbox: null }));
    const fact: MasterFact = { person, e_code, belegfeld_id: fs[0].belegfeld_id, value: win.rep, confidence: win.docs.size, sources };
    const conflict = ranked.slice(1).map(([, c]) => ({ value: c.rep, documents: [...c.docs] }));
    if (conflict.length) fact.conflict = conflict;
    fakten.push(fact);
  }
  fakten.sort((a, b) => (a.person < b.person ? -1 : a.person > b.person ? 1 : a.e_code < b.e_code ? -1 : 1));
  const seen = new Set<'A' | 'B'>(fakten.map((f) => f.person));
  return { entitaeten: buildEntities(roster, seen, household), fakten, verworfen: [] };
}

// ── optionales main(): Real-Samples laden + drucken ─────────────────────
const SAMPLE_DIR = process.env.MC_SAMPLES ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'var', 'extract-samples');
// Bank-Belege + VaSt (eDaten). ex_est lassen wir bewusst weg, weil es die
// reinen Stammdaten enthält; der Harmonizer soll am verrauschten Bank-/VaSt-Set
// zeigen, dass er Bank-Namen/-Adressen filtert. (ex_0..ex_5 sind stale.)
const SAMPLE_FILES = ['ex_b4', 'ex_b5', 'ex_b6', 'ex_b7', 'ex_b8', 'ex_vast'];
const STRICKER: Household = {
  personA: { idnr: '85236749007', vorname: 'Rainer', nachname: 'Stricker' },
  personB: { idnr: '54129386608', vorname: 'Maria Ute', nachname: 'Stricker' },
};

function main(): void {
  const args = process.argv.slice(2);
  const files = args.length ? args : SAMPLE_FILES.map((n) => join(SAMPLE_DIR, `${n}.json`));
  const outputs: ExtractOutput[] = [];
  for (const f of files) {
    if (!existsSync(f)) { console.error(`skip (fehlt): ${f}`); continue; }
    outputs.push(JSON.parse(readFileSync(f, 'utf8')) as ExtractOutput);
  }
  const mc = harmonize(outputs, STRICKER);

  console.log(`\n╔══ MASTERCASE (harmonisiert) · ${outputs.length} Belege ══`);
  console.log(`\nENTITÄTEN`);
  for (const e of mc.entitaeten) console.log(`  Person ${e.person} · ${e.name ?? '?'} · IdNr ${e.idnr ?? '?'}`);

  console.log(`\nFAKTEN  (person · e_code · belegfeld_id = wert · conf=#Belege)`);
  for (const f of mc.fakten) {
    const conf = `conf=${f.confidence}`;
    const cflt = f.conflict ? `  ⚠ konflikt: ${f.conflict.map((c) => `${c.value}[${c.documents.length}]`).join(', ')}` : '';
    console.log(`  ${f.person}  ${f.e_code}  ${f.belegfeld_id.padEnd(30)} = ${String(f.value).padEnd(22)} ${conf}${cflt}`);
  }

  console.log(`\nVERWORFEN (Rolle-Filter: Bank/Gläubiger/Müll) — ${mc.verworfen.length}`);
  for (const d of mc.verworfen)
    console.log(`  ✗ ${d.e_code}  ${d.belegfeld_id.padEnd(30)} = ${String(d.value).padEnd(28)} [${d.grund}]`);

  console.log(`\n── ${mc.fakten.length} Fakten · A: ${mc.fakten.filter((f) => f.person === 'A').length} · B: ${mc.fakten.filter((f) => f.person === 'B').length} · ${mc.verworfen.length} verworfen ──`);
}

// Nur als Skript ausführen, nicht beim Import (server.ts nutzt harmonize()).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
