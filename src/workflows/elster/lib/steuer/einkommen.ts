/**
 * einkommen — Ermittlung des zu versteuernden Einkommens (zvE) aus
 * semantischen Einkommensbausteinen, nach dem Schema der §§ 2, 10 EStG:
 *
 *   Σ Einkünfte  (§19 Abs.1 Arbeitslohn, §19 Abs.2 Versorgungsbezüge,
 *                 §22 Renten, §20 Kapital)
 *     − Altersentlastungsbetrag (§24a)            ⇒ Gesamtbetrag der Einkünfte
 *     − Sonderausgaben (Vorsorge §10 + Pauschbetrag) ⇒ Einkommen
 *     − Freibeträge (Kinder §32 …)                 ⇒ zu versteuerndes Einkommen
 *
 * ════════════════════════════════════════════════════════════════════════
 *  PROFIL-ADAPTIV & ZEILENGENAU. Welche Einkunftsart mit welcher Regel
 *  gerechnet wird, entscheidet das deterministische Steuerzahler-Profil
 *  (profil.ts): Versorgungsbezüge (§19 Abs.2) bekommen Versorgungsfreibetrag
 *  + Zuschlag + WK-Pauschbetrag 102 €; aktiver Arbeitslohn (§19 Abs.1) den
 *  AN-Pauschbetrag 1.230 €; Renten (§22) den festgeschriebenen Rentenfrei-
 *  betrag + 102 € WK. JEDE Zeile steht mit Rechtsgrundlage im Trace und ist
 *  so im Fall-Tab und gegen den Bescheid prüfbar.
 *
 *  Reichweite: vollständig für §19 Abs.1+2, §22, Vorsorge-Sonderausgaben,
 *  Altersentlastung. §35a (Steuerermäßigung, mindert die Steuer nicht das
 *  zvE) und außergewöhnliche Belastungen werden in engine.ts/tarif.ts
 *  ausgewiesen, nicht hier.
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
  /** Etikett für den Trace (z.B. "gesetzliche Rente", "Betriebsrente"). */
  bezeichnung?: string;
}

/** § 19 Abs. 2 — ein Versorgungsbezug (Beamtenpension/Werksrente). */
export interface VersorgungsPosten {
  /** Jahresbetrag der Versorgungsbezüge (brutto, Nr. 8 LStB). */
  brutto: number;
  /** Maßgebendes Kalenderjahr des Versorgungsbeginns (Nr. 30 LStB). Bestimmt
   *  die festgeschriebene Versorgungsfreibetrags-Kohorte (§19 Abs.2 Satz 3).
   *  Fehlt der Beleg, ist der Wert undefined → die Berechnung weist die Lücke
   *  AUS (kein stilles Defaulten). */
  beginnJahr?: number;
}

/** Semantische Bausteine je steuerpflichtiger Person. Beträge in Euro. */
export interface PersonenEinkommen {
  /** § 19 Abs. 1 — AKTIVER Bruttoarbeitslohn (ohne Versorgungsanteil). */
  bruttoarbeitslohn?: number;
  /** Tatsächliche Werbungskosten (Anlage N). Wenn < AN-Pauschbetrag, wird
   *  der Pauschbetrag angesetzt (§ 9a). */
  werbungskosten?: number;
  /** § 19 Abs. 2 — Versorgungsbezüge (Pension). */
  versorgungsbezuege?: VersorgungsPosten[];
  /** § 22 — Leibrenten (Anlage R). */
  renten?: RentenPosten[];
  /** § 10 Abs. 1 Nr. 2 — Altersvorsorgeaufwendungen (AN+AG-Anteil RV,
   *  Rürup). Vereinfachte 100%-Abzugslogik 2023, gedeckelt am Höchstbetrag. */
  altersvorsorgeaufwand?: number;
  /** § 10 Abs. 1 Nr. 3 — Basis-KV + Pflichtpflege (voll abzugsfähig). */
  kvPvBasisbeitrag?: number;
  /** § 10 Abs. 1 Nr. 3 Satz 4 — Krankengeld-Anspruch (gesetzlich Versicherte
   *  mit Krankengeld): kürzt die KV-Beiträge auf 96 %. Privat Versicherte und
   *  Rentner OHNE Krankengeld: false/undefined → 100 % abzugsfähig. */
  krankengeldAnspruch?: boolean;
  /** § 10b — geleistete Spenden/Zuwendungen (abziehbar bis 20 % des GdE). */
  spenden?: number;
  /** Geburtsjahr — für den Altersentlastungsbetrag (§ 24a). */
  geburtsjahr?: number;
}

