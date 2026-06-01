/**
 * dokument-jahr — Tests des Belegjahr-Detektors (rein, netz-/DB-frei).
 *
 * Ausführen:  npx tsx src/workflows/elster/lib/field-mapper/dokument-jahr.test.ts
 */
import { detectDokumentJahr } from './dokument-jahr.ts';

let pass = 0, fail = 0;
function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`, detail ?? ''); }
}

console.log('\n1. Voll-Erklärung: Kopfzeile „Einkommensteuererklärung <Jahr>" → high\n');
{
  const r = detectDokumentJahr('Einkommensteuererklärung 2023\n8 Geburtsdatum 27.05.1963\nAnlage N\n5 Bruttoarbeitslohn 50.000,00');
  assert('jahr = 2023', r.jahr === 2023, r);
  assert('confidence = high', r.confidence === 'high', r);
}

console.log('\n2. Erklärung 2024 (wie im lane1-Test) → high 2024\n');
{
  const r = detectDokumentJahr('Einkommensteuererklärung 2024\n5 Bruttoarbeitslohn 63.559,90');
  assert('jahr = 2024 / high', r.jahr === 2024 && r.confidence === 'high', r);
}

console.log('\n3. Lohnsteuerbescheinigung: „für 2024" + „bis 31.12.2024" → high 2024\n');
{
  const r = detectDokumentJahr('Ausdruck der elektronischen Lohnsteuerbescheinigung für 2024\nBescheinigungszeitraum vom 01.01.2024 bis 31.12.2024\nGeburtsdatum 12.03.1980');
  assert('jahr = 2024', r.jahr === 2024, r);
  assert('confidence = high (Jahre konsistent)', r.confidence === 'high', r);
}

console.log('\n4. Volksbank: „für das Jahr 2024" → high 2024\n');
{
  const r = detectDokumentJahr('Erträgnisaufstellung für das Jahr 2024 für Ihre privaten Kapitalerträge\n28.03.2024 Zinsen Einlagen 4,06');
  assert('jahr = 2024 / high', r.jahr === 2024 && r.confidence === 'high', r);
}

console.log('\n5. Bank-Steuerbescheinigung für das Kalenderjahr 2023 → high 2023\n');
{
  const r = detectDokumentJahr('Steuerbescheinigung für das Kalenderjahr 2023\nHöhe der Kapitalerträge 1.234,56');
  assert('jahr = 2023 / high', r.jahr === 2023 && r.confidence === 'high', r);
}

console.log('\n6. Kein Jahressignal (nur ein Geburtsdatum) → none\n');
{
  const r = detectDokumentJahr('Steuerbescheinigung\nFür (Gläubiger) Herrn Rainer Stricker\nHöhe der Kapitalerträge Zeile 7 Anlage KAP 11,25');
  assert('jahr = null / none', r.jahr === null && r.confidence === 'none', r);
}

console.log('\n7. Alte Datumsangaben werden NICHT als Belegjahr gewertet\n');
{
  // Geburtsdatum 1963 ist < 2000 → unplausibel; keine Anker → none.
  const r = detectDokumentJahr('Name: Mustermann\nGeburtsdatum 24.11.1963\nKontostand 0,00');
  assert('jahr = null', r.jahr === null, r);
}

console.log('\n8. Widersprüchliche verankerte Jahre → low (Rückfrage)\n');
{
  const r = detectDokumentJahr('Einkommensteuererklärung 2022\nfür das Jahr 2023\nbis 31.12.2023');
  assert('confidence = low', r.confidence === 'low', r);
  assert('bester Tipp = 2023 (häufigste)', r.jahr === 2023, r);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
