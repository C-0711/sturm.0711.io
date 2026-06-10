/**
 * SteuerfallEngine — in-process §32a Einkommensteuertarif + Soli.
 *
 * The <10ms calculated core. The authoritative engine is the BMF Calculator
 * MCP on :12010 (`berechne_vollstaendige_steuer_v2`), which does both
 * zvE-aggregation AND tariff. This module re-implements ONLY the tariff +
 * Soli (the pure zvE → Steuer function) in-process so a preview is instant;
 * the MCP stays the source of truth for aggregation and edge-case deductions.
 *
 * Every constant below was VALIDATED against the live :12010 oracle (VZ 2023):
 *   zvE 38 734 → ESt 7 411,57   (Zone 3 polynomial)
 *   zvE 68 734 → ESt 18 895,30  (Zone 4 linear)
 *   zvE 318 734 → ESt 125 122,57 (Zone 5 linear)
 *   Soli(18 895,30) = 74,38 · Soli(39 895,30) = 1 229,38 · Soli(125 122,57) = 5 916,88
 *
 * Two deliberate matches to the oracle over the statute text:
 *  1. ESt is rounded to CENTS, not floored to full euro (§32a Abs. 1 Satz 5
 *     says floor-to-euro; the MCP keeps cents, so we keep cents — the legal
 *     floor is a display step applied downstream).
 *  2. Soli = 5,5 % · max(0, ESt − Freigrenze) — a Freibetrag model. The MCP
 *     does NOT apply the §4 SolzG Freigrenze+Milderungszone (11,9 %); it
 *     deducts the Freigrenze as a Freibetrag at all income levels. We match
 *     the authoritative engine, not memory.
 */

export type Veranlagungsart = 'einzel' | 'zusammen';

export interface TarifJahr {
  /** § 32a (1) Nr. 1 — Grundfreibetrag (Zone 1 obergrenze). */
  grundfreibetrag: number;
  /** Zone-2 obergrenze (progressiv, Eingangssatz). */
  zone2Obergrenze: number;
  /** Zone-3 obergrenze (progressiv). */
  zone3Obergrenze: number;
  /** Zone-4 obergrenze (42 %); ab darüber 45 % (Reichensteuer). */
  zone4Obergrenze: number;
  /** Zone 2: ESt = (z2A·y + z2B)·y, y = (zvE − GFB)/10000. */
  zone2: { a: number; b: number };
  /** Zone 3: ESt = (z3A·z + z3B)·z + z3C, z = (zvE − zone2Obergrenze)/10000. */
  zone3: { a: number; b: number; c: number };
  /** Zone 4: ESt = 0,42·zvE − z4Abzug. */
  zone4: { satz: number; abzug: number };
  /** Zone 5: ESt = 0,45·zvE − z5Abzug. */
  zone5: { satz: number; abzug: number };
  /** § 3 SolzG — Soli-Freigrenze (ESt) einzel / zusammen. */
  soliFreigrenzeEinzel: number;
  soliFreigrenzeZusammen: number;
  soliSatz: number;
}

/** § 32a / § 4 SolzG — VZ 2023 (settled). Validated against :12010. */
export const TARIF_2023: TarifJahr = {
  grundfreibetrag: 10908,
  zone2Obergrenze: 15999,
  zone3Obergrenze: 62809,
  zone4Obergrenze: 277825,
  zone2: { a: 979.18, b: 1400 },
  zone3: { a: 192.59, b: 2397, c: 966.53 },
  zone4: { satz: 0.42, abzug: 9972.98 },
  zone5: { satz: 0.45, abzug: 18307.73 },
  soliFreigrenzeEinzel: 17543,
  soliFreigrenzeZusammen: 35086,
  soliSatz: 0.055,
};

const JAHRE: Record<number, TarifJahr> = { 2023: TARIF_2023 };

export function tarifJahr(jahr: number): TarifJahr {
  const t = JAHRE[jahr];
  if (!t) throw new Error(`Kein §32a-Tarif hinterlegt für VZ ${jahr} (vorhanden: ${Object.keys(JAHRE).join(', ')})`);
  return t;
}

export type Steuerzone = 1 | 2 | 3 | 4 | 5;

/** Round to cents the way the :12010 oracle does (no euro-floor). */
const cents = (x: number): number => Math.round(x * 100) / 100;

export function steuerzone(zvE: number, jahr = 2023): Steuerzone {
  const t = tarifJahr(jahr);
  if (zvE <= t.grundfreibetrag) return 1;
  if (zvE <= t.zone2Obergrenze) return 2;
  if (zvE <= t.zone3Obergrenze) return 3;
  if (zvE <= t.zone4Obergrenze) return 4;
  return 5;
}

