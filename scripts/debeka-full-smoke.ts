/**
 * Full Debeka Beleg run through the PolarQuant pipeline.
 * Tests all three modes for comparison.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { runPipeline, type PipelineMode } from '../src/verticals/elster-v3/lib/polarquant-pipeline.ts';

const OCR_MD = '/tmp/debeka-haubrich-ocr.md';
const ATOMS = 'src/verticals/elster-v3/data/atoms.json';
const EMB = 'src/verticals/elster-v3/data/embeddings.gemma4.fp32.bin';

async function main() {
  const md = await readFile(OCR_MD, 'utf-8');
  const modes: PipelineMode[] = ['tier1-only', 'tier2-only', 'tier1+tier2-fallback', 'auto'];

  console.log('================================================================');
  console.log('FULL DEBEKA BELEG — Hildburg Haubrich-Koch, 2024');
  console.log('================================================================\n');

  for (const mode of modes) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`MODE: ${mode}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const result = await runPipeline(md, {
      mode,
      atomsPath: ATOMS,
      embeddingsPath: EMB,
      embeddingDim: 768,
      marginGate: 0.02,
      topK: 20,
    });

    for (const s of result.sections) {
      const tag = s.section_beitragsart ? '📋' : '📄';
      console.log(`\n${tag} #${s.section_idx} [${s.section_heading}]`);
      if (s.section_beitragsart) {
        console.log(`   Beitragsart: ${s.section_beitragsart.slice(0,90)}`);
        console.log(`   Pool: ${s.pool_size} atoms, mode_used=${s.mode_used}`);
        if (s.tier1) console.log(`   Tier-1: polar_score=${s.tier1.polar_score.toFixed(3)} margin=${s.tier1.polar_margin.toFixed(3)} (${s.tier1.strategy})`);
        if (s.tier2) console.log(`   Tier-2: ${s.tier2.ms}ms in=${s.tier2.tokens_in} out=${s.tier2.tokens_out} | ${s.tier2.reasoning.slice(0,80)}`);
        if (s.status === 'hit') {
          console.log(`   ✅ ${s.picked_ecode} (${s.anlage}/Z${s.vordruckzeile}, paths=${s.kontextPaths.join(',')})`);
          console.log(`      = ${s.wert_raw} → ELSTER "${s.wert_elster_xml}"`);
        } else if (s.status === 'no-match-by-rule') {
          console.log(`   ⊘ no-match (by rule)`);
        } else if (s.status === 'no-extract') {
          console.log(`   ⚠ picked ${s.picked_ecode} but value not extractable`);
        }
      }
    }

    console.log(`\n📊 SUMMARY [${mode}]:`);
    console.log(`   total_ms=${result.total_ms}`);
    console.log(`   sections_total=${result.summary.sections_total}`);
    console.log(`   sections_with_beitragsart=${result.summary.sections_with_beitragsart}`);
    console.log(`   hits=${result.summary.hits}`);
    console.log(`   no_match_by_rule=${result.summary.no_match_by_rule}`);
    console.log(`   tier2_invocations=${result.summary.tier2_invocations}`);
    console.log();
  }

  // Final ELSTER-XML preview (using tier2-only)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('FINAL ELSTER-XML KEY-VALUE PAIRS (tier2-only)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const final = await runPipeline(md, { mode: 'tier2-only', atomsPath: ATOMS, embeddingsPath: EMB, embeddingDim: 768 });
  const hits = final.sections.filter(s => s.status === 'hit');
  for (const h of hits) {
    console.log(`  ${h.picked_ecode} = ${h.wert_elster_xml}  // ${h.anlage}/Z${h.vordruckzeile}, ${h.kontextPaths[0]}`);
  }
  console.log(`\nTotal ELSTER-XML positions: ${hits.length}`);
  await writeFile('/tmp/debeka-full-pipeline-result.json', JSON.stringify(final, null, 2));
  console.log('Full result → /tmp/debeka-full-pipeline-result.json');
}

main().catch(e => { console.error(e); process.exit(1); });
