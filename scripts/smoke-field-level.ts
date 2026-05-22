/**
 * End-to-End: OCR → Mistral-Structure (HTML v6) → FIELD-LEVEL-POLAR → direkter eCode-Assign.
 *
 * Konzept-Test: statt section-level embedding wird JEDES <field> direkt geembedded.
 * Polar findet pro field die top-K eCodes. tier-1 nimmt top-1, value ist schon im
 * field.value (typed durch Mistral).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mistralStructureStage, type ParsedField, type ParsedSection } from '../src/verticals/elster-v3/stages/mistral-structure.ts';
import { embedQueries, l2normalize, EMBEDDINGGEMMA_DIM } from '../src/lib/gemma-embed.ts';
import { ExactFp32Index, type CascadeManifest } from '../src/lib/quantum-index.ts';
import { roundForElster } from '../src/verticals/elster-v3/lib/eur-parse.ts';

const META_DIR = '/home/christoph.bertsch/0711/0711-STURM/workspaces/haubrich-koch-hildburg-2024/meta';
const LAYOUT_A = `${META_DIR}/f2a377dd-36e1-43ef-b16a-6cb115845f38.json`;
const LAYOUT_B = `${META_DIR}/5304e988-ac73-4e04-bb04-95af71bd6e49.json`;

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/verticals/elster-v3/data');
const ECODE_REGEX = /^E\d{7}$/;

interface Atom {
  field_name: string;
  value: string;
  citation_section: string;
  metadata?: any;
}

const GROUND_TRUTH = [
  { ecode: 'E2003104', expected: 1781, bedeutung: 'Private KV Basisabsicherung' },
  { ecode: 'E2003202', expected:  772, bedeutung: 'Pflege-Pflichtversicherung' },
  { ecode: 'E2004003', expected: 1781, bedeutung: 'Private KV Basis abzgl. Zuschuesse' },
  { ecode: 'E2004103', expected:  772, bedeutung: 'PV Pflicht abzgl. Zuschuesse' },
  { ecode: 'E2004303', expected:  456, bedeutung: 'Private KV/PV ueber Basis (Wahlleistungen)' },
];

function parseGermanCurrency(s: string): number | null {
  // "1.781,98" oder "1781,98" → 1781.98 ; "1781" → 1781 ; "1781.98" → 1781.98
  if (!s) return null;
  const m = s.match(/-?\d{1,3}(?:\.\d{3})*(?:,\d{2})?|-?\d+(?:\.\d{2})?/);
  if (!m) return null;
  const raw = m[0];
  if (raw.includes(',')) {
    return parseFloat(raw.replace(/\./g, '').replace(',', '.'));
  }
  return parseFloat(raw);
}

function ctxNew(): any {
  return {
    runId: 's', workflowId: 's', stageId: 's', config: {}, logger: console,
    artifacts: {}, emit: () => {}, signal: new AbortController().signal, results: {},
  };
}

async function runOne(metaPath: string, layoutName: string) {
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  const ocrText = meta.ocr.markdown;

  console.log('═'.repeat(82));
  console.log(`Layout: ${layoutName}`);
  console.log(`Beleg:  ${meta.originalFilename}`);
  console.log('═'.repeat(82));

  const tTotal0 = Date.now();

  // 1. Mistral-Structure mit v6-Prompt
  const tM0 = Date.now();
  const structured = await mistralStructureStage.run({ ocrText }, ctxNew());
  const tMistral = Date.now() - tM0;

  // Sammle alle Currency-Fields (das sind die Tier-1-Kandidaten)
  const currencyFields: Array<{
    section: ParsedSection; field: ParsedField; query: string; value: number | null;
  }> = [];
  for (const sec of structured.sections) {
    for (const f of sec.fields) {
      if (f.type === 'currency' || f.type === 'integer') {
        const parsed = parseGermanCurrency(f.value);
        // Query = section-Role + Beitragsart-Kontext + field-key
        // Context-Priority: beitragsart > versicherung > merkmal_zum_beitrag
        // (beitragsart unterscheidet sich pro Block, merkmal_zum_beitrag ist generisch)
        const sectionContext: string[] = [];
        const ctxField =
          sec.fields.find((x) => x.key === 'beitragsart') ??
          sec.fields.find((x) => x.key === 'versicherung') ??
          sec.fields.find((x) => x.key === 'merkmal_zum_beitrag');
        if (ctxField) sectionContext.push(ctxField.value);
        sectionContext.push(f.key.replace(/_/g, ' '));
        const query = sectionContext.join('. ');
        currencyFields.push({ section: sec, field: f, query, value: parsed });
      }
    }
  }

  // 2. Atoms laden + ExactFp32Index
  const atomsRaw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'atoms.json'), 'utf-8')) as Atom[];
  const cm: CascadeManifest = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'embeddings.gemma4.cascade.json'), 'utf-8'));
  const exact = await ExactFp32Index.load(path.join(DATA_DIR, cm.exact!.file), cm.exact!.d);
  const allEcodeIndices = atomsRaw
    .map((a, i) => (ECODE_REGEX.test(a.field_name) ? i : -1))
    .filter((i) => i >= 0);

  // 3. Embed alle Field-Queries (batch)
  const tE0 = Date.now();
  const queries = currencyFields.map((f) => f.query);
  const vecs = queries.length ? await embedQueries(queries) : [];
  const vecsNorm = vecs.map((v) => l2normalize(new Float32Array(v)));
  const tEmbed = Date.now() - tE0;

  // 4. Pro Field: top-3 eCodes via exact rerank
  const tR0 = Date.now();
  const fieldResults = currencyFields.map((f, i) => {
    const q = vecsNorm[i];
    const top = exact.rerank(q, allEcodeIndices, 5);
    const candidates = top.map((h) => ({
      ecode: atomsRaw[h.idx].field_name,
      score: h.score,
      drucktext: atomsRaw[h.idx].metadata?.drucktext ?? atomsRaw[h.idx].value,
      anlage: atomsRaw[h.idx].metadata?.anlage,
      vordruckzeile: atomsRaw[h.idx].metadata?.vordruckzeile,
    }));
    return { field: f, candidates };
  });
  const tRerank = Date.now() - tR0;

  // 5. Zuordnung: top-1 eCode pro field, value gerundet (expense floor)
  const ecodeAssignments: Record<string, { value: number; from_field: string; score: number; query: string }> = {};
  for (const fr of fieldResults) {
    if (fr.candidates.length === 0 || fr.field.value === null) continue;
    const top = fr.candidates[0];
    const rounded = roundForElster(fr.field.value, 'expense');
    // Wenn schon ein Wert für diesen eCode existiert, behalte den mit höherem Score
    const existing = ecodeAssignments[top.ecode];
    if (!existing || top.score > existing.score) {
      ecodeAssignments[top.ecode] = {
        value: rounded,
        from_field: `${fr.field.section.id}.${fr.field.field.key}`,
        score: top.score,
        query: fr.field.query,
      };
    }
  }

  const tTotal = Date.now() - tTotal0;

  // 6. Output
  console.log(`\nPipeline-Zeiten:`);
  console.log(`  Mistral-Structure: ${tMistral} ms (${structured.sections.length} sections, ${structured.stats.fieldCount} fields)`);
  console.log(`  Currency-Fields:   ${currencyFields.length}`);
  console.log(`  Embeddings:        ${tEmbed} ms`);
  console.log(`  Rerank+Assign:     ${tRerank} ms`);
  console.log(`  TOTAL:             ${tTotal} ms`);

  console.log(`\n--- Field-Level-Polar: Top-Match pro Currency-Field ---`);
  console.log(`${'section.field_key'.padEnd(56)} ${'value'.padStart(8)}  top1-eCode score`);
  console.log('─'.repeat(95));
  for (const fr of fieldResults) {
    const t = fr.candidates[0];
    const fkey = `${fr.field.section.id}.${fr.field.field.key}`.slice(0, 55);
    const val = fr.field.value !== null ? fr.field.value.toFixed(2) : '?';
    console.log(`${fkey.padEnd(56)} ${val.padStart(8)}  ${t?.ecode} @ ${t?.score.toFixed(3)} (${(t?.drucktext ?? '').slice(0, 45)})`);
  }

  console.log(`\n--- Ground-Truth-Diff ---`);
  console.log(`eCode      Bedeutung                                  Expected  Got       Status`);
  console.log('─'.repeat(95));
  let pass = 0, fail = 0, miss = 0;
  for (const gt of GROUND_TRUTH) {
    const got = ecodeAssignments[gt.ecode];
    let status: string;
    if (!got) { status = 'MISSING'; miss++; }
    else if (got.value === gt.expected) { status = `✓ MATCH (from ${got.from_field})`; pass++; }
    else { status = `✗ WRONG (got ${got.value} from ${got.from_field})`; fail++; }
    console.log(
      `${gt.ecode}  ${gt.bedeutung.padEnd(42).slice(0, 42)} ${String(gt.expected).padEnd(9)} ${String(got?.value ?? '—').padEnd(9)} ${status}`,
    );
  }
  return { pass, fail, miss, total: GROUND_TRUTH.length, totalMs: tTotal };
}

async function main() {
  console.log('\n████  FIELD-LEVEL-POLAR — Mistral fields[] → embed(field_key + ctx) → top-1 eCode  ████\n');
  const a = await runOne(LAYOUT_A, 'A — ELSTER XSD-Datensatz');
  const b = await runOne(LAYOUT_B, 'B — Brief-PDF mit Spalten-Matrix');
  console.log('\n' + '═'.repeat(82));
  console.log(`Layout A: ${a.pass}/${a.total} match, ${a.fail} wrong, ${a.miss} missing  (${a.totalMs} ms)`);
  console.log(`Layout B: ${b.pass}/${b.total} match, ${b.fail} wrong, ${b.miss} missing  (${b.totalMs} ms)`);
  console.log(`Aggregat: ${a.pass + b.pass}/${a.total + b.total} = ${(((a.pass + b.pass) / (a.total + b.total)) * 100).toFixed(0)}% cent-genau`);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
