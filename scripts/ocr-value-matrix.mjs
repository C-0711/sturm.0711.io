#!/usr/bin/env node
/**
 * Volle Matrix: aus dem OCR-Text alle Werte rausziehen, gegen das
 * canonical_layer eines Run abgleichen, GAP aufzeigen (was im Text ist
 * aber NICHT als eCode gemappt wurde, und umgekehrt).
 *
 *   node scripts/ocr-value-matrix.mjs <runId>           # default: latest est_2023
 */
import { readFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

let runId = process.argv[2];
if (!runId) {
  const runs = (await readdir(path.join(REPO, 'runs/elster-v5_2-rag'))).sort().reverse();
  for (const r of runs) {
    try {
      const inp = JSON.parse(await readFile(path.join(REPO, 'runs/elster-v5_2-rag', r, '_input.json'), 'utf-8'));
      if (inp.filename === 'stricker_est_2023.pdf') { runId = r; break; }
    } catch {}
  }
}
if (!runId) { console.error('no run found'); process.exit(1); }
console.log(`Run: ${runId}`);

const result = JSON.parse(await readFile(path.join(REPO, 'runs/elster-v5_2-rag', runId, '_result.json'), 'utf-8'));
const ocrText = result.stages.ocr.output.text;
const canonical = result.stages.phase5Merge.output.canonical_layer || {};

// Parse OCR text into lines, find every line that looks like "Zeile X Drucktext Wert"
const lines = ocrText.split('\n');

// Pattern: starts with optional Zeilen-Nr, then label, then value at end.
// Beispiele:
//   "8 Identifikationsnummer 85236749007"
//   "5 Bruttoarbeitslohn 63.559,90"
//   "11 Religion ev"
//   "Steuernummer 02/171/51864"
//   "Soliditätszuschlag 0,00"
const LINE_RX = /^\s*(?:(\d{1,3})\s+)?([A-ZÄÖÜßa-zäöü0-9 ,()\-./%§&'":+]+?)\s+([A-Za-z0-9.,/+\-:€%]+)\s*$/;
const VALUE_RX = /^([+\-]?\d{1,3}(?:\.\d{3})*,\d{2}|[+\-]?\d{1,3}(?:\.\d{3})+|[+\-]?\d{2,11}|\d{2}\.\d{2}\.\d{4}|DE\d{18,22}|\d{2,3}\/\d{3}\/\d{4,5}|ev|rk|ak|is|jd|fr|fa|[A-ZÄÖÜß][a-zäöüß\-]+)$/;

// Build value-set from canonical eCodes
const canonValues = new Set();
for (const [ecode, e] of Object.entries(canonical)) {
  if (e.value != null) canonValues.add(String(e.value).trim());
  if (e.normalized != null) canonValues.add(String(e.normalized).trim());
}

const ocrCandidates = []; // { line, zeile, label, value, mapped }
for (const raw of lines) {
  const l = raw.trim();
  if (!l) continue;
  // Skip pure headings / markdown
  if (l.startsWith('#') || l.startsWith('|') || l.startsWith('---')) continue;
  // Try Zeilen-Pattern
  const m = LINE_RX.exec(l);
  if (!m) continue;
  const [, zeile, label, value] = m;
  if (!VALUE_RX.test(value)) continue;
  // Skip page numbers / report headers / boilerplate
  if (label.length < 4) continue;
  if (/^(Seite|Datum|Erstellt|Page|von)/i.test(label)) continue;
  const mapped = canonValues.has(value) || canonValues.has(value.replace(/[.,]/g, ''));
  ocrCandidates.push({ zeile: zeile || '—', label: label.slice(0, 70), value, mapped });
}

// Group mapped vs unmapped
const mapped = ocrCandidates.filter((c) => c.mapped);
const unmapped = ocrCandidates.filter((c) => !c.mapped);

console.log('\n══════════════════════════════════════════════════════════════════════════════');
console.log(`OCR Lines with key-value patterns:  ${ocrCandidates.length}`);
console.log(`  ✓ Mapped to eCode (Wert kommt im canonical_layer vor):  ${mapped.length}`);
console.log(`  ✗ Unmapped (Wert NICHT im canonical_layer):             ${unmapped.length}`);
console.log(`Canonical eCodes (final, dedupliziert):                   ${Object.keys(canonical).length}`);
console.log('══════════════════════════════════════════════════════════════════════════════');

console.log('\n=== ✓ MAPPED — OCR-Wert findet sich im canonical_layer ===');
console.log('Z   Drucktext (OCR-Label)                              Wert            → eCodes');
console.log('─'.repeat(80));
for (const c of mapped) {
  // find matching eCodes
  const matching = [];
  for (const [ec, e] of Object.entries(canonical)) {
    const ev = String(e.value || '').trim();
    const en = String(e.normalized || '').trim();
    if (ev === c.value || en === c.value || ev === c.value.replace(/[.,]/g, '') || en === c.value.replace(/[.,]/g, '')) {
      matching.push(ec);
    }
  }
  console.log(`${String(c.zeile).padStart(3)}  ${c.label.padEnd(50)} ${c.value.padEnd(15)} → ${matching.slice(0,4).join(',')}${matching.length>4?'…':''}`);
}

console.log('\n=== ✗ UNMAPPED — OCR-Werte die NICHT in eCodes landen ===');
console.log('Z   Drucktext (OCR-Label)                              Wert');
console.log('─'.repeat(80));
for (const c of unmapped) {
  console.log(`${String(c.zeile).padStart(3)}  ${c.label.padEnd(50)} ${c.value}`);
}

// Also: eCodes that have a value but the value doesn't appear in OCR (LLM-generated)
console.log('\n=== ⚠ eCodes ohne klaren OCR-Beleg (vermutlich LLM-Fill) ===');
for (const [ec, e] of Object.entries(canonical)) {
  if (!e.value) continue;
  const v = String(e.value).trim();
  const inText = ocrText.includes(v);
  if (!inText && e.origin && e.origin.startsWith('LLM')) {
    console.log(`  ${ec} ${e.drucktext?.slice(0,40)?.padEnd(40)} value="${v}" origin=${e.origin}`);
  }
}
