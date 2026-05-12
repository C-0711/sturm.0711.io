/**
 * Tests für die Container-driven Validatoren in src/lib/elster-catalog.ts.
 * Reine Logik-Tests — keine Embedding- oder LLM-Calls.
 *
 * Run: node --test --import tsx src/lib/elster-catalog.test.ts
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  normalizeForElster,
  checkFormat,
  einkunftsartVonAtom,
  einkunftsartenVonAtomen,
  paragraphFuer,
  type CatalogAtom,
} from './elster-catalog.ts';

function atom(overrides: {
  field_name: string;
  value?: string;
  metadata: Partial<CatalogAtom['metadata']> & {
    anlage: string;
    datentyp: CatalogAtom['metadata']['datentyp'];
    formatRegex: string;
  };
}): CatalogAtom {
  const meta = {
    pflicht: false,
    vordruckzeile: '1',
    drucktext: '',
    ...overrides.metadata,
  } as CatalogAtom['metadata'];
  return {
    atom_id: `test/${overrides.field_name}`,
    container_id: 'test',
    layer_id: 'elster',
    field_path: `elster.${overrides.field_name}`,
    field_name: overrides.field_name,
    value: overrides.value ?? overrides.field_name,
    value_type: 'string',
    lang: 'de',
    citation_document: 'test',
    citation_section: '',
    citation_excerpt: '',
    citation_confidence: 1,
    citation_method: 'test',
    trust_level: 'verified',
    source_type: 'primary-source',
    contributor_id: 'test',
    commit_hash: 'test',
    metadata: meta,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// normalizeForElster
// ──────────────────────────────────────────────────────────────────────────

test('normalizeForElster currency: German notation → cents', () => {
  assert.equal(normalizeForElster('1.234,56', 'currency'), '123456');
  assert.equal(normalizeForElster('30.707,00', 'currency'), '3070700');
  assert.equal(normalizeForElster('-30.707,00', 'currency'), '-3070700');
  assert.equal(normalizeForElster('1.234,56 €', 'currency'), '123456');
  assert.equal(normalizeForElster('200,00', 'currency'), '20000');
  assert.equal(normalizeForElster('200', 'currency'), '20000');
  assert.equal(normalizeForElster('200.00', 'currency'), '20000'); // ISO accepted too
});

test('normalizeForElster currency: pure integer (e.g. PLZ)', () => {
  assert.equal(normalizeForElster('40878', 'currency'), '4087800');
  // hint: bei PLZ-Feldern ist der formatRegex separat (5-stellig) — die
  // currency-Normalisierung produziert "4087800", was die PLZ-regex ablehnt;
  // genau das wollen wir auch (Fehlerverhalten erwünscht).
});

test('normalizeForElster date: ISO → DE', () => {
  assert.equal(normalizeForElster('2024-12-31', 'date'), '31.12.2024');
  assert.equal(normalizeForElster('2024/01/05', 'date'), '05.01.2024');
});

test('normalizeForElster date: already DE → passthrough', () => {
  assert.equal(normalizeForElster('31.12.2024', 'date'), '31.12.2024');
  assert.equal(normalizeForElster('1.1.2024', 'date'), '01.01.2024');
});

test('normalizeForElster date: garbage → null', () => {
  assert.equal(normalizeForElster('blablubb', 'date'), null);
  assert.equal(normalizeForElster('', 'date'), null);
});

test('normalizeForElster string: trim only', () => {
  assert.equal(normalizeForElster('  Hello  ', 'string'), 'Hello');
});

// ──────────────────────────────────────────────────────────────────────────
// checkFormat
// ──────────────────────────────────────────────────────────────────────────

test('checkFormat: real Bruttoarbeitslohn-Atom passes on valid value', () => {
  // E0200201 — Bruttoarbeitslohn, currency, 12-stelliger Integer-Regex
  const a = atom({
    field_name: 'E0200201',
    metadata: {
      anlage: 'N', datentyp: 'currency', pflicht: false, vordruckzeile: '5',
      drucktext: 'Bruttoarbeitslohn',
      formatRegex: '^(?=.{1,12}$)(-(?=.*[1-9].*))?(?!0\\d)\\d{1,12}$',
      maxLaenge: 12,
    },
  });
  const r = checkFormat('30.707,00', a);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.normalized, '3070700');
});

test('checkFormat: rejects out-of-range value (>maxLaenge)', () => {
  const a = atom({
    field_name: 'E0200201',
    metadata: {
      anlage: 'N', datentyp: 'currency', pflicht: false, vordruckzeile: '5',
      drucktext: 'Bruttoarbeitslohn',
      formatRegex: '^\\d{1,12}$',
      maxLaenge: 12,
    },
  });
  const r = checkFormat('99999999999999999', a); // >12 digits
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /maxLaenge|regex/);
});

test('checkFormat: rejects bad date', () => {
  const a = atom({
    field_name: 'E1800501',
    metadata: {
      anlage: 'R', datentyp: 'date', pflicht: true, vordruckzeile: '4',
      drucktext: 'Beginn der Rente',
      formatRegex: '\\d\\d\\.\\d\\d\\.\\d\\d\\d\\d',
    },
  });
  assert.equal(checkFormat('blah', a).ok, false);
  assert.equal(checkFormat('1995-12-01', a).ok, true); // ISO normalises to DE first
  assert.equal(checkFormat('01.12.1995', a).ok, true);
});

test('checkFormat: null/empty → not ok', () => {
  const a = atom({
    field_name: 'E0100201',
    metadata: { anlage: 'ESt1A', datentyp: 'string', formatRegex: '.*' },
  });
  assert.equal(checkFormat(null, a).ok, false);
  assert.equal(checkFormat('', a).ok, false);
});

// ──────────────────────────────────────────────────────────────────────────
// einkunftsartVonAtom / einkunftsartenVonAtomen
// ──────────────────────────────────────────────────────────────────────────

test('einkunftsartVonAtom: extracts prefix before "/"', () => {
  const a = atom({
    field_name: 'E0200201',
    metadata: {
      anlage: 'N', datentyp: 'currency', formatRegex: '.*',
      kontextPaths: ['ArbL/LStB_1_5_Sum'],
    },
  });
  assert.equal(einkunftsartVonAtom(a), 'ArbL');
});

test('einkunftsartVonAtom: null when kontextPaths missing/empty', () => {
  const a = atom({
    field_name: 'X',
    metadata: { anlage: 'N', datentyp: 'string', formatRegex: '.*' },
  });
  assert.equal(einkunftsartVonAtom(a), null);
});

test('einkunftsartenVonAtomen: dedupes preserving first-occurrence order', () => {
  const xs = [
    atom({ field_name: 'A', metadata: { anlage: 'N', datentyp: 'currency', formatRegex: '.*', kontextPaths: ['ArbL/x'] } }),
    atom({ field_name: 'B', metadata: { anlage: 'N', datentyp: 'currency', formatRegex: '.*', kontextPaths: ['Wk/y'] } }),
    atom({ field_name: 'C', metadata: { anlage: 'N', datentyp: 'currency', formatRegex: '.*', kontextPaths: ['ArbL/z'] } }),
    atom({ field_name: 'D', metadata: { anlage: 'SA', datentyp: 'currency', formatRegex: '.*', kontextPaths: ['Zuw/q'] } }),
  ];
  assert.deepEqual(einkunftsartenVonAtomen(xs), ['ArbL', 'Wk', 'Zuw']);
});

// ──────────────────────────────────────────────────────────────────────────
// paragraphFuer
// ──────────────────────────────────────────────────────────────────────────

test('paragraphFuer: known prefix → §EStG-Zitat (aus Container)', async () => {
  assert.match(await paragraphFuer('ArbL'), /§19/);
  assert.match(await paragraphFuer('Leibr_gesetzl'), /§22/);
  assert.match(await paragraphFuer('Zuw'), /§10b/);
  assert.match(await paragraphFuer('St_Erm'), /§35a/);
});

test('paragraphFuer: unknown prefix → fallback', async () => {
  assert.match(await paragraphFuer('UnbekannterCode_123'), /nicht zugeordnet/);
});
