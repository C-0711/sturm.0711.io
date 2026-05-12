/**
 * Run: node --test --import tsx src/lib/prompt-budget.test.ts
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  computePromptBudget,
  assertFitsInBudget,
  splitToFitBudget,
  shouldFanoutBySource,
  contextTokensFor,
  PromptBudgetExceededError,
} from './prompt-budget.ts';

test('contextTokensFor: known model → exact window', () => {
  assert.equal(contextTokensFor('gemma4-mm'), 128_000);
  assert.equal(contextTokensFor('mistral-small-latest'), 32_000);
});

test('contextTokensFor: unknown model → 32K fallback', () => {
  assert.equal(contextTokensFor('whatever-the-frontier-is-2030'), 32_000);
});

test('computePromptBudget: Gemma-4 128K, ~2K schema, 2K output, 2K overhead', () => {
  // Realistischer Layer-1-Call gegen Gemma-4-mm
  const b = computePromptBudget({
    modelContextTokens: 128_000,
    schema: { type: 'object', properties: { a: { type: 'string' } } }, // tiny
    maxOutputTokens: 2_000,
    overheadTokens: 2_000,
  });
  // Brutto: 128k - ~30 schema - 2k output - 2k overhead ≈ 124k
  // Safety 0.8: ≈ 99k tokens für Source
  // × 3.5 chars/token ≈ 347k chars für Source
  assert.ok(b.sourceMaxChars > 300_000, `expected >300k, got ${b.sourceMaxChars}`);
  assert.ok(b.sourceMaxChars < 400_000, `expected <400k, got ${b.sourceMaxChars}`);
});

test('computePromptBudget: Mistral-small 32K is the constraining case', () => {
  const b = computePromptBudget({
    modelContextTokens: 32_000,
    schema: { type: 'object' },
    maxOutputTokens: 2_000,
    overheadTokens: 2_000,
  });
  // Brutto: 32k - ~5 schema - 2k - 2k ≈ 28k. Safety 0.8 ≈ 22k tokens
  // × 3.5 ≈ 78k chars
  assert.ok(b.sourceMaxChars > 60_000);
  assert.ok(b.sourceMaxChars < 90_000);
});

test('computePromptBudget: respects minSourceChars floor', () => {
  // pathological tiny context
  const b = computePromptBudget({
    modelContextTokens: 2_000,
    maxOutputTokens: 1_900,  // alles fast aufgebraucht
    overheadTokens: 500,
    minSourceChars: 1_000,
  });
  assert.equal(b.sourceMaxChars, 1_000); // floor respected
});

test('computePromptBudget: large schema reduces source budget', () => {
  const small = computePromptBudget({
    modelContextTokens: 32_000,
    schema: { type: 'object' },
    maxOutputTokens: 2_000,
    overheadTokens: 2_000,
  });
  const bigSchema = computePromptBudget({
    modelContextTokens: 32_000,
    // ~10K char schema
    schema: { type: 'object', properties: Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`field${i}`, { type: 'string', description: `description for field ${i}` }]),
    ) },
    maxOutputTokens: 2_000,
    overheadTokens: 2_000,
  });
  assert.ok(bigSchema.sourceMaxChars < small.sourceMaxChars,
    `schema-aware shrinkage: ${bigSchema.sourceMaxChars} < ${small.sourceMaxChars}`);
});

test('assertFitsInBudget: passes when small enough', () => {
  const b = computePromptBudget({
    modelContextTokens: 32_000,
    maxOutputTokens: 2_000,
    overheadTokens: 2_000,
  });
  // No throw expected
  assertFitsInBudget('hello world', b);
});

test('assertFitsInBudget: throws PromptBudgetExceededError when over budget', () => {
  const b = computePromptBudget({
    modelContextTokens: 1_000,
    maxOutputTokens: 900,
    overheadTokens: 80,
    minSourceChars: 100,
  });
  assert.equal(b.sourceMaxChars, 100);
  assert.throws(
    () => assertFitsInBudget('x'.repeat(500), b),
    (e: unknown): e is PromptBudgetExceededError =>
      e instanceof PromptBudgetExceededError && e.textLen === 500 && e.budgetChars === 100,
  );
});

test('splitToFitBudget: passthrough when small enough', () => {
  const b = computePromptBudget({
    modelContextTokens: 32_000,
    maxOutputTokens: 2_000,
    overheadTokens: 2_000,
  });
  const chunks = splitToFitBudget('hello world', b);
  assert.deepEqual(chunks, ['hello world']);
});

test('splitToFitBudget: paragraph-split — alle chunks im Budget, kein Inhalt verloren', () => {
  const b = computePromptBudget({
    modelContextTokens: 1_000,
    maxOutputTokens: 900,
    overheadTokens: 80,
    minSourceChars: 100,
  });
  const text = [
    'paragraph eins mit etwas text',
    'paragraph zwei mit anderem text',
    'paragraph drei',
    'paragraph vier hier',
  ].join('\n\n');
  const chunks = splitToFitBudget(text, b);
  // jeder Chunk im Budget
  for (const c of chunks) assert.ok(c.length <= b.sourceMaxChars, `chunk too big: ${c.length}`);
  // Inhalt verlustfrei rekonstruierbar
  const joined = chunks.join('\n\n');
  for (const p of text.split('\n\n')) {
    assert.ok(joined.includes(p), `lost paragraph: "${p}"`);
  }
});

test('splitToFitBudget: header-first strategy when markdown headers present', () => {
  // Budget so eng setzen, dass die gesamten 3 Sections nicht in 1 Chunk passen.
  const b = computePromptBudget({
    modelContextTokens: 1_000,
    maxOutputTokens: 900,
    overheadTokens: 80,
    minSourceChars: 50,
  });
  // Jede section ~40-50 chars, gesamt ~140 — passt nicht in 50-char Budget.
  const text = [
    '# Spendenquittung 1\nFoo bar baz quux corge waldo fred',
    '# Spendenquittung 2\nWaldo fred plugh xyzzy thud',
    '# Spendenquittung 3\nQuuxquux corgefoo bazquux',
  ].join('\n\n');
  const chunks = splitToFitBudget(text, b);
  assert.ok(chunks.length >= 3, `expected ≥3, got ${chunks.length}`);
  assert.ok(chunks[0].startsWith('# '));
});

test('splitToFitBudget: extreme paragraph forces char-split — kein Verlust', () => {
  const b = computePromptBudget({
    modelContextTokens: 1_000,
    maxOutputTokens: 900,
    overheadTokens: 80,
    minSourceChars: 50,
  });
  const giant = 'x'.repeat(500);
  const chunks = splitToFitBudget(giant, b);
  for (const c of chunks) assert.ok(c.length <= b.sourceMaxChars);
  // Sum aller chunks = original (char-for-char, weil keine paragraph-boundary)
  assert.equal(chunks.join('').length, 500);
});

test('splitToFitBudget: empty string → one empty chunk', () => {
  const b = computePromptBudget({
    modelContextTokens: 32_000,
    maxOutputTokens: 2_000,
    overheadTokens: 2_000,
  });
  assert.deepEqual(splitToFitBudget('', b), ['']);
});

test('shouldFanoutBySource: default factor 1.0 → fanout bei jeder Übergröße', () => {
  const b = computePromptBudget({
    modelContextTokens: 32_000,
    maxOutputTokens: 2_000,
    overheadTokens: 2_000,
  });
  assert.equal(shouldFanoutBySource(50_000, b), false);
  assert.equal(shouldFanoutBySource(b.sourceMaxChars + 1, b), true);
  // custom factor < 1 → frühes Fanout (safety)
  assert.equal(shouldFanoutBySource(b.sourceMaxChars * 0.95, b, 0.9), true);
});
