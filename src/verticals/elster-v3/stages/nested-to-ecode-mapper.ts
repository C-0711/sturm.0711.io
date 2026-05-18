/**
 * @deprecated 2026-05-18 — DUPLICATE of canonical projection logic in
 *   src/verticals/elster/lib/deterministic-rules.ts (PROJECTION_RULES +
 *   applyProjections()). Wird in PHASE 3 vollständig entfernt zusammen mit
 *   dem Konsumenten-Refactor (layer1-prepop-stage ruft applyProjections()
 *   statt nestedToECodes()). Bis dahin bleibt diese Datei nur weil
 *   layer1-prepop-stage.ts noch importiert.
 *
 * Original-Doku (zum Verständnis):
 * Mapper: Layer-1 nested JSON → flacher canonical_layer eCode-Record für
 * phase5-merge. Hardcoded Pfad→eCode pro doc_class. Wird ersetzt durch die
 * Container-deklarative rules.json (gebaut aus PROJECTION_RULES).
 */
import type { DocClass } from '../data/belegtyp-doc-class.ts';

export interface ECodeEntry {
  eCode: string;
  value: string;
  normalized: string | null;
  normalizedNumber?: number;
  datentyp: 'string' | 'date' | 'currency' | 'integer';
  anlage: string;
  drucktext: string;
  vordruckzeile: string;
  origin: 'LAYER1_NESTED';
  trust: 'high';
  /** Belegstelle für confirmed_by[]. */
  source: { filename?: string; page?: number; pathInNested: string };
}

interface MapContext {
  filename?: string;
  page?: number;
  /** "rolle hauptperson" → Person A; "rolle ehegatte_lebenspartner" → Person B.
   *  Anlage-Slots mit _A/_B-Varianten verwenden das. */
  personRole?: 'hauptperson' | 'ehegatte_lebenspartner' | 'unbekannt' | null;
}

function num(v: unknown): { value: string; normalized: string; normalizedNumber: number } | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  // ELSTER-Normalisierung: Cents als Integer? Hier behalten wir den Float —
  // phase5-merge/canonicalLayerToElsterFelder kennt currency-Normalisierung.
  return { value: String(v), normalized: n.toFixed(2), normalizedNumber: n };
}

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

