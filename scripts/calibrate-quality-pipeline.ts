#!/usr/bin/env tsx
/**
 * Calibration harness for the elster-v3 quality pipeline.
 *
 * For each fixture in `tests/groundtruth/`, we measure the *retrieval lane*
 * (quantum-ground + retrieval-verify) against the expected eCodes:
 *
 *   • quantum-ground: given the fixture's `anchors[]` as OCR phrases, how
 *     many of the expected eCodes land in the cascade's top-K candidates?
 *     This is the **recall ceiling** for the prompt-grounding step — Layer-1
 *     can't pick what retrieval didn't surface.
 *
 *   • retrieval-verify: given a synthetic nested JSON built from the
 *     fixture's `expected[label] = value`, how does the verifier rate each
 *     leaf? We want NOVELTY=0 and ECODE_MISMATCH=0 on known-good rows;
 *     LOW_CONFIDENCE may legitimately fire on hard German labels.
 *
 * The harness emits a calibration report with per-fixture detail + aggregate
 * stats + recommended threshold settings derived from the score distribution.
 *
 * Usage:
 *   EMBED_CPU=1 OLLAMA_URL=http://localhost:11434 \
 *     tsx scripts/calibrate-quality-pipeline.ts
 *
 * Output: tests/groundtruth/calibration_report.json
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  embedQueries,
  type GemmaEmbedOptions,
} from '../src/lib/gemma-embed.ts';
import {
  QuantumCascade,
  type CascadeManifest,
} from '../src/lib/quantum-index.ts';
import {
  loadDokumenttypen,
  findDokumenttyp,
} from '../src/workflows/steuerbelege/lib/typen-katalog.ts';
import { loadCatalog, type CatalogAtom } from '../src/lib/elster-catalog.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const GOLD = join(REPO_ROOT, 'tests/groundtruth');
const DATA = join(REPO_ROOT, 'src/verticals/elster-v3/data');

interface GoldFixture {
  dokumenttyp_id: string;
  anlage: string;
  anchor: string;
  anchors: string[];
  expected: Record<string, { value: unknown; required: boolean; label: string }>;
  notes?: string[];
}

interface FixtureResult {
  file: string;
  dokumenttyp_id: string;
  expectedECodes: string[];
  /** Aus dokumenttypen.json: erwartete ELSTER-Anlagen für diesen Belegtyp. */
  expectedAnlagen: string[];
  /** Wie viele expected eCodes Pflicht-Atome dieser Anlagen sind (Scaffold-Lift-Floor). */
  expectedPflichtCount: number;
  groundingRecall: {
    /** Fraction of expected eCodes the cascade surfaces in top-K (per K). */
    perK: Record<number, number>;
    /** Mit Pflicht-Scaffold der dokumenttypen.anlagen — wie quantum-ground es jetzt macht. */
    perK_withScaffold: Record<number, number>;
    /** Differenz: scaffold − cascade (rein additiver Recall-Lift durch das Gerüst). */
    perK_scaffoldLift: Record<number, number>;
    /** Atom-level details for the hardest case. */
    misses: Array<{ eCode: string; label: string; bestRankObserved: number | null; bestScore: number | null }>;
  };
  labelScores: Array<{
    eCode: string;
    label: string;
    /** Top-1 cascade score on `label`. */
    top1Score: number;
    /** Whether the expected eCode appears in the cascade's top-20. */
    inTop20: boolean;
    /** Rank of the expected eCode (1-indexed), or null if not in top-20. */
    rank: number | null;
  }>;
}

