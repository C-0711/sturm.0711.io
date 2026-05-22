/**
 * Polar-only ABER mit Anlage-Vorfilter (nur Anlage N, 134 eCodes statt 2287).
 * Plus direkter Vergleich pdftotext + gemma4-mm + Profil.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { embedQueries, l2normalize } from '../src/lib/gemma-embed.ts';
import { ExactFp32Index, type CascadeManifest } from '../src/lib/quantum-index.ts';

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/verticals/elster-v3/data');
const ECODE_REGEX = /^E\d{7}$/;
const PDF = '/home/christoph.bertsch/dev-cb-ctax/uploads/upload_1779179499563_af0331_Lohnsteuerbescheinigung_2024_57438590613_LBV_NRW.pdf';

const GROUND_TRUTH: Record<string, { expected: number; value: string }> = {
  'E0200201': { expected: 30707, value: '30.707,00' },
  'E0200301': { expected: 2960,  value: '2.960,00' },
  'E0200401': { expected: 0,     value: '0,00' },
  'E0200501': { expected: 266,   value: '266,35' },
};

interface Atom { field_name: string; value: string; citation_section: string; metadata?: any; }

function extractFieldPairs(text: string): { label: string; value: string }[] {
  const pairs: { label: string; value: string }[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(.+?\S)\s{5,}(\S.*?)$/);
    if (m && m[1].length > 3 && m[2].length > 0) {
      pairs.push({ label: m[1].trim(), value: m[2].trim() });
    }
  }
  return pairs;
}

async function main() {
  console.log('████  pdftotext + Polar mit Anlage-N-Filter  ████\n');

  const pdfText = execSync(`pdftotext -layout '${PDF}' -`).toString();
  const pairs = extractFieldPairs(pdfText);

  const atomsRaw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'atoms.json'), 'utf-8')) as Atom[];
  const cm: CascadeManifest = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'embeddings.gemma4.cascade.json'), 'utf-8'));
  const exact = await ExactFp32Index.load(path.join(DATA_DIR, cm.exact!.file), cm.exact!.d);

  // Filter: NUR Anlage N
  const anlageN_indices = atomsRaw
    .map((a, i) => (ECODE_REGEX.test(a.field_name) && a.metadata?.anlage === 'N' ? i : -1))
    .filter((i) => i >= 0);
  console.log(`Anlage-N-Filter: ${anlageN_indices.length} eCodes (von 2287 total)\n`);

  const labels = pairs.map((p) => p.label);
  const vecs = await embedQueries(labels);
  const vecsNorm = vecs.map((v) => l2normalize(new Float32Array(v)));

  const results = pairs.map((p, i) => ({
    pair: p,
    candidates: exact.rerank(vecsNorm[i], anlageN_indices, 3).map((h) => ({
      ecode: atomsRaw[h.idx].field_name,
      score: h.score,
      drucktext: atomsRaw[h.idx].metadata?.drucktext ?? atomsRaw[h.idx].value,
      vordruckzeile: atomsRaw[h.idx].metadata?.vordruckzeile,
    })),
  }));

  console.log('=== Polar Top-3 pro Label (nur Anlage N) ===\n');
  for (const r of results) {
    if (!r.candidates.length) continue;
    console.log(`[${r.pair.label}]  Value: ${r.pair.value}`);
    for (const c of r.candidates) {
      console.log(`  ${c.score.toFixed(3)}  ${c.ecode}  Z.${String(c.vordruckzeile ?? '-').padStart(3)}  ${(c.drucktext ?? '').slice(0, 75)}`);
    }
    console.log('');
  }

  // Ground-Truth-Diff
  console.log('=== Ground-Truth-Diff (mit Anlage-N-Filter) ===');
  console.log(`${'Label'.padEnd(45)} ${'Expected'.padEnd(10)} Top-1                in top-3?`);
  console.log('─'.repeat(98));
  let pass = 0;
  for (const [exp_ec, gt] of Object.entries(GROUND_TRUTH)) {
    const label = exp_ec === 'E0200201' ? 'Bruttoarbeitslohn'
      : exp_ec === 'E0200301' ? 'einbehaltene Lohnsteuer'
      : exp_ec === 'E0200401' ? 'einbehaltener Solidaritätszuschlag'
      : 'einbehaltene Kirchensteuer';
    const r = results.find((x) => x.pair.label.toLowerCase().startsWith(label.toLowerCase().slice(0, 18)));
    if (!r) { console.log(`${label.padEnd(45)} ${exp_ec.padEnd(10)} NOT FOUND in pairs`); continue; }
    const top1 = r.candidates[0];
    const inTop3 = r.candidates.some((c) => c.ecode === exp_ec);
    let status: string;
    if (top1?.ecode === exp_ec) { status = '✓ TOP-1'; pass++; }
    else if (inTop3) status = '⚠ in top-3';
    else status = '✗ not in top-3';
    console.log(
      `${label.padEnd(45)} ${exp_ec.padEnd(10)} ${(top1?.ecode + '@' + top1?.score.toFixed(2)).padEnd(20)} ${status}`,
    );
  }
  console.log(`\n→ ${pass}/${Object.keys(GROUND_TRUTH).length} top-1 mit Anlage-Filter = ${pass*100/Object.keys(GROUND_TRUTH).length}%\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