export interface SteuerfallEingabe {
  vz: number;
  art: Veranlagungsart;
  personA: PersonenEinkommen;
  personB?: PersonenEinkommen;
}

/** Aufgeschlüsselte Versorgungsbezugs-Einkünfte (§19 Abs.2). */
export interface VersorgungDetail {
  brutto: number;
  beginnJahr?: number;
  freibetragProzent: number;
  versorgungsfreibetrag: number;
  zuschlag: number;
  werbungskostenPauschbetrag: number;
  einkuenfte: number;
  /** true wenn das Beginnjahr fehlte und konservativ angenommen werden musste. */
  beginnAngenommen: boolean;
}

export interface ZvEKomponenten {
  einkuenfteArbeit: number;
  /** § 19 Abs. 2 — Einkünfte aus Versorgungsbezügen (nach Freibetrag/WK). */
  einkuenfteVersorgung: number;
  einkuenfteRenten: number;
  einkuenfteKapital: number;
  summeEinkuenfte: number;
  altersentlastungsbetrag: number;
  gesamtbetragEinkuenfte: number;
  sonderausgaben: number;
  zvE: number;
  /** Versorgungs-Aufschlüsselung je Person (für UI / Bescheid-Druck). */
  versorgungDetails: VersorgungDetail[];
  /** Schritt-für-Schritt-Trace für die UI / den Bescheid-Druck. */
  trace: Array<{ schritt: string; betrag: number; hinweis?: string; rechtsgrundlage?: string }>;
  /** Offene Punkte, die der Nutzer klären muss (z.B. fehlender Versorgungsbeginn). */
  hinweise: string[];
}

// ── Statutorische Pauschbeträge / Höchstbeträge (VZ-abhängig) ────────────
const AN_PAUSCHBETRAG: Record<number, number> = { 2023: 1230, 2024: 1230 };
const RENTEN_WK_PAUSCHBETRAG = 102;          // § 9a Satz 1 Nr. 3
const VERSORGUNG_WK_PAUSCHBETRAG = 102;      // § 9a Satz 1 Nr. 1 Buchst. b
const SONDERAUSGABEN_PAUSCHBETRAG = 36;      // § 10c (72 € bei Zusammenveranlagung)
const ALTERSVORSORGE_HOECHST: Record<number, number> = { 2023: 26528, 2024: 27566 };
const SONSTIGE_VORSORGE_HOECHST_AN = 1900;   // § 10 Abs. 4 (Arbeitnehmer)

/** § 19 Abs. 2 Satz 3 EStG — Versorgungsfreibetrag, FESTGESCHRIEBEN nach dem
 *  Jahr des Versorgungsbeginns. {prozent, höchstbetrag, zuschlag}. Werte:
 *  AltEinkG-Tafel; ab 2023 Wachstumschancengesetz (−0,4 pp / −30 € / −9 €). */
const VERSORGUNGSFREIBETRAG_TAFEL: Record<number, { prozent: number; max: number; zuschlag: number }> = {
  2005: { prozent: 0.400, max: 3000, zuschlag: 900 },
  2006: { prozent: 0.384, max: 2880, zuschlag: 864 },
  2007: { prozent: 0.368, max: 2760, zuschlag: 828 },
  2008: { prozent: 0.352, max: 2640, zuschlag: 792 },
  2009: { prozent: 0.336, max: 2520, zuschlag: 756 },
  2010: { prozent: 0.320, max: 2400, zuschlag: 720 },
  2011: { prozent: 0.304, max: 2280, zuschlag: 684 },
  2012: { prozent: 0.288, max: 2160, zuschlag: 648 },
  2013: { prozent: 0.272, max: 2040, zuschlag: 612 },
  2014: { prozent: 0.256, max: 1920, zuschlag: 576 },
  2015: { prozent: 0.240, max: 1800, zuschlag: 540 },
  2016: { prozent: 0.224, max: 1680, zuschlag: 504 },
  2017: { prozent: 0.208, max: 1560, zuschlag: 468 },
  2018: { prozent: 0.192, max: 1440, zuschlag: 432 },
  2019: { prozent: 0.176, max: 1320, zuschlag: 396 },
  2020: { prozent: 0.160, max: 1200, zuschlag: 360 },
  2021: { prozent: 0.152, max: 1140, zuschlag: 342 },
  2022: { prozent: 0.144, max: 1080, zuschlag: 324 },
  2023: { prozent: 0.140, max: 1050, zuschlag: 315 },
  2024: { prozent: 0.136, max: 1020, zuschlag: 306 },
};

