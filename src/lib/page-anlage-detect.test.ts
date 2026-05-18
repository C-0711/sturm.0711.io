import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitOcrByPages,
  detectAnlagenPerPage,
  pagesForAnlage,
} from './page-anlage-detect.ts';

test('splitOcrByPages: clean Stricker-style markers', () => {
  const text = [
    'Seite 1 von 3',
    'Hauptvordruck ESt 1 A',
    'Vorname: Rainer',
    '',
    'Seite 2 von 3',
    'Anlage N',
    'Bruttoarbeitslohn 63.559,90',
    '',
    'Seite 3 von 3',
    'Anlage Vorsorgeaufwand',
  ].join('\n');
  const pages = splitOcrByPages(text);
  assert.equal(pages.length, 3);
  assert.match(pages[0], /Hauptvordruck/);
  assert.match(pages[1], /Anlage N/);
  assert.match(pages[2], /Vorsorgeaufwand/);
});

test('splitOcrByPages: no markers → single page', () => {
  const text = 'Just one blob of text\nwith no Seite markers.';
  const pages = splitOcrByPages(text);
  assert.equal(pages.length, 1);
  assert.equal(pages[0], text);
});

test('splitOcrByPages: empty input → one empty page', () => {
  assert.deepEqual(splitOcrByPages(''), ['']);
  assert.deepEqual(splitOcrByPages(undefined as unknown as string), ['']);
});

test('detectAnlagenPerPage: Stricker-shaped 6-page case', () => {
  const pages = [
    'Hauptvordruck ESt 1 A\nVorname: Rainer',
    'Anlage N\nWerbungskosten',
    'Anlage KAP (Person A)\nEinkünfte aus Kapitalvermögen',
    'Anlage KAP (Person B)',
    'Anlage Vorsorgeaufwand\nKrankenversicherung',
    'Hinweise und Belehrungen\nDatenschutz',
  ];
  const m = detectAnlagenPerPage(pages);
  assert.deepEqual(m['ESt1A'], [0]);
  assert.deepEqual(m['N'], [1]);
  assert.deepEqual(m['KAP'], [2, 3]);
  assert.deepEqual(m['VOR'], [4]);
  assert.equal(m['KAP_I'], undefined);
});

test('detectAnlagenPerPage: KAP-INV does not pollute KAP', () => {
  const pages = ['Anlage KAP-INV\nInvestmenterträge'];
  const m = detectAnlagenPerPage(pages);
  assert.deepEqual(m['KAP_I'], [0]);
  // KAP_I matches BOTH "Anlage KAP-INV" and "Investmenterträge"; KAP's
  // regex uses (?![- ]?INV) negative lookahead, so it must NOT match.
  assert.equal(m['KAP'], undefined);
});

test('detectAnlagenPerPage: multiple anlagen same page', () => {
  const pages = ['Anlage N\n…\nAnlage Vorsorgeaufwand'];
  const m = detectAnlagenPerPage(pages);
  assert.deepEqual(m['N'], [0]);
  assert.deepEqual(m['VOR'], [0]);
});

test('pagesForAnlage: hit returns page list', () => {
  const m = { VOR: [4, 5] };
  assert.deepEqual(pagesForAnlage('VOR', m, 6), [4, 5]);
});

test('pagesForAnlage: miss + all-pages fallback', () => {
  assert.deepEqual(pagesForAnlage('VOR', {}, 3, 'all-pages'), [0, 1, 2]);
});

test('pagesForAnlage: miss + first-page fallback', () => {
  assert.deepEqual(pagesForAnlage('VOR', {}, 3, 'first-page'), [0]);
});
