/**
 * extractor-lstb-zeilen Tests — LStB-Zeilennummer-Anker.
 *
 * Kernbeweis: der Anker rettet Felder über die STABILE Nummer, auch wenn
 * das Label-Wording unbekannt/garbled ist. Das ist der Robustheits-Hebel
 * für "funktioniert dynamisch für alle VaSt-Dokumente".
 *
 * Ausführen:
 *   npx tsx src/workflows/elster/lib/field-mapper/extractor-lstb-zeilen.test.ts
 */
import { extractLstbByZeilennummer } from './extractor-lstb-zeilen.ts';
import { mapBeleg } from './mapper.ts';

let pass = 0, fail = 0;
function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`, detail ?? ''); }
}

console.log('\n1. Standard-LStB-Zeilen → korrekte E-Codes\n');
{
  const text = `
 3.     Bruttoarbeitslohn (ohne 9. und 10.)                                                 69.291,80 €
 4.     Einbehaltene Lohnsteuer (von 3.)                                                    7.532,00 €
 5.     Einbehaltener Solidaritätszuschlag (von 3.)                                         0,00 €
 6.     Einbehaltene Kirchensteuer des Arbeitnehmers (von 3.)                               338,94 €
 7.     Einbehaltene Kirchensteuer des Partners (von 3.)                                    338,94 €
 19.    Entschädigungen / Arbeitslohn für mehrere Kalenderjahre (in 3.                      300,00 €
 22.    a) Arbeitgeberanteil / -zuschuss zur gesetzlichen Rentenversicherung                6.544,01 €
 23.    a) Arbeitnehmeranteil zur gesetzlichen Rentenversicherung                           6.544,01 €
 23.    b) Arbeitnehmeranteil zu berufsständischen Versorgungseinrichtungen                 0,00 €
 25.    Arbeitnehmerbeiträge zur gesetzlichen Krankenversicherung                           4.901,83 €
 26.    Arbeitnehmerbeiträge zur sozialen Pflegeversicherung                                1.427,16 €
 27.    Arbeitnehmerbeiträge zur gesetzlichen Arbeitslosenversicherung                      914,71 €
`;
  const hits = extractLstbByZeilennummer(text, 'A');
  const byZeile = new Map(hits.map((h) => [h.zeile, h.field]));
  assert('Nr.3 → E0200201 = 69292', byZeile.get('3')?.eCode === 'E0200201' && byZeile.get('3')?.wert === '69292', byZeile.get('3'));
  assert('Nr.4 → E0200301 = 7532,00', byZeile.get('4')?.eCode === 'E0200301' && byZeile.get('4')?.wert === '7532,00');
  assert('Nr.5 → E0200401 = 0,00',    byZeile.get('5')?.eCode === 'E0200401');
  assert('Nr.6 → E0200501 = 338,94',  byZeile.get('6')?.eCode === 'E0200501' && byZeile.get('6')?.wert === '338,94');
  assert('Nr.7 → E0200601',            byZeile.get('7')?.eCode === 'E0200601');
  assert('Nr.19 → E0201806 = 300',     byZeile.get('19')?.eCode === 'E0201806' && byZeile.get('19')?.wert === '300');
  assert('Nr.22a → E2000801 = 6544',   byZeile.get('22a')?.eCode === 'E2000801' && byZeile.get('22a')?.wert === '6544');
  assert('Nr.23a → E2000601 = 6544',   byZeile.get('23a')?.eCode === 'E2000601');
  assert('Nr.23b → E2000501',          byZeile.get('23b')?.eCode === 'E2000501');
  assert('Nr.25 → E2001203 = 4902',    byZeile.get('25')?.eCode === 'E2001203' && byZeile.get('25')?.wert === '4902');
  assert('Nr.26 → E2001505 = 1427',    byZeile.get('26')?.eCode === 'E2001505');
  assert('Nr.27 → E2004403 = 915',     byZeile.get('27')?.eCode === 'E2004403' && byZeile.get('27')?.wert === '915');
}

console.log('\n2. ROBUSTHEITS-BEWEIS: garbled Label, aber Nummer da → gerettet\n');
{
  // Ein hypothetischer Arbeitgeber-Export mit komplett unbekanntem Wording,
  // aber die offizielle Zeilen-Nummer ist da. Label-Matching scheitert,
  // Nr-Anker rettet.
  const text = `
Lohnsteuerbescheinigung
Identifikationsnummer    11 222 333 444
Steuerklasse             1
 3.     Brutto-Entgelt gemäß §2 EStG (firmenspezifische Bezeichnung)        55.000,00 €
 4.     Abgeführte LSt an das FA                                            8.000,00 €
`;
  const r = mapBeleg({ belegTyp: 'VaSt_LStB', person: 'A', rawText: text });
  const brutto = r.felder.find((f) => f.eCode === 'E0200201');
  const lst = r.felder.find((f) => f.eCode === 'E0200301');
  assert('Bruttoarbeitslohn gerettet trotz "Brutto-Entgelt gemäß §2"',
    brutto?.wert === '55000', brutto);
  assert('Lohnsteuer gerettet trotz "Abgeführte LSt"',
    lst?.wert === '8000,00', lst);
  assert('Rettung via Nr-Anker dokumentiert (warning)',
    r.warnings.some((w) => w.includes('LStB-Nr-Anker rettete')), r.warnings);
}

console.log('\n3. Kein Doppel-Emit: bekanntes Label + Nummer → nur 1 Feld\n');
{
  const text = `
