/**
 * Run: node --test --import tsx src/verticals/elster-v3/stages/lohnsteuerbescheid-mapper.test.ts
 *
 * Unit tests for LohnsteuerbescheidMapper.
 *
 * NO real PII: all IdNrs, names, and values are synthetic. Real-data tests
 * live in a separate fixture file that is .gitignored.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  LohnsteuerbescheidMapper,
  calculateRatio,
  levenshteinDistance,
  type Atom,
  type Chunk,
} from './lohnsteuerbescheid-mapper.ts';

// ────────────────────────────────────────────────────────────────────────
// Synthetic ELSTER atoms — minimal subset for testing
// ────────────────────────────────────────────────────────────────────────
const SYNTH_ATOMS: Atom[] = [
  // Anlage N (LStB-relevant)
  { ecode: 'E0200201', anlage: 'N', drucktext: 'Bruttoarbeitslohn', zeile: '3' },
  { ecode: 'E0200301', anlage: 'N', drucktext: 'Einbehaltene Lohnsteuer', zeile: '4' },
  { ecode: 'E0200401', anlage: 'N', drucktext: 'Einbehaltener Solidaritätszuschlag', zeile: '5' },
  { ecode: 'E0200501', anlage: 'N', drucktext: 'Einbehaltene Kirchensteuer des Arbeitnehmers', zeile: '6' },
  { ecode: 'E0200601', anlage: 'N', drucktext: 'Einbehaltene Kirchensteuer des Partners', zeile: '7' },
  { ecode: 'E0200002', anlage: 'N', drucktext: 'Steuerklasse' },
  // Anlage VOR (Vorsorgeaufwand)
  { ecode: 'E2000801', anlage: 'VOR', drucktext: 'Arbeitgeberanteil zur gesetzlichen Rentenversicherung', zeile: '22' },
  { ecode: 'E2000401', anlage: 'VOR', drucktext: 'Arbeitnehmeranteil zur gesetzlichen Rentenversicherung', zeile: '23' },
  { ecode: 'E2001203', anlage: 'VOR', drucktext: 'Arbeitnehmerbeiträge zur gesetzlichen Krankenversicherung', zeile: '25' },
  { ecode: 'E2001505', anlage: 'VOR', drucktext: 'Arbeitnehmerbeiträge zur sozialen Pflegeversicherung', zeile: '26' },
  { ecode: 'E2004403', anlage: 'VOR', drucktext: 'Arbeitnehmerbeiträge zur gesetzlichen Arbeitslosenversicherung', zeile: '27' },
  // Other anlagen (should be filtered out for LStB-routing)
  { ecode: 'E1900701', anlage: 'KAP', drucktext: 'Kapitalerträge' },
];

// ────────────────────────────────────────────────────────────────────────
// Core math
// ────────────────────────────────────────────────────────────────────────
test('levenshteinDistance: identical strings → 0', () => {
  assert.equal(levenshteinDistance('Lohnsteuer', 'Lohnsteuer'), 0);
});

test('levenshteinDistance: known small distance', () => {
  assert.equal(levenshteinDistance('Lohnsteuer', 'Lohnsteer'), 1);
});

test('calculateRatio: exact match → 1.0', () => {
  assert.equal(calculateRatio('Bruttoarbeitslohn', 'Bruttoarbeitslohn'), 1.0);
});

test('calculateRatio: case + punctuation insensitive', () => {
  const r = calculateRatio('  BRUTTOARBEITSLOHN!!  ', 'Bruttoarbeitslohn');
  assert.ok(r > 0.99, `expected ~1.0, got ${r}`);
});

test('calculateRatio: OCR-corrupted label still > threshold', () => {
  // "Bnittoarbeitslohn" (OCR misread B→B, ru→ni)
  const r = calculateRatio('Bnittoarbeitslohn', 'Bruttoarbeitslohn');
  assert.ok(r > 0.85, `expected > 0.85, got ${r}`);
});

test('calculateRatio: unrelated strings → low', () => {
  const r = calculateRatio('Kapitalerträge', 'Bruttoarbeitslohn');
  assert.ok(r < 0.5, `expected < 0.5, got ${r}`);
});

// ────────────────────────────────────────────────────────────────────────
// LStB mapping — Fast-Path via Zeile-Nr
// ────────────────────────────────────────────────────────────────────────
test('mapLStB: Zeile-3 → E0200201 (Brutto) — Fast Path', () => {
  const m = new LohnsteuerbescheidMapper(SYNTH_ATOMS);
  const chunks: Chunk[] = [
    { zeile: '3', label: 'Bruttoarbeitslohn (ohne 9. und 10.)', value: '50.000,00 €' },
  ];
  m.processBeleg('lohnsteuerbescheinigung', chunks);
  assert.equal(m.extractedData['E0200201'], 5000000); // cents
});

test('mapLStB: multiple LStB rows → cents stored per eCode', () => {
  const m = new LohnsteuerbescheidMapper(SYNTH_ATOMS);
  const chunks: Chunk[] = [
    { zeile: '3', label: 'Bruttoarbeitslohn', value: '50.000,00 €' },
    { zeile: '4', label: 'Einbehaltene Lohnsteuer', value: '5.432,10 €' },
    { zeile: '23', label: 'Arbeitnehmeranteil RV', value: '4.650,00 €' },
    { zeile: '25', label: 'AN-Beitrag KV', value: '3.650,00 €' },
  ];
  m.processBeleg('lohnsteuerbescheinigung', chunks);
  assert.equal(m.extractedData['E0200201'], 5000000);
  assert.equal(m.extractedData['E0200301'], 543210);
  assert.equal(m.extractedData['E2000401'], 465000);
  assert.equal(m.extractedData['E2001203'], 365000);
});

test('mapLStB: Fallback Ratio Math when Zeile missing', () => {
  const m = new LohnsteuerbescheidMapper(SYNTH_ATOMS);
  const chunks: Chunk[] = [
    {
      zeile: null,
      label: 'Einbehaltener Solidaritätszuschlag',
      value: '0,00 €',
    },
  ];
  m.processBeleg('lohnsteuerbescheinigung', chunks);
  assert.equal(m.extractedData['E0200401'], 0);
});

test('mapLStB: ignores atoms outside N/VOR/AV anlagen', () => {
  const m = new LohnsteuerbescheidMapper(SYNTH_ATOMS);
  const chunks: Chunk[] = [
    { zeile: null, label: 'Kapitalerträge', value: '500,00 €' },
  ];
  m.processBeleg('lohnsteuerbescheinigung', chunks);
  // E1900701 is anlage=KAP — must NOT be matched in LStB routing
  assert.equal(m.extractedData['E1900701'], undefined);
});

// ────────────────────────────────────────────────────────────────────────
// Person-A/B disambig via IdNr
// ────────────────────────────────────────────────────────────────────────
test('Person-Routing: first IdNr seen = A, second distinct = B', () => {
  const m = new LohnsteuerbescheidMapper(SYNTH_ATOMS);
  // First beleg with synthetic IdNr1 → Person A
  m.processBeleg('religionszugehörigkeit', [
    { zeile: null, label: 'Identifikationsnummer', value: '12345678901' },
    { zeile: null, label: 'Religion', value: 'Evangelisch' },
  ]);
  // Second beleg with different IdNr → Person B
  m.processBeleg('religionszugehörigkeit', [
    { zeile: null, label: 'Identifikationsnummer', value: '98765432109' },
    { zeile: null, label: 'Religion', value: 'Römisch-katholisch' },
  ]);

  assert.equal(m.extractedData['E0100402_A'], 'Evangelisch');
  assert.equal(m.extractedData['E0100402_B'], 'Römisch-katholisch');
  assert.equal(m.personMapping.primary, '12345678901');
  assert.equal(m.personMapping.secondary, '98765432109');
});

test('Person-Routing: re-seeing primary IdNr stays Person A', () => {
  const m = new LohnsteuerbescheidMapper(SYNTH_ATOMS);
  m.processBeleg('religionszugehörigkeit', [
    { zeile: null, label: 'Identifikationsnummer', value: '12345678901' },
    { zeile: null, label: 'Religion', value: 'Evangelisch' },
  ]);
  // Second beleg with SAME IdNr should still be Person A
  m.processBeleg('mitteilung freigestellte kapitalerträge', [
    { zeile: null, label: 'Identifikationsnummer', value: '12345678901' },
    { zeile: null, label: 'Betrag', value: '5,00 €' },
  ]);
  assert.equal(m.extractedData['E1902402_A'], 500);
  assert.equal(m.extractedData['E1902402_B'], undefined);
});

// ────────────────────────────────────────────────────────────────────────
// KapErt aggregation
// ────────────────────────────────────────────────────────────────────────
test('mapKapErt: multiple Freistellungsaufträge for same person → sum', () => {
  const m = new LohnsteuerbescheidMapper(SYNTH_ATOMS);
  m.processBeleg('mitteilung freigestellte kapitalerträge', [
    { zeile: null, label: 'Identifikationsnummer', value: '12345678901' },
    { zeile: null, label: 'Betrag', value: '5,00 €' },
  ]);
  m.processBeleg('mitteilung freigestellte kapitalerträge', [
    { zeile: null, label: 'Identifikationsnummer', value: '12345678901' },
    { zeile: null, label: 'Betrag', value: '319,00 €' },
  ]);
  // 500 + 31900 = 32400 cents
  assert.equal(m.extractedData['E1902402_A'], 32400);
});

// ────────────────────────────────────────────────────────────────────────
// Routing
// ────────────────────────────────────────────────────────────────────────
test('processBeleg: empty chunks → no-op', () => {
  const m = new LohnsteuerbescheidMapper(SYNTH_ATOMS);
  m.processBeleg('lohnsteuerbescheinigung', []);
  assert.deepEqual(m.extractedData, {});
});

test('processBeleg: unknown docClass → no extraction', () => {
  const m = new LohnsteuerbescheidMapper(SYNTH_ATOMS);
  m.processBeleg('rentenbescheid', [
    { zeile: '3', label: 'Bruttoarbeitslohn', value: '50.000,00 €' },
  ]);
  assert.deepEqual(m.extractedData, {});
});
