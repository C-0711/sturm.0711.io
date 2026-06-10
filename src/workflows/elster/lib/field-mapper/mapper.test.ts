/**
 * field-mapper — Tests mit Fixtures aus Stricker- und Hildburg-Belegen.
 *
 * Ausführen:
 *   npx tsx src/workflows/elster/lib/field-mapper/mapper.test.ts
 */
import { mapBeleg, aggregate, detectBelegTyp } from './mapper.ts';
import type { BelegInput, MappedField } from './types.ts';

let pass = 0, fail = 0;
function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`, detail ?? ''); }
}
function find(felder: MappedField[], eCode: string): MappedField | undefined {
  return felder.find((f) => f.eCode === eCode);
}

// ── Fixtures (gekürzt — realer Inhalt aus den Stricker/Hildburg-PDFs) ─────

const STRICKER_LSTB = `
Transferticket: Steuer-Abruf
Veranlagungszeitraum 2024
Lohnsteuerbescheinigung Verbandsgemeindewerke Abwasser
Name des Arbeitgebers     Verbandsgemeindewerke Abwasser
Identifikationsnummer     85236749007
Nachname                  Stricker
Vorname                   Rainer
Steuerklasse              3
Kirchensteuermerkmal (Konfession)   Evangelisch
Bruttoarbeitslohn (ohne 9. und 10.)   69.291,80 €
Einbehaltene Lohnsteuer (von 3.)      7.532,00 €
Einbehaltener Solidaritätszuschlag (von 3.)   0,00 €
Einbehaltene Kirchensteuer des Arbeitnehmers (von 3.)   338,94 €
Einbehaltene Kirchensteuer des Partners (von 3.)        338,94 €
`;

const HILDBURG_RBM_DRV = `
Transferticket: Seite 1 von 2
Veranlagungszeitraum: 2024
Identifikationsnummer: 57 438 590 613
Rentenbezugsmitteilung
Identifikationsnummer    57 438 590 613
Vorname                  Hildburg
Name                     Haubrich-Koch
Zuflussjahr              2024
Renten-/Leistungserbringer    Deutsche Rentenversicherung Bund
Rentenart    Leistung aus einer inländischen gesetzlichen Rentenversicherung
Renten-/Leistungsbetrag    24.807,78
Rechtsgrundlage    Leibrente aus einer gesetzlichen Rentenversicherung
Rentenanpassungsbetrag    7.953,18
Beginn der Rente/Leistung    01.12.1995
Höhe der geleisteten/erstatteten Beiträge/Zuschüsse zur Kranken-/Pflegeversicherung    1.119,36
`;

const HILDBURG_RBM_PHILIPS = `
Rentenbezugsmitteilung
Identifikationsnummer    57 438 590 613
Vorname                  Hildburg
Name                     Haubrich-Koch
Renten-/Leistungserbringer    Philips Pensionskasse (VVaG)
Rentenart    Leistung aus sonstigen Verträgen oder aus sonstigen Verpflichtungsgründen
Renten-/Leistungsbetrag    704,52
Rechtsgrundlage    Leibrente aus einem Altersvorsorgevertrag oder aus einer betrieblichen Altersversorgung
Beginn der Rente/Leistung    01.12.1995
`;

const HILDBURG_KRV = `
Beitragsbescheinigung Kranken-/Pflegeversicherung
Versicherungsnehmer: Identifikationsnummer    57 438 590 613
Geleistete Beiträge zur Krankenversicherung (ohne Krankengeldanspruch) ohne Zusatzbeitrag für Basisleistungen    1.781,98
Geleistete Beiträge zur sozialen oder privaten Pflegepflichtversicherung    772,68
`;

const HILDBURG_RELIGION = `
Religionszugehörigkeit
Identifikationsnummer    57 438 590 613
Religion                 Evangelisch
`;

const STRICKER_FSA_SPARKASSE = `
Mitteilung über freigestellte Kapitalerträge Sparkasse Westerwald-Sieg
Identifikationsnummer    85236749007
Vorname                  Rainer
Nachname                 Stricker
Meldejahr                2024
Betrag                   5,00 €
`;

const STRICKER_FSA_VOLKSBANK = `
Mitteilung über freigestellte Kapitalerträge Volksbank Gebhardshain eG
Identifikationsnummer    85236749007
Meldejahr                2024
Betrag                   319,00 €
`;

// ── Tests ─────────────────────────────────────────────────────────────────

console.log('\n1. Beleg-Typ-Erkennung aus Titel\n');
assert('LStB erkannt',         detectBelegTyp(STRICKER_LSTB) === 'VaSt_LStB');
assert('RBM erkannt (DRV)',    detectBelegTyp(HILDBURG_RBM_DRV) === 'VaSt_RBM');
assert('RBM erkannt (Philips)',detectBelegTyp(HILDBURG_RBM_PHILIPS) === 'VaSt_RBM');
assert('KRV erkannt',          detectBelegTyp(HILDBURG_KRV) === 'VaSt_KRV');
assert('Religion erkannt',     detectBelegTyp(HILDBURG_RELIGION) === 'VaSt_Religion');
assert('FSA erkannt',          detectBelegTyp(STRICKER_FSA_SPARKASSE) === 'VaSt_FSA');

console.log('\n2. Stricker LStB → Anlage N + VOR\n');
{
  const r = mapBeleg({ belegTyp: 'VaSt_LStB', person: 'A', rawText: STRICKER_LSTB });
  const brutto = find(r.felder, 'E0200201');
  const lst    = find(r.felder, 'E0200301');
  const solz   = find(r.felder, 'E0200401');
  const kisAn  = find(r.felder, 'E0200501');
  const kisP   = find(r.felder, 'E0200601');
  const stkl   = find(r.felder, 'E0200002');
  const rel    = find(r.felder, 'E0100402');
  assert('Bruttoarbeitslohn → E0200201 = 69292',  brutto?.wert === '69292', brutto?.wert);
  assert('Lohnsteuer → E0200301 = 7532,00',       lst?.wert === '7532,00',   lst?.wert);
  assert('SolZ → E0200401 = 0,00',                solz?.wert === '0,00',     solz?.wert);
  assert('KiSt AN → E0200501 = 338,94',           kisAn?.wert === '338,94',  kisAn?.wert);
  assert('KiSt Partner → E0200601 = 338,94',      kisP?.wert === '338,94',   kisP?.wert);
  assert('Steuerklasse → E0200002 = 3',           stkl?.wert === '3',        stkl?.wert);
  assert('Religion → E0100402 = 02 (Evangelisch)', rel?.wert === '02',       rel?.wert);
  assert('Komma statt Punkt im Decimal',          lst?.wert?.includes(',') === true);
}

console.log('\n3. Hildburg RBM DRV (gesetzlich) → Anlage R Leibr_gesetzl\n');
{
  const r = mapBeleg({ belegTyp: 'VaSt_RBM', person: 'A', rawText: HILDBURG_RBM_DRV });
  const betrag = find(r.felder, 'E1800301');
  const anpass = find(r.felder, 'E1800606');
  const beginn = find(r.felder, 'E1800501');
  const zusch  = find(r.felder, 'E2003402');
  // Renten in Anlage R sind int_euro (verifiziert via validate-schemas-against-db).
  // 24.807,78 € → 24808 (kaufmännisch); 7.953,18 → 7953.
  assert('Rentenbetrag → E1800301 = 24808',     betrag?.wert === '24808', betrag?.wert);
  assert('Kontext = Leibr_gesetzl/Einz',        betrag?.kontextSubpath === 'Leibr_gesetzl/Einz', betrag?.kontextSubpath);
  assert('Anpassung → E1800606 = 7953',         anpass?.wert === '7953', anpass?.wert);
  assert('Beginn → E1800501 = 01.12.1995',      beginn?.wert === '01.12.1995', beginn?.wert);
  assert('KV-Zuschuss → Anlage VOR E2003402 (priv-KV default)',
                                                zusch?.eCode === 'E2003402' && zusch.anlage === 'VOR');
}

console.log('\n4. Hildburg RBM Philips (bAV) → Anlage R Leibr_sonst (Kontext-Branch + E-Code-Remap)\n');
{
  const r = mapBeleg({ belegTyp: 'VaSt_RBM', person: 'A', rawText: HILDBURG_RBM_PHILIPS });
  // bAV-Routing: E1800301 (gesetzlich) → E1803102 (sonst)
  const betrag = find(r.felder, 'E1803102');
  const beginn = find(r.felder, 'E1803202');
  // E1800606 (Rentenanpassung) hat kein bAV-Pendant — muss verworfen werden
  const anpass = find(r.felder, 'E1800606');
  assert('bAV-Remap: E1800301 → E1803102', betrag?.eCode === 'E1803102', betrag?.eCode);
  assert('bAV-Branch erkannt → Leibr_sonst/Einz',
    betrag?.kontextSubpath === 'Leibr_sonst/Einz', betrag?.kontextSubpath);
  assert('bAV-Remap: E1800501 → E1803202', beginn?.eCode === 'E1803202', beginn?.eCode);
  assert('Rentenanpassung E1800606 in bAV verworfen', anpass === undefined, anpass);
  assert('Branch-Warning gesetzt',
    (betrag?.warnings ?? []).some((w) => w.includes('bAV')) === true);
}

console.log('\n5. Hildburg KRV → Anlage VOR (private KV/PV)\n');
{
  const r = mapBeleg({ belegTyp: 'VaSt_KRV', person: 'A', rawText: HILDBURG_KRV });
  const kv = find(r.felder, 'E2003104');
  const pv = find(r.felder, 'E2003202');
  assert('priv KV → E2003104 = 1782',  kv?.wert === '1782', kv?.wert);
  assert('priv PV → E2003202 = 773',   pv?.wert === '773',  pv?.wert);
}

console.log('\n6. Hildburg Religion → ESt1A E0100402 = EV\n');
{
  const r = mapBeleg({ belegTyp: 'VaSt_Religion', person: 'A', rawText: HILDBURG_RELIGION });
  const rel = find(r.felder, 'E0100402');
  assert('Religion → 02 (Evangelisch ELSTER-Code)', rel?.wert === '02', rel?.wert);
}

console.log('\n7. Aggregation: 2 Stricker FSA-Belege → KAP-Summe\n');
{
  const r1 = mapBeleg({ belegTyp: 'VaSt_FSA', person: 'A', rawText: STRICKER_FSA_SPARKASSE });
  const r2 = mapBeleg({ belegTyp: 'VaSt_FSA', person: 'A', rawText: STRICKER_FSA_VOLKSBANK });
  const agg = aggregate([r1, r2]);
  const sum = agg.find((f) => f.eCode === 'E1901402');
  assert('FSA-Summe E1901402 = 324 (5+319)', sum?.wert === '324', sum?.wert);
  assert('Aggregat-Warning gesetzt',         (sum?.warnings ?? []).some((w) => w.includes('Aggregat')) === true);
}

console.log('\n8. Normalisierungs-Edge-Cases\n');
{
  const r = mapBeleg({
    belegTyp: 'VaSt_LStB',
    person: 'A',
    rawText: `
Lohnsteuerbescheinigung
Identifikationsnummer    11 222 333 444
Bruttoarbeitslohn        12.345,67 €
einbehaltene Lohnsteuer  1.234,56 €
Steuerklasse             1
Kirchensteuermerkmal (Konfession)   Römisch-katholisch
`,
  });
  const id = find(r.felder, 'E0100081');
  const br = find(r.felder, 'E0200201');
  const ls = find(r.felder, 'E0200301');
  const rl = find(r.felder, 'E0100402');
  assert('IdNr Spaces entfernt → 11222333444', id?.wert === '11222333444', id?.wert);
  assert('Brutto 12345,67 → gerundet 12346',    br?.wert === '12346', br?.wert);
  assert('LSt deutsches Komma',                 ls?.wert === '1234,56', ls?.wert);
  assert('Römisch-katholisch → 03 (RK ELSTER-Code)', rl?.wert === '03', rl?.wert);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
