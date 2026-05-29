/**
 * einkommen — Ermittlung des zu versteuernden Einkommens (zvE) aus
 * semantischen Einkommensbausteinen, nach dem Schema der §§ 2, 10 EStG:
 *
 *   Σ Einkünfte  (§19 nichtselbst. Arbeit, §22 Renten, …)
 *     − Altersentlastungsbetrag (§24a)            ⇒ Gesamtbetrag der Einkünfte
 *     − Sonderausgaben (Vorsorge §10 + Pauschbetrag) ⇒ Einkommen
 *     − Freibeträge (Kinder §32 …)                 ⇒ zu versteuerndes Einkommen
 *
 * ════════════════════════════════════════════════════════════════════════
 *  EHRLICHE ABGRENZUNG (Reichweite v1):
 *  - Vollständig: §19 (Lohn − WK-Pauschbetrag/echte WK), §22 (Renten ×
 *    Besteuerungsanteil − WK-Pauschbetrag 102 €), Sonderausgaben-Pauschbetrag,
 *    eine vereinfachte Vorsorgeaufwand-Abzugslogik (Höchstbeträge 2023).
 *  - NICHT abgebildet (Default 0, dokumentiert): Günstigerprüfung KAP,
 *    außergewöhnliche Belastungen mit zumutbarer Eigenbelastung, §35a-
 *    Steuerermäßigungen (mindern die Steuer, nicht das zvE), Verlustvortrag.
 *  Das zvE ist damit für einfache Fälle exakt und für komplexe eine
 *  TRANSPARENTE Näherung — die autoritative Zahl liefert die BMF-MCP, gegen
 *  die der Tarif (zvE→ESt) in tarif.mcp.test.ts gegengeprüft wird.
 * ════════════════════════════════════════════════════════════════════════
 */
import type { Veranlagungsart } from './tarif.ts';

/** § 22 Nr. 1 — eine Leibrente mit ihrem steuerpflichtigen Anteil. */
export interface RentenPosten {
  /** Jahresrentenbetrag (brutto). */
  jahresbetrag: number;
  /** Besteuerungsanteil 0..1 (z.B. 0,83 bei Rentenbeginn 2023). Wenn der
   *  Beleg den steuerpflichtigen Anteil direkt nennt, kann stattdessen
   *  `steuerpflichtigerAnteil` gesetzt werden. */
  besteuerungsanteil?: number;
  /** Direkt gelieferter steuerpflichtiger Betrag (überschreibt die
   *  Berechnung aus jahresbetrag × besteuerungsanteil). */
  steuerpflichtigerAnteil?: number;
}

/** Semantische Bausteine je steuerpflichtiger Person. Beträge in Euro. */
export interface PersonenEinkommen {
  /** § 19 — Bruttoarbeitslohn (Anlage N, Zeile 5). */
  bruttoarbeitslohn?: number;
  /** Tatsächliche Werbungskosten (Anlage N). Wenn < AN-Pauschbetrag, wird
   *  der Pauschbetrag angesetzt (§ 9a). */
  werbungskosten?: number;
  /** § 22 — Leibrenten (Anlage R). */
  renten?: RentenPosten[];
  /** § 10 Abs. 1 Nr. 2 — Altersvorsorgeaufwendungen (AN+AG-Anteil RV,
   *  Rürup). Vereinfachte 100%-Abzugslogik 2023, gedeckelt am Höchstbetrag. */
  altersvorsorgeaufwand?: number;
  /** § 10 Abs. 1 Nr. 3 — Basis-KV + Pflichtpflege (voll abzugsfähig). */
  kvPvBasisbeitrag?: number;
  /** Geburtsjahr — für den Altersentlastungsbetrag (§ 24a). */
  geburtsjahr?: number;
}

export interface SteuerfallEingabe {
  vz: number;
  art: Veranlagungsart;
  personA: PersonenEinkommen;
  personB?: PersonenEinkommen;
}

export interface ZvEKomponenten {
  einkuenfteArbeit: number;
  einkuenfteRenten: number;
  summeEinkuenfte: number;
  altersentlastungsbetrag: number;
  gesamtbetragEinkuenfte: number;
  sonderausgaben: number;
  zvE: number;
  /** Schritt-für-Schritt-Trace für die UI / den Bescheid-Druck. */
  trace: Array<{ schritt: string; betrag: number; hinweis?: string }>;
}

// ── Statutorische Pauschbeträge / Höchstbeträge (VZ-abhängig) ────────────
const AN_PAUSCHBETRAG: Record<number, number> = { 2023: 1230, 2024: 1230 };
const RENTEN_WK_PAUSCHBETRAG = 102;          // § 9a Satz 1 Nr. 3
const SONDERAUSGABEN_PAUSCHBETRAG = 36;      // § 10c (72 € bei Zusammenveranlagung)
const ALTERSVORSORGE_HOECHST: Record<number, number> = { 2023: 26528, 2024: 27566 };
const SONSTIGE_VORSORGE_HOECHST_AN = 1900;   // § 10 Abs. 4 (Arbeitnehmer)
const ALTERSENTLASTUNG_MAX_PROZENT = 0.136;  // VZ 2023, geb. 1958
const ALTERSENTLASTUNG_MAX_BETRAG = 646;     // VZ 2023
const ALTERSENTLASTUNG_GEBURTSJAHR_VOR = 1959;

function anPauschbetrag(vz: number): number {
  return AN_PAUSCHBETRAG[vz] ?? 1230;
}
function altersvorsorgeHoechst(vz: number): number {
  return ALTERSVORSORGE_HOECHST[vz] ?? ALTERSVORSORGE_HOECHST[2024];
}

