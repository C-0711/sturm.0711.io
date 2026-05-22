import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { exportStageOutputAsRawFirst } from './gitchain-schema-export.ts';

async function readJsonl(p: string) {
  return (await fs.readFile(p, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function main() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'sturm-gitchain-schema-'));

  await exportStageOutputAsRawFirst({
    runRoot: root,
    workflowId: 'elster-v5_2-rag',
    runId: 'run123',
    stageId: 'ocr',
    runInput: { filename: 'steuerfall.pdf', filePath: '/tmp/steuerfall.pdf' },
    output: {
      pages: [
        { index: 0, markdown: '# ESt1A', chars: 120 },
        { index: 1, markdown: '# Anlage N', chars: 140 },
      ],
      text: 'joined text',
      erkannte_anlagen: ['ESt1A', 'N'],
      primary_form: 'ESt1A',
    },
  });

  await exportStageOutputAsRawFirst({
    runRoot: root,
    workflowId: 'elster-v5_2-rag',
    runId: 'run123',
    stageId: 'phase1Regex',
    runInput: { filename: 'steuerfall.pdf' },
    output: {
      per_anlage: {
        N: {
          regex_hits: {
            E0200201: {
              eCode: 'E0200201',
              value: '63.559,90',
              normalized: '6355990',
              origin: 'REGEX_100%',
              evidence_line: 'Bruttoarbeitslohn 63.559,90',
              anlage: 'N',
              drucktext: 'Bruttoarbeitslohn',
              vordruckzeile: '3',
              datentyp: 'currency',
              page: 4,
            },
          },
          missing_ecodes: [],
          fieldCount: 1,
          hitCount: 1,
          durationMs: 12,
        },
      },
      totalHits: 1,
      totalMissing: 0,
      ms: 12,
    },
  });

  await exportStageOutputAsRawFirst({
    runRoot: root,
    workflowId: 'elster-v5_2-rag',
    runId: 'run123',
    stageId: 'phase3LlmFill',
    runInput: { filename: 'steuerfall.pdf' },
    output: {
      per_anlage: {
        N: {
          llm_hits: {
            E0200201: {
              eCode: 'E0200201',
              value: '70.000,00',
              origin: 'LLM_FSM',
              anlage: 'N',
              drucktext: 'Bruttoarbeitslohn',
              vordruckzeile: '3',
              datentyp: 'currency',
              page: 4,
            },
          },
          still_missing: [],
          prefilled_count: 1,
          missing_at_start: 0,
          durationMs: 20,
        },
      },
      totalFilled: 1,
      ms: 20,
    },
  });

  await exportStageOutputAsRawFirst({
    runRoot: root,
    workflowId: 'elster-v5_2-rag',
    runId: 'run123',
    stageId: 'layer2Resolve',
    runInput: { filename: 'steuerfall.pdf' },
    output: {
      nested: {
        person: {
          vorname: 'Max',
          steuerklasse: '1',
        },
        bank: {
          iban: 'DE123',
        },
      },
      stats: { entitiesScanned: 1 },
    },
  });

  const summary = await exportStageOutputAsRawFirst({
    runRoot: root,
    workflowId: 'elster-v5_2-rag',
    runId: 'run123',
    stageId: 'phase6BmfRechner',
    runInput: { filename: 'steuerfall.pdf' },
    output: {
      canonical_layer: {
        E0200201: {
          value: '63559,90',
          normalized: '6355990',
          normalizedNumber: 63559.9,
          origin: 'REGEX_100%',
          datentyp: 'currency',
          evidence_line: 'Bruttoarbeitslohn 63.559,90',
          page: 4,
          trust: 'high',
          trust_reasons: ['Regex-Match mit Belegzeile'],
          anlage: 'N',
          drucktext: 'Bruttoarbeitslohn',
        },
        E0107201: {
          value: '1234.56',
          normalized: '123456',
          normalizedNumber: 1234.56,
          origin: 'BMF_RECHNER',
          datentyp: 'currency',
          trust: 'high',
          trust_reasons: ['BMF Lane-1 deterministisch berechnet'],
          anlage: 'ESt1A',
          drucktext: 'tarifliche Einkommensteuer',
        },
      },
    },
  });

  assert.ok(summary);

  const base = path.join(root, '_gitchain_v2');
  const extractedDocs = await readJsonl(path.join(base, '01_extracted', 'documents.jsonl'));
  const extractedFacts = await readJsonl(path.join(base, '01_extracted', 'facts.jsonl'));
  const normalizedProducts = await readJsonl(path.join(base, '02_normalized', 'products.jsonl'));
  const normalizedDocs = await readJsonl(path.join(base, '02_normalized', 'documents.jsonl'));
  const normalizedFeatures = await readJsonl(path.join(base, '02_normalized', 'features.jsonl'));
  const normalizedValues = await readJsonl(path.join(base, '02_normalized', 'values.jsonl'));
  const entityLinks = await readJsonl(path.join(base, '03_linked', 'entity_links.jsonl'));
  const documentLinks = await readJsonl(path.join(base, '03_linked', 'document_links.jsonl'));
  const refs = await readJsonl(path.join(base, '03_linked', 'source_refs.jsonl'));
  const resolved = await readJsonl(path.join(base, '04_resolved', 'resolved_values.jsonl'));
  const conflicts = await readJsonl(path.join(base, '04_resolved', 'conflicts.jsonl'));
  const decisions = await readJsonl(path.join(base, '04_resolved', 'decisions.jsonl'));

  assert.equal(extractedDocs.length, 1);
  assert.equal(extractedFacts.length, 1);
  assert.equal(normalizedDocs.length, 1);
  assert.ok(normalizedProducts.some((r) => String(r.product_id).includes('anlage_N')));
  assert.ok(normalizedProducts.some((r) => String(r.product_id).includes('anlage_ESt1A')));
  assert.ok(normalizedProducts.some((r) => String(r.product_id).includes('root')));
  assert.ok(normalizedFeatures.some((r) => r.feature_code === 'E0200201'));
  assert.ok(normalizedFeatures.some((r) => r.feature_code === 'person.vorname'));
  assert.ok(normalizedValues.some((r) => r.feature_code === 'E0200201'));
  assert.ok(normalizedValues.some((r) => r.feature_code === 'person.vorname'));
  assert.equal(entityLinks.length, 2);
  assert.equal(documentLinks.length, 3);
  assert.equal(refs.length, 1);
  assert.equal(resolved.length, 2);
  assert.equal(conflicts.length, 1);
  assert.equal(decisions.length, 2);
  assert.equal(extractedDocs[0].document_type, 'ESt1A');
  assert.equal(extractedFacts[0].predicate_raw, 'E0200201');
  assert.equal(refs[0].source_type, 'ocr_span');

  const primaryDocumentId = extractedDocs[0].document_id;
  assert.equal(normalizedDocs[0].document_id, primaryDocumentId);
  assert.equal(refs[0].document_id, primaryDocumentId);
  assert.ok(documentLinks.every((r) => r.document_id === primaryDocumentId));

  const phase1Value = normalizedValues.find((r) => r.feature_code === 'E0200201');
  assert.ok(phase1Value);
  assert.equal(extractedFacts[0].subject_raw, phase1Value.entity_id);
  assert.equal(refs[0].value_id, phase1Value.value_id);

  const resolvedN = resolved.find((r) => r.feature_code === 'E0200201');
  const conflictN = conflicts.find((r) => r.feature_code === 'E0200201');
  const decisionN = decisions.find((r) => r.feature_code === 'E0200201');
  assert.ok(resolvedN && conflictN && decisionN);
  assert.equal(resolvedN.entity_id, phase1Value.entity_id);
  assert.deepEqual(resolvedN.candidate_value_ids, [phase1Value.value_id]);
  assert.equal(decisionN.chosen_value_id, phase1Value.value_id);
  assert.equal(conflictN.status, 'resolved');
  assert.equal(conflictN.candidates.length, 2);

  const rootProduct = normalizedProducts.find((r) => String(r.product_id).includes('root'));
  const nProduct = normalizedProducts.find((r) => String(r.product_id).includes('anlage_N'));
  assert.ok(rootProduct && nProduct);
  assert.ok(entityLinks.some((r) => r.left_id === nProduct.product_id && r.right_id === rootProduct.product_id && r.link_type === 'belongs_to_family'));
  assert.ok(documentLinks.some((r) => r.entity_id === rootProduct.product_id && r.relationship === 'describes'));
  assert.ok(documentLinks.some((r) => r.entity_id === nProduct.product_id && r.relationship === 'evidences'));

  console.log('gitchain-schema-export OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
