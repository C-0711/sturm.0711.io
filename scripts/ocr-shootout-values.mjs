#!/usr/bin/env node
/**
 * Nach scripts/ocr-shootout-stricker.mjs: misst pro OCR-Engine wie viele
 * "Werte" der gelieferte Text enthält — gemessen über Regex-Treffer auf
 * tax-typische Patterns (Beträge in EUR, IDNr, IBAN, Datum, Lohn-Header).
 *
 *   node scripts/ocr-shootout-values.mjs reports/ocr-shootout-<ts>/results.json
 */
import { readFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const reportArg = process.argv[2];
const reportPath = reportArg
  ? path.resolve(reportArg)
  : (async () => {
      const dirs = (await readdir(path.join(REPO, 'reports')))
        .filter((d) => d.startsWith('ocr-shootout-'))
        .sort()
        .reverse();
      return path.join(REPO, 'reports', dirs[0], 'results.json');
    })();
const resultsPath = typeof reportPath === 'string' ? reportPath : await reportPath;
const summary = JSON.parse(await readFile(resultsPath, 'utf-8'));

const PATTERNS = {
  amount:    /\b\d{1,3}(?:\.\d{3})*,\d{2}\b|\b\d+,\d{2}\b/g,
  idnr:      /\b\d{11}\b/g,
  iban:      /\bDE\d{2}\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{2}\b/g,
  date:      /\b\d{2}\.\d{2}\.\d{4}\b/g,
  ecode:     /\bE\d{7}\b/g,
  steuernr:  /\b\d{2,3}\/\d{3}\/\d{4,5}\b/g,
  lohn_kw:   /Bruttoarbeitslohn|Lohnsteuer|Kapitalertr[äa]ge|Bemessungsgrundlage|Identifikationsnummer|IBAN|Solidarit[äa]tszuschlag|Kirchensteuer/g,
};

const ENGINES = ['text_layer', 'mistral', 'lighton', 'paddle'];

async function loadEngineText(workflowDir, runId, engine) {
  const p = path.join(REPO, 'runs', workflowDir, runId, '_result.json');
  try {
    const r = JSON.parse(await readFile(p, 'utf-8'));
    const b = r?.stages?.ocr_fanout?.output?.branches?.[engine];
    if (!b) return '';
    if (typeof b.text === 'string') return b.text;
    if (Array.isArray(b.pages)) return b.pages.map((p) => p?.markdown || '').join('\n');
    if (typeof b.markdown === 'string') return b.markdown;
  } catch { /* ignore */ }
  return '';
}

function countMatches(text) {
  const out = {};
  for (const [k, rx] of Object.entries(PATTERNS)) {
    out[k] = (text.match(rx) || []).length;
  }
  out._total = Object.values(out).reduce((a, b) => a + b, 0);
  out._chars = text.length;
  return out;
}

const rows = [];
for (const r of summary.results) {
  if (!r.runId) continue;
  const perEngine = {};
  for (const e of ENGINES) {
    const txt = await loadEngineText('ocr-shootout', r.runId, e);
    perEngine[e] = txt ? countMatches(txt) : null;
  }
  rows.push({ filename: r.filename, runId: r.runId, perEngine });
}

console.log('═══════════════════════════════════════════════════════════════════════════');
console.log('Per-Doc per-Engine: extrahierte Werte (Regex-Treffer)');
console.log('═══════════════════════════════════════════════════════════════════════════');
for (const r of rows) {
  console.log(`\n${r.filename}`);
  console.log('  engine        chars   amt  idnr  iban  date  steuernr  lohn-kw   TOTAL');
  for (const e of ENGINES) {
    const c = r.perEngine[e];
    if (!c) { console.log(`  ${e.padEnd(13)}  ERR`); continue; }
    console.log(
      `  ${e.padEnd(13)} ${String(c._chars).padStart(5)}` +
      ` ${String(c.amount).padStart(5)}` +
      ` ${String(c.idnr).padStart(5)}` +
      ` ${String(c.iban).padStart(5)}` +
      ` ${String(c.date).padStart(5)}` +
      ` ${String(c.steuernr).padStart(9)}` +
      ` ${String(c.lohn_kw).padStart(8)}` +
      `   ${String(c._total).padStart(5)}`
    );
  }
}

console.log('\n═══════════════════════════════════════════════════════════════════════════');
console.log('Aggregate — Werte pro Engine über alle 7 Belege');
console.log('═══════════════════════════════════════════════════════════════════════════');
const totalByEngine = {};
for (const e of ENGINES) {
  totalByEngine[e] = { chars: 0, amount: 0, idnr: 0, iban: 0, date: 0, steuernr: 0, lohn_kw: 0, total: 0, ok: 0 };
}
for (const r of rows) {
  for (const e of ENGINES) {
    const c = r.perEngine[e];
    if (!c) continue;
    totalByEngine[e].ok += 1;
    totalByEngine[e].chars += c._chars;
    totalByEngine[e].total += c._total;
    for (const k of ['amount', 'idnr', 'iban', 'date', 'steuernr', 'lohn_kw']) {
      totalByEngine[e][k] += c[k];
    }
  }
}
console.log('engine        docs-ok   chars   amount  idnr  iban  date  steuernr  lohn-kw   TOTAL');
for (const e of ENGINES) {
  const t = totalByEngine[e];
  console.log(
    `${e.padEnd(13)}    ${String(t.ok).padStart(2)}    ${String(t.chars).padStart(6)}` +
    ` ${String(t.amount).padStart(7)}` +
    ` ${String(t.idnr).padStart(5)}` +
    ` ${String(t.iban).padStart(5)}` +
    ` ${String(t.date).padStart(5)}` +
    ` ${String(t.steuernr).padStart(9)}` +
    ` ${String(t.lohn_kw).padStart(8)}` +
    `   ${String(t.total).padStart(5)}`
  );
}