interface CalibrationReport {
  fixtures: FixtureResult[];
  summary: {
    totalFixtures: number;
    totalExpectedECodes: number;
    /** Recall ohne Pflicht-Scaffold (rein Cascade über anchors). */
    avgGroundingRecall: Record<number, number>;
    /** Recall MIT Pflicht-Scaffold der dokumenttypen.anlagen (production-path). */
    avgGroundingRecall_withScaffold: Record<number, number>;
    /** Additiver Lift durch das Scaffold pro K. */
    avgScaffoldLift: Record<number, number>;
    /** Top-1 score distribution across all known-good labels. Used to
     *  derive a konfidenzGrenze that keeps false-positives low. */
    knownGoodTop1Stats: { p5: number; p25: number; p50: number; p75: number; p95: number; mean: number };
    recommendedThresholds: {
      unbekanntGrenze: number;
      konfidenzGrenze: number;
      rationale: string;
    };
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[i];
}

async function loadCascade(finalK: number) {
  const manifest: CascadeManifest = JSON.parse(
    await readFile(join(DATA, 'embeddings.gemma4.cascade.json'), 'utf-8'),
  );
  const cascade = await QuantumCascade.loadFromManifest(DATA, manifest, finalK);
  const atoms: Array<{ atom_id: string; field_name: string; metadata?: { anlage?: string; drucktext?: string } }> =
    JSON.parse(await readFile(join(DATA, 'atoms.json'), 'utf-8'));
  const eCodeToIdx = new Map<string, number>();
  atoms.forEach((a, i) => eCodeToIdx.set(a.field_name, i));
  return { cascade, atoms, eCodeToIdx };
}

async function runFixture(
  file: string,
  fix: GoldFixture,
  cascade: QuantumCascade,
  atoms: CatalogAtom[],
  eCodeToIdx: Map<string, number>,
  /** ELSTER-Anlagen für diesen Belegtyp (aus dokumenttypen.json). */
  expectedAnlagen: string[],
  embedOpts: GemmaEmbedOptions,
): Promise<FixtureResult> {
  const expectedECodes = Object.keys(fix.expected);
  const expectedIdxs = expectedECodes
    .map((c) => ({ eCode: c, idx: eCodeToIdx.get(c) }))
    .filter((x): x is { eCode: string; idx: number } => x.idx !== undefined);

  // ── 1. Grounding recall: embed anchors, take cascade top-K, measure hits.
  const Ks = [10, 25, 50, 100, 200];
  const perK: Record<number, number> = {};
  const perK_withScaffold: Record<number, number> = {};
  const perK_scaffoldLift: Record<number, number> = {};
  const missesByECode = new Map<string, { bestRank: number | null; bestScore: number | null; label: string }>();
  for (const e of expectedECodes) {
    missesByECode.set(e, { bestRank: null, bestScore: null, label: fix.expected[e].label });
  }

  // Scaffold: alle Pflicht-Atome der erwarteten Anlagen — IMMER bekannt,
  // unabhängig vom Embedding-Match. Exakt das was quantum-ground in der
  // Production tut. Wir tracken sie als "rank=0"-Treffer.
  const expectedAnlagenSet = new Set(expectedAnlagen);
  const scaffoldIdxs = new Set<number>();
  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i];
    if (expectedAnlagenSet.has(a.metadata.anlage) && a.metadata.pflicht) {
      scaffoldIdxs.add(i);
    }
  }
  const expectedPflichtCount = expectedIdxs.filter((x) => scaffoldIdxs.has(x.idx)).length;

  if (fix.anchors.length > 0) {
    const anchorVecs = await embedQueries(fix.anchors, embedOpts);
    const maxK = Math.max(...Ks);
    for (const k of Ks) perK[k] = 0;
    const allHits = new Map<number, number>(); // idx → bestRank über alle anchors
    for (const qv of anchorVecs) {
      const top = cascade.topK(qv, maxK);
      top.forEach((s, rank) => {
        const prev = allHits.get(s.idx);
        if (prev === undefined || rank + 1 < prev) allHits.set(s.idx, rank + 1);
      });
    }
    // Cascade-only Recall (das alte Verhalten — was ohne quantum-ground passierte).
    for (const k of Ks) {
      let hit = 0;
      for (const { idx } of expectedIdxs) {
        const r = allHits.get(idx);
        if (r !== undefined && r <= k) hit++;
      }
      perK[k] = expectedIdxs.length === 0 ? 0 : hit / expectedIdxs.length;
    }
    // Cascade + Scaffold (was quantum-ground heute tatsächlich liefert).
    for (const k of Ks) {
      let hit = 0;
      for (const { idx } of expectedIdxs) {
        // Pflicht-Atome der Anlagen sind IMMER drin (scaffold) — egal ob rank existiert.
        if (scaffoldIdxs.has(idx)) { hit++; continue; }
        const r = allHits.get(idx);
        if (r !== undefined && r <= k) hit++;
      }
      perK_withScaffold[k] = expectedIdxs.length === 0 ? 0 : hit / expectedIdxs.length;
      perK_scaffoldLift[k] = perK_withScaffold[k] - perK[k];
    }
    for (const { eCode, idx } of expectedIdxs) {
      const r = allHits.get(idx);
      const slot = missesByECode.get(eCode);
      if (slot) slot.bestRank = r ?? null;
    }
  } else {
    for (const k of Ks) { perK[k] = 0; perK_withScaffold[k] = 0; perK_scaffoldLift[k] = 0; }
  }

  // ── 2. Label-side scores: for each expected (eCode, label) pair, embed
  // `label` as a query and report the top-1 cascade score + rank of the
  // expected eCode. This drives the confidence-threshold recommendation.
  const labelQueries = expectedECodes.map((c) => fix.expected[c].label);
  const labelVecs = labelQueries.length > 0 ? await embedQueries(labelQueries, embedOpts) : [];
  const labelScores: FixtureResult['labelScores'] = [];
  for (let i = 0; i < expectedECodes.length; i++) {
    const eCode = expectedECodes[i];
    const expIdx = eCodeToIdx.get(eCode);
    const top = cascade.topK(labelVecs[i], 20);
    const rank = expIdx !== undefined ? top.findIndex((s) => s.idx === expIdx) + 1 || null : null;
    labelScores.push({
      eCode,
      label: fix.expected[eCode].label,
      top1Score: top[0]?.score ?? 0,
      inTop20: rank !== null && rank > 0,
      rank: rank && rank > 0 ? rank : null,
    });
  }

  const misses = expectedECodes
    .map((eCode) => missesByECode.get(eCode)!)
    .map((m, i) => ({ eCode: expectedECodes[i], label: m.label, bestRankObserved: m.bestRank, bestScore: m.bestScore }))
    .filter((m) => m.bestRankObserved === null || m.bestRankObserved > 50);

  return {
    file,
    dokumenttyp_id: fix.dokumenttyp_id,
    expectedECodes,
    expectedAnlagen,
    expectedPflichtCount,
    groundingRecall: { perK, perK_withScaffold, perK_scaffoldLift, misses },
    labelScores,
  };
}