Lohnsteuerbescheinigung
 3.     Bruttoarbeitslohn (ohne 9. und 10.)                                 60.000,00 €
`;
  const r = mapBeleg({ belegTyp: 'VaSt_LStB', person: 'A', rawText: text });
  const bruttos = r.felder.filter((f) => f.eCode === 'E0200201');
  assert('genau 1× E0200201 (Label-Match gewinnt, kein Anker-Doppel)',
    bruttos.length === 1, bruttos);
  assert('Wert korrekt = 60000', bruttos[0]?.wert === '60000', bruttos[0]);
}

console.log('\n4. Nicht-LStB-Belegtyp → Anker läuft NICHT\n');
{
  // Eine RBM mit einer "3." Zeile darf NICHT als LStB-Nr.3 interpretiert werden.
  const text = `
Rentenbezugsmitteilung
Identifikationsnummer    11 222 333 444
 3.     Irgendwas                                                            999,00
`;
  const r = mapBeleg({ belegTyp: 'VaSt_RBM', person: 'A', rawText: text });
  const fakeBrutto = r.felder.find((f) => f.eCode === 'E0200201');
  assert('kein E0200201 in RBM (Anker nur für VaSt_LStB)', fakeBrutto === undefined);
}

console.log('\n5. Mehrdeutige Nummern (31) NICHT im Anker — Label disambiguiert\n');
{
  const text = `
 31.    Bei unterjähriger Zahlung: erster Monat                            01
 31.    Bei unterjähriger Zahlung: letzter Monat                           12
`;
  const hits = extractLstbByZeilennummer(text, 'A');
  assert('Nr.31 NICHT im Anker (mehrdeutig erster/letzter Monat)',
    hits.find((h) => h.zeile === '31') === undefined, hits);
}

console.log('\n6. FOTO-LStB: OCR-Komma-Dropout repariert (echte Melanie-Tokens)\n');
{
  // Reale paddleocr-Ausgabe eines fotografierten LStB @300dpi: getrennte
  // EUR|Ct-Spalten → Komma verloren ("24.432,98" → "24.43298"). Räumlich
  // rekonstruiert: Nummer+Label auf einer Zeile, Wert auf der Folgezeile.
  // Kontinuierliche Nummern wie im echten Muster (Zwischenfelder 7-21, 24
  // sind im Druck/OCR vorhanden, auch wenn 0/leer) — so bleibt die Sequenz.
  const text = `
Ausdruck der elektronischen Lohnsteuerbescheinigung für 2024
3.Bruttoarbeitslohn einschl. Sachbezüge ohne
9.und 10.   24.43298
4. Einbehaltene Lohnsteuer von 3.
4.05896
5.Einbehaltener Solidaritätszuschlag von 3
6.Einbehaltene Kirchensteuer des Arbeitnehmers
von 3.   36519
7. Einbehaltene Kirchensteuer des Ehegatten
8.In 3.enthaltene Versorgungsbezüge
9.Ermäßigt besteuerte Versorgungsbezüge
10. Ermäßigt besteuerter Arbeitslohn
11. Einbehaltene Lohnsteuer von 9. und 10.
12. Einbehaltener Solidaritätszuschlag
13. Einbehaltene Kirchensteuer des Arbeitnehmers
14. Einbehaltene Kirchensteuer des Ehegatten
15. Kurzarbeitergeld
16. Steuerfreier Arbeitslohn
17. Steuerfreie Arbeitgeberleistungen
18. Pauschal besteuerte Arbeitgeberleistungen
19. Steuerpflichtige Entschädigungen
20. Steuerfreie Verpflegungszuschüsse
21. Steuerfreie Arbeitgeberleistungen
22.Arbeitgeber a) zur gesetzlichen Rentenversicherung   2.27227
23.Arbeitnehmer a) zur gesetzlichen Rentenversicherung   2.27227
24. Steuerfreie Arbeitgeberzuschüsse
25.Arbeitnehmerbeiträge zur gesetzlichen
Krankenversicherung   1.93024
26.Arbeitnehmerbeiträge zur sozialen
Pflegeversicherung   41535
27.Arbeitnehmerbeiträge zur
Arbeitslosenversicherung   31759
`;
  const hits = extractLstbByZeilennummer(text, 'A');
  const byZeile = new Map(hits.map((h) => [h.zeile, h.field]));
  assert('Nr.3 Brutto 24.43298 → 24433 (Komma repariert)', byZeile.get('3')?.wert === '24433', byZeile.get('3'));
  assert('Nr.4 LSt 4.05896 → 4058,96',  byZeile.get('4')?.wert === '4058,96', byZeile.get('4'));
  assert('Nr.6 KiSt 36519 → 365,19',    byZeile.get('6')?.wert === '365,19', byZeile.get('6'));
  assert('Nr.22a RV-AG 2.27227 → 2272', byZeile.get('22a')?.wert === '2272', byZeile.get('22a'));
  assert('Nr.23a RV-AN 2.27227 → 2272', byZeile.get('23a')?.wert === '2272', byZeile.get('23a'));
  assert('Nr.25 KV 1.93024 → 1930',     byZeile.get('25')?.wert === '1930', byZeile.get('25'));
  assert('Nr.26 PV 41535 → 415',        byZeile.get('26')?.wert === '415', byZeile.get('26'));
  assert('Nr.27 ALV 31759 → 318',       byZeile.get('27')?.wert === '318', byZeile.get('27'));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
