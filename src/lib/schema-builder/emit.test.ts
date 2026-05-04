/**
 * Run: `node --test --import tsx src/lib/schema-builder/emit.test.ts`
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { toJsonSchema } from './emit.ts';
import { coerce, coerceTree } from './post-process.ts';
import type { BuilderField } from './types.ts';

test('toJsonSchema emits additionalProperties:false and required list', () => {
  const fields: BuilderField[] = [
    { id: '1', name: 'name', kind: 'text', config: { kind: 'text' }, required: true },
    { id: '2', name: 'amount', kind: 'currency_eur', config: { kind: 'currency_eur' }, required: false },
  ];
  const out = toJsonSchema('extraction', fields);
  assert.equal(out.name, 'extraction');
  assert.equal(out.schema.type, 'object');
  assert.equal(out.schema.additionalProperties, false);
  assert.deepEqual(out.schema.required, ['name']);
  assert.equal(out.schema.properties!.name.type, 'string');
  assert.equal(out.schema.properties!.amount.type, 'number');
  assert.match(String(out.schema.properties!.amount.description), /German notation/);
});

test('checkbox emits boolean; coerce handles ☑/☐', () => {
  const fields: BuilderField[] = [
    { id: '1', name: 'agree', kind: 'checkbox', config: { kind: 'checkbox' }, required: true,
      ocrBinding: { type: 'checkbox' } },
  ];
  const out = toJsonSchema('cb', fields);
  assert.equal(out.schema.properties!.agree.type, 'boolean');
  assert.equal(coerce('☑', { type: 'checkbox' }), true);
  assert.equal(coerce('☐', { type: 'checkbox' }), false);
  assert.equal(coerce('Ja', { type: 'checkbox' }), true);
  assert.equal(coerce('vielleicht', { type: 'checkbox' }), null);
});

test('amount coercion: German notation', () => {
  assert.equal(coerce('1.234,56', { type: 'amount', locale: 'de-DE', currency: 'EUR' }), 1234.56);
  assert.equal(coerce('1.234.567,89 EUR', { type: 'amount', locale: 'de-DE', currency: 'EUR' }), 1234567.89);
  assert.equal(coerce(42, { type: 'amount', locale: 'de-DE', currency: 'EUR' }), 42);
});

test('IBAN coercion validates shape and DE-length', () => {
  assert.equal(coerce('DE89 3704 0044 0532 0130 00', { type: 'iban', country: 'DE' }), 'DE89370400440532013000');
  assert.equal(coerce('DE89370400440532013000', { type: 'iban', country: 'DE' }), 'DE89370400440532013000');
  assert.equal(coerce('GB29 NWBK 6016 1331 9268 19', { type: 'iban' }), 'GB29NWBK60161331926819');
  assert.equal(coerce('NOPE', { type: 'iban' }), null);
  assert.equal(coerce('DE89', { type: 'iban', country: 'DE' }), null); // wrong length for DE
});

test('German tax-id checksum', () => {
  // Known-good test ID from the BZSt spec: 02476291358
  assert.equal(coerce('02476291358', { type: 'tax_id', country: 'DE' }), '02476291358');
  assert.equal(coerce('12345678901', { type: 'tax_id', country: 'DE' }), null);
  assert.equal(coerce('not a tax id', { type: 'tax_id', country: 'DE' }), null);
});

test('coerceTree walks objects and applies bindings only to leaves with bindings', () => {
  const fields: BuilderField[] = [
    { id: '1', name: 'person', kind: 'object', config: { kind: 'object' }, required: true,
      children: [
        { id: '1a', name: 'name', kind: 'text', config: { kind: 'text' }, required: true },
        { id: '1b', name: 'iban', kind: 'iban', config: { kind: 'iban' }, required: false,
          ocrBinding: { type: 'iban', country: 'DE' } },
      ],
    },
    { id: '2', name: 'amount', kind: 'currency_eur', config: { kind: 'currency_eur' }, required: false,
      ocrBinding: { type: 'amount', locale: 'de-DE', currency: 'EUR' } },
  ];
  const result = coerceTree({
    person: { name: 'Müller', iban: 'DE89 3704 0044 0532 0130 00' },
    amount: '1.234,56',
  }, fields);
  assert.deepEqual(result, {
    person: { name: 'Müller', iban: 'DE89370400440532013000' },
    amount: 1234.56,
  });
});

test('array<object> recursion uses parent children as item shape', () => {
  const fields: BuilderField[] = [
    { id: '1', name: 'rows', kind: 'array', config: { kind: 'array', itemKind: 'object' }, required: true,
      children: [
        { id: '1a', name: 'label', kind: 'text', config: { kind: 'text' }, required: true },
      ],
    },
  ];
  const out = toJsonSchema('rows', fields);
  const arr = out.schema.properties!.rows;
  assert.equal(arr.type, 'array');
  assert.equal(arr.items!.type, 'object');
  assert.equal(arr.items!.additionalProperties, false);
  assert.equal(arr.items!.properties!.label.type, 'string');
});
