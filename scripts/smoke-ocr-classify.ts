/**
 * Smoke-Test für die neue elster/mistral-ocr-classify-Stage.
 * Lädt ein Stricker-Fixture, ruft die Stage direkt auf, druckt erkannte Anlagen.
 *
 *   npx tsx scripts/smoke-ocr-classify.ts [fixture]
 *
 * Default-Fixture: tests/fixtures/stricker/stricker_est_2023.pdf
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mistralOcrClassifyStage } from '../src/verticals/elster-v3/stages/mistral-ocr-classify.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const fixture =
  process.argv[2] ??
  path.join(REPO, 'tests/fixtures/stricker/stricker_est_2023.pdf');
const filename = path.basename(fixture);

function logger(level: string) {
  return (msg: string, payload?: unknown) => {
    if (payload !== undefined) console.log(`[${level}] ${msg}`, payload);
    else console.log(`[${level}] ${msg}`);
  };
}

const ctx = {
  runId: 'smoke-' + Date.now(),
  stageId: 'elster/mistral-ocr-classify',
  config: {},
  signal: undefined,
  emit(event: string, payload: unknown) {
    if (event === 'ocr_done' || event === 'ocr_classified' || event === 'ocr_degraded') {
      console.log(`  · event ${event}`, payload);
    }
  },
  logger: {
    debug: logger('debug'),
    info: logger('info'),
    warn: logger('warn'),
    error: logger('error'),
  },
  artifacts: { write: async () => {}, read: async () => null },
} as unknown as Parameters<typeof mistralOcrClassifyStage.run>[1];

console.log(`Smoke-Test: ${fixture}`);
console.log('Ruft mistral-ocr-classify direkt …');
const t0 = Date.now();
const out = await mistralOcrClassifyStage.run({ filePath: fixture, filename }, ctx);
const ms = Date.now() - t0;

console.log('\n========= Ergebnis =========');
console.log(`Model:              ${out.model}`);
console.log(`Pages:              ${out.pages.length}`);
console.log(`Chars (gesamt):     ${out.chars}`);
console.log(`Dauer:              ${ms} ms`);
console.log(`Erkannte Anlagen:   ${out.erkannte_anlagen.join(', ') || '(keine)'}`);
console.log(`Primary Form:       ${out.primary_form ?? '—'}`);
console.log(`Klassifik.-Konfid:  ${out.classify_confidence}`);
console.log(`Quelle:             ${out.classify_source}`);
console.log('============================');
console.log('\nErste 600 Zeichen OCR-Text:');
console.log(out.text.slice(0, 600));
