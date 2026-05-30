/**
 * tarif — In-process §32a-EStG income-tax tariff (Grundtarif + Splitting),
 * Solidaritätszuschlag (§ 4 SolzG + Milderungszone) and Kirchensteuer.
 *
 * ════════════════════════════════════════════════════════════════════════
 *  This is the hot-path replacement for the external BMF Lane-1 MCP
 *  (`ctaxv1-lane1-bmf` on :12010) — pure arithmetic, no I/O, microseconds.
 *  The MCP stays the AUTHORITY OF RECORD: `tarif.test.ts` asserts this
 *  implementation matches the MCP's `einkommensteuer` for the MCP's
 *  reported `zve` (tariff correctness, decoupled from zvE-aggregation).
 *
 *  Statutory parameters are §32a EStG per Veranlagungszeitraum. VZ 2023 is
 *  settled (Grundfreibetrag 10.908 €, confirmed against the constants in
 *  tools/elster-inverse-solver/tax_law_constants.py). VZ 2024 carries the
 *  Existenzminimum-2024 (retroactive) values and is marked RECONCILE — the
 *  MCP-validation gate is the source of truth there.
 * ════════════════════════════════════════════════════════════════════════
 */

export type Veranlagungsart = 'einzeln' | 'zusammen';

/** Per-VZ §32a tariff coefficients. Zone formulae (§32a Abs. 1):
 *  - zvE ≤ grundfreibetrag                       → 0
 *  - grundfreibetrag < zvE ≤ zone2Ober: y=(zvE−grundfreibetrag)/10000;
 *                                       ESt = (p2a·y + p2b)·y
 *  - zone2Ober < zvE ≤ zone3Ober:       z=(zvE−zone2Ober)/10000;
 *                                       ESt = (p3a·z + p3b)·z + p3c
 *  - zone3Ober < zvE ≤ zone4Ober:       ESt = 0,42·zvE − z4sub
 *  - zvE > zone4Ober:                   ESt = 0,45·zvE − z5sub
 *  ESt is rounded DOWN to a full euro (§32a Abs. 1 Satz 6). */
export interface TarifParams {
  vz: number;
  grundfreibetrag: number;
  zone2Ober: number;
  zone3Ober: number;
  zone4Ober: number;
  p2a: number; p2b: number;
  p3a: number; p3b: number; p3c: number;
  z4sub: number;
  z5sub: number;
  /** § 3 SolzG Freigrenze (ESt-Betrag) für Einzelveranlagung. */
  soliFreigrenzeEinzeln: number;
  /** Freigrenze bei Zusammenveranlagung (= 2× Einzel). */
  soliFreigrenzeZusammen: number;
  /** true wenn VZ noch gegen die MCP gegengeprüft werden muss. */
  reconcile?: boolean;
}

/** § 4 SolzG: Soli-Satz 5,5 %. */
export const SOLI_SATZ = 0.055;
/** Milderungszone: Soli steigt mit 11,9 % oberhalb der Freigrenze (§ 4
 *  Satz 2 SolzG), gedeckelt durch 5,5 % × ESt. */
export const SOLI_MILDERUNG_SATZ = 0.119;

export const TARIF_PARAMS: Record<number, TarifParams> = {
  // ── VZ 2023 — settled (§32a Abs. 1 i.d.F. InflAusG) ──────────────────
  2023: {
    vz: 2023,
    grundfreibetrag: 10908,
    zone2Ober: 15999,
    zone3Ober: 62809,
    zone4Ober: 277825,
    p2a: 979.18, p2b: 1400,
    p3a: 192.59, p3b: 2397, p3c: 966.53,
    z4sub: 9972.98,
    z5sub: 18307.73,
    soliFreigrenzeEinzeln: 17543,
    soliFreigrenzeZusammen: 35086,
  },
  // ── VZ 2024 — amtliche §32a-Endfassung (BMF EStH 2024, GFB 11.784 €) ──
  //    Koeffizienten aus dem amtlichen Einkommensteuer-Handbuch 2024
  //    (esth.bundesfinanzministerium.de, §32a, rückwirkende GFB-11.784-
  //    Fassung): STETIG + MONOTON an den Zonenknicken 17.005/66.760
  //    (Test tarif.test.ts). Zuvor stand hier die kaputte Mischung
  //    „2023-Koeffizienten + 2024-GFB" (979.18/192.59/966.53), die an den
  //    Knicken NICHT monoton war (Hard-Case-Audit 2026-05-30, ESt fiel bei
  //    +Einkommen) — derselbe Bug steckt in der MCP-parameters-Tabelle.
  2024: {
    vz: 2024,
    grundfreibetrag: 11784,
    zone2Ober: 17005,
    zone3Ober: 66760,
    zone4Ober: 277825,
    p2a: 954.80, p2b: 1400,
    p3a: 181.19, p3b: 2397, p3c: 991.21,
    z4sub: 10636.31,
    z5sub: 18971.06,
    soliFreigrenzeEinzeln: 19638,
    soliFreigrenzeZusammen: 39276,
  },
};

export function tarifParams(vz: number): TarifParams {
  const p = TARIF_PARAMS[vz];
  if (!p) {
    const known = Object.keys(TARIF_PARAMS).join(', ');
    throw new Error(`§32a-Tarif für VZ ${vz} nicht hinterlegt (bekannt: ${known})`);
  }
  return p;
}

