/**
 * Run: node --test --import tsx src/verticals/elster-v3/stages/felder-katalog.test.ts
 *
 * Tests den Container-Lookup-Pfad gegen das echte atoms.json (read-only).
 * Verifies sort-order: pflicht=true zuerst, dann vordruckzeile aufsteigend.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { felderFuerAnlage } from '../../../lib/elster-catalog.ts';

test('felderFuerAnlage("N") liefert sortierte Felder mit Pflicht zuerst', async () => {
  const liste = await felderFuerAnlage('N');
  assert.equal(liste.anlage, 'N');
  assert.ok(liste.felder.length > 0, 'Anlage N hat Felder');
  // Alle eCodes matchen das Format
  for (const f of liste.felder) {
    assert.match(f.eCode, /^E\d+$/, `bad eCode: ${f.eCode}`);
    assert.equal(typeof f.drucktext, 'string');
    assert.ok(['string', 'date', 'currency'].includes(f.datentyp));
    assert.equal(typeof f.formatRegex, 'string');
    assert.equal(typeof f.pflicht, 'boolean');
    assert.equal(typeof f.vordruckzeile, 'string');
  }
  // Sort: pflicht zuerst
  const firstNonPflichtIdx = liste.felder.findIndex((f) => !f.pflicht);
  if (firstNonPflichtIdx > 0) {
    // Alle vor diesem Index müssen pflicht=true sein
    for (let i = 0; i < firstNonPflichtIdx; i++) {
      assert.equal(liste.felder[i].pflicht, true, `slot ${i} sollte pflicht sein`);
    }
    // Alle ab diesem Index dürfen NICHT pflicht sein
    for (let i = firstNonPflichtIdx; i < liste.felder.length; i++) {
      assert.equal(liste.felder[i].pflicht, false, `slot ${i} sollte nicht pflicht sein`);
    }
  }
});

test('felderFuerAnlage liefert leeres Array für unbekannte Anlage', async () => {
  const liste = await felderFuerAnlage('XYZ_GIBT_ES_NICHT');
  assert.equal(liste.felder.length, 0);
  assert.equal(liste.anlage, 'XYZ_GIBT_ES_NICHT');
});

test('felderFuerAnlage: Anlage R enthält Renten-eCodes', async () => {
  const liste = await felderFuerAnlage('R');
  assert.ok(liste.felder.length > 0);
  // Anlage R sollte den eCode für Rentenbetrag enthalten (E1800301)
  const rentenBetrag = liste.felder.find((f) => f.eCode === 'E1800301');
  assert.ok(rentenBetrag, 'E1800301 (Rentenbetrag) muss in Anlage R sein');
  assert.equal(rentenBetrag.datentyp, 'currency');
  // Einkunftsart-Prefix sollte gesetzt sein (BMF-Vokabular)
  assert.ok(
    rentenBetrag.einkunftsart === null || rentenBetrag.einkunftsart.length > 0,
    'einkunftsart entweder null oder non-empty string',
  );
});

test('felderFuerAnlage: vordruckzeile-Sortierung innerhalb gleicher Pflicht-Klasse', async () => {
  const liste = await felderFuerAnlage('N');
  const pflichtFelder = liste.felder.filter((f) => f.pflicht);
  // monotone aufsteigend
  for (let i = 1; i < pflichtFelder.length; i++) {
    const prev = Number(pflichtFelder[i - 1].vordruckzeile) || Number.MAX_SAFE_INTEGER;
    const curr = Number(pflichtFelder[i].vordruckzeile) || Number.MAX_SAFE_INTEGER;
    assert.ok(prev <= curr, `pflicht-Felder nicht sortiert bei ${i}: ${prev} > ${curr}`);
  }
});
