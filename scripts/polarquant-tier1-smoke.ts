/**
 * PolarQuant Tier-1 Smoke v2 — anlage-whitelist + belegtyp-context + margin-gate.
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

const OCR_MD = '/tmp/debeka-haubrich-ocr.md';
const ATOMS  = 'src/verticals/elster-v3/data/atoms.json';
const FP32   = 'src/verticals/elster-v3/data/embeddings.gemma4.fp32.bin';
const OUT    = '/tmp/polarquant-tier1-smoke-result.json';

const GROUND_TRUTH = [
  { name: 'KV Basis',  beleg_label: 'Geleistete Beiträge zur Krankenversicherung (ohne Krankengeldanspruch) ohne Zusatzbeitrag für Basisleistungen', expected_ecode: 'E2003104', expected_value: 1781.98, expected_elster_xml: '1782' },
  { name: 'PV Pflicht', beleg_label: 'Geleistete Beiträge zur sozialen oder privaten Pflegepflichtversicherung', expected_ecode: 'E2004103', expected_value: 772.68, expected_elster_xml: '773' },
  { name: 'KV Gesamt (NO eCode)',  beleg_label: 'Gesamtbeitrag zur Krankenversicherung (Basisleistungen und Wahlleistungen)', expected_ecode: null, expected_value: 2238.60 },
  { name: 'PV Gesamt (NO eCode)',  beleg_label: 'Gesamtbeitrag zur Pflegeversicherung (Pflegepflichtversicherung und freiwillige Zusatzpflegeversicherung)', expected_ecode: null, expected_value: 772.68 },
];

const MARGIN_GATE = 0.012;   // top1-top2 score margin required for confident match

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
  console.log('Sections:', sections.length);

  const matches: any[] = [];
  for (const [i,s] of sections.entries()) {
    const ba = s.body.match(/Beitragsart\s*\|\s*([^|\n]+)/);
    if (!ba) {
      matches.push({ section_idx: i, section_heading: s.heading, section_beitragsart: null });
      continue;
    }
    const { candidates, margin, queryText } = await polarMatchSection(s, index, atomsByIdx, belegCtx, 5);
    const extracts = candidates.map(c => tier1Extract(s, c.atom, c.score, margin));
    const sorted = [...extracts].sort((a,b) => (b.confidence - a.confidence) || (b.audit.polar_score - a.audit.polar_score));
    // Margin gate: if top1-top2 polar margin is too small, demote to low-margin
    let best = null;
    if (sorted[0] && sorted[0].confidence >= 0.65 && sorted[0].wert) {
      if (margin >= MARGIN_GATE) {
        best = { ecode: sorted[0].ecode, wert: sorted[0].wert, wert_numeric: sorted[0].wert_numeric, wert_elster_xml: sorted[0].wert_elster_xml, confidence: sorted[0].confidence, strategy: sorted[0].strategy, polar_margin: margin };
      } else {
        best = { ecode: sorted[0].ecode, wert: null, wert_numeric: null, wert_elster_xml: null, confidence: 0, strategy: 'low-margin', polar_margin: margin };
      }
    }
    matches.push({
      section_idx: i,
      section_heading: s.heading,
      section_beitragsart: ba[1].trim(),
      query_text: queryText.slice(0, 120),
      polar_margin: Number(margin.toFixed(4)),
      top_candidates: candidates.map(c => ({ ecode: c.atom.ecode, drucktext: c.atom.drucktext.slice(0,80), anlage: c.atom.anlage, zeile: c.atom.vordruckzeile, polar_score: Number(c.score.toFixed(4)) })),
      extracts,
      best,
    });
  }
  phases.match_and_extract = Date.now() - t;

  const result = { total_ms: Date.now() - tWall, phases, sections_count: sections.length, beleg_context: belegCtx, matches, ground_truth: GROUND_TRUTH };
  await writeFile(OUT, JSON.stringify(result, null, 2));

  console.log('\n=== TIMING ===');
  for (const [k,v] of Object.entries(phases)) console.log('  ' + k.padEnd(20) + v + 'ms');
  console.log('  TOTAL              ' + (Date.now()-tWall) + 'ms\n');

  console.log('=== POLAR MATCHES per Beitragsdaten-Section ===');
  for (const m of matches) {
    if (!m.section_beitragsart) continue;
    console.log('--- Section #' + m.section_idx + ': ' + m.section_beitragsart.slice(0,80));
    console.log('    query: ' + m.query_text);
    console.log('    margin: ' + m.polar_margin);
    for (const c of m.top_candidates) {
      console.log('    ' + c.ecode + '  score=' + c.polar_score + '  anl=' + c.anlage.padEnd(6) + '  zeile=' + (c.zeile||'-').padEnd(3) + '  ' + c.drucktext);
    }
    console.log('  BEST: ' + (m.best ? m.best.ecode + ' = ' + m.best.wert + ' [elster=' + m.best.wert_elster_xml + '] (conf=' + m.best.confidence.toFixed(2) + ', ' + m.best.strategy + ')' : '(none)'));
  }

  console.log('\n=== GROUND-TRUTH CHECK ===');
  let hits = 0;
  for (const gt of GROUND_TRUTH) {
    const found = matches.find(m => m.section_beitragsart === gt.beleg_label && m.best);
    if (!gt.expected_ecode) {
      console.log('  [SKIP-NO-ECODE]  ' + gt.name);
      if (found && found.best && found.best.ecode) console.log('    ⚠ false positive: matched ' + found.best.ecode + ' = ' + found.best.wert);
      continue;
    }
    if (found && found.best.ecode === gt.expected_ecode && Math.abs(found.best.wert_numeric - gt.expected_value) < 0.01) {
      const xmlOk = !gt.expected_elster_xml || found.best.wert_elster_xml === gt.expected_elster_xml;
      console.log('  ' + (xmlOk?'✅':'⚠️') + ' ' + gt.name + '  ' + gt.expected_ecode + ' = ' + gt.expected_value + ' → ELSTER "' + found.best.wert_elster_xml + '" (conf=' + found.best.confidence.toFixed(2) + ', ' + found.best.strategy + ', margin=' + found.polar_margin + ')');
      if (xmlOk) hits++;
    } else {
      console.log('  ❌ ' + gt.name + '  expected ' + gt.expected_ecode + '=' + gt.expected_value + '  got: ' + (found ? (found.best ? found.best.ecode+'='+found.best.wert+' ['+found.best.strategy+']' : '(low-margin)') : '(no section)'));
    }
  }
  const elsterTargets = GROUND_TRUTH.filter(g => g.expected_ecode).length;
  console.log('\n=== SCORE: ' + hits + '/' + elsterTargets + ' ELSTER-relevant ground-truth hits ===');
}
main().catch(e => { console.error(e); process.exit(1); });
