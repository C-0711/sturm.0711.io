/**
 * adapter — Brücke von gemappten ELSTER-E-Codes (runLane1-Output) auf die
 * semantischen Einkommensbausteine des Rechenkerns (einkommen.ts/engine.ts).
 *
 * ════════════════════════════════════════════════════════════════════════
 *  Reine, I/O-freie Funktion. Bildet die einkommens-/steuerrelevanten
 *  E-Codes je Person ab; Identitäts-/Adress-/Religion-Felder werden
 *  ignoriert (sie fließen nicht in die Bemessungsgrundlage).
 *
 *  KONFLIKT-AUFLÖSUNG: ein Fall kann denselben E-Code je Person mehrfach
 *  tragen (verschiedene Belege/Sections, OCR-Varianten). Für Einkünfte wird
 *  der GRÖSSTE plausible Wert je (eCode, person) genommen (eine LStB mit
 *  Volljahres-Brutto schlägt eine unterjährige), für Abzugsteuern die SUMME
 *  (mehrere Arbeitgeber → mehrere LSt-Beträge). Beide Strategien sind
 *  dokumentiert und über `notes` im Ergebnis nachvollziehbar.
 *
 *  WICHTIG: Der Aufrufer MUSS sicherstellen, dass die Felder zu EINEM
 *  Steuerpflichtigen (bzw. einer Ehegatten-Veranlagung) gehören. Werden
 *  Belege verschiedener Personen in einen Fall gemischt, ist das Ergebnis
 *  bedeutungslos — `bausteineAusFelder` rechnet, was es bekommt.
 * ════════════════════════════════════════════════════════════════════════
 */
import type { PersonenEinkommen, SteuerfallEingabe } from './einkommen.ts';
import type { Anrechnung } from './engine.ts';
import type { Veranlagungsart } from './tarif.ts';

/** Minimaler Feld-Shape (Teilmenge von MappedField). */
export interface SteuerFeld {
  eCode: string;
  /** Normalisierter Wert (deutsches Format, z.B. "1.234,56" oder "1234"). */
  wert: string;
  person: 'A' | 'B';
  anlage?: string;
  pdfLabel?: string;
}

/** Deutsches Zahlformat → JS-number. "1.234,56" → 1234.56; "" → null. */
export function parseEuro(wert: string | undefined): number | null {
  if (!wert) return null;
  const s = wert.trim().replace(/[^\d.,-]/g, '');
  if (!s) return null;
  // Tausenderpunkt entfernen, Dezimalkomma → Punkt.
  const norm = s.replace(/\./g, '').replace(',', '.');
  const n = Number(norm);
  return Number.isFinite(n) ? n : null;
}

/** § 22 EStG — Besteuerungsanteil nach Jahr des Rentenbeginns (Kohorte).
 *  Tabelle § 22 Nr. 1 Satz 3 Buchst. a Doppelbuchst. aa. */
export function besteuerungsanteil(rentenbeginnJahr: number): number {
  if (rentenbeginnJahr <= 2005) return 0.50;
  if (rentenbeginnJahr >= 2040) return 1.0;
  if (rentenbeginnJahr <= 2020) return 0.50 + (rentenbeginnJahr - 2005) * 0.02; // 2%/Jahr
  return 0.80 + (rentenbeginnJahr - 2020) * 0.01;                                // 1%/Jahr
}

