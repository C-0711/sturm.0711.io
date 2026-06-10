/**
 * Run: node --test --import tsx src/verticals/elster-v3/stages/elster-v6-stages.test.ts
 *
 * Verifies that both elster-v6 stages (Lohnsteuerbescheid + Einkommensteuer-
 * erklärung) are properly registered + have correct shape.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { lohnsteuerbescheidMapperStage } from './lohnsteuerbescheid-mapper-stage.ts';
import { einkommensteuererklaerungMapperStage } from './einkommensteuererklaerung-mapper-stage.ts';

test('LohnsteuerbescheidMapperStage: ID + shape', () => {
  assert.equal(lohnsteuerbescheidMapperStage.id, 'elster-v3/lohnsteuerbescheid-mapper');
  assert.match(lohnsteuerbescheidMapperStage.name, /Lohnsteuerbescheid/);
  assert.ok(typeof lohnsteuerbescheidMapperStage.run === 'function');
  assert.ok(lohnsteuerbescheidMapperStage.hints?.inputPorts);
  assert.ok(lohnsteuerbescheidMapperStage.hints?.outputPorts);
});

test('EinkommensteuererklaerungMapperStage: ID + shape', () => {
  assert.equal(
    einkommensteuererklaerungMapperStage.id,
    'elster-v3/einkommensteuererklaerung-mapper',
  );
  assert.match(einkommensteuererklaerungMapperStage.name, /Einkommensteuererklärung/);
  assert.ok(typeof einkommensteuererklaerungMapperStage.run === 'function');
  assert.ok(einkommensteuererklaerungMapperStage.hints?.inputPorts);
});

test('LStBMapper.run: empty belege → no-op', async () => {
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    emit: () => {},
    config: {},
  } as never;
  const result = await lohnsteuerbescheidMapperStage.run({ belege: [] }, ctx);
  assert.deepEqual(result.ecodes, {});
  assert.equal(result.lockCount, 0);
});

test('ESEMapper.run: empty ocrText → no-op', async () => {
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    emit: () => {},
    config: {},
  } as never;
  const result = await einkommensteuererklaerungMapperStage.run({ ocrText: '' }, ctx);
  assert.deepEqual(result.ecodes, {});
  assert.equal(result.lockCount, 0);
});

test('Both stages have distinct IDs', () => {
  assert.notEqual(lohnsteuerbescheidMapperStage.id, einkommensteuererklaerungMapperStage.id);
});