/** § 24a EStG — Altersentlastungsbetrag, FESTGESCHRIEBEN nach dem auf die
 *  Vollendung des 64. Lebensjahres folgenden Kalenderjahr. {prozent, max}. */
const ALTERSENTLASTUNG_TAFEL: Record<number, { prozent: number; max: number }> = {
  2005: { prozent: 0.400, max: 1900 }, 2006: { prozent: 0.384, max: 1824 },
  2007: { prozent: 0.368, max: 1748 }, 2008: { prozent: 0.352, max: 1672 },
  2009: { prozent: 0.336, max: 1596 }, 2010: { prozent: 0.320, max: 1520 },
  2011: { prozent: 0.304, max: 1444 }, 2012: { prozent: 0.288, max: 1368 },
  2013: { prozent: 0.272, max: 1292 }, 2014: { prozent: 0.256, max: 1216 },
  2015: { prozent: 0.240, max: 1140 }, 2016: { prozent: 0.224, max: 1064 },
  2017: { prozent: 0.208, max: 988 }, 2018: { prozent: 0.192, max: 912 },
  2019: { prozent: 0.176, max: 836 }, 2020: { prozent: 0.160, max: 760 },
  2021: { prozent: 0.152, max: 722 }, 2022: { prozent: 0.144, max: 684 },
  2023: { prozent: 0.140, max: 665 }, 2024: { prozent: 0.136, max: 646 },
};

function anPauschbetrag(vz: number): number {
  return AN_PAUSCHBETRAG[vz] ?? 1230;
}
function altersvorsorgeHoechst(vz: number): number {
  return ALTERSVORSORGE_HOECHST[vz] ?? ALTERSVORSORGE_HOECHST[2024];
}
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Tafel-Lookup mit Klammerung: Jahre ≤ Tafelanfang → erste Zeile (40 %),
 *  Jahre > Tafelende → letzte hinterlegte Zeile. */
function tafelZeile<T>(tafel: Record<number, T>, jahr: number): { jahr: number; zeile: T } {
  const jahre = Object.keys(tafel).map(Number);
  const min = Math.min(...jahre), max = Math.max(...jahre);
  const j = Math.min(Math.max(jahr, min), max);
  return { jahr: j, zeile: tafel[j] };
}

/** § 19 Abs. 1 — Einkünfte aus AKTIVER nichtselbständiger Arbeit. */
function einkuenfteArbeit(p: PersonenEinkommen, vz: number): number {
  const lohn = p.bruttoarbeitslohn ?? 0;
  if (lohn <= 0) return 0;
  const wk = Math.max(p.werbungskosten ?? 0, anPauschbetrag(vz));
  return Math.max(0, lohn - wk);
}

/** § 19 Abs. 2 — Einkünfte aus Versorgungsbezügen, mit festgeschriebenem
 *  Versorgungsfreibetrag + Zuschlag (nach Beginnjahr) und WK-Pauschbetrag 102.
 *  Mehrere Bezüge: maßgebend ist das FRÜHESTE Beginnjahr (höchste Kohorte);
 *  Freibetrag/Zuschlag werden EINMAL auf die Summe angewandt. */
function einkuenfteVersorgung(p: PersonenEinkommen): VersorgungDetail | null {
  const bezuege = (p.versorgungsbezuege ?? []).filter((v) => v.brutto > 0);
  if (bezuege.length === 0) return null;
  const brutto = round2(bezuege.reduce((s, v) => s + v.brutto, 0));
  const beginnJahre = bezuege.map((v) => v.beginnJahr).filter((y): y is number => typeof y === 'number');
  const beginnAngenommen = beginnJahre.length === 0;
  // Maßgebend: frühestes Beginnjahr (höchster Freibetrag). Fehlt es ganz,
  // konservativ ≤2005 (40 %) annehmen UND als Hinweis ausweisen.
  const maßgeblich = beginnAngenommen ? 2005 : Math.min(...beginnJahre);
  const { zeile } = tafelZeile(VERSORGUNGSFREIBETRAG_TAFEL, maßgeblich);
  const versorgungsfreibetrag = round2(Math.min(zeile.prozent * brutto, zeile.max));
  const zuschlag = Math.min(zeile.zuschlag, Math.max(0, brutto - versorgungsfreibetrag));
  const einkuenfte = Math.max(0, round2(brutto - versorgungsfreibetrag - zuschlag - VERSORGUNG_WK_PAUSCHBETRAG));
  return {
    brutto, beginnJahr: beginnAngenommen ? undefined : maßgeblich,
    freibetragProzent: zeile.prozent, versorgungsfreibetrag, zuschlag,
    werbungskostenPauschbetrag: VERSORGUNG_WK_PAUSCHBETRAG, einkuenfte, beginnAngenommen,
  };
}