async function main(): Promise<void> {
  const embedOpts: GemmaEmbedOptions = { cpuOnly: process.env.EMBED_CPU === '1' };

  console.error(`=== Quality-pipeline calibration ===`);
  console.error(`  cascade source: ${DATA}/embeddings.gemma4.cascade.json`);
  console.error(`  gold set:       ${GOLD}`);

  const handle = await loadCatalog();
  const { cascade } = await (async () => {
    const manifest: CascadeManifest = JSON.parse(
      await readFile(join(DATA, 'embeddings.gemma4.cascade.json'), 'utf-8'),
    );
    return { cascade: await QuantumCascade.loadFromManifest(DATA, manifest, 200) };
  })();
  const atoms = handle.atoms;
  const eCodeToIdx = new Map<string, number>();
  atoms.forEach((a, i) => eCodeToIdx.set(a.field_name, i));
  console.error(`  cascade:        ${cascade.describe()}`);
  console.error(`  atoms:          ${atoms.length}`);

  // Dokumenttypen-Katalog → findDokumenttyp() löst id ODER alias auf.
  // Aliase leben jetzt im Katalog selbst (dokumenttypen.json `aliases[]`).
  await loadDokumenttypen();
  const lookupAnlagen = async (typ: string): Promise<string[]> => {
    const d = await findDokumenttyp(typ);
    return d?.anlagen ?? [];
  };

  const allFiles = (await readdir(GOLD)).filter(
    (f) => f.endsWith('.json') && f !== 'calibration_report.json',
  );

  const results: FixtureResult[] = [];
  for (const f of allFiles) {
    const fix: GoldFixture = JSON.parse(await readFile(join(GOLD, f), 'utf-8'));
    const expectedAnlagen = await lookupAnlagen(fix.dokumenttyp_id);
    console.error(`\n  → ${f}  (dokumenttyp_id=${fix.dokumenttyp_id}, expected=${Object.keys(fix.expected).length}, anlagen=[${expectedAnlagen.join(',')}])`);
    const r = await runFixture(f, fix, cascade, atoms, eCodeToIdx, expectedAnlagen, embedOpts);
    results.push(r);
    for (const ls of r.labelScores) {
      const rankStr = ls.rank ? `rank=${ls.rank}` : 'NOT in top-20';
      console.error(`     ${ls.eCode}: top1=${ls.top1Score.toFixed(3)} ${rankStr}  ← "${ls.label.slice(0, 60)}"`);
    }
    const cascadeRec = Object.entries(r.groundingRecall.perK)
      .map(([k, v]) => `@${k}:${(v * 100).toFixed(0)}%`).join('  ');
    const scaffRec = Object.entries(r.groundingRecall.perK_withScaffold)
      .map(([k, v]) => `@${k}:${(v * 100).toFixed(0)}%`).join('  ');
    console.error(`     cascade-only  : ${cascadeRec}`);
    console.error(`     +scaffold     : ${scaffRec}  (Pflicht-Atome in Anlagen: ${r.expectedPflichtCount}/${r.expectedECodes.length} expected)`);
  }

  // ── Aggregate ────────────────────────────────────────────────────────
  const Ks = [10, 25, 50, 100, 200];
  const avgGroundingRecall: Record<number, number> = {};
  const avgGroundingRecall_withScaffold: Record<number, number> = {};
  const avgScaffoldLift: Record<number, number> = {};
  for (const k of Ks) {
    let sumC = 0, sumS = 0, n = 0;
    for (const r of results) {
      if (typeof r.groundingRecall.perK[k] === 'number') {
        sumC += r.groundingRecall.perK[k];
        sumS += r.groundingRecall.perK_withScaffold[k] ?? 0;
        n++;
      }
    }
    avgGroundingRecall[k] = n > 0 ? sumC / n : 0;
    avgGroundingRecall_withScaffold[k] = n > 0 ? sumS / n : 0;
    avgScaffoldLift[k] = avgGroundingRecall_withScaffold[k] - avgGroundingRecall[k];
  }

  const top1ScoresKnownGood: number[] = [];
  for (const r of results) for (const ls of r.labelScores) top1ScoresKnownGood.push(ls.top1Score);
  top1ScoresKnownGood.sort((a, b) => a - b);
  const p5 = percentile(top1ScoresKnownGood, 0.05);
  const p25 = percentile(top1ScoresKnownGood, 0.25);
  const p50 = percentile(top1ScoresKnownGood, 0.50);
  const p75 = percentile(top1ScoresKnownGood, 0.75);
  const p95 = percentile(top1ScoresKnownGood, 0.95);
  const mean = top1ScoresKnownGood.reduce((s, v) => s + v, 0) / Math.max(1, top1ScoresKnownGood.length);

  // Recommended thresholds:
  //   • unbekanntGrenze = p5 of known-good top-1. Anything below this is
  //     "weaker than the worst real label" → likely hallucinated.
  //   • konfidenzGrenze = p25. Below this is the gray zone — flag for
  //     review but don't reject outright. We leave a 20% margin below p5
  //     for the unbekanntGrenze to absorb the long left tail.
  const unbekanntGrenze = Math.max(0.05, p5 * 0.8);
  const konfidenzGrenze = Math.max(unbekanntGrenze + 0.02, p25);

  const totalExpectedECodes = results.reduce((s, r) => s + r.expectedECodes.length, 0);
  const report: CalibrationReport = {
    fixtures: results,
    summary: {
      totalFixtures: results.length,
      totalExpectedECodes,
      avgGroundingRecall,
      avgGroundingRecall_withScaffold,
      avgScaffoldLift,
      knownGoodTop1Stats: { p5, p25, p50, p75, p95, mean },
      recommendedThresholds: {
        unbekanntGrenze,
        konfidenzGrenze,
        rationale:
          `Based on top-1 cosine distribution over ${top1ScoresKnownGood.length} known-good (label, eCode) pairs: ` +
          `p5=${p5.toFixed(3)} p25=${p25.toFixed(3)} p50=${p50.toFixed(3)} p95=${p95.toFixed(3)}. ` +
          `unbekanntGrenze = max(0.05, 0.8·p5); konfidenzGrenze = max(novelty+0.02, p25).`,
      },
    },
  };

  await writeFile(join(GOLD, 'calibration_report.json'), JSON.stringify(report, null, 2) + '\n');

  console.error(`\n=== Aggregate ===`);
  console.error(`  fixtures: ${results.length}, total expected eCodes: ${totalExpectedECodes}`);
  console.error(`  avg cascade-only:        ` + Object.entries(avgGroundingRecall)
    .map(([k, v]) => `@${k}:${(v * 100).toFixed(1)}%`).join('  '));
  console.error(`  avg cascade + scaffold:  ` + Object.entries(avgGroundingRecall_withScaffold)
    .map(([k, v]) => `@${k}:${(v * 100).toFixed(1)}%`).join('  '));
  console.error(`  avg scaffold lift:       ` + Object.entries(avgScaffoldLift)
    .map(([k, v]) => `@${k}:+${(v * 100).toFixed(1)}pp`).join('  '));
  console.error(`  known-good top-1 cosine distribution:`);
  console.error(`    p5=${p5.toFixed(3)}  p25=${p25.toFixed(3)}  p50=${p50.toFixed(3)}  p75=${p75.toFixed(3)}  p95=${p95.toFixed(3)}  mean=${mean.toFixed(3)}`);
  console.error(`  recommended thresholds:`);
  console.error(`    unbekanntGrenze:    ${unbekanntGrenze.toFixed(3)}`);
  console.error(`    konfidenzGrenze: ${konfidenzGrenze.toFixed(3)}`);
  console.error(`\n  → report: ${join(GOLD, 'calibration_report.json')}`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
