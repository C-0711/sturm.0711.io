import { describe, it, expect } from 'vitest';
import { findEurValues, firstEurInSection, parseEurString } from './eur-parse.ts';

describe('parseEurString', () => {
  it.each([
    ['1.781,98', 1781.98],
    ['772,68', 772.68],
    ['2.238,60 €', 2238.6],
    ['456,62 EUR', 456.62],
    ['−2.960,00', -2960],
    ['0,00', 0],
    ['12.345,67 €', 12345.67],
  ])('parsed "%s" → %d', (input, expected) => {
    expect(parseEurString(input)).toBe(expected);
  });

  it.each([
    '57438590613',         // IdNr — kein Komma
    '02/171/51864',        // Steuernummer
    '24.11.1935',          // Datum
    '2024',                // Jahr
    '01.2024',             // Monat-Jahr
    '1.78,12',             // ungueltig: Tausender-Punkt vor 2 Ziffern
    '1.2345,67',           // ungueltig: Tausender-Punkt vor 4 Ziffern
    '1234567890,12',       // zu viele Vorkommastellen
  ])('rejected "%s"', (input) => {
    expect(parseEurString(input)).toBeNull();
  });
});

describe('findEurValues — Tabellen-Zeilen mit mehreren Werten', () => {
  it('Layout-B Brief-Spalten: Krankenversicherung A/B/C/D-Spalten', () => {
    const section =
      '| Krankenversicherung | 01.2024 - 12.2024 | 2.238,60 EUR |   | (Zeile 23 bzw. 26) 1.781,98 EUR | (Zeile 25 bzw. 28)  |';
    const eurs = findEurValues(section);
    expect(eurs.map((e) => e.value)).toEqual([2238.6, 1781.98]);
  });

  it('Wahlleistungen-Footer aus Brief', () => {
    const section = '(Zeile 27 bzw. 29)*\n\n456,62 EUR';
    expect(findEurValues(section).map((e) => e.value)).toEqual([456.62]);
  });

  it('Layout-A XSD-Hoehe-Zeile', () => {
    const section = '|  Höhe der geleisteten/erstatteten Beiträge/Zuschüsse | 1.781,98  |';
    expect(findEurValues(section).map((e) => e.value)).toEqual([1781.98]);
  });

  it('IdNr in Section stoert nicht', () => {
    const section = 'Identifikationsnummer: 57 438 590 613\nBeitrag: 1.234,56 €';
    expect(findEurValues(section).map((e) => e.value)).toEqual([1234.56]);
  });
});

describe('firstEurInSection', () => {
  it('Layout B Spalten: erste EUR ist Gesamt (2238.60), NICHT Basis (1781.98)', () => {
    const section =
      '| Krankenversicherung | 01.2024 - 12.2024 | 2.238,60 EUR |   | (Zeile 23 bzw. 26) 1.781,98 EUR |  |';
    const first = firstEurInSection(section);
    expect(first?.value).toBe(2238.6);
    // → DAS IST DER ERWARTETE PUNKT: "erste EUR" gibt im Layout-B den Gesamt-
    //   wert, nicht den Basis-Wert. Wenn Tier-1 das nicht reicht, eskaliert
    //   der Beleg via Confidence-Check in Tier-3.
  });

  it('Layout A XSD: erste EUR ist DER Wert', () => {
    const section = '|  Höhe der geleisteten/erstatteten Beiträge/Zuschüsse | 1.781,98  |';
    expect(firstEurInSection(section)?.value).toBe(1781.98);
  });

  it('Leere Section → null', () => {
    expect(firstEurInSection('Versicherungsnehmer: Hildburg Haubrich-Koch')).toBeNull();
  });
});