// ── E-Code → semantische Rolle ───────────────────────────────────────────
//   AUTORITATIVE VOKABULAR-AUSRICHTUNG: die Code-Mengen spiegeln die
//   `lane1_bmf_calculator.module_mappings` der BMF-MCP (Single Source of
//   Truth), ergänzt um die vom sturm-Extraktor erzeugten Codes — so
//   konsumieren In-Process-Kern und MCP DASSELBE Vokabular (Conformance-
//   Befund: ungleiche Codes waren ~90% der zvE-Divergenz).
const ECODE_BRUTTOLOHN = new Set(['E0200201', 'E0200204', 'E0200203']); // tarif_32a.bruttolohn
const ECODE_LOHNSTEUER = new Set(['E0200301', 'E0200303']);
const ECODE_SOLI_ABZUG = new Set(['E0200401', 'E0200403']);
const ECODE_KIST_ABZUG = new Set(['E0200501', 'E0200503', 'E0200601']);
// anlage_r.rente_brutto (MCP) + Extraktor-Codes:
const ECODE_RENTE = new Set(['E2400103', 'E2400203', 'E1800301', 'E1803102']);
const ECODE_RENTENBEGINN = new Set(['E2400107', 'E2400207', 'E1800501', 'E1803202']);
// Rentenanpassungsbetrag (voll steuerpflichtig) → festgeschriebener Rentenfreibetrag.
const ECODE_RENTEN_ANPASSUNG = new Set(['E1800606', 'E2400106', 'E2400206']);
const ECODE_KAP_ERTRAG = new Set(['E1900701']);
const ECODE_KAP_STEUER = new Set(['E1904701']);
// Geleistete Vorauszahlungen (intern, aus der Steuerkontoabfrage injiziert) —
// ESt/SolZ/KiSt; werden wie einbehaltene Abzugsteuern auf die Festsetzung
// angerechnet. Keine ELSTER-Deklarationsfelder, daher interne Codes.
const ECODE_VORAUSZAHLUNG = new Set(['VZ_EST', 'VZ_SOLZ', 'VZ_KIST']);
// vorsorgeaufwand: rv_beitraege + ruerup + av (§10 Abs.1 Nr.2):
const ECODE_ALTERSVORSORGE = new Set([
  'E0202204', 'E2000401',           // rv_beitraege (MCP)
  'E0202704', 'E2004403',           // av_beitraege (MCP)
  'E2003001', 'E2003002',           // ruerup_beitraege (MCP)
  'E2000601', 'E2000501',           // Extraktor-Varianten
]);
// vorsorgeaufwand: kv_beitraege + pv_beitraege (§10 Abs.1 Nr.3):
const ECODE_KV_PV_BASIS = new Set([
  'E0202504', 'E2001203', 'E2004003', 'E2003104', // kv_beitraege (MCP)
  'E0202604', 'E2001505', 'E2004103', 'E2003202', // pv_beitraege (MCP)
]);

interface PersonAkku {
  bruttolohn: number[];
  lohnsteuer: number;
  soli: number;
  kist: number;
  rente: number;
  rentenbeginn: number | null;
  rentenAnpassung: number;
  kapErtrag: number;
  kapSteuer: number;
  altersvorsorge: number;
  kvPv: number;
  vorauszahlung: number;
  geburtsjahr?: number;
}
const emptyAkku = (): PersonAkku => ({
  bruttolohn: [], lohnsteuer: 0, soli: 0, kist: 0, rente: 0,
  rentenbeginn: null, rentenAnpassung: 0, kapErtrag: 0, kapSteuer: 0, altersvorsorge: 0, kvPv: 0, vorauszahlung: 0,
});

export interface AdapterErgebnis {
  eingabe: SteuerfallEingabe;
  anrechnung: Anrechnung;
  kirchensteuerHebesatz: number;
  notes: string[];
}

/**
 * Mappt gemappte Felder EINES Steuerfalls auf Rechenkern-Eingaben.
 * @param art  Veranlagungsart (default: 'zusammen' wenn Person B Einkünfte hat).
 * @param vz   Veranlagungszeitraum (für Geburtsjahr/Altersentlastung).
 */