/** § 22 — steuerpflichtige Renteneinkünfte einer Person (nach WK 102). */
function einkuenfteRenten(p: PersonenEinkommen): number {
  const renten = p.renten ?? [];
  if (renten.length === 0) return 0;
  let stpfl = 0;
  for (const r of renten) {
    if (typeof r.steuerpflichtigerAnteil === 'number') stpfl += r.steuerpflichtigerAnteil;
    else stpfl += r.jahresbetrag * (r.besteuerungsanteil ?? 0);
  }
  return Math.max(0, round2(stpfl - RENTEN_WK_PAUSCHBETRAG));
}

/** § 24a — Altersentlastungsbetrag (Kohorte nach Geburtsjahr). Bemessung NUR
 *  auf aktiven Arbeitslohn + positive Nebeneinkünfte (NICHT Renten/Versorgung).
 *  Kohortenjahr = Geburtsjahr + 65 (= Jahr nach Vollendung des 64. LJ). */
function altersentlastungsbetrag(p: PersonenEinkommen, vz: number, aktiverLohn: number, positiveNebeneinkuenfte: number): number {
  if (!p.geburtsjahr) return 0;
  const kohortenjahr = p.geburtsjahr + 65;
  if (kohortenjahr > vz) return 0; // 64. LJ noch nicht vor VZ-Beginn vollendet
  const { zeile } = tafelZeile(ALTERSENTLASTUNG_TAFEL, kohortenjahr);
  const basis = Math.max(0, aktiverLohn) + Math.max(0, positiveNebeneinkuenfte);
  return round2(Math.min(zeile.prozent * basis, zeile.max));
}

/** § 10 — abzugsfähige Vorsorgeaufwendungen einer Person. */
function vorsorgeaufwendungen(p: PersonenEinkommen, vz: number): number {
  const alters = Math.min(p.altersvorsorgeaufwand ?? 0, altersvorsorgeHoechst(vz)); // 100% ab 2023
  // § 10 Abs. 1 Nr. 3 Satz 4 — die 4 %-Kürzung (→ 96 %) gilt NUR für KV-Beiträge
  // MIT Krankengeld-Anspruch (gesetzlich versicherte Arbeitnehmer). Privat
  // Versicherte und Rentner ohne Krankengeld: 100 % abzugsfähig (Default).
  const kvFaktor = p.krankengeldAnspruch ? 0.96 : 1.0;
  const kvPvBasis = (p.kvPvBasisbeitrag ?? 0) * kvFaktor;
  void SONSTIGE_VORSORGE_HOECHST_AN;
  return round2(alters + kvPvBasis);
}

/**
 * Ermittelt das zu versteuernde Einkommen (zvE) mit vollständigem Trace.
 * Profil-adaptiv: §19 Abs.2 Versorgung getrennt von §19 Abs.1 aktivem Lohn.
 */