// ── LStB ─────────────────────────────────────────────────────────────
function mapLohnsteuerbescheinigung(nested: any, ctx: MapContext): ECodeEntry[] {
  const out: ECodeEntry[] = [];
  const an = nested?.arbeitnehmer ?? {};
  const lohn = nested?.lohn ?? {};
  const soz = nested?.sozialversicherung ?? {};
  const vers = nested?.versorgungsbezug ?? {};

  const push = (eCode: string, raw: unknown, anlage: string, vordruckzeile: string, drucktext: string, datentyp: ECodeEntry['datentyp'], pathInNested: string) => {
    if (raw == null) return;
    if (datentyp === 'currency') {
      const n = num(raw);
      if (!n) return;
      out.push({
        eCode, value: n.value, normalized: n.normalized, normalizedNumber: n.normalizedNumber,
        datentyp, anlage, drucktext, vordruckzeile,
        origin: 'LAYER1_NESTED', trust: 'high',
        source: { filename: ctx.filename, page: ctx.page, pathInNested },
      });
    } else {
      const s = str(raw);
      if (!s) return;
      out.push({
        eCode, value: s, normalized: s,
        datentyp, anlage, drucktext, vordruckzeile,
        origin: 'LAYER1_NESTED', trust: 'high',
        source: { filename: ctx.filename, page: ctx.page, pathInNested },
      });
    }
  };

  // Arbeitnehmer-Stammdaten → ESt1A
  push('E0100201', an.familienname, 'ESt1A', '4', 'Familienname', 'string', 'arbeitnehmer.familienname');
  push('E0100301', an.vorname, 'ESt1A', '5', 'Vorname', 'string', 'arbeitnehmer.vorname');
  push('E0100081', an.steuer_id, 'ESt1A', '7', 'Identifikationsnummer', 'string', 'arbeitnehmer.steuer_id');
  push('E0100402', an.konfession, 'ESt1A', '8', 'Religion (Hauptperson)', 'string', 'arbeitnehmer.konfession');
  push('E0100502', an.konfession_ehegatte, 'ESt1A', '17', 'Religion (Ehegatte)', 'string', 'arbeitnehmer.konfession_ehegatte');

  // LStB-Hauptzeilen → Anlage N (Z.5-9)
  push('E0200002', an.steuerklasse, 'N', '4', 'Steuerklasse', 'string', 'arbeitnehmer.steuerklasse');
  push('E0200201', lohn.bruttoarbeitslohn, 'N', '5', 'Bruttoarbeitslohn', 'currency', 'lohn.bruttoarbeitslohn');
  push('E0200301', lohn.lohnsteuer_einbehalten, 'N', '6', 'Lohnsteuer', 'currency', 'lohn.lohnsteuer_einbehalten');
  push('E0200401', lohn.solidaritaetszuschlag_einbehalten, 'N', '7', 'Solidaritätszuschlag', 'currency', 'lohn.solidaritaetszuschlag_einbehalten');
  push('E0200501', lohn.kirchensteuer_arbeitnehmer_einbehalten, 'N', '8', 'Kirchensteuer des Arbeitnehmers', 'currency', 'lohn.kirchensteuer_arbeitnehmer_einbehalten');
  push('E0200601', lohn.kirchensteuer_ehegatte_einbehalten, 'N', '9', 'Kirchensteuer des Ehegatten (Konfessionsverschiedenheit)', 'currency', 'lohn.kirchensteuer_ehegatte_einbehalten');

  // Versorgungsbezug → Anlage N (Z.8, Z.29, Z.30) — optional
  push('E0200801', vers.versorgungsbezug_brutto, 'N', '8', 'Steuerbegünstigte Versorgungsbezüge', 'currency', 'versorgungsbezug.versorgungsbezug_brutto');
  push('E0200902', vers.bemessungsgrundlage_freibetrag, 'N', '29', 'Bemessungsgrundlage Versorgungsfreibetrag', 'currency', 'versorgungsbezug.bemessungsgrundlage_freibetrag');
  push('E0201307', vers.versorgungsbeginn_jahr, 'N', '30', 'Versorgungsbeginn Jahr', 'integer', 'versorgungsbezug.versorgungsbeginn_jahr');

  // Sozialvers Z.22-27 → Anlage VOR (kritisch — bisher fehlte alles)
  push('E2000401', soz.rv_arbeitnehmer, 'VOR', '4', 'Arbeitnehmeranteil RV', 'currency', 'sozialversicherung.rv_arbeitnehmer');
  push('E2000801', soz.rv_arbeitgeber, 'VOR', '9', 'Arbeitgeberanteil RV', 'currency', 'sozialversicherung.rv_arbeitgeber');
  push('E2000501', soz.berufsstaendisch_arbeitnehmer, 'VOR', '5', 'AN-Anteil berufsständische Versorgung', 'currency', 'sozialversicherung.berufsstaendisch_arbeitnehmer');
  push('E2001203', soz.kv_arbeitnehmer, 'VOR', '11', 'AN-Beiträge gesetzliche KV', 'currency', 'sozialversicherung.kv_arbeitnehmer');
  push('E2001505', soz.pv_arbeitnehmer, 'VOR', '13', 'AN-Beiträge soziale PV', 'currency', 'sozialversicherung.pv_arbeitnehmer');
  push('E2004403', soz.av_arbeitnehmer, 'VOR', '43', 'AN-Beiträge gesetzliche Arbeitslosenvers', 'currency', 'sozialversicherung.av_arbeitnehmer');

  return out;
}

// ── Religionszugehörigkeit ──────────────────────────────────────────
function mapReligionszugehoerigkeit(nested: any, _ctx: MapContext): ECodeEntry[] {
  const out: ECodeEntry[] = [];
  const personen = Array.isArray(nested?.personen) ? nested.personen : [];
  for (const p of personen) {
    const rolle = String(p?.rolle ?? '').toLowerCase();
    const ist_haupt = rolle === 'hauptperson';
    const ist_ehe = rolle === 'ehegatte_lebenspartner';
    // konfession_raw fallback wenn Gemma "evangelisch" statt "ev" geliefert hat
    const konfRaw = String(p?.konfession ?? p?.konfession_raw ?? '').toLowerCase();
    const konfMap: Record<string, string> = {
      'evangelisch': 'ev', 'ev': 'ev',
      'römisch-katholisch': 'rk', 'roemisch-katholisch': 'rk', 'rk': 'rk', 'roemisch_katholisch': 'rk',
      'altkatholisch': 'ak', 'ak': 'ak',
      'israelitisch': 'is', 'is': 'is', 'jüdisch': 'is',
      'freireligiös': 'fr', 'freireligioes': 'fr', 'fr': 'fr',
      'lutherisch': 'lt', 'lt': 'lt',
      'reformiert': 'rf', 'rf': 'rf',
    };
    const konf = konfMap[konfRaw] ?? konfRaw ?? '';
    if (ist_haupt) {
      if (p?.steuer_id) out.push({
        eCode: 'E0100081', value: String(p.steuer_id), normalized: String(p.steuer_id),
        datentyp: 'string', anlage: 'ESt1A', drucktext: 'Identifikationsnummer (Hauptperson)', vordruckzeile: '7',
        origin: 'LAYER1_NESTED', trust: 'high',
        source: { filename: _ctx.filename, page: _ctx.page, pathInNested: 'personen[].steuer_id (hauptperson)' },
      });
      if (konf) out.push({
        eCode: 'E0100402', value: konf, normalized: konf,
        datentyp: 'string', anlage: 'ESt1A', drucktext: 'Religion (Hauptperson)', vordruckzeile: '8',
        origin: 'LAYER1_NESTED', trust: 'high',
        source: { filename: _ctx.filename, page: _ctx.page, pathInNested: 'personen[].konfession (hauptperson)' },
      });
    } else if (ist_ehe) {
      if (p?.steuer_id) out.push({
        eCode: 'E0100082', value: String(p.steuer_id), normalized: String(p.steuer_id),
        datentyp: 'string', anlage: 'ESt1A', drucktext: 'Identifikationsnummer (Ehegatte)', vordruckzeile: '16',
        origin: 'LAYER1_NESTED', trust: 'high',
        source: { filename: _ctx.filename, page: _ctx.page, pathInNested: 'personen[].steuer_id (ehegatte)' },
      });
      if (konf) out.push({
        eCode: 'E0100502', value: konf, normalized: konf,
        datentyp: 'string', anlage: 'ESt1A', drucktext: 'Religion (Ehegatte)', vordruckzeile: '17',
        origin: 'LAYER1_NESTED', trust: 'high',
        source: { filename: _ctx.filename, page: _ctx.page, pathInNested: 'personen[].konfession (ehegatte)' },
      });
    }
  }
  return out;
}