/**
 * § 32a (1) — Grundtarif (Einzelveranlagung). zvE → ESt, cent-rounded.
 * zvE is taken on full euros (§32a rounds zvE down to the full euro first).
 */
export function tarifEinkommensteuer(zvE: number, jahr = 2023): number {
  const t = tarifJahr(jahr);
  const x = Math.floor(zvE); // § 32a — auf vollen Euro abgerundetes zvE
  if (x <= t.grundfreibetrag) return 0;
  if (x <= t.zone2Obergrenze) {
    const y = (x - t.grundfreibetrag) / 10000;
    return cents((t.zone2.a * y + t.zone2.b) * y);
  }
  if (x <= t.zone3Obergrenze) {
    const z = (x - t.zone2Obergrenze) / 10000;
    return cents((t.zone3.a * z + t.zone3.b) * z + t.zone3.c);
  }
  if (x <= t.zone4Obergrenze) return cents(t.zone4.satz * x - t.zone4.abzug);
  return cents(t.zone5.satz * x - t.zone5.abzug);
}

/** § 32a (5) — Splitting: ESt = 2 · Grundtarif(zvE/2). */
export function splittingEinkommensteuer(zvE: number, jahr = 2023): number {
  return cents(2 * tarifEinkommensteuer(Math.floor(zvE / 2), jahr));
}

/** Einkommensteuer nach Veranlagungsart. */
export function einkommensteuer(zvE: number, art: Veranlagungsart, jahr = 2023): number {
  return art === 'zusammen' ? splittingEinkommensteuer(zvE, jahr) : tarifEinkommensteuer(zvE, jahr);
}

/**
 * Solidaritätszuschlag — wie :12010: 5,5 % · max(0, ESt − Freigrenze).
 * (Freibetrag-Modell; nicht die §4-SolzG-Milderungszone.)
 */
export function solidaritaetszuschlag(est: number, art: Veranlagungsart, jahr = 2023): number {
  const t = tarifJahr(jahr);
  const freigrenze = art === 'zusammen' ? t.soliFreigrenzeZusammen : t.soliFreigrenzeEinzel;
  return cents(t.soliSatz * Math.max(0, est - freigrenze));
}

/**
 * Grenzsteuersatz — analytische Ableitung dESt/dzvE (matcht :12010 ~6 Dezimal).
 * Zone 1: 0 · Zone 2/3: lineare Ableitung der Parabel · Zone 4/5: 0,42 / 0,45.
 * Splitting: Ableitung an zvE/2 (Satz bleibt gleich beim Verdoppeln).
 */
export function grenzsteuersatz(zvE: number, art: Veranlagungsart, jahr = 2023): number {
  const t = tarifJahr(jahr);
  const x = art === 'zusammen' ? Math.floor(zvE / 2) : Math.floor(zvE);
  if (x <= t.grundfreibetrag) return 0;
  if (x <= t.zone2Obergrenze) {
    const y = (x - t.grundfreibetrag) / 10000;
    return (2 * t.zone2.a * y + t.zone2.b) / 10000;
  }
  if (x <= t.zone3Obergrenze) {
    const z = (x - t.zone2Obergrenze) / 10000;
    return (2 * t.zone3.a * z + t.zone3.b) / 10000;
  }
  if (x <= t.zone4Obergrenze) return t.zone4.satz;
  return t.zone5.satz;
}

export interface SteuerfallInput {
  zve: number;
  erklaerungsjahr?: number;
  veranlagungsart?: Veranlagungsart;
}

export interface SteuerfallErgebnis {
  zve: number;
  erklaerungsjahr: number;
  veranlagungsart: Veranlagungsart;
  steuerzone: Steuerzone;
  einkommensteuer: number;
  solidaritaetszuschlag: number;
  gesamtsteuer: number;
  grenzsteuersatz: number;
  durchschnittssteuersatz: number;
}

/**
 * Pure in-process tariff core. Takes a zvE (from the MCP's aggregation, or a
 * preview aggregation) and returns the full Steuer breakdown in microseconds.
 */
export class SteuerfallEngine {
  berechne(input: SteuerfallInput): SteuerfallErgebnis {
    const jahr = input.erklaerungsjahr ?? 2023;
    const art = input.veranlagungsart ?? 'einzel';
    const zve = Math.max(0, input.zve);
    const est = einkommensteuer(zve, art, jahr);
    const soli = solidaritaetszuschlag(est, art, jahr);
    return {
      zve,
      erklaerungsjahr: jahr,
      veranlagungsart: art,
      steuerzone: steuerzone(zve, jahr),
      einkommensteuer: est,
      solidaritaetszuschlag: soli,
      gesamtsteuer: cents(est + soli),
      grenzsteuersatz: grenzsteuersatz(zve, art, jahr),
      durchschnittssteuersatz: zve > 0 ? est / zve : 0,
    };
  }
}