export function bausteineAusFelder(
  felder: SteuerFeld[],
  opts: { vz: number; art?: Veranlagungsart; kirchensteuerHebesatz?: number } = { vz: 2023 },
): AdapterErgebnis {
  const akku: Record<'A' | 'B', PersonAkku> = { A: emptyAkku(), B: emptyAkku() };
  const notes: string[] = [];

  for (const f of felder) {
    const p = akku[f.person] ?? akku.A;
    const n = parseEuro(f.wert);
    if (ECODE_BRUTTOLOHN.has(f.eCode)) { if (n && n > 0) p.bruttolohn.push(n); }
    else if (ECODE_LOHNSTEUER.has(f.eCode)) { if (n) p.lohnsteuer += n; }
    else if (ECODE_SOLI_ABZUG.has(f.eCode)) { if (n) p.soli += n; }
    else if (ECODE_KIST_ABZUG.has(f.eCode)) { if (n) p.kist += n; }
    else if (ECODE_VORAUSZAHLUNG.has(f.eCode)) { if (n) p.vorauszahlung += n; }
    else if (ECODE_RENTE.has(f.eCode)) { if (n) p.rente += n; }
    else if (ECODE_RENTEN_ANPASSUNG.has(f.eCode)) { if (n) p.rentenAnpassung += n; }
    else if (ECODE_RENTENBEGINN.has(f.eCode)) {
      const yr = parseInt((f.wert.match(/(19|20)\d{2}/) ?? [])[0] ?? '', 10);
      if (yr) p.rentenbeginn = p.rentenbeginn ? Math.min(p.rentenbeginn, yr) : yr;
    }
    else if (ECODE_KAP_ERTRAG.has(f.eCode)) { if (n) p.kapErtrag += n; }
    else if (ECODE_KAP_STEUER.has(f.eCode)) { if (n) p.kapSteuer += n; }
    else if (ECODE_ALTERSVORSORGE.has(f.eCode)) { if (n) p.altersvorsorge += n; }
    else if (ECODE_KV_PV_BASIS.has(f.eCode)) { if (n) p.kvPv += n; }
    else if (f.eCode === 'E0100401' || f.eCode === 'E0100801') {
      const yr = parseInt((f.wert.match(/(19|20)\d{2}/) ?? [])[0] ?? '', 10);
      if (yr) p.geburtsjahr = yr;
    }
  }

  const toPerson = (a: PersonAkku, who: string): PersonenEinkommen => {
    // Konflikt: mehrere Bruttolohn-Werte → größter (Volljahr schlägt Teiljahr).
    let lohn = 0;
    if (a.bruttolohn.length > 0) {
      lohn = Math.max(...a.bruttolohn);
      if (a.bruttolohn.length > 1) {
        notes.push(`Person ${who}: ${a.bruttolohn.length} Bruttolohn-Werte ${JSON.stringify(a.bruttolohn)} → größter (${lohn}) gewählt.`);
      }
    }
    const renten = a.rente > 0
      ? [{ jahresbetrag: a.rente, besteuerungsanteil: besteuerungsanteil(a.rentenbeginn ?? 2005),
           // Festgeschriebener Rentenfreibetrag (§22): steuerpflichtig = Brutto −
           // (1−Anteil)×(Brutto − Anpassungsbetrag). Ohne Anpassung kollabiert das
           // zur reinen Besteuerungsanteil-Formel (= bisheriges Verhalten).
           steuerpflichtigerAnteil: round2(a.rente - (1 - besteuerungsanteil(a.rentenbeginn ?? 2005)) * Math.max(0, a.rente - a.rentenAnpassung)) }]
      : [];
    if (renten.length) notes.push(`Person ${who}: Rente ${a.rente} × Besteuerungsanteil(${a.rentenbeginn ?? 2005})=${besteuerungsanteil(a.rentenbeginn ?? 2005).toFixed(2)}.`);
    return {
      bruttoarbeitslohn: lohn,
      altersvorsorgeaufwand: a.altersvorsorge,
      kvPvBasisbeitrag: a.kvPv,
      renten,
      geburtsjahr: a.geburtsjahr,
    };
  };

  const personA = toPerson(akku.A, 'A');
  const personB = toPerson(akku.B, 'B');
  const bHatEinkunft = (personB.bruttoarbeitslohn ?? 0) > 0 || (personB.renten?.length ?? 0) > 0;
  const art: Veranlagungsart = opts.art ?? (bHatEinkunft ? 'zusammen' : 'einzeln');

  const anrechnung: Anrechnung = {
    lohnsteuer: round2(akku.A.lohnsteuer + akku.B.lohnsteuer),
    solidaritaetszuschlag: round2(akku.A.soli + akku.B.soli),
    kirchensteuer: round2(akku.A.kist + akku.B.kist),
    kapitalertragsteuer: round2(akku.A.kapSteuer + akku.B.kapSteuer),
    vorauszahlungen: round2(akku.A.vorauszahlung + akku.B.vorauszahlung),
  };

  return {
    eingabe: { vz: opts.vz, art, personA, personB: bHatEinkunft ? personB : undefined },
    anrechnung,
    kirchensteuerHebesatz: opts.kirchensteuerHebesatz ?? 0,
    notes,
  };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