export function aggregiereZvE(input: SteuerfallEingabe): ZvEKomponenten {
  const { vz, art } = input;
  const personen = [input.personA, input.personB].filter(Boolean) as PersonenEinkommen[];
  const trace: ZvEKomponenten['trace'] = [];
  const hinweise: string[] = [];
  const versorgungDetails: VersorgungDetail[] = [];

  let arbeit = 0, versorgung = 0, renten = 0, kapital = 0, aev = 0, vorsorge = 0, spendenSumme = 0;
  for (const p of personen) {
    spendenSumme += Math.max(0, p.spenden ?? 0);
    const eArbeit = einkuenfteArbeit(p, vz);
    const vDetail = einkuenfteVersorgung(p);
    const eRenten = einkuenfteRenten(p);
    if (vDetail) {
      versorgungDetails.push(vDetail);
      versorgung += vDetail.einkuenfte;
      if (vDetail.beginnAngenommen) {
        hinweise.push(
          `Versorgungsbeginn (Nr. 30 LStB) fehlt → konservativ ≤2005 angenommen ` +
          `(40 %, max 3.000 € + 900 € Zuschlag). Bitte Beginnjahr bestätigen — ` +
          `bei späterem Beginn ist der Freibetrag geringer.`,
        );
      }
    }
    // Altersentlastung: Bemessung auf aktiven Lohn + positive Nebeneinkünfte
    // (Kapital), NICHT auf Renten/Versorgung.
    aev += altersentlastungsbetrag(p, vz, eArbeit, kapitalAus(p));
    arbeit += eArbeit;
    renten += eRenten;
    kapital += kapitalAus(p);
    vorsorge += vorsorgeaufwendungen(p, vz);
  }

  if (arbeit > 0) trace.push({ schritt: 'Einkünfte §19 Abs.1 (aktiver Arbeitslohn, nach WK)', betrag: arbeit, rechtsgrundlage: '§19 Abs.1, §9a Nr.1a EStG' });
  for (const v of versorgungDetails) {
    trace.push({ schritt: 'Versorgungsbezüge brutto (Nr. 8 LStB)', betrag: v.brutto, rechtsgrundlage: '§19 Abs.2 EStG' });
    trace.push({ schritt: `Versorgungsfreibetrag (${(v.freibetragProzent * 100).toFixed(1)} %${v.beginnJahr ? `, Beginn ${v.beginnJahr}` : ', Beginn angenommen ≤2005'})`, betrag: -v.versorgungsfreibetrag, rechtsgrundlage: '§19 Abs.2 Satz 3 EStG' });
    trace.push({ schritt: 'Zuschlag zum Versorgungsfreibetrag', betrag: -v.zuschlag, rechtsgrundlage: '§19 Abs.2 Satz 3 EStG' });
    trace.push({ schritt: 'Werbungskosten-Pauschbetrag Versorgung', betrag: -v.werbungskostenPauschbetrag, rechtsgrundlage: '§9a Satz 1 Nr.1b EStG' });
    trace.push({ schritt: '= Einkünfte §19 Abs.2 (Versorgungsbezüge)', betrag: v.einkuenfte });
  }
  if (renten > 0) trace.push({ schritt: 'Einkünfte §22 Nr.1 (Renten, steuerpflichtig nach WK)', betrag: renten, rechtsgrundlage: '§22 Nr.1, §9a Nr.3 EStG' });

  const summeEinkuenfte = round2(arbeit + versorgung + renten + kapital);
  trace.push({ schritt: 'Summe der Einkünfte', betrag: summeEinkuenfte });

  if (aev > 0) trace.push({ schritt: 'Altersentlastungsbetrag', betrag: -aev, rechtsgrundlage: '§24a EStG' });
  const gesamtbetragEinkuenfte = round2(Math.max(0, summeEinkuenfte - aev));
  trace.push({ schritt: 'Gesamtbetrag der Einkünfte', betrag: gesamtbetragEinkuenfte });

  const saPausch = SONDERAUSGABEN_PAUSCHBETRAG * (art === 'zusammen' ? 2 : 1);
  // § 10b — Spenden/Zuwendungen, abziehbar bis 20 % des Gesamtbetrags der Einkünfte.
  const spendenAbzug = round2(Math.min(spendenSumme, 0.20 * gesamtbetragEinkuenfte));
  const sonderausgaben = round2(vorsorge + saPausch + spendenAbzug);
  if (vorsorge > 0) trace.push({ schritt: 'Vorsorgeaufwendungen (KV/PV-Basis, Altersvorsorge)', betrag: -vorsorge, rechtsgrundlage: '§10 Abs.1 Nr.2+3 EStG' });
  if (spendenAbzug > 0) trace.push({ schritt: 'Spenden / Zuwendungen', betrag: -spendenAbzug, rechtsgrundlage: '§10b EStG' });
  trace.push({ schritt: 'Sonderausgaben-Pauschbetrag', betrag: -saPausch, rechtsgrundlage: '§10c EStG' });

  const einkommen = round2(Math.max(0, gesamtbetragEinkuenfte - sonderausgaben));
  trace.push({ schritt: 'Einkommen', betrag: einkommen });

  // Freibeträge (Kinder etc.) — v1: keine. zvE = abgerundetes Einkommen.
  const zvE = Math.floor(einkommen);
  trace.push({ schritt: 'zu versteuerndes Einkommen (zvE)', betrag: zvE, rechtsgrundlage: '§2 Abs.5 EStG' });

  return {
    einkuenfteArbeit: arbeit,
    einkuenfteVersorgung: versorgung,
    einkuenfteRenten: renten,
    einkuenfteKapital: kapital,
    summeEinkuenfte,
    altersentlastungsbetrag: aev,
    gesamtbetragEinkuenfte,
    sonderausgaben,
    zvE,
    versorgungDetails,
    trace,
    hinweise,
  };
}

/** § 20 — Kapitaleinkünfte, die in die Veranlagung einbezogen werden. I.d.R.
 *  abgeltend besteuert / unter Sparer-Pauschbetrag → hier 0 (dokumentiert).
 *  Platzhalter für Günstigerprüfung; das Profil führt den Brutto-Betrag. */
function kapitalAus(_p: PersonenEinkommen): number {
  return 0;
}
