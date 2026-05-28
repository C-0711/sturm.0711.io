/**
 * extractor-anlage-zeilen Tests — "Zeile X Anlage KAP"-Anker.
 *
 * Fixture nachgebaut aus echter Westerwald-Bank-Steuerbescheinigung
 * (Rainer Stricker, KJ 2024). Beweis: der Anker rettet die Beträge über
 * die amtliche Zeilen-Referenz, auch wenn das Label vom Wert getrennt ist.
 *
 * Ausführen:
 *   npx tsx src/workflows/elster/lib/field-mapper/extractor-anlage-zeilen.test.ts
 */
import { extractByAnlageZeile } from './extractor-anlage-zeilen.ts';
import { mapBeleg } from './mapper.ts';

let pass = 0, fail = 0;
function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`, detail ?? ''); }
}

// Layout 1:1 wie im Westerwald-Bank-PDF: Label-Zeile + (mehrzeilige
// Beschreibung) + "Zeile N Anlage KAP   Wert" auf eigener Zeile.
const WESTERWALD_STBESCH = `
Steuerbescheinigung
Bescheinigung für alle Privatkonten und / oder -depots
Für (Gläubiger):    Herr Rainer Stricker

werden für das Kalenderjahr 2024 folgende Angaben bescheinigt:
                                                                                          EUR / CT
Höhe der Kapitalerträge
nach Berücksichtigung der teilweisen Steuerfreistellung im Sinne des § 20 Abs. 1 Nr. 6 Satz 9 EStG
(ohne Kapitalerträge aus Lebensversicherungen im Sinne des § 20 Abs. 1 Nr. 6 Satz 2 EStG)
                                                                       Zeile 7 Anlage KAP          11,25
Kapitalertragsteuer
                                                                       Zeile 37 Anlage KAP          2,75
Solidaritätszuschlag
                                                                       Zeile 38 Anlage KAP          0,15
Kirchensteuer zur Kapitalertragsteuer
Evangelische Kirche im Rheinland
                                                                       Zeile 39 Anlage KAP          0,24
`;

console.log('\n1. extractByAnlageZeile — direkte Zeilen-Referenzen\n');
{
  const hits = extractByAnlageZeile(WESTERWALD_STBESCH, 'A');
  const byRef = new Map(hits.map((h) => [h.ref, h.field]));
  assert('KAP:7 → E1900701 = 11 (int_euro)',  byRef.get('KAP:7')?.eCode === 'E1900701' && byRef.get('KAP:7')?.wert === '11', byRef.get('KAP:7'));
  assert('KAP:37 → E1904701 = 2,75',          byRef.get('KAP:37')?.eCode === 'E1904701' && byRef.get('KAP:37')?.wert === '2,75', byRef.get('KAP:37'));
  assert('KAP:38 → E1904901 = 0,15',          byRef.get('KAP:38')?.eCode === 'E1904901' && byRef.get('KAP:38')?.wert === '0,15');
  assert('KAP:39 → E1904801 = 0,24',          byRef.get('KAP:39')?.eCode === 'E1904801' && byRef.get('KAP:39')?.wert === '0,24');
  assert('genau 4 Hits',                       hits.length === 4, hits.length);
}

console.log('\n2. ROBUSTHEITS-BEWEIS: Label vom Wert getrennt → über Zeile gerettet\n');
{
  // "Höhe der Kapitalerträge" steht 3 Zeilen über dem Wert. Label-Matching
  // (das Label+Wert auf EINER Zeile erwartet) verpasst es. Der
  // Anlage-Zeile-Anker rettet es über "Zeile 7 Anlage KAP".
  const r = mapBeleg({ belegTyp: 'Steuerbescheinigung_Bank', person: 'A', rawText: WESTERWALD_STBESCH });
  const kapErt = r.felder.find((f) => f.eCode === 'E1900701');
  const kapSt  = r.felder.find((f) => f.eCode === 'E1904701');
  const solz   = r.felder.find((f) => f.eCode === 'E1904901');
  const kist   = r.felder.find((f) => f.eCode === 'E1904801');
  assert('Kapitalerträge gerettet (Z.7)',     kapErt?.wert === '11', kapErt);
  assert('Kapitalertragsteuer gerettet (Z.37)', kapSt?.wert === '2,75', kapSt);
  assert('SolZ gerettet (Z.38)',              solz?.wert === '0,15', solz);
  assert('KiSt gerettet (Z.39)',              kist?.wert === '0,24', kist);
  assert('Anker-Rettung dokumentiert',
    r.warnings.some((w) => w.includes('Anlage-Zeile-Anker rettete')), r.warnings);
}

console.log('\n3. Beide Token-Reihenfolgen: "Anlage KAP Zeile 7" auch erkannt\n');
{
  const text = `
Steuerbescheinigung
Kapitalerträge          Anlage KAP Zeile 7          5.000,00
`;
  const hits = extractByAnlageZeile(text, 'A');
  assert('Anlage-vor-Zeile-Form erkannt', hits.find((h) => h.ref === 'KAP:7')?.field.wert === '5000', hits);
}

console.log('\n4. Kein Anker bei Nicht-Steuerbescheinigung-Belegtyp\n');
{
  // Eine LStB mit zufälliger "Zeile 7 Anlage KAP"-Erwähnung darf den
  // Anker NICHT triggern (er läuft nur für Steuerbescheinigung_Bank).
  const text = `
Lohnsteuerbescheinigung
Identifikationsnummer    11 222 333 444
Verweis: siehe Zeile 7 Anlage KAP                                    999,00
`;
  const r = mapBeleg({ belegTyp: 'VaSt_LStB', person: 'A', rawText: text });
  assert('kein E1900701 in LStB', r.felder.find((f) => f.eCode === 'E1900701') === undefined);
}

console.log('\n5. Unbekannte Anlage:Zeile → ignoriert (kein Fehl-Mapping)\n');
{
  const text = `
Steuerbescheinigung
Irgendwas      Zeile 999 Anlage XYZ          42,00
`;
  const hits = extractByAnlageZeile(text, 'A');
  assert('Zeile 999 Anlage XYZ nicht im Table → 0 Hits', hits.length === 0, hits);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
