/**
 * lane2-adapter Tests — pure-function checks (kein Netzwerk).
 *
 * Ausführen:
 *   npx tsx src/workflows/elster/lib/field-mapper/lane2-adapter.test.ts
 */
import { ocrEnsembleToRawText } from './lane2-adapter.ts';
import type { OcrEnsembleResponse } from './ocr-ensemble-client.ts';

let pass = 0, fail = 0;
function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`, detail ?? ''); }
}

console.log('\n1. Records mit bbox auf gleicher Y-Linie → eine Zeile mit Spaces\n');
{
  const resp: OcrEnsembleResponse = {
    document_sha256_hex: 'deadbeef',
    consensus_pages: [
      {
        page_index: 0,
        records: [
          { text: 'Bruttoarbeitslohn',
            bbox: [50, 100, 200, 120],
            confidence_min: 0.9, voters: ['paddle'] },
          { text: '69.291,80 €',
            bbox: [500, 100, 600, 120],
            confidence_min: 0.9, voters: ['paddle'] },
        ],
      },
    ],
    tagged_pages: [],
  };
  const text = ocrEnsembleToRawText(resp);
  assert('eine Zeile', text.split('\n').length === 1);
  assert('Label vor Wert', text.indexOf('Bruttoarbeitslohn') < text.indexOf('69.291'));
  assert('≥2 Spaces zwischen Label und Wert', /Bruttoarbeitslohn\s{2,}69\./.test(text), text);
}

console.log('\n2. Records auf verschiedenen Y-Linien → mehrere Zeilen\n');
{
  const resp: OcrEnsembleResponse = {
    document_sha256_hex: 'deadbeef',
    consensus_pages: [
      {
        page_index: 0,
        records: [
          { text: 'Bruttoarbeitslohn',
            bbox: [50, 100, 200, 120],
            confidence_min: 0.9, voters: ['paddle'] },
          { text: 'Lohnsteuer',
            bbox: [50, 200, 200, 220],
            confidence_min: 0.9, voters: ['paddle'] },
          { text: '7.532,00',
            bbox: [500, 200, 600, 220],
            confidence_min: 0.9, voters: ['paddle'] },
        ],
      },
    ],
    tagged_pages: [],
  };
  const text = ocrEnsembleToRawText(resp);
  const lines = text.split('\n');
  assert('zwei Zeilen', lines.length === 2, lines);
  assert('Zeile 1 = Bruttoarbeitslohn allein',
    lines[0].trim() === 'Bruttoarbeitslohn', lines[0]);
  assert('Zeile 2 = Lohnsteuer + 7.532,00',
    /Lohnsteuer\s{2,}7\.532,00/.test(lines[1]), lines[1]);
}

console.log('\n3. Records ohne bbox → eigene Zeilen am Page-Ende\n');
{
  const resp: OcrEnsembleResponse = {
    document_sha256_hex: 'deadbeef',
    consensus_pages: [
      {
        page_index: 0,
        records: [
          { text: 'Hat-bbox', bbox: [0, 0, 10, 10], confidence_min: 1, voters: [] },
          { text: 'Nullbox-1', bbox: null, confidence_min: 1, voters: [] },
          { text: 'Nullbox-2', bbox: null, confidence_min: 1, voters: [] },
        ],
      },
    ],
    tagged_pages: [],
  };
  const text = ocrEnsembleToRawText(resp);
  const lines = text.split('\n');
  assert('drei Zeilen', lines.length === 3, lines);
  assert('bbox-Record zuerst',  lines[0].includes('Hat-bbox'));
  assert('Nullbox-Records folgen in insertion-order',
    lines[1] === 'Nullbox-1' && lines[2] === 'Nullbox-2', [lines[1], lines[2]]);
}

console.log('\n4. Mehrere Pages → mit Doppel-Newline getrennt\n');
{
  const resp: OcrEnsembleResponse = {
    document_sha256_hex: 'deadbeef',
    consensus_pages: [
      { page_index: 1, records: [{ text: 'Page-2', bbox: null, confidence_min: 1, voters: [] }] },
      { page_index: 0, records: [{ text: 'Page-1', bbox: null, confidence_min: 1, voters: [] }] },
    ],
    tagged_pages: [],
  };
  const text = ocrEnsembleToRawText(resp);
  assert('Page-1 vor Page-2 (sort by page_index)',
    text.indexOf('Page-1') < text.indexOf('Page-2'), text);
  assert('Pages durch Leerzeile getrennt',
    /Page-1\n\nPage-2/.test(text), text);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