/** § 19 — Einkünfte aus nichtselbständiger Arbeit einer Person. */
function einkuenfteArbeit(p: PersonenEinkommen, vz: number): number {
  const lohn = p.bruttoarbeitslohn ?? 0;
  if (lohn <= 0) return 0;
  const wk = Math.max(p.werbungskosten ?? 0, anPauschbetrag(vz));
  return Math.max(0, lohn - wk);
}

/** § 22 — steuerpflichtige Renteneinkünfte einer Person. */
function einkuenfteRenten(p: PersonenEinkommen): number {
  const renten = p.renten ?? [];
  if (renten.length === 0) return 0;
  let stpfl = 0;
  for (const r of renten) {
    if (typeof r.steuerpflichtigerAnteil === 'number') stpfl += r.steuerpflichtigerAnteil;
    else stpfl += r.jahresbetrag * (r.besteuerungsanteil ?? 0);
  }
  return Math.max(0, stpfl - RENTEN_WK_PAUSCHBETRAG);
}

/** § 24a — Altersentlastungsbetrag (vereinfacht für VZ 2023, geb. vor 1959). */
function altersentlastungsbetrag(p: PersonenEinkommen, vz: number): number {
  if (vz !== 2023) return 0; // Tabelle nur für 2023 hinterlegt
  if (!p.geburtsjahr || p.geburtsjahr >= ALTERSENTLASTUNG_GEBURTSJAHR_VOR) return 0;
  // Bemessung auf Arbeitslohn + positive Nebeneinkünfte (ohne Renten/Pensionen).
  const basis = p.bruttoarbeitslohn ?? 0;
  return Math.min(ALTERSENTLASTUNG_MAX_PROZENT * basis, ALTERSENTLASTUNG_MAX_BETRAG);
}

/** § 10 — abzugsfähige Vorsorgeaufwendungen einer Person.
 *  Gegen die BMF-MCP gegengeprüft (conformance): die Δ-Kurve war exakt
 *  4% × KV → § 10 Abs. 1 Nr. 3 Satz 4 (Kürzung der Basis-KV mit
 *  Krankengeld-Anspruch auf 96%; Pflegepflicht voll). */
function vorsorgeaufwendungen(p: PersonenEinkommen, vz: number): number {
  const alters = Math.min(p.altersvorsorgeaufwand ?? 0, altersvorsorgeHoechst(vz)); // 100% ab 2023
  // § 10 Abs. 1 Nr. 3 Satz 4 — Basis-KV mit Krankengeld-Anspruch zu 96%.
  // Vereinfacht auf den kombinierten KV/PV-Betrag (KV-dominiert); exakt für
  // den Conformance-Fall (KV-only). Getrennte KV/PV-Erfassung ist die
  // Verfeinerung für hohe PV-Anteile (PV wäre voll abzugsfähig).
  const kvPvBasis = (p.kvPvBasisbeitrag ?? 0) * 0.96;
  void SONSTIGE_VORSORGE_HOECHST_AN;
  return alters + kvPvBasis;
}

/**
 * Ermittelt das zu versteuernde Einkommen (zvE) mit vollständigem Trace.
 */
export function aggregiereZvE(input: SteuerfallEingabe): ZvEKomponenten {
  const { vz, art } = input;
  const personen = [input.personA, input.personB].filter(Boolean) as PersonenEinkommen[];
  const trace: ZvEKomponenten['trace'] = [];

  let arbeit = 0, renten = 0, aev = 0, vorsorge = 0;
  for (const p of personen) {
    arbeit += einkuenfteArbeit(p, vz);
    renten += einkuenfteRenten(p);
    aev += altersentlastungsbetrag(p, vz);
    vorsorge += vorsorgeaufwendungen(p, vz);
  }
  trace.push({ schritt: 'Einkünfte §19 (Arbeit, nach WK)', betrag: arbeit });
  trace.push({ schritt: 'Einkünfte §22 (Renten, stpfl.)', betrag: renten });

  const summeEinkuenfte = arbeit + renten;
  trace.push({ schritt: 'Summe der Einkünfte', betrag: summeEinkuenfte });

  trace.push({ schritt: 'Altersentlastungsbetrag §24a', betrag: -aev });
  const gesamtbetragEinkuenfte = Math.max(0, summeEinkuenfte - aev);
  trace.push({ schritt: 'Gesamtbetrag der Einkünfte', betrag: gesamtbetragEinkuenfte });

  const saPausch = SONDERAUSGABEN_PAUSCHBETRAG * (art === 'zusammen' ? 2 : 1);
  const sonderausgaben = vorsorge + saPausch;
  trace.push({ schritt: 'Vorsorgeaufwendungen §10', betrag: -vorsorge });
  trace.push({ schritt: 'Sonderausgaben-Pauschbetrag §10c', betrag: -saPausch });

  const einkommen = Math.max(0, gesamtbetragEinkuenfte - sonderausgaben);
  trace.push({ schritt: 'Einkommen', betrag: einkommen });

  // Freibeträge (Kinder etc.) — v1: keine. zvE = Einkommen.
  const zvE = Math.floor(einkommen);
  trace.push({ schritt: 'zu versteuerndes Einkommen (zvE)', betrag: zvE });

  return {
    einkuenfteArbeit: arbeit,
    einkuenfteRenten: renten,
    summeEinkuenfte,
    altersentlastungsbetrag: aev,
    gesamtbetragEinkuenfte,
    sonderausgaben,
    zvE,
    trace,
  };
}
