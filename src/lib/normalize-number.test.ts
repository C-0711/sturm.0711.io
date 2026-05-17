/**
 * Run: node --test --import tsx src/lib/normalize-number.test.ts
 *
 * Covers the German-format → JS-number heuristic used to populate
 * canonical_layer.normalizedNumber. The Hildburg-ground-truth and Stricker
 * (WISO) regression cases are explicit at the bottom.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { parseGermanMoney } from './normalize-number.ts';

test('German thousands + decimal + currency symbol → number', () => {
  assert.equal(parseGermanMoney('1.781,98 EUR'), 1781.98);
});

test('German thousands + decimal (no currency) → number', () => {
  assert.equal(parseGermanMoney('1.781,98'), 1781.98);
});

test('German decimal with € symbol → number', () => {
  assert.equal(parseGermanMoney('1781,98 €'), 1781.98);
});

test('English decimal (already normalized) → number', () => {
  assert.equal(parseGermanMoney('1781.98'), 1781.98);
});

test('Plain integer string → number', () => {
  assert.equal(parseGermanMoney('1781'), 1781);
});

test('Plain small integer "40" → 40', () => {
  assert.equal(parseGermanMoney('40'), 40);
});

test('Negative German thousands+decimal → negative number', () => {
  assert.equal(parseGermanMoney('-9.132,74'), -9132.74);
});

test('Negative with currency → negative number', () => {
  assert.equal(parseGermanMoney('-1.234,50'), -1234.5);
});

test('German thousand-grouped integer "6.011" → 6011 (Stricker WISO case)', () => {
  assert.equal(parseGermanMoney('6.011'), 6011);
});

test('German thousand-grouped integer "63.559" → 63559', () => {
  assert.equal(parseGermanMoney('63.559'), 63559);
});

test('Multi-group German thousands "12.345.678" → 12345678', () => {
  assert.equal(parseGermanMoney('12.345.678'), 12345678);
});

test('English thousands + decimal "1,234.56" → 1234.56', () => {
  assert.equal(parseGermanMoney('1,234.56'), 1234.56);
});

test('Pure German decimal "772,68" → 772.68 (Hildburg)', () => {
  assert.equal(parseGermanMoney('772,68'), 772.68);
});

test('German "20,00 EUR" → 20 (Hildburg)', () => {
  assert.equal(parseGermanMoney('20,00 EUR'), 20);
});

test('Empty string → null', () => {
  assert.equal(parseGermanMoney(''), null);
});

test('Whitespace-only → null', () => {
  assert.equal(parseGermanMoney('   '), null);
});

test('Non-numeric text "Nicht zutreffend" → null', () => {
  assert.equal(parseGermanMoney('Nicht zutreffend'), null);
});

test('Currency symbol only → null', () => {
  assert.equal(parseGermanMoney('€'), null);
});

test('Null/undefined input → null', () => {
  assert.equal(parseGermanMoney(null), null);
  assert.equal(parseGermanMoney(undefined), null);
});

test('Number input passthrough', () => {
  assert.equal(parseGermanMoney(1781.98), 1781.98);
  assert.equal(parseGermanMoney(0), 0);
  assert.equal(parseGermanMoney(-50), -50);
});

test('NaN / Infinity input → null', () => {
  assert.equal(parseGermanMoney(Number.NaN), null);
  assert.equal(parseGermanMoney(Number.POSITIVE_INFINITY), null);
});

test('Boolean / object inputs → null', () => {
  // @ts-expect-error — runtime guard
  assert.equal(parseGermanMoney(true), null);
  // @ts-expect-error — runtime guard
  assert.equal(parseGermanMoney({}), null);
});

test('Single decimal "1234.5" → 1234.5 (English, non-thousand-pattern)', () => {
  assert.equal(parseGermanMoney('1234.5'), 1234.5);
});

test('Hildburg ground-truth round-trip: "1.781,98 EUR" matches float 1781.98', () => {
  // The canonical_layer.value the comparator was choking on.
  const parsed = parseGermanMoney('1.781,98 EUR');
  assert.equal(parsed, 1781.98);
  // Comparison the Hildburg comparator does:
  assert.equal(Math.abs((parsed ?? NaN) - 1781.98) < 1e-9, true);
});
