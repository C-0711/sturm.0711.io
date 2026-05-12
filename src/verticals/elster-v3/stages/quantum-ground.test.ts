/**
 * Pure-logic tests for quantum-ground's phrase extractor (no LLM calls).
 *
 * Run: node --test --import tsx src/verticals/elster-v3/stages/quantum-ground.test.ts
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { extrahierePhrasen } from './quantum-ground.ts';

const SAMPLE_OCR = `
# Spendenbescheinigung 2024

Aussteller: BUND e.V., Berlin
Datum: 2024-12-31
Betrag: 200,00 €
IBAN: DE12345678901234567890

Es handelt sich um eine **Spende**.
Die Zuwendung wird steuerlich anerkannt.

Mitgliedsbeitrag oder Spende?  Spende.

X = checked
ja

# Anschrift des Spenders
Hildburg Mustermann
Beispielweg 1
12345 Musterstadt

Identifikationsnummer der empfangsberechtigten Person: 12345678901
`;

test('extrahierePhrasen keeps label-like lines and drops noise', () => {
  const phrases = extrahierePhrasen(SAMPLE_OCR, 20);
  // Should keep informational labels
  assert.ok(phrases.includes('Spendenbescheinigung 2024'), 'header present');
  assert.ok(
    phrases.some((p) => p.startsWith('Aussteller:')),
    'aussteller present',
  );
  assert.ok(
    phrases.some((p) => p.includes('Anschrift des Spenders')),
    'address heading present',
  );
  // Should drop pure-numeric and currency rows
  assert.ok(!phrases.some((p) => /^\d{4,}/.test(p)), 'no IBAN-numeric row');
  assert.ok(!phrases.some((p) => p.endsWith('€')), 'no currency-tailed row');
  // Should drop boilerplate single-word lines
  assert.ok(!phrases.includes('ja'), 'no "ja"');
  assert.ok(!phrases.includes('Datum'), 'no bare "Datum"');
  // Should respect max
  const small = extrahierePhrasen(SAMPLE_OCR, 3);
  assert.equal(small.length, 3);
});

test('extrahierePhrasen dedupes case-insensitively', () => {
  const text = 'Bruttoarbeitslohn\nBRUTTOARBEITSLOHN\nBruttoarbeitslohn\n';
  const phrases = extrahierePhrasen(text, 20);
  assert.equal(phrases.length, 1);
  assert.equal(phrases[0], 'Bruttoarbeitslohn');
});

test('extrahierePhrasen handles markdown decoration', () => {
  const text = '## Empfänger\n* Caritas e.V.\n> Quote line\n# Section title\n';
  const phrases = extrahierePhrasen(text, 10);
  assert.ok(phrases.includes('Empfänger'));
  assert.ok(phrases.includes('Caritas e.V.'));
  assert.ok(phrases.includes('Quote line'));
  assert.ok(phrases.includes('Section title'));
});

test('extrahierePhrasen returns [] on empty input', () => {
  assert.deepEqual(extrahierePhrasen('', 10), []);
  assert.deepEqual(extrahierePhrasen('   \n\n\n   ', 10), []);
});
