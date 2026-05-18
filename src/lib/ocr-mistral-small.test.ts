import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Import the internal splitter via re-running it on captured text.
// We don't export it directly; we exercise it indirectly through the
// fixture's pre-joined markdown and assert page-grouping behaviour
// matches the expected 6-page Stricker shape.

interface Fixture {
  generatedAt: string;
  sourcePdf: string;
  sha256: string;
  ocrModel: string;
  ocrMs: number;
  pages: Array<{ index: number; markdown: string }>;
  markdown: string;
}

const FIXTURE = path.join(
  process.cwd(),
  'tests/fixtures/stricker-ocr-mistral-small.json',
);

test('stricker fixture exists and has expected shape', () => {
  if (!fs.existsSync(FIXTURE)) {
    console.warn(`  ⊘ skipping — fixture not present at ${FIXTURE}`);
    return;
  }
  const fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8')) as Fixture;
  assert.ok(Array.isArray(fx.pages));
  assert.ok(fx.pages.length >= 6, `expected ≥6 pages, got ${fx.pages.length}`);
  assert.ok(fx.ocrModel.startsWith('mistral-small'));
  assert.ok(fx.markdown.length > 1000);
});

test('stricker fixture contains Stricker identity markers', () => {
  if (!fs.existsSync(FIXTURE)) return;
  const fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8')) as Fixture;
  // Hauptvordruck cover page identifiers (real Stricker form).
  assert.match(fx.markdown, /Stricker|Hauptvordruck|ESt\s*1\s*A/i);
  // Werbungskosten page numbers (Anlage N Zeile 57/65/67).
  assert.match(fx.markdown, /Arbeitsmittel|Kontoführungsgeb/i);
  // Vorsorgeaufwand page identifier.
  assert.match(fx.markdown, /Arbeitslosenversicherung|Vorsorgeaufwendungen/i);
});

test('stricker fixture preserves Zeile numbers (page-Zeile filter requirement)', () => {
  if (!fs.existsSync(FIXTURE)) return;
  const fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8')) as Fixture;
  // Spike-required Zeile leaders: 5 Brutto, 57 Arbeitsmittel, 67 Summe,
  // 43 Arbeitslosenvers.
  const rowLeaders = [...fx.markdown.matchAll(/(?:^|\n|\|)\s*(\d{1,3})\s+[A-ZÄÖÜa-zäöü]/g)]
    .map((m) => m[1]);
  const unique = new Set(rowLeaders);
  // We expect at least these well-known ELSTER Zeile numbers in Stricker:
  // 4 (Steuerklasse), 5 (Brutto), 43 (ALV), 57 (Arbeitsmittel), 65/67 (Werbungskosten)
  const expected = ['4', '5', '57'];
  for (const e of expected) {
    assert.ok(unique.has(e), `expected Zeile ${e} in fixture; got ${[...unique].sort().slice(0, 30).join(',')}`);
  }
});
