/**
 * Tests fuer field-map-builder. Hand-gebaute Fixtures — keine Catalog-Abhaengigkeit.
 *
 * Run: node --test --import tsx src/lib/field-map-builder.test.ts
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { buildFieldMap } from './field-map-builder.ts';
import type { AnlagenFeld, AnlagenFelderListe } from './elster-catalog.ts';

function feld(o: Partial<AnlagenFeld> & { eCode: string }): AnlagenFeld {
  return {
    eCode: o.eCode,
    drucktext: o.drucktext ?? `Drucktext ${o.eCode}`,
    bezeichnung: o.bezeichnung ?? '',
    datentyp: o.datentyp ?? 'string',
    formatRegex: o.formatRegex ?? '',
    pflicht: o.pflicht ?? false,
    vordruckzeile: o.vordruckzeile ?? '1',
    einkunftsart: o.einkunftsart ?? null,
    maxLaenge: o.maxLaenge,
    minLaenge: o.minLaenge,
  };
}

function liste(anlage: string, felder: AnlagenFeld[]): AnlagenFelderListe {
  // anlage-Cast: ElsterAnlage ist string-Literal-Union; fuer Tests reicht der String.
  return { anlage: anlage as AnlagenFelderListe['anlage'], felder };
}

test('empty input: only header in mapText, empty schema, empty stats', () => {
  const r = buildFieldMap({ perAnlage: {} });
  assert.equal(r.mapText, 'FELD-MAPPING (eCode | Anlage | Zeile | Bezeichnung):');
  assert.deepEqual(r.jsonSchema.schema.properties, {});
  assert.equal(r.fields.length, 0);
  assert.equal(r.stats.totalFields, 0);
  assert.equal(r.stats.pflichtCount, 0);
  assert.deepEqual(r.stats.byAnlage, {});
  assert.equal(r.stats.droppedByCap, 0);
  assert.equal(r.jsonSchema.name, 'elster_extract');
  assert.equal(r.jsonSchema.strict, true);
  assert.equal(r.jsonSchema.schema.additionalProperties, false);
});

test('one Anlage, 3 fields (1 pflicht, 2 not) — pflicht sortiert nach vorn', () => {
  const r = buildFieldMap({
    perAnlage: {
      N: liste('N', [
        feld({ eCode: 'E0200401', drucktext: 'Lohnsteuer', datentyp: 'currency', vordruckzeile: '6' }),
        feld({ eCode: 'E0200201', drucktext: 'Bruttoarbeitslohn', datentyp: 'currency', vordruckzeile: '5', pflicht: true }),
        // 'integer' is not in ElsterDatentyp but the builder accepts any string via datentyp.
        feld({ eCode: 'E0200103', drucktext: 'Steuerklasse', datentyp: 'integer' as AnlagenFeld['datentyp'], vordruckzeile: '4' }),
      ]),
    },
  });
  assert.equal(r.fields[0].eCode, 'E0200201', 'pflicht muss ganz vorne sein');
  // Die restlichen zwei: nach Vordruckzeile, also 4 vor 6.
  assert.equal(r.fields[1].eCode, 'E0200103');
  assert.equal(r.fields[2].eCode, 'E0200401');
  assert.equal(r.stats.pflichtCount, 1);
  assert.equal(r.stats.totalFields, 3);
  assert.deepEqual(r.stats.byAnlage, { N: 3 });
});

test('two Anlagen grouped alphabetically (KAP before N)', () => {
  const r = buildFieldMap({
    perAnlage: {
      N: liste('N', [feld({ eCode: 'E0200201', vordruckzeile: '5', pflicht: true })]),
      KAP: liste('KAP', [feld({ eCode: 'E0700100', vordruckzeile: '7', pflicht: true })]),
    },
  });
  assert.equal(r.fields[0].anlage, 'KAP');
  assert.equal(r.fields[1].anlage, 'N');
  const lines = r.mapText.split('\n');
  assert.ok(lines[1].includes('KAP'), 'KAP-Zeile zuerst');
  assert.ok(lines[2].includes(' N |') || lines[2].includes('| N |'), 'dann N');
});

test('anlagenSubset filters out other anlagen', () => {
  const r = buildFieldMap({
    perAnlage: {
      N: liste('N', [feld({ eCode: 'E0200201' })]),
      KAP: liste('KAP', [feld({ eCode: 'E0700100' })]),
      G: liste('G', [feld({ eCode: 'E0300100' })]),
    },
    anlagenSubset: ['N'],
  });
  assert.equal(r.fields.length, 1);
  assert.equal(r.fields[0].anlage, 'N');
  assert.deepEqual(r.stats.byAnlage, { N: 1 });
});

test('anlagenSubset with unknown anlage is silently skipped', () => {
  const r = buildFieldMap({
    perAnlage: {
      N: liste('N', [feld({ eCode: 'E0200201' })]),
    },
    anlagenSubset: ['N', 'KAP', 'SOMETHING_ELSE'],
  });
  assert.equal(r.fields.length, 1);
});

test('maxFields=2 with 5 fields (2 pflicht) keeps only the 2 pflicht', () => {
  const r = buildFieldMap({
    perAnlage: {
      N: liste('N', [
        feld({ eCode: 'E0001', pflicht: false, vordruckzeile: '1' }),
        feld({ eCode: 'E0002', pflicht: true, vordruckzeile: '2' }),
        feld({ eCode: 'E0003', pflicht: false, vordruckzeile: '3' }),
        feld({ eCode: 'E0004', pflicht: true, vordruckzeile: '4' }),
        feld({ eCode: 'E0005', pflicht: false, vordruckzeile: '5' }),
      ]),
    },
    maxFields: 2,
  });
  assert.equal(r.fields.length, 2);
  assert.ok(r.fields.every((f) => f.pflicht), 'nur pflicht-Felder bleiben');
  assert.equal(r.stats.pflichtCount, 2);
  assert.equal(r.stats.droppedByCap, 3);
});

test('custom hintForDatentyp ueberschreibt Default-Hints', () => {
  const r = buildFieldMap({
    perAnlage: {
      N: liste('N', [feld({ eCode: 'E0001', datentyp: 'currency', vordruckzeile: '1' })]),
    },
    hintForDatentyp: (dt) => `<<${dt}>>`,
  });
  assert.ok(r.fields[0].hintLine.endsWith('<<currency>>'), `actual: ${r.fields[0].hintLine}`);
});

test('JSON schema properties match exactly the fields (no extras, no missing)', () => {
  const r = buildFieldMap({
    perAnlage: {
      N: liste('N', [
        feld({ eCode: 'E0001', vordruckzeile: '1' }),
        feld({ eCode: 'E0002', vordruckzeile: '2' }),
      ]),
      G: liste('G', [feld({ eCode: 'E0003', vordruckzeile: '3' })]),
    },
  });
  const schemaKeys = Object.keys(r.jsonSchema.schema.properties).sort();
  const fieldKeys = r.fields.map((f) => f.eCode).sort();
  assert.deepEqual(schemaKeys, fieldKeys);
  for (const v of Object.values(r.jsonSchema.schema.properties)) {
    assert.deepEqual(v, { type: ['string', 'null'] });
  }
});

test('duplicate eCode across anlagen: first-wins dedup', () => {
  const r = buildFieldMap({
    perAnlage: {
      // Die Iteration ist insertion-order. KAP wird zuerst gesehen.
      KAP: liste('KAP', [feld({ eCode: 'E9999', drucktext: 'erstes' })]),
      N: liste('N', [feld({ eCode: 'E9999', drucktext: 'zweites' })]),
    },
  });
  assert.equal(r.fields.length, 1);
  assert.equal(r.fields[0].anlage, 'KAP');
  assert.equal(r.fields[0].drucktext, 'erstes');
});

test('drucktext with pipe character ist escaped (kein | in der Tabelle)', () => {
  const r = buildFieldMap({
    perAnlage: {
      N: liste('N', [feld({ eCode: 'E0001', drucktext: 'links | rechts', vordruckzeile: '1' })]),
    },
  });
  const drucktextPart = r.fields[0].hintLine.split('|').slice(3).join('|');
  assert.ok(!r.fields[0].drucktext === false);
  // Genau drei Trennstriche im hintLine (eCode | Anlage | Zeile | Text) — kein vierter.
  const pipeCount = (r.fields[0].hintLine.match(/\|/g) || []).length;
  assert.equal(pipeCount, 3, `expected 3 pipes, got ${pipeCount}: ${r.fields[0].hintLine}`);
  assert.ok(drucktextPart.includes('links / rechts'));
});

test('vordruckzeile leer/missing → "-" in der Tabelle', () => {
  const r = buildFieldMap({
    perAnlage: {
      N: liste('N', [feld({ eCode: 'E0001', vordruckzeile: '' })]),
    },
  });
  assert.ok(r.fields[0].hintLine.includes('| - |'), r.fields[0].hintLine);
});

test('mapText hat sauberen Header + indentierte Zeilen', () => {
  const r = buildFieldMap({
    perAnlage: {
      N: liste('N', [
        feld({ eCode: 'E0200201', drucktext: 'Bruttoarbeitslohn', datentyp: 'currency', vordruckzeile: '5', pflicht: true }),
      ]),
    },
  });
  const lines = r.mapText.split('\n');
  assert.equal(lines[0], 'FELD-MAPPING (eCode | Anlage | Zeile | Bezeichnung):');
  assert.ok(lines[1].startsWith('  '), 'Zeilen sind eingerueckt');
  assert.ok(lines[1].includes('Bruttoarbeitslohn'));
  assert.ok(lines[1].includes('Eurobetrag'));
});

test('schemaName-Override', () => {
  const r = buildFieldMap({
    perAnlage: {},
    schemaName: 'my_custom_schema',
  });
  assert.equal(r.jsonSchema.name, 'my_custom_schema');
});
