/**
 * engine — `berechneSteuerfall`: der vollständige, I/O-freie Rechenkern.
 *
 *   semantische Einkommensbausteine
 *      → zvE (einkommen.ts, §§2/10)
 *      → festzusetzende Steuer (tarif.ts, §32a + Soli + KiSt)
 *      → Anrechnung der Steuerabzüge (LSt, KapESt, …)
 *      → Erstattung / Nachzahlung
 *
 * Reine Arithmetik, Mikrosekunden — der <10 ms-Hot-Path für eine
 * Sofort-Vorschau des Steuerbescheids. Die festzusetzende ESt (Tarif über
 * ein gegebenes zvE) ist gegen die autoritative BMF-MCP gegengeprüft
 * (tarif.mcp.test.ts); das zvE ist eine transparente Haupt­pfad-Ermittlung
 * (siehe einkommen.ts), für die die MCP die verbindliche Zahl bleibt.
 */
import { aggregiereZvE, type SteuerfallEingabe, type ZvEKomponenten } from './einkommen.ts';
import { berechneSteuer, type SteuerErgebnis } from './tarif.ts';

/** Bereits einbehaltene/abgeführte Steuerabzüge (Vorauszahlungen). */
export interface Anrechnung {
  /** Einbehaltene Lohnsteuer (Anlage N). */
  lohnsteuer?: number;
  /** Einbehaltener Solidaritätszuschlag (auf LSt/KapESt). */
  solidaritaetszuschlag?: number;
  /** Einbehaltene Kirchensteuer. */
  kirchensteuer?: number;
  /** Kapitalertragsteuer (Abgeltung), falls in die Veranlagung einbezogen. */
  kapitalertragsteuer?: number;
  /** Geleistete Vorauszahlungen (ESt+SolZ+KiSt) aus der Steuerkontoabfrage —
   *  werden wie einbehaltene Abzugsteuern auf die Festsetzung angerechnet. */
  vorauszahlungen?: number;
}

export interface SteuerfallRechnung extends SteuerfallEingabe {
  /** Kirchensteuer-Hebesatz (0 | 0.08 | 0.09). Default 0. */
  kirchensteuerHebesatz?: number;
  /** Bereits einbehaltene Abzugsteuern für die Anrechnung. */
  anrechnung?: Anrechnung;
  /** § 35a Abs. 2 — Bemessungsbasis haushaltsnahe Dienstleistungen/Pflege. */
  haushaltsnahe35aBasis?: number;
}

export interface SteuerbescheidErgebnis {
  vz: number;
  art: SteuerfallEingabe['art'];
  einkommen: ZvEKomponenten;
  steuer: SteuerErgebnis;
  anrechnung: Required<Anrechnung> & { summe: number };
  /** Festgesetzte Gesamtsteuer (ESt + Soli + KiSt). */
  festgesetzt: number;
  /** Summe der angerechneten Abzugsteuern. */
  angerechnet: number;
  /** > 0 = Erstattung an den Steuerpflichtigen; < 0 = Nachzahlung. */
  erstattung: number;
}

/**
 * Vollständige Steuerfall-Berechnung (zvE → Steuer → Saldo).
 */
export function berechneSteuerfall(input: SteuerfallRechnung): SteuerbescheidErgebnis {
  const einkommen = aggregiereZvE(input);
  const steuer = berechneSteuer({
    zvE: einkommen.zvE,
    vz: input.vz,
    art: input.art,
    kirchensteuerHebesatz: input.kirchensteuerHebesatz ?? 0,
    haushaltsnahe35aBasis: input.haushaltsnahe35aBasis ?? 0,
  });

  const a = input.anrechnung ?? {};
  const anrechnung = {
    lohnsteuer: a.lohnsteuer ?? 0,
    solidaritaetszuschlag: a.solidaritaetszuschlag ?? 0,
    kirchensteuer: a.kirchensteuer ?? 0,
    kapitalertragsteuer: a.kapitalertragsteuer ?? 0,
    vorauszahlungen: a.vorauszahlungen ?? 0,
    summe: 0,
  };
  anrechnung.summe = round2(
    anrechnung.lohnsteuer +
      anrechnung.solidaritaetszuschlag +
      anrechnung.kirchensteuer +
      anrechnung.kapitalertragsteuer +
      anrechnung.vorauszahlungen,
  );

  const festgesetzt = steuer.gesamtsteuer;
  const angerechnet = anrechnung.summe;
  return {
    vz: input.vz,
    art: input.art,
    einkommen,
    steuer,
    anrechnung,
    festgesetzt,
    angerechnet,
    erstattung: round2(angerechnet - festgesetzt),
  };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
