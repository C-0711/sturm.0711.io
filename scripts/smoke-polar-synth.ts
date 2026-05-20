/**
 * Smoke-Test: Polar-Schema-Synth gegen Debeka-Krankenversicherungs-Beleg.
 *
 * Erfolgskriterien:
 *   1. Stage laeuft ohne Exception
 *   2. Pflicht-eCodes E2001203 + E2001505 sind in ecodes_required
 *   3. coverage_stats.pflicht_satisfied === true
 *   4. coverage_stats.sections_covered > 0
 *   5. ecode_descriptions enthaelt sinnvolle deutsche Bezeichnungen
 */

import * as fs from 'node:fs';
import { polarSchemaSynthStage } from '../src/verticals/elster-v3/stages/polar-schema-synth.ts';

const META_PATH =
  '/home/christoph.bertsch/0711/0711-STURM/workspaces/haubrich-koch-hildburg-2024/meta/f2a377dd-36e1-43ef-b16a-6cb115845f38.json';

async function main() {
  const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf-8'));
  const ocrText = meta?.ocr?.markdown ?? '';
  const ocrPages = meta?.ocr?.pages ?? [];
  const docClass = meta?.classification?.label ?? '';
  const docName = meta?.originalFilename ?? '';

  console.log('───────────────────────────────────────────────────────────');
  console.log('SMOKE-TEST polar-schema-synth');
  console.log('Beleg :', docName);
  console.log('Class :', docClass);
  console.log('OCR   :', ocrText.length, 'chars,', ocrPages.length, 'pages');
  console.log('───────────────────────────────────────────────────────────');

  const ctx: any = {
    runId: 'smoke-001',
    workflowId: 'smoke',
    stageId: 'polar-schema-synth',
    config: {},
    logger: console,
    artifacts: {},
    emit: (name: string, payload: unknown) => {
      console.log('[emit]', name, JSON.stringify(payload).slice(0, 200));
    },
    signal: new AbortController().signal,
    results: {},
  };

  const t0 = Date.now();
  const result = await polarSchemaSynthStage.run(
    {
      ocrText,
      ocrPages,
      docClass,
      classifierAnlagen: [],
      minScore: 0.55,
      topKPerSection: 8,
      maxEcodes: 30,
      minSectionLength: 50,
    },
    ctx,
  );
  const elapsed = Date.now() - t0;

  console.log('\n=== RESULT ===');
  console.log('Wall-Clock:        ', elapsed, 'ms');
  console.log('Anlage-Hints:      ', result.anlage_hints);
  console.log('Sections:          ', result.sections.length);
  console.log('eCodes required:   ', result.ecodes_required);
  console.log('eCodes optional:   ', result.ecodes_optional);
  console.log('Coverage:          ', JSON.stringify(result.coverage_stats));
  console.log('Pflicht satisfied?:', result.coverage_stats.pflicht_satisfied);
  console.log('\nTop-3 Sections + selected eCodes:');
  for (const s of result.sections.slice(0, 3)) {
    console.log(`  [${s.id}] ${s.label}`);
    console.log(`         excerpt: ${s.ocr_excerpt.replace(/\n/g, ' ').slice(0, 120)}…`);
  }
  console.log('\neCode descriptions (selected):');
  for (const ec of [...result.ecodes_required, ...result.ecodes_optional].slice(0, 15)) {
    const d = result.ecode_descriptions[ec];
    console.log(`  ${ec}  ${d?.value ?? '?'}  [${d?.anlage ?? '?'}]  type=${result.type_hints[ec] ?? '?'}`);
  }

  console.log('\n=== ASSERTIONS ===');
  const checks = [
    { name: 'Pflicht E2001203 in required', ok: result.ecodes_required.includes('E2001203') },
    { name: 'Pflicht E2001505 in required', ok: result.ecodes_required.includes('E2001505') },
    { name: 'pflicht_satisfied === true', ok: result.coverage_stats.pflicht_satisfied === true },
    { name: 'sections_covered > 0', ok: result.coverage_stats.sections_covered > 0 },
    { name: 'has description for required eCodes', ok: result.ecodes_required.every((e: string) => !!result.ecode_descriptions[e]) },
  ];
  for (const c of checks) {
    console.log(c.ok ? '✓' : '✗', c.name);
  }
  const allOk = checks.every((c) => c.ok);
  console.log('\n', allOk ? '🟢 SMOKE PASS' : '🔴 SMOKE FAIL');
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
