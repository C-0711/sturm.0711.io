/**
 * Tests für aggregateCase + document-type-hints.
 * Run: tsx src/server/aggregation.test.ts
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { aggregateCase } from './aggregation.ts';
import { suggestedDocsForECode, documentTypeHintsMap } from './document-type-hints.ts';
import type { ApplicationInstance, CaseDocument } from './applications.ts';

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}`, detail ?? ''); }
}
function eq<T>(name: string, actual: T, expected: T) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, ok ? undefined : { actual, expected });
}

async function makeRunDir(runsDir: string, workflowId: string, runId: string, canonicalLayer: Record<string, unknown>, runState: 'ok' | 'error' = 'ok') {
  const d = path.join(runsDir, workflowId, runId, 'phase6BmfRechner');
  await fs.mkdir(d, { recursive: true });
  await fs.writeFile(path.join(d, 'output.json'), JSON.stringify({ canonical_layer: canonicalLayer }));
  await fs.writeFile(path.join(runsDir, workflowId, runId, '_result.json'), JSON.stringify({ state: runState }));
}

function makeDoc(runId: string, filename: string, anlagen: string[]): CaseDocument {
  return {
    runId,
    filename,
    inboxPath: `inbox/${filename}`,
    sha256: '0'.repeat(64),
    size: 1000,
    uploadedAt: '2026-05-15T00:00:00Z',
    anlagen,
  };
}

async function main() {
  console.log('\n=== document-type-hints: exact match ===');
  {
    eq('E0200201 → Lohnsteuerbescheinigung', suggestedDocsForECode('E0200201'), ['Lohnsteuerbescheinigung']);
  }

  console.log('\n=== document-type-hints: prefix match ===');
  {
    eq('E0700123 → Spendenquittung', suggestedDocsForECode('E0700123'), ['Spendenquittung', 'Mitgliedsbescheinigung Kirchensteuer']);
    eq('E1500999 → Krankenversicherung', suggestedDocsForECode('E1500999'), ['Beitragsbescheinigung Krankenversicherung']);
  }

  console.log('\n=== document-type-hints: bulk map ===');
  {
    const m = documentTypeHintsMap(['E0200201', 'E9999999', 'E0700001']);
    assert('Lohnsteuer mapped', Array.isArray(m['E0200201']));
    assert('unknown eCode not in map', !('E9999999' in m));
  }

  // ── Aggregation: ein Beleg, eindeutig ─────────────────────────────
  console.log('\n=== aggregate: ein Beleg, eindeutig ===');
  {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sturm-agg-test-'));
    try {
      await makeRunDir(tmp, 'wf', 'r1', {
        E0200201: { value: '69.291,80', normalized: '6929180', origin: 'REGEX_3F', anlage: 'N', drucktext: 'Bruttoarbeitslohn', vordruckzeile: '5', datentyp: 'currency' },
      });
      const inst: ApplicationInstance = {
        caseId: 'c', appId: 'a', displayName: 'd', mandantId: 'm',
        status: 'in_bearbeitung', createdAt: 't', updatedAt: 't',
        runs: ['r1'], workspacePath: 'ws',
        documents: [makeDoc('r1', 'lohnsteuer.pdf', ['N'])],
      };
      const agg = await aggregateCase(inst, { runsDir: tmp, extractionWorkflowId: 'wf', loadPflichtFelder: async () => [] });
      eq('eCodes count', agg.stats.eCodes, 1);
      eq('docs count', agg.stats.docs, 1);
      eq('value', agg.merged_layer.E0200201?.value, '69.291,80');
      eq('confirmed by 1', agg.merged_layer.E0200201?.confidence_count, 1);
      eq('no conflicts', agg.stats.conflicts, 0);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  // ── Aggregation: zwei Belege, gleicher Wert → bestätigt ───────────
  console.log('\n=== aggregate: zwei Belege bestätigen gleichen Wert ===');
  {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sturm-agg-test-'));
    try {
      await makeRunDir(tmp, 'wf', 'r1', {
        E0200201: { value: '100,00', normalized: '10000', origin: 'REGEX_3F', anlage: 'N', drucktext: 'Bruttoarbeitslohn' },
      });
      await makeRunDir(tmp, 'wf', 'r2', {
        E0200201: { value: '100,00', normalized: '10000', origin: 'LLM_FSM', anlage: 'N', drucktext: 'Bruttoarbeitslohn' },
      });
      const inst: ApplicationInstance = {
        caseId: 'c', appId: 'a', displayName: 'd', mandantId: 'm',
        status: 'in_bearbeitung', createdAt: 't', updatedAt: 't',
        runs: ['r1', 'r2'], workspacePath: 'ws',
        documents: [makeDoc('r1', 'doc1.pdf', ['N']), makeDoc('r2', 'doc2.pdf', ['N'])],
      };
      const agg = await aggregateCase(inst, { runsDir: tmp, extractionWorkflowId: 'wf', loadPflichtFelder: async () => [] });
      eq('1 eCode, 2 confirmations', agg.merged_layer.E0200201?.confidence_count, 2);
      eq('no conflicts', agg.stats.conflicts, 0);
      eq('2 sources listed', agg.merged_layer.E0200201?.confirmed_by.length, 2);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  // ── Aggregation: zwei Belege, anderer Wert → Konflikt ─────────────
  console.log('\n=== aggregate: zwei Belege, anderer Wert → Konflikt + Trust-Sieger ===');
  {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sturm-agg-test-'));
    try {
      await makeRunDir(tmp, 'wf', 'r1', {
        E0200201: { value: '100,00', normalized: '10000', origin: 'LLM_FSM', anlage: 'N', drucktext: 'Bruttoarbeitslohn' },
      });
      await makeRunDir(tmp, 'wf', 'r2', {
        E0200201: { value: '200,00', normalized: '20000', origin: 'REGEX_100%', anlage: 'N', drucktext: 'Bruttoarbeitslohn' },
      });
      const inst: ApplicationInstance = {
        caseId: 'c', appId: 'a', displayName: 'd', mandantId: 'm',
        status: 'in_bearbeitung', createdAt: 't', updatedAt: 't',
        runs: ['r1', 'r2'], workspacePath: 'ws',
        documents: [makeDoc('r1', 'doc1.pdf', ['N']), makeDoc('r2', 'doc2.pdf', ['N'])],
      };
      const agg = await aggregateCase(inst, { runsDir: tmp, extractionWorkflowId: 'wf', loadPflichtFelder: async () => [] });
      eq('1 conflict', agg.stats.conflicts, 1);
      eq('REGEX_100% gewinnt', agg.merged_layer.E0200201?.value, '200,00');
      eq('winner-origin REGEX_100%', agg.merged_layer.E0200201?.origin, 'REGEX_100%');
      eq('2 candidates im conflict', agg.conflicts[0].candidates.length, 2);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  // ── Aggregation: disjunkte eCodes (Union) ─────────────────────────
  console.log('\n=== aggregate: disjunkte eCodes werden Union ===');
  {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sturm-agg-test-'));
    try {
      await makeRunDir(tmp, 'wf', 'r1', {
        E0200201: { value: '100', normalized: '10000', origin: 'REGEX_3F', anlage: 'N' },
      });
      await makeRunDir(tmp, 'wf', 'r2', {
        E0700101: { value: '50', normalized: '5000', origin: 'REGEX_3F', anlage: 'SO' },
      });
      const inst: ApplicationInstance = {
        caseId: 'c', appId: 'a', displayName: 'd', mandantId: 'm',
        status: 'in_bearbeitung', createdAt: 't', updatedAt: 't',
        runs: ['r1', 'r2'], workspacePath: 'ws',
        documents: [makeDoc('r1', 'lohnsteuer.pdf', ['N']), makeDoc('r2', 'spende.pdf', ['SO'])],
      };
      const agg = await aggregateCase(inst, { runsDir: tmp, extractionWorkflowId: 'wf', loadPflichtFelder: async () => [] });
      eq('2 eCodes union', agg.stats.eCodes, 2);
      eq('0 conflicts', agg.stats.conflicts, 0);
      assert('beide eCodes im merged_layer',
        !!agg.merged_layer.E0200201 && !!agg.merged_layer.E0700101);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  // ── Pflicht-Coverage ──────────────────────────────────────────────
  console.log('\n=== aggregate: Pflicht-Coverage ===');
  {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sturm-agg-test-'));
    try {
      await makeRunDir(tmp, 'wf', 'r1', {
        E0200201: { value: '100', normalized: '10000', origin: 'REGEX_3F', anlage: 'N' },
      });
      const inst: ApplicationInstance = {
        caseId: 'c', appId: 'a', displayName: 'd', mandantId: 'm',
        status: 'in_bearbeitung', createdAt: 't', updatedAt: 't',
        runs: ['r1'], workspacePath: 'ws',
        documents: [makeDoc('r1', 'lohnsteuer.pdf', ['N'])],
      };
      // Mock: 2 Pflicht-Atome für Anlage N — E0200201 ist belegt, E0200999 fehlt.
      const agg = await aggregateCase(inst, {
        runsDir: tmp, extractionWorkflowId: 'wf',
        loadPflichtFelder: async (a) => a === 'N' ? [
          { eCode: 'E0200201', drucktext: 'Bruttoarbeitslohn', vordruckzeile: '5', pflicht: true },
          { eCode: 'E0200999', drucktext: 'Fehlt absichtlich', vordruckzeile: '99', pflicht: true },
          { eCode: 'E0200888', drucktext: 'Optional', vordruckzeile: '88', pflicht: false },
        ] : [],
      });
      eq('coverage total', agg.pflicht_coverage.total, 2);
      eq('coverage covered', agg.pflicht_coverage.covered, 1);
      eq('coverage pct', agg.pflicht_coverage.pct, 50);
      eq('coverage measurable', agg.pflicht_coverage.measurable, true);
      eq('missing has 1 entry', agg.pflicht_missing.length, 1);
      eq('missing eCode', agg.pflicht_missing[0].eCode, 'E0200999');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  // ── Pflicht-Coverage: keine Pflicht-Atome (z.B. Anlage N im Katalog-Bug D1) ──
  console.log('\n=== aggregate: 0 Pflicht-Atome → measurable=false ===');
  {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sturm-agg-test-'));
    try {
      await makeRunDir(tmp, 'wf', 'r1', {
        E0200201: { value: '100', normalized: '10000', origin: 'REGEX_3F', anlage: 'N' },
      });
      const inst: ApplicationInstance = {
        caseId: 'c', appId: 'a', displayName: 'd', mandantId: 'm',
        status: 'in_bearbeitung', createdAt: 't', updatedAt: 't',
        runs: ['r1'], workspacePath: 'ws',
        documents: [makeDoc('r1', 'lohnsteuer.pdf', ['N'])],
      };
      const agg = await aggregateCase(inst, {
        runsDir: tmp, extractionWorkflowId: 'wf',
        loadPflichtFelder: async () => [], // 0 Pflicht-Atome
      });
      eq('measurable false', agg.pflicht_coverage.measurable, false);
      eq('total 0', agg.pflicht_coverage.total, 0);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  // ── normalizedNumber: vorhanden im canonical_layer wird durchgereicht ───
  console.log('\n=== aggregate: normalizedNumber wird durchgereicht ===');
  {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sturm-agg-test-'));
    try {
      await makeRunDir(tmp, 'wf', 'r1', {
        // Schon vom Producer (phase5-merge) gesetzt — Aggregation reicht durch.
        E0200201: {
          value: '1.781,98 EUR',
          normalized: '178198',
          normalizedNumber: 1781.98,
          origin: 'REGEX_3F',
          anlage: 'N',
          drucktext: 'Bruttoarbeitslohn',
          datentyp: 'currency',
        },
      });
      const inst: ApplicationInstance = {
        caseId: 'c', appId: 'a', displayName: 'd', mandantId: 'm',
        status: 'in_bearbeitung', createdAt: 't', updatedAt: 't',
        runs: ['r1'], workspacePath: 'ws',
        documents: [makeDoc('r1', 'lohnsteuer.pdf', ['N'])],
      };
      const agg = await aggregateCase(inst, { runsDir: tmp, extractionWorkflowId: 'wf', loadPflichtFelder: async () => [] });
      eq('normalizedNumber durchgereicht', agg.merged_layer.E0200201?.normalizedNumber, 1781.98);
      eq('value bleibt original', agg.merged_layer.E0200201?.value, '1.781,98 EUR');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  // ── normalizedNumber: fehlt im canonical_layer, wird aus value abgeleitet ───
  console.log('\n=== aggregate: normalizedNumber-Fallback aus value (alter Run ohne Feld) ===');
  {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sturm-agg-test-'));
    try {
      await makeRunDir(tmp, 'wf', 'r1', {
        // Alter Run (vor diesem Feature) — kein normalizedNumber im Artefakt.
        E0200201: {
          value: '1.781,98 EUR',
          normalized: '178198',
          origin: 'REGEX_3F',
          anlage: 'N',
          drucktext: 'Bruttoarbeitslohn',
          datentyp: 'currency',
        },
        // Stricker-Regression: deutsche Tausenderpunkt ohne Dezimalen.
        E0700101: {
          value: '6.011',
          normalized: '601100',
          origin: 'REGEX_3F',
          anlage: 'SO',
          drucktext: 'Spende',
          datentyp: 'currency',
        },
        // Nicht-numerisch: kein normalizedNumber erwartet.
        E9900001: {
          value: 'Max Mustermann',
          normalized: 'Max Mustermann',
          origin: 'LLM_FSM',
          anlage: 'ESt1A',
          drucktext: 'Name',
          datentyp: 'string',
        },
      });
      const inst: ApplicationInstance = {
        caseId: 'c', appId: 'a', displayName: 'd', mandantId: 'm',
        status: 'in_bearbeitung', createdAt: 't', updatedAt: 't',
        runs: ['r1'], workspacePath: 'ws',
        documents: [makeDoc('r1', 'mixed.pdf', ['N', 'SO', 'ESt1A'])],
      };
      const agg = await aggregateCase(inst, { runsDir: tmp, extractionWorkflowId: 'wf', loadPflichtFelder: async () => [] });
      eq('Hildburg-Fall: "1.781,98 EUR" → 1781.98',
        agg.merged_layer.E0200201?.normalizedNumber, 1781.98);
      eq('Stricker-Fall: "6.011" → 6011',
        agg.merged_layer.E0700101?.normalizedNumber, 6011);
      eq('string-Feld: kein normalizedNumber',
        agg.merged_layer.E9900001?.normalizedNumber, undefined);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  console.log(`\nResult: ${pass} pass, ${fail} fail`);
  if (fail > 0) {
    console.log('Failures:', failures);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
