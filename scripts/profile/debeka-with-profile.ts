/**
 * Debeka 2024 → run pipeline TWICE:
 *   A) without profile (baseline)
 *   B) with Hildburg profile injected
 * Compare results section-by-section.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { runPipeline, type PipelineMode } from '../../src/verticals/elster-v3/lib/polarquant-pipeline.ts';

const OCR_MD = '/tmp/debeka-haubrich-ocr.md';
const ATOMS = 'src/verticals/elster-v3/data/atoms.json';
const EMB = 'src/verticals/elster-v3/data/embeddings.gemma4.fp32.bin';
const PROFILE = '/tmp/profile-haubrich-koch.json';

interface Profile { atoms: Array<{ field_id: string; field_name: string; value: any; group: string; ecode?: string; anlage?: string; vordruckzeile?: string }> }

function summarizeProfile(p: Profile): string {
  const get = (id: string) => p.atoms.find(a => a.field_id === id)?.value;
  const ecodes = p.atoms.filter(a => a.ecode).map(a => `${a.ecode}=${a.field_name}:${a.value}`).slice(0, 25);

  return [
    `Mandantin: ${get('vorname')} ${get('name')}, geb. ${get('geburtsdatum')}, Rentnerin, verwitwet seit ${get('verwitwet_seit')}.`,
    `IdNr ${get('idnr')}, ev., FA ${get('finanzamt')}, Steuernr ${get('steuernummer_bescheid')}, Alleinveranlagung (Person A allein, KEIN Ehegatte).`,
    `Aktive Einkunftsarten 2023: Versorgungsbezüge StKl 1 (${get('arbeitslohn_stkl1_2023')} €, Beginn 1991) + StKl 6 (${get('arbeitslohn_stkl6_2023')} €, Beginn 2005); gesetzliche Rente ${get('rente_jahresbetrag_2023')} € (Beginn 1995-12-01); AV-Vertrag ${get('av_leibrente_2023')} €; KapErtr ${get('kapitalertraege_2023')} €.`,
    `Versicherungen aktiv: Debeka KV (2023 = ${get('kv_beitrag_2023')} €), Debeka Pflege-Pflicht (2023 = ${get('pv_beitrag_2023')} €), Debeka Wahlleistungen (${get('wahlleistungen_kv_2023')} €), DEVK Haftpflicht (${get('haftpflicht_devk_2023')} €). Beitragsrückerstattung 2023 = ${get('kv_pv_erstattung_2023')} €. Zuschuss RV→KV 2023 = ${get('kv_pv_zuschuss_2023')} €.`,
    `KEINE Arbeitgeber-LStB (Rentnerin), aber Anlage N WIRD ausgefüllt für Versorgungsbezüge (steuerbegünstigt nach § 19 EStG).`,
    `Bekannte Drift-Erwartungen 2024: KV-Beitrag +2-3 % (Beitragsanpassung), Pflege +10 % (Beitragssatz-Erhöhung 2024).`,
    'Bevorzugte ELSTER-Anlagen: VOR (Vorsorge), R (Renten), RAV_bAV (AV-Vertrag), KAP, ESt1A.',
  ].join(' ');
}

async function main() {
  const md = await readFile(OCR_MD, 'utf-8');
  const profile: Profile = JSON.parse(await readFile(PROFILE, 'utf-8'));
  const summary = summarizeProfile(profile);

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('Debeka 2024 Beleg — A/B-Test: with vs. without Mandant-Profil');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('\nProfile-Summary in Tier-2 prompt:');
  console.log('  ' + summary.slice(0,300) + '...\n');

  const cfgBase = {
    atomsPath: ATOMS, embeddingsPath: EMB, embeddingDim: 768,
    marginGate: 0.02, topK: 20, mode: 'tier2-only' as PipelineMode,
  };

  console.log('━━━━━ A) WITHOUT profile ━━━━━');
  const a = await runPipeline(md, cfgBase);
  console.log('━━━━━ B) WITH profile ━━━━━');
  const b = await runPipeline(md, { ...cfgBase, profileSummary: summary });

  // Compare
  console.log('\n═══════════════════ COMPARISON ═══════════════════');
  for (let i = 0; i < a.sections.length; i++) {
    const sa = a.sections[i], sb = b.sections[i];
    if (!sa.section_beitragsart) continue;
    const sym = sa.picked_ecode === sb.picked_ecode ? '=' : '≠';
    console.log(`#${sa.section_idx} ${sym} [${(sa.section_beitragsart||'').slice(0,55)}]`);
    console.log(`     A: ${sa.picked_ecode || 'NONE'} (${sa.status})`);
    console.log(`     B: ${sb.picked_ecode || 'NONE'} (${sb.status})`);
    if (sa.picked_ecode !== sb.picked_ecode) {
      console.log(`     A-reason: ${(sa.tier2?.reasoning || '').slice(0,90)}`);
      console.log(`     B-reason: ${(sb.tier2?.reasoning || '').slice(0,90)}`);
    }
  }

  console.log('\n📊 Summary A (no profile):  hits=' + a.summary.hits + ', no-match=' + a.summary.no_match_by_rule + ', tier2=' + a.summary.tier2_invocations + ', total_ms=' + a.total_ms);
  console.log('📊 Summary B (w/ profile):  hits=' + b.summary.hits + ', no-match=' + b.summary.no_match_by_rule + ', tier2=' + b.summary.tier2_invocations + ', total_ms=' + b.total_ms);

  await writeFile('/tmp/debeka-ab.json', JSON.stringify({ A: a, B: b }, null, 2));
  console.log('\n→ /tmp/debeka-ab.json');
}
main().catch(e => { console.error(e); process.exit(1); });
