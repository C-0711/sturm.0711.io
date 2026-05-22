/**
 * "Tier-2 only" Smoke: skip Polar embedding, hand Gemma the full Anlage-VOR catalog
 * filtered by preferredKontextPaths. Tests: how well does Gemma alone perform?
 */
import { readFile, writeFile } from 'node:fs/promises';
import {
  splitSections,
  loadContainerAtoms,
  tier1Extract,
  extractBelegContext,
  type AtomMeta,
} from '../src/verticals/elster-v3/lib/polarquant-tier1.ts';
import { gemmaDisambiguate } from '../src/verticals/elster-v3/lib/polarquant-tier2.ts';

const OCR_MD = '/tmp/debeka-haubrich-ocr.md';
const ATOMS = 'src/verticals/elster-v3/data/atoms.json';
const OUT = '/tmp/tier2-only-result.json';

const GT = [
  { name: 'KV Basis',  beleg_label: 'Geleistete Beiträge zur Krankenversicherung (ohne Krankengeldanspruch) ohne Zusatzbeitrag für Basisleistungen', expected_ecode: 'E2003104', expected_value: 1781.98, expected_elster_xml: '1782' },
  { name: 'PV Pflicht', beleg_label: 'Geleistete Beiträge zur sozialen oder privaten Pflegepflichtversicherung', expected_ecode: 'E2003202', expected_value: 772.68, expected_elster_xml: '773' },
  { name: 'KV Gesamt',  beleg_label: 'Gesamtbeitrag zur Krankenversicherung (Basisleistungen und Wahlleistungen)', expected_ecode: null, expected_value: 2238.60 },
  { name: 'PV Gesamt',  beleg_label: 'Gesamtbeitrag zur Pflegeversicherung (Pflegepflichtversicherung und freiwillige Zusatzpflegeversicherung)', expected_ecode: null, expected_value: 772.68 },
];

async function main() {
  const t0 = Date.now();
  const md = await readFile(OCR_MD, 'utf-8');
  const { atomsByEcode, atomsByIdx } = await loadContainerAtoms(ATOMS);
  const belegCtx = extractBelegContext(md);
  const sections = splitSections(md);
  console.log('Beleg:', belegCtx.belegtyp, '|', belegCtx.uebermittelndeStelle);
  console.log('preferredKontextPaths:', belegCtx.preferredKontextPaths);

  // Build candidate pool: all atoms in allowed anlagen that match preferred kontextPath
  // (or all VOR atoms if no preference)
  const allowed = new Set(belegCtx.allowedAnlagen);
  const preferred = new Set(belegCtx.preferredKontextPaths || []);
  const pool = atomsByIdx.filter(a => {
    if (!allowed.has(a.anlage)) return false;
    if (a.anlage !== 'VOR') return false; // keep test focused
    if (preferred.size === 0) return true;
    return (a.kontextPaths || []).some(p => preferred.has(p));
  });
  console.log(`Candidate pool: ${pool.length} atoms (Anlage VOR, kontextPath-filtered)`);

  // Show the pool we hand to Gemma
  console.log('\nPool:');
  pool.forEach(a => console.log(`  - ${a.ecode} Z${a.vordruckzeile}: ${a.drucktext.slice(0,80)}`));
  console.log();

  const matches: any[] = [];
  for (const [i, s] of sections.entries()) {
    const ba = s.body.match(/Beitragsart\s*\|\s*([^|\n]+)/);
    if (!ba) { matches.push({ section_idx: i, skipped: true }); continue; }

    // Pass ALL pool atoms as candidates (no polar pre-ranking)
    const candidates = pool.map(a => ({ atom: a, score: 1.0 })); // dummy score
    const t2 = await gemmaDisambiguate(s, candidates, belegCtx);

    let chosen: any = null;
    if (t2.picked_ecode) {
      const atom = pool.find(a => a.ecode === t2.picked_ecode)!;
      const extract = tier1Extract(s, atom, 1.0, 1.0);
      if (extract.wert) {
        chosen = { tier: '2-only', ecode: extract.ecode, wert: extract.wert, wert_numeric: extract.wert_numeric, wert_elster_xml: extract.wert_elster_xml, reasoning: t2.reasoning };
      }
    }

    matches.push({
      section_idx: i,
      section_beitragsart: ba[1].trim(),
      tier2_picked: t2.picked_ecode,
      tier2_reasoning: t2.reasoning,
      tier2_ms: t2.audit.ms,
      tier2_tokens_in: t2.audit.tokens_in,
      tier2_tokens_out: t2.audit.tokens_out,
      chosen,
    });
  }

  const totalMs = Date.now() - t0;
  await writeFile(OUT, JSON.stringify({ total_ms: totalMs, beleg_context: belegCtx, pool_size: pool.length, matches, ground_truth: GT }, null, 2));

  console.log('=== RESULTS ===');
  for (const m of matches) {
    if (m.skipped) continue;
    console.log(`#${m.section_idx}: ${m.section_beitragsart.slice(0,70)}`);
    console.log(`  Gemma: ${m.tier2_picked || 'NONE'} (${m.tier2_ms}ms, in=${m.tier2_tokens_in} out=${m.tier2_tokens_out})`);
    console.log(`  Reasoning: ${m.tier2_reasoning.slice(0, 100)}`);
    if (m.chosen) console.log(`  ✓ CHOSEN: ${m.chosen.ecode} = ${m.chosen.wert} [elster=${m.chosen.wert_elster_xml}]`);
    else console.log(`  ∅ no chosen value`);
  }

  console.log('\n=== GROUND-TRUTH ===');
  let hits = 0, fps = 0;
  for (const gt of GT) {
    const found = matches.find(m => m.section_beitragsart === gt.beleg_label);
    if (!gt.expected_ecode) {
      if (found?.chosen) { console.log(`  ❌ FP  ${gt.name}: expected no-match, got ${found.chosen.ecode}=${found.chosen.wert}`); fps++; }
      else                 console.log(`  ✅ NM  ${gt.name}`);
      continue;
    }
    if (found?.chosen && found.chosen.ecode === gt.expected_ecode && Math.abs(found.chosen.wert_numeric - gt.expected_value) < 0.01) {
      console.log(`  ✅ HIT ${gt.name}: ${gt.expected_ecode} = ${gt.expected_value}`); hits++;
    } else {
      console.log(`  ❌ MISS ${gt.name}: expected ${gt.expected_ecode}=${gt.expected_value}, got ${found?.chosen ? found.chosen.ecode+'='+found.chosen.wert : '(none)'}`);
    }
  }
  const targets = GT.filter(g => g.expected_ecode).length;
  console.log(`\n=== SCORE: ${hits}/${targets} hits, ${fps} FPs, total ${totalMs}ms ===`);
}
main().catch(e => { console.error(e); process.exit(1); });
