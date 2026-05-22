/**
 * E2E mit Mistral als Tiebreak-Indikator:
 *   1. Mistral-Structure → fields[]
 *   2. Polar embed → top-5 eCodes pro currency-field
 *   3. Mistral-Rerank → picked aus Polar's top-5 (catalog-bound)
 *   4. Round + assign
 *
 * Mistral kennt keine eCodes ausser den 5 die Polar pro Field vorqualifiziert.
 * Damit ist Catalog-Containment garantiert.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mistralStructureStage, type ParsedField, type ParsedSection } from '../src/verticals/elster-v3/stages/mistral-structure.ts';
import { embedQueries, l2normalize } from '../src/lib/gemma-embed.ts';
import { ExactFp32Index, type CascadeManifest } from '../src/lib/quantum-index.ts';
import { roundForElster } from '../src/verticals/elster-v3/lib/eur-parse.ts';

const META_DIR = '/home/christoph.bertsch/0711/0711-STURM/workspaces/haubrich-koch-hildburg-2024/meta';
const LAYOUT_A = `${META_DIR}/f2a377dd-36e1-43ef-b16a-6cb115845f38.json`;
const LAYOUT_B = `${META_DIR}/5304e988-ac73-4e04-bb04-95af71bd6e49.json`;

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/verticals/elster-v3/data');
const ECODE_REGEX = /^E\d{7}$/;

const GROUND_TRUTH = [
  { ecode: 'E2003104', expected: 1781, bedeutung: 'Private KV Basisabsicherung' },
  { ecode: 'E2003202', expected:  772, bedeutung: 'Pflege-Pflichtversicherung' },
  { ecode: 'E2004003', expected: 1781, bedeutung: 'Private KV Basis abzgl. Zuschuesse' },
  { ecode: 'E2004103', expected:  772, bedeutung: 'PV Pflicht abzgl. Zuschuesse' },
  { ecode: 'E2004303', expected:  456, bedeutung: 'Private KV/PV ueber Basis (Wahlleistungen)' },
];

interface Atom {
  field_name: string;
  value: string;
  citation_section: string;
  metadata?: any;
}

function parseGermanCurrency(s: string): number | null {
  if (!s) return null;
  const m = s.match(/-?\d{1,3}(?:\.\d{3})*(?:,\d{2})?|-?\d+(?:\.\d{2})?/);
  if (!m) return null;
  const raw = m[0];
  if (raw.includes(',')) return parseFloat(raw.replace(/\./g, '').replace(',', '.'));
  return parseFloat(raw);
}

function ctxNew(): any {
  return { runId:'s',workflowId:'s',stageId:'s',config:{},logger:console,artifacts:{},emit:()=>{},signal:new AbortController().signal,results:{} };
}

async function mistralCall(system: string, user: string): Promise<{ content: string; ms: number; tokens: { in: number; out: number } }> {
  const t0 = Date.now();
  const resp = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.MISTRAL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'mistral-small-latest',
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  const data = await resp.json() as any;
  return {
    content: data.choices?.[0]?.message?.content ?? '',
    ms: Date.now() - t0,
    tokens: { in: data.usage?.prompt_tokens ?? 0, out: data.usage?.completion_tokens ?? 0 },
  };
}

const RERANK_SYSTEM = `Du bist ein BMF-Steuer-Disambiguator. Du bekommst Currency-Fields aus einem Steuerbeleg und pro Field eine Liste von 5 ELSTER-eCode-Kandidaten mit BMF-Beschreibung.

Deine Aufgabe: Pro Field exakt EINEN eCode aus den 5 Kandidaten wählen — den semantisch passendsten basierend auf:
1. Beleg-Kontext (Aussteller, Beitragsart, Person)
2. Feld-Semantik (key + value)
3. BMF-Beschreibung des eCodes

WICHTIG:
- Du darfst NUR aus den 5 vorgegebenen Kandidaten wählen. Nichts erfinden.
- Falls KEINER passt: pick "NONE" + reasoning.
- Antworte als JSON-Array, ein Objekt pro Field.

Output-Format:
[
  {
    "field_id": "s3.hoehe_beitraege",
    "chosen_ecode": "E2004003",
    "reasoning": "Aussteller Debeka ist private inländische KV (nicht Ausland-vergleichbar), Block 1 sagt explizit 'ohne Krankengeldanspruch ohne Zusatzbeitrag' = Basis, abzgl. Zuschuesse impliziert → E2004003 statt E2002502 (vergleichbar Ausland)."
  },
  ...
]`;

async function runOne(metaPath: string, layoutName: string) {
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  const ocrText = meta.ocr.markdown;

  console.log('═'.repeat(82));
  console.log(`Layout: ${layoutName}`);
  console.log(`Beleg:  ${meta.originalFilename}`);
  console.log('═'.repeat(82));

  const tTotal0 = Date.now();

  // 1. Mistral-Structure (v6)
  const tM0 = Date.now();
  const structured = await mistralStructureStage.run({ ocrText }, ctxNew());
  const tMistral1 = Date.now() - tM0;

  // Sammle alle currency fields + Section-Context
  type FieldCtx = {
    section: ParsedSection; field: ParsedField; value: number | null;
    field_id: string; context_text: string;
  };
  const currencyFields: FieldCtx[] = [];
  // Beleg-Header-Context aus allen Sections sammeln (Aussteller, Anrede, Datum)
  const belegHeader: string[] = [];
  for (const sec of structured.sections) {
    if (sec.role === 'header' || sec.role === 'stammdaten') {
      for (const f of sec.fields) {
        if (f.type === 'text' && (f.key.includes('aussteller') || f.key.includes('uebermittelnde') || f.key.includes('dokumenttitel') || f.key.includes('titel'))) {
          belegHeader.push(`${f.key}: ${f.value}`);
        }
      }
    }
  }

  for (const sec of structured.sections) {
    for (const f of sec.fields) {
      if (f.type !== 'currency' && f.type !== 'integer') continue;
      const parsed = parseGermanCurrency(f.value);
      // Section-internen Kontext sammeln (beitragsart, versicherung, alle non-currency text fields)
      const innerCtx: string[] = [];
      const beitragsart = sec.fields.find((x) => x.key === 'beitragsart');
      const versicherung = sec.fields.find((x) => x.key === 'versicherung');
      const merkmal = sec.fields.find((x) => x.key === 'merkmal_zum_beitrag');
      if (beitragsart) innerCtx.push(`beitragsart: ${beitragsart.value}`);
      if (versicherung) innerCtx.push(`versicherung: ${versicherung.value}`);
      if (merkmal) innerCtx.push(`merkmal: ${merkmal.value}`);
      const field_id = `${sec.id}.${f.key}`;
      currencyFields.push({
        section: sec, field: f, value: parsed, field_id,
        context_text: [...innerCtx, `${f.key}: ${f.value}`].join('. '),
      });
    }
  }

  // 2. Polar embed pro field → top-5 eCodes
  const atomsRaw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'atoms.json'), 'utf-8')) as Atom[];
  const cm: CascadeManifest = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'embeddings.gemma4.cascade.json'), 'utf-8'));
  const exact = await ExactFp32Index.load(path.join(DATA_DIR, cm.exact!.file), cm.exact!.d);
  const allEcodeIndices = atomsRaw
    .map((a, i) => (ECODE_REGEX.test(a.field_name) ? i : -1))
    .filter((i) => i >= 0);

  const tE0 = Date.now();
  const queries = currencyFields.map((f) => f.context_text);
  const vecs = queries.length ? await embedQueries(queries) : [];
  const vecsNorm = vecs.map((v) => l2normalize(new Float32Array(v)));
  const tEmbed = Date.now() - tE0;

  const tR0 = Date.now();
  const polarCandidates = currencyFields.map((f, i) => {
    const q = vecsNorm[i];
    const top = exact.rerank(q, allEcodeIndices, 5);
    return {
      field: f,
      candidates: top.map((h) => ({
        ecode: atomsRaw[h.idx].field_name,
        score: h.score,
        drucktext: atomsRaw[h.idx].metadata?.drucktext ?? atomsRaw[h.idx].value,
        anlage: atomsRaw[h.idx].metadata?.anlage,
        vordruckzeile: atomsRaw[h.idx].metadata?.vordruckzeile,
      })),
    };
  });
  const tRerank = Date.now() - tR0;

  // 3. Mistral-Rerank: pro Field die top-5 + Kontext → pick
  const rerankPayload = polarCandidates.map((pc) => ({
    field_id: pc.field.field_id,
    section_role: pc.field.section.role,
    section_block: pc.field.section.block,
    field_key: pc.field.field.key,
    field_value: pc.field.field.value,
    context: pc.field.context_text,
    candidates: pc.candidates.map((c) => ({
      ecode: c.ecode,
      anlage: c.anlage,
      vordruckzeile: c.vordruckzeile,
      drucktext: c.drucktext?.slice(0, 200),
    })),
  }));
  const rerankUser = [
    `Beleg-Header-Kontext: ${belegHeader.join(' | ')}`,
    `OCR-Auszug (zur Disambig falls noetig):`,
    ocrText.slice(0, 1500),
    ``,
    `Currency-Fields mit Polar-Kandidaten:`,
    JSON.stringify(rerankPayload, null, 2),
  ].join('\n');

  const tMR0 = Date.now();
  const rerank = await mistralCall(RERANK_SYSTEM, rerankUser);
  const tMistral2 = Date.now() - tMR0;

  // Parse JSON-Antwort
  let rerankResults: Array<{ field_id: string; chosen_ecode: string; reasoning: string }> = [];
  try {
    // Mistral könnte mit ```json wrapper antworten
    const cleaned = rerank.content.replace(/```json\s*|\s*```/g, '').trim();
    rerankResults = JSON.parse(cleaned);
  } catch (e) {
    console.error('Failed to parse rerank JSON:', rerank.content.slice(0, 500));
    rerankResults = [];
  }

  // 4. Final-Pick + Rundung
  const ecodeAssignments: Record<string, { value: number; from_field: string; chosen_by: 'mistral' | 'polar-top1'; polar_score: number; reasoning?: string }> = {};
  for (const pc of polarCandidates) {
    if (pc.field.value === null) continue;
    const mistralChoice = rerankResults.find((r) => r.field_id === pc.field.field_id);
    let chosenEcode: string | null = null;
    let chosenBy: 'mistral' | 'polar-top1' = 'polar-top1';
    let polarScore = 0;
    let reasoning = '';

    if (mistralChoice && mistralChoice.chosen_ecode !== 'NONE') {
      const inPolar = pc.candidates.find((c) => c.ecode === mistralChoice.chosen_ecode);
      if (inPolar) {
        chosenEcode = mistralChoice.chosen_ecode;
        chosenBy = 'mistral';
        polarScore = inPolar.score;
        reasoning = mistralChoice.reasoning;
      }
    }
    if (!chosenEcode) {
      // Fallback Polar top-1
      chosenEcode = pc.candidates[0]?.ecode;
      polarScore = pc.candidates[0]?.score ?? 0;
    }

    if (!chosenEcode) continue;
    const rounded = roundForElster(pc.field.value, 'expense');
    const existing = ecodeAssignments[chosenEcode];
    if (!existing || polarScore > existing.polar_score) {
      ecodeAssignments[chosenEcode] = {
        value: rounded,
        from_field: pc.field.field_id,
        chosen_by: chosenBy,
        polar_score: polarScore,
        reasoning,
      };
    }
  }

  const tTotal = Date.now() - tTotal0;

  console.log(`\nPipeline-Zeiten:`);
  console.log(`  Mistral-Structure: ${tMistral1} ms`);
  console.log(`  Polar embed:       ${tEmbed} ms`);
  console.log(`  Polar rerank:      ${tRerank} ms (${currencyFields.length} currency fields × top-5)`);
  console.log(`  Mistral-Rerank:    ${tMistral2} ms (in=${rerank.tokens.in} out=${rerank.tokens.out})`);
  console.log(`  TOTAL:             ${tTotal} ms`);

  console.log(`\n--- Mistral Reasoning (pro Field) ---`);
  for (const r of rerankResults) {
    const pc = polarCandidates.find((p) => p.field.field_id === r.field_id);
    if (!pc) continue;
    const inPolar = pc.candidates.find((c) => c.ecode === r.chosen_ecode);
    console.log(`\n  ${r.field_id} → ${r.chosen_ecode}${inPolar ? '' : ' (NICHT in Polar top-5!)'}`);
    console.log(`    Wert: ${pc.field.field.value}`);
    console.log(`    Reasoning: ${r.reasoning.slice(0, 200)}`);
    console.log(`    Polar top-5: ${pc.candidates.map((c) => c.ecode + '@' + c.score.toFixed(2)).join(', ')}`);
  }

  console.log(`\n--- Ground-Truth-Diff ---`);
  console.log(`eCode      Bedeutung                                  Expected  Got       Status`);
  console.log('─'.repeat(95));
  let pass = 0, fail = 0, miss = 0;
  for (const gt of GROUND_TRUTH) {
    const got = ecodeAssignments[gt.ecode];
    let status: string;
    if (!got) { status = 'MISSING'; miss++; }
    else if (got.value === gt.expected) { status = `✓ MATCH via ${got.chosen_by} (${got.from_field})`; pass++; }
    else { status = `✗ WRONG (got ${got.value} via ${got.chosen_by} from ${got.from_field})`; fail++; }
    console.log(
      `${gt.ecode}  ${gt.bedeutung.padEnd(42).slice(0, 42)} ${String(gt.expected).padEnd(9)} ${String(got?.value ?? '—').padEnd(9)} ${status}`,
    );
  }
  return { pass, fail, miss, total: GROUND_TRUTH.length, totalMs: tTotal };
}

async function main() {
  console.log('\n████  MISTRAL-RERANK als Tiebreak-Indicator (catalog-bound)  ████\n');
  const a = await runOne(LAYOUT_A, 'A — ELSTER XSD-Datensatz');
  const b = await runOne(LAYOUT_B, 'B — Brief-PDF mit Spalten-Matrix');
  console.log('\n' + '═'.repeat(82));
  console.log(`Layout A: ${a.pass}/${a.total} match  (${a.totalMs} ms)`);
  console.log(`Layout B: ${b.pass}/${b.total} match  (${b.totalMs} ms)`);
  console.log(`Aggregat: ${a.pass + b.pass}/${a.total + b.total} = ${(((a.pass + b.pass) / (a.total + b.total)) * 100).toFixed(0)}% cent-genau`);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