// ── Mitteilung Kapitalerträge (Freistellungs-Mitteilung) ─────────────
function mapMitteilungKapitalertraege(nested: any, ctx: MapContext): ECodeEntry[] {
  const out: ECodeEntry[] = [];
  const person = nested?.person ?? {};
  const partner = nested?.ehepartner ?? {};
  const fk = Array.isArray(nested?.freigestellte_kapitalertraege) ? nested.freigestellte_kapitalertraege : [];

  // Person-IdNrs → ESt1A
  if (person.steuer_id) out.push({
    eCode: 'E0100081', value: String(person.steuer_id), normalized: String(person.steuer_id),
    datentyp: 'string', anlage: 'ESt1A', drucktext: 'Identifikationsnummer (Hauptperson)', vordruckzeile: '7',
    origin: 'LAYER1_NESTED', trust: 'high',
    source: { filename: ctx.filename, page: ctx.page, pathInNested: 'person.steuer_id' },
  });
  if (partner.steuer_id) out.push({
    eCode: 'E0100082', value: String(partner.steuer_id), normalized: String(partner.steuer_id),
    datentyp: 'string', anlage: 'ESt1A', drucktext: 'Identifikationsnummer (Ehegatte)', vordruckzeile: '16',
    origin: 'LAYER1_NESTED', trust: 'high',
    source: { filename: ctx.filename, page: ctx.page, pathInNested: 'ehepartner.steuer_id' },
  });

  // Summe freigestellt → KAP Sparer-Pauschbetrag inanspruchgenommen.
  // Bei Multi-Mitteilung addiert der Aggregator über mehrere Belege.
  let summe = 0;
  for (const f of fk) {
    const betrag = Number(f?.betrag_eur);
    if (Number.isFinite(betrag)) summe += betrag;
  }
  if (summe > 0) {
    out.push({
      eCode: 'E1901401', value: String(summe), normalized: summe.toFixed(2), normalizedNumber: summe,
      datentyp: 'currency', anlage: 'KAP', drucktext: 'In Anspruch genommener Sparer-Pauschbetrag', vordruckzeile: '14',
      origin: 'LAYER1_NESTED', trust: 'high',
      source: { filename: ctx.filename, page: ctx.page, pathInNested: 'summen.summe_freigestellt_eur (computed)' },
    });
  }

  return out;
}

// ── Dispatcher ──────────────────────────────────────────────────────
export function nestedToECodes(
  docClass: DocClass,
  nested: unknown,
  ctx: MapContext = {},
): ECodeEntry[] {
  if (!nested || typeof nested !== 'object') return [];
  switch (docClass) {
    case 'lohnsteuerbescheinigung': return mapLohnsteuerbescheinigung(nested, ctx);
    case 'religionszugehoerigkeit': return mapReligionszugehoerigkeit(nested, ctx);
    case 'mitteilung_kapitalertraege': return mapMitteilungKapitalertraege(nested, ctx);
    // TODO: steuerbescheinigung_kapitalertraege, personaldaten_hauptvordruck, spendenquittung, rentenbezugsmitteilung
    default: return [];
  }
}

/** Person-Cluster aus mehreren Belegen extrahieren: erste IdNr = Person A. */
export interface PersonCluster {
  A?: string;
  B?: string | null;
}

export function clusterPersonen(allEntries: ECodeEntry[]): PersonCluster {
  // E0100081 = Hauptperson IdNr, E0100082 = Ehegatte IdNr
  const a = allEntries.find((e) => e.eCode === 'E0100081')?.value;
  const b = allEntries.find((e) => e.eCode === 'E0100082')?.value;
  return { A: a, B: b ?? null };
}
