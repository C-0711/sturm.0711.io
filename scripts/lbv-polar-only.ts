/**
 * pdftotext + Polar-Turbo-Container — KEIN LLM.
 * Test: kann reine deterministische Embedding-Suche die richtigen eCodes finden?
 *
 * Setup: pdftotext liefert sauberen Text aus LBV-NRW-LStB.
 *        Sections via Header-Erkennung gesplittet.
 *        Jeder (label, value)-Paar wird gegen atoms.json embedded.
 *        Top-1 eCode pro Paar mit fp32-Rerank.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { embedQueries, l2normalize } from '../src/lib/gemma-embed.ts';
import { ExactFp32Index, type CascadeManifest } from '../src/lib/quantum-index.ts';

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/verticals/elster-v3/data');
const ECODE_REGEX = /^E\d{7}$/;

const PDF_PATH = '/home/christoph.bertsch/dev-cb-ctax/uploads/upload_1779179499563_af0331_Lohnsteuerbescheinigung_2024_57438590613_LBV_NRW.pdf';

// Ground Truth aus pdftotext-Output
const GROUND_TRUTH = [
  { ecode_hint: 'E0200201', expected: 30707, label: 'Bruttoarbeitslohn', expected_value: '30.707,00' },
  { ecode_hint: 'E0200301', expected: 2960,  label: 'einbehaltene Lohnsteuer', expected_value: '2.960,00' },
  { ecode_hint: 'E0200401', expected: 0,     label: 'einbehaltener Solidaritätszuschlag', expected_value: '0,00' },
  { ecode_hint: 'E0200501', expected: 266,   label: 'einbehaltene Kirchensteuer', expected_value: '266,35' },
];

interface Atom {
  field_name: string;
  value: string;
  citation_section: string;
  metadata?: any;
}

interface FieldPair {
  label: string;     // z.B. "Bruttoarbeitslohn"
  value: string;     // z.B. "30.707,00"
}

function extractFieldPairs(text: string): FieldPair[] {
  // pdftotext -layout hat label und value durch viele Spaces getrennt.
  // Pattern: ein label gefolgt von 5+ spaces + value (Zahl/Wort/Datum).
  const lines = text.split('\n');
  const pairs: FieldPair[] = [];
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed.trim()) continue;
    // Match: label + 5+ spaces + value
    const m = trimmed.match(/^\s*(.+?\S)\s{5,}(\S.*?)$/);
    if (m && m[1].length > 3 && m[2].length > 0) {
      pairs.push({ label: m[1].trim(), value: m[2].trim() });
    }
  }
  return pairs;
}

async function main() {
  console.log('████  pdftotext + Polar-Turbo-Container (KEIN LLM)  ████\n');

  // 1. pdftotext extraction
  const t0 = Date.now();
  const pdfText = execSync(`pdftotext -layout '${PDF_PATH}' -`).toString();
  const tPdftotext = Date.now() - t0;
  console.log(`pdftotext: ${tPdftotext} ms, ${pdfText.length} chars\n`);

  // 2. Field-Pair extraction
  const pairs = extractFieldPairs(pdfText);
  console.log(`Extrahierte Label-Value-Paare: ${pairs.length}`);
  for (const p of pairs) {
    console.log(`  ${p.label.padEnd(60).slice(0, 60)} | ${p.value}`);
  }

  // 3. Container laden
  const atomsRaw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'atoms.json'), 'utf-8')) as Atom[];
  const cm: CascadeManifest = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'embeddings.gemma4.cascade.json'), 'utf-8'));
  const exact = await ExactFp32Index.load(path.join(DATA_DIR, cm.exact!.file), cm.exact!.d);
  const allEcodeIndices = atomsRaw
    .map((a, i) => (ECODE_REGEX.test(a.field_name) ? i : -1))
    .filter((i) => i >= 0);

  // 4. Embed alle Labels
  const labels = pairs.map((p) => p.label);
  const tE0 = Date.now();
  const vecs = await embedQueries(labels);
  const vecsNorm = vecs.map((v) => l2normalize(new Float32Array(v)));
  const tEmbed = Date.now() - tE0;

  // 5. Polar Top-3 pro Label
  const tR0 = Date.now();
  const results = pairs.map((p, i) => {
    const top = exact.rerank(vecsNorm[i], allEcodeIndices, 3);
    return {
      pair: p,
      candidates: top.map((h) => ({
        ecode: atomsRaw[h.idx].field_name,
        score: h.score,
        drucktext: atomsRaw[h.idx].metadata?.drucktext ?? atomsRaw[h.idx].value,
        anlage: atomsRaw[h.idx].metadata?.anlage,
        vordruckzeile: atomsRaw[h.idx].metadata?.vordruckzeile,
      })),
    };
  });
  const tPolar = Date.now() - tR0;

  console.log(`\nEmbed: ${tEmbed} ms (${labels.length} labels)`);
  console.log(`Polar rerank: ${tPolar} ms\n`);

  console.log('=== Polar Top-3 pro Label ===');
  for (const r of results) {
    console.log(`\n[${r.pair.label}]  Value: ${r.pair.value}`);
    for (const c of r.candidates) {
      console.log(`  ${c.score.toFixed(3)}  ${c.ecode}  [${(c.anlage ?? '?').padEnd(8).slice(0,8)}]  Z.${String(c.vordruckzeile ?? '-').padStart(3)}  ${c.drucktext?.slice(0,70)}`);
    }
  }

  // 6. Ground-Truth-Diff: wo landet der echte eCode?
  console.log('\n\n=== Ground-Truth-Diff ===');
  console.log('Label                                Expected   Polar top-1       in top-3?');
  console.log('─'.repeat(95));
  let pass = 0;
  for (const gt of GROUND_TRUTH) {
    const r = results.find((x) => x.pair.label.toLowerCase().includes(gt.label.toLowerCase().slice(0, 20)));
    if (!r) {
      console.log(`${gt.label.padEnd(36).slice(0,36)} ${gt.ecode_hint}  (NOT FOUND in pairs)`);
      continue;
    }
    const top1 = r.candidates[0];
    const inTop3 = r.candidates.some((c) => c.ecode === gt.ecode_hint);
    const status = top1?.ecode === gt.ecode_hint ? '✓ TOP-1' : (inTop3 ? '⚠ in top-3' : '✗ NOT in top-3');
    if (top1?.ecode === gt.ecode_hint) pass++;
    console.log(
      `${gt.label.padEnd(36).slice(0,36)} ${gt.ecode_hint}    Polar=${top1?.ecode}@${top1?.score.toFixed(2)}   ${status}`,
    );
  }
  console.log(`\n→ ${pass}/${GROUND_TRUTH.length} eCodes als Polar-Top-1 = ${pass*100/GROUND_TRUTH.length}%`);
}

main().catch((e) => { console.error(e); process.exit(1); });
