/**
 * Tests für `klassifizierungStage` — additive Felder `doc_type` + `steuerjahr`
 * für v5_4 Hybrid-Routing.
 *
 * Covers:
 *   1. VAST-Bundle (Transferticket) → doc_type='vast_bundle', steuerjahr=2024
 *   2. WISO-ESE (Hauptvordruck)     → doc_type='einkommensteuererklaerung', steuerjahr=2023
 *   3. Spendenquittung              → doc_type='einzelbeleg', steuerjahr=2024
 *
 * Run: npx tsx src/workflows/elster/stages/klassifizierung-doc-type.test.ts
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  klassifizierungStage,
  type KlassifizierungOutput,
  type KlassifizierungConfig,
} from './klassifizierung.ts';
import type { StageContext, StageLogger, ArtifactStore } from '../../../core/types.ts';
import type { ToolContainerView } from '../../../core/tools/types.ts';

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}`, detail ?? ''); }
}

// ── Fixture OCR snippets ────────────────────────────────────────────
const OCR_VAST = `
ELSTER — Quittung
Transferticket: Steuer-Abruf vom 12.03.2025
Veranlagungszeitraum 2024
Steuerpflichtiger: Max Mustermann
Religion: Evangelisch
Bruttoarbeitslohn: 65.000,00 €
Lohnsteuer: 12.345,67 €
`;

const OCR_WISO_ESE = `
Einkommensteuererklärung 2023
Hauptvordruck ESt 1 A
Steuerpflichtiger: Erika Beispiel
Anlage N — Einkünfte aus nichtselbständiger Arbeit
Bruttoarbeitslohn: 48.500,00 €
`;

const OCR_SPENDE = `
Spendenquittung Verein X e.V.
Datum: 15.06.2024
Betrag: 250,00 €
Bestätigung gemäß § 50 EStDV
`;

// ── Stub context ────────────────────────────────────────────────────
function makeCtx(artifactsDir: string): StageContext<KlassifizierungConfig> {
  const logger: StageLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  const artifacts: ArtifactStore = {
    async write(rel, data) {
      const abs = path.join(artifactsDir, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, JSON.stringify(data, null, 2), 'utf-8');
    },
    async writeBuffer(rel, data) {
      const abs = path.join(artifactsDir, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, data);
    },
    async read<T = unknown>(rel: string): Promise<T> {
      const raw = await fs.readFile(path.join(artifactsDir, rel), 'utf-8');
      return JSON.parse(raw) as T;
    },
    async readBuffer(rel) {
      return fs.readFile(path.join(artifactsDir, rel));
    },
    async exists(rel) {
      try { await fs.access(path.join(artifactsDir, rel)); return true; } catch { return false; }
    },
    absolutePath(rel) { return path.join(artifactsDir, rel); },
  };
  // Minimal ToolContainerView stub — keine LLM-Calls erwartet, da meta-doc
  // bzw. erste Regex-Treffer (oder leerer Treffer mit mode='zero' der nur
  // bei Fehlen einen LLM-Call ausgelöst hätte) den Pfad bestimmen. Für
  // Spendenquittung deaktivieren wir den Fallback per Config (llmFallbackWhen='never').
  const tools: ToolContainerView = {
    has: () => false,
    get: () => { throw new Error('no tools bound in test'); },
    getByRole: () => { throw new Error('no tools bound in test'); },
    list: () => [],
  } as unknown as ToolContainerView;

  return {
    runId: 'test-run',
    workflowId: 'elster',
    stageId: 'elster/klassifizierung',
    config: { llmFallbackWhen: 'never' as const },
    logger,
    artifacts,
    emit: () => {},
    signal: new AbortController().signal,
    results: {},
    tools,
  } as unknown as StageContext<KlassifizierungConfig>;
}

async function main() {
  console.log('\nklassifizierung — doc_type + steuerjahr');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'klassifizierung-test-'));

  // ── 1. VAST-Bundle ────────────────────────────────────────────────
  console.log('\n1. VAST-Bundle (Transferticket)');
  const out_vast = (await klassifizierungStage.run(
    { text: OCR_VAST },
    makeCtx(path.join(tmp, 'vast')),
  )) as KlassifizierungOutput;
  assert('VAST: doc_type=vast_bundle', out_vast.doc_type === 'vast_bundle', out_vast.doc_type);
  assert('VAST: steuerjahr=2024', out_vast.steuerjahr === 2024, out_vast.steuerjahr);

  // ── 2. WISO-ESE ───────────────────────────────────────────────────
  console.log('\n2. WISO-ESE (Hauptvordruck)');
  const out_ese = (await klassifizierungStage.run(
    { text: OCR_WISO_ESE },
    makeCtx(path.join(tmp, 'ese')),
  )) as KlassifizierungOutput;
  assert(
    'ESE: doc_type=einkommensteuererklaerung',
    out_ese.doc_type === 'einkommensteuererklaerung',
    out_ese.doc_type,
  );
  assert('ESE: steuerjahr=2023', out_ese.steuerjahr === 2023, out_ese.steuerjahr);

  // ── 3. Spendenquittung ────────────────────────────────────────────
  console.log('\n3. Spendenquittung (Einzelbeleg)');
  const out_spende = (await klassifizierungStage.run(
    { text: OCR_SPENDE },
    makeCtx(path.join(tmp, 'spende')),
  )) as KlassifizierungOutput;
  assert(
    'Spende: doc_type=einzelbeleg',
    out_spende.doc_type === 'einzelbeleg',
    out_spende.doc_type,
  );
  assert('Spende: steuerjahr=2024', out_spende.steuerjahr === 2024, out_spende.steuerjahr);

  await fs.rm(tmp, { recursive: true, force: true });
}

main().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length > 0) {
    console.log('Failures:'); for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}).catch((e) => {
  console.error('Test crashed:', e);
  process.exit(1);
});
