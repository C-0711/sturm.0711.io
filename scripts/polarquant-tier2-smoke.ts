/**
 * PolarQuant Tier-1+Tier-2 Smoke against Debeka Haubrich-Koch 2024.
 * Tier-1 (deterministic embedding match) → margin-gate → Tier-2 (Gemma-4-31b vLLM).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { ExactFp32Index } from '../src/lib/quantum-index.ts';
import {
  splitSections,
  polarMatchSection,
  tier1Extract,
  loadContainerAtoms,
  extractBelegContext,
} from '../src/verticals/elster-v3/lib/polarquant-tier1.ts';
import { gemmaDisambiguate } from '../src/verticals/elster-v3/lib/polarquant-tier2.ts';

const OCR_MD = '/tmp/debeka-haubrich-ocr.md';
const ATOMS  = 'src/verticals/elster-v3/data/atoms.json';
const FP32   = 'src/verticals/elster-v3/data/embeddings.gemma4.fp32.bin';
const OUT    = '/tmp/polarquant-tier2-smoke-result.json';

const GT = [
  { name: 'KV Basis',  beleg_label: 'Geleistete Beiträge zur Krankenversicherung (ohne Krankengeldanspruch) ohne Zusatzbeitrag für Basisleistungen', expected_ecode: 'E2003104', expected_value: 1781.98, expected_elster_xml: '1782' },
  { name: 'PV Pflicht', beleg_label: 'Geleistete Beiträge zur sozialen oder privaten Pflegepflichtversicherung', expected_ecode: 'E2003202', expected_value: 772.68, expected_elster_xml: '773' },
  { name: 'KV Gesamt',  beleg_label: 'Gesamtbeitrag zur Krankenversicherung (Basisleistungen und Wahlleistungen)', expected_ecode: null, expected_value: 2238.60 },
  { name: 'PV Gesamt',  beleg_label: 'Gesamtbeitrag zur Pflegeversicherung (Pflegepflichtversicherung und freiwillige Zusatzpflegeversicherung)', expected_ecode: null, expected_value: 772.68 },
];

const MARGIN_GATE = 0.020;   // below → invoke tier-2
const TOP_K = 20;            // wider candidate pool for tier-2

async function main() {
  const tWall = Date.now();
  const phases: Record<string, number> = {};
  let t = Date.now();

  const md = await readFile(OCR_MD, 'utf-8');
  const { atomsByIdx } = await loadContainerAtoms(ATOMS);
  phases.loadAtoms = Date.now() - t; t = Date.now();
  const index = await ExactFp32Index.load(FP32, 768);
  phases.loadIndex = Date.now() - t; t = Date.now();
  const sections = splitSections(md);
  const belegCtx = extractBelegContext(md);
  phases.split_and_ctx = Date.now() - t; t = Date.now();

  console.log('Beleg-Context:', JSON.stringify(belegCtx));
  console.log('Sections:', sections.length, ' MARGIN_GATE:', MARGIN_GATE, ' TOP_K:', TOP_K, '\n');

  const matches: any[] = [];
  for (const [i,s] of sections.entries()) {
    const ba = s.body.match(/Beitragsart\s*\|\s*([^|\n]+)/);
    if (!ba) { matches.push({ section_idx: i, section_heading: s.heading, section_beitragsart: null }); continue; }

    const { candidates, margin, queryText } = await polarMatchSection(s, index, atomsByIdx, belegCtx, TOP_K);
    const t1Extracts = candidates.map(c => tier1Extract(s, c.atom, c.score, margin));

    // Decide tier strategy
    let chosen: any = null;
    let tier2: any = null;
    if (margin >= MARGIN_GATE) {
      // Tier-1 confident — pick top-1
      const top1 = t1Extracts[0];
      if (top1.confidence >= 0.65 && top1.wert) {
        chosen = { tier: 1, ecode: top1.ecode, wert: top1.wert, wert_numeric: top1.wert_numeric, wert_elster_xml: top1.wert_elster_xml, confidence: top1.confidence, strategy: top1.strategy };
      }
    } else {
      // Tier-2 disambiguation
      tier2 = await gemmaDisambiguate(s, candidates, belegCtx);
      if (tier2.picked_ecode) {
        // Find the extract that matches the picked ecode
        const pickedExtract = t1Extracts.find(e => e.ecode === tier2.picked_ecode);
        if (pickedExtract && pickedExtract.wert) {
          chosen = { tier: 2, ecode: pickedExtract.ecode, wert: pickedExtract.wert, wert_numeric: pickedExtract.wert_numeric, wert_elster_xml: pickedExtract.wert_elster_xml, confidence: 0.92, strategy: pickedExtract.strategy + '+gemma-disambig', reasoning: tier2.reasoning };
        }
      }
    }

    matches.push({
      section_idx: i,
      section_heading: s.heading,
      section_beitragsart: ba[1].trim(),
      polar_margin: Number(margin.toFixed(4)),
      query_text: queryText.slice(0, 120),
      top_candidates: candidates.slice(0, 5).map(c => ({ ecode: c.atom.ecode, anlage: c.atom.anlage, zeile: c.atom.vordruckzeile, polar_score: Number(c.score.toFixed(4)), drucktext: c.atom.drucktext.slice(0,80) })),
      tier2_invoked: tier2 !== null,
      tier2_audit: tier2 ? { picked: tier2.picked_ecode, reasoning: tier2.reasoning, ms: tier2.audit.ms, tokens_in: tier2.audit.tokens_in, tokens_out: tier2.audit.tokens_out } : null,
      chosen,
    });
  }
  phases.match_extract_disambig = Date.now() - t;

  const totalMs = Date.now() - tWall;
  await writeFile(OUT, JSON.stringify({ total_ms: totalMs, phases, beleg_context: belegCtx, matches, ground_truth: GT }, null, 2));

  console.log('=== TIMING ===');
  for (const [k,v] of Object.entries(phases)) console.log('  ' + k.padEnd(28) + v + 'ms');
  console.log('  TOTAL                      ' + totalMs + 'ms\n');

  console.log('=== RESULTS per Section ===');
  for (const m of matches) {
    if (!m.section_beitragsart) continue;
    console.log('--- #' + m.section_idx + ': ' + m.section_beitragsart.slice(0,75));
    console.log('  polar margin=' + m.polar_margin + (m.tier2_invoked ? ' → Tier-2' : ' → Tier-1'));
    if (m.tier2_audit) console.log('  tier2: picked=' + m.tier2_audit.picked + ' (' + m.tier2_audit.ms + 'ms) — ' + m.tier2_audit.reasoning.slice(0,100));
    if (m.chosen) {
      console.log('  ✓ CHOSEN: T' + m.chosen.tier + ' ' + m.chosen.ecode + ' = ' + m.chosen.wert + ' [elster=' + m.chosen.wert_elster_xml + '] (conf=' + m.chosen.confidence.toFixed(2) + ', ' + m.chosen.strategy + ')');
    } else {
      console.log('  ∅ no match');
    }
  }

  console.log('\n=== GROUND-TRUTH CHECK ===');
  let hits = 0, fps = 0;
  for (const gt of GT) {
    const found = matches.find(m => m.section_beitragsart === gt.beleg_label);
    if (!gt.expected_ecode) {
      if (found?.chosen) { console.log('  ❌ FP  ' + gt.name + '  expected no-match, got ' + found.chosen.ecode + '=' + found.chosen.wert); fps++; }
      else                 console.log('  ✅ NM  ' + gt.name + '  correctly no-match');
      continue;
    }
    if (found?.chosen && found.chosen.ecode === gt.expected_ecode && Math.abs(found.chosen.wert_numeric - gt.expected_value) < 0.01 && (!gt.expected_elster_xml || found.chosen.wert_elster_xml === gt.expected_elster_xml)) {
      console.log('  ✅ HIT ' + gt.name + '  T' + found.chosen.tier + ' ' + gt.expected_ecode + ' = ' + gt.expected_value + ' → ELSTER "' + found.chosen.wert_elster_xml + '" (' + found.chosen.strategy + ')');
      hits++;
    } else {
      console.log('  ❌ MISS ' + gt.name + '  expected ' + gt.expected_ecode + '=' + gt.expected_value + ', got ' + (found?.chosen ? found.chosen.ecode+'='+found.chosen.wert : '(none)'));
    }
  }
  const targets = GT.filter(g => g.expected_ecode).length;
  console.log('\n=== SCORE: ' + hits + '/' + targets + ' hits, ' + fps + ' false positives ===');
}
main().catch(e => { console.error(e); process.exit(1); });