/**
 * § 32a Abs. 1 Grundtarif. `zvE` wird nach Satz 1 auf den vollen Euro
 * abgerundet; das ESt-Ergebnis ebenso (Satz 6).
 */
export function einkommensteuerGrundtarif(zvE: number, vz: number): number {
  const p = tarifParams(vz);
  const x = Math.floor(Math.max(0, zvE)); // auf vollen Euro abgerundet
  let est: number;
  if (x <= p.grundfreibetrag) {
    est = 0;
  } else if (x <= p.zone2Ober) {
    const y = (x - p.grundfreibetrag) / 10000;
    est = (p.p2a * y + p.p2b) * y;
  } else if (x <= p.zone3Ober) {
    const z = (x - p.zone2Ober) / 10000;
    est = (p.p3a * z + p.p3b) * z + p.p3c;
  } else if (x <= p.zone4Ober) {
    est = 0.42 * x - p.z4sub;
  } else {
    est = 0.45 * x - p.z5sub;
  }
  return Math.floor(est); // § 32a Abs. 1 Satz 6 — voller Euro
}

/**
 * Tarifliche Einkommensteuer. Bei Zusammenveranlagung gilt das
 * Splitting-Verfahren (§ 32a Abs. 5): 2 × Grundtarif(zvE / 2).
 */
export function einkommensteuer(
  zvE: number,
  vz: number,
  art: Veranlagungsart = 'einzeln',
): number {
  if (art === 'zusammen') {
    const halb = Math.floor(Math.max(0, zvE) / 2);
    return 2 * einkommensteuerGrundtarif(halb, vz);
  }
  return einkommensteuerGrundtarif(zvE, vz);
}

/**
 * Solidaritätszuschlag auf die festzusetzende ESt (§ 3, § 4 SolzG).
 * Unterhalb der Freigrenze 0 €; in der Milderungszone die kleinere von
 * 5,5 % × ESt und 11,9 % × (ESt − Freigrenze); darüber 5,5 % × ESt.
 * Auf 2 Nachkommastellen kaufmännisch gerundet.
 */
export function solidaritaetszuschlag(
  est: number,
  vz: number,
  art: Veranlagungsart = 'einzeln',
): number {
  const p = tarifParams(vz);
  const freigrenze = art === 'zusammen' ? p.soliFreigrenzeZusammen : p.soliFreigrenzeEinzeln;
  if (est <= freigrenze) return 0;
  const voll = SOLI_SATZ * est;
  const milderung = SOLI_MILDERUNG_SATZ * (est - freigrenze);
  return round2(Math.min(voll, milderung));
}

/**
 * Kirchensteuer = Hebesatz × Bemessungsgrundlage. Bemessungsgrundlage ist
 * vereinfachend die festzusetzende ESt (ohne Kinderfreibetrags-Korrektur
 * nach § 51a EStG — diese Verfeinerung folgt, sobald Kinder im Fall sind).
 * Hebesatz: 8 % (BY, BW) bzw. 9 % (übrige Länder); 0 % wenn kein Mitglied.
 */
export function kirchensteuer(est: number, hebesatz: number): number {
  if (hebesatz <= 0 || est <= 0) return 0;
  return round2(hebesatz * est);
}

export interface SteuerEingabe {
  zvE: number;
  vz: number;
  art?: Veranlagungsart;
  /** Kirchensteuer-Hebesatz (0, 0.08, 0.09). Default 0 (kein Mitglied). */
  kirchensteuerHebesatz?: number;
}

export interface SteuerErgebnis {
  vz: number;
  art: Veranlagungsart;
  zvE: number;
  einkommensteuer: number;
  solidaritaetszuschlag: number;
  kirchensteuer: number;
  /** ESt + Soli + KiSt. */
  gesamtsteuer: number;
  /** Durchschnittssteuersatz = ESt / zvE. */
  durchschnittssteuersatz: number;
  /** Grenzsteuersatz an der Stelle zvE (numerische Ableitung über 1 €). */
  grenzsteuersatz: number;
}

/** Vollständige Tarifberechnung über ein bereits ermitteltes zvE. */
export function berechneSteuer(input: SteuerEingabe): SteuerErgebnis {
  const art = input.art ?? 'einzeln';
  const zvE = Math.floor(Math.max(0, input.zvE));
  const est = einkommensteuer(zvE, input.vz, art);
  const soli = solidaritaetszuschlag(est, input.vz, art);
  const kist = kirchensteuer(est, input.kirchensteuerHebesatz ?? 0);
  // Grenzsteuersatz über ein 100-€-Fenster — ein 1-€-Schritt wird von der
  // Euro-Abrundung des §32a-Tarifs (Satz 6) verschluckt und ergäbe 0/1.
  const estPlus = einkommensteuer(zvE + 100, input.vz, art);
  return {
    vz: input.vz,
    art,
    zvE,
    einkommensteuer: est,
    solidaritaetszuschlag: soli,
    kirchensteuer: kist,
    gesamtsteuer: round2(est + soli + kist),
    durchschnittssteuersatz: zvE > 0 ? est / zvE : 0,
    grenzsteuersatz: Math.max(0, (estPlus - est) / 100),
  };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
