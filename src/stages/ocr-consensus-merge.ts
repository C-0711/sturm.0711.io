/**
 * ocr-consensus-merge — quality-first merger across multiple OCR engines.
 *
 * Input: the FanoutOutput from `compare/fanout` running mistral-ocr +
 * lighton-ocr + paddleocr-vl on the same document. Each branch produces
 * markdown text (and, for mistral-ocr, optional per-line confidence + bbox).
 *
 * Output:
 *   • A merged markdown text where each line is the best-supported variant
 *     across branches.
 *   • A `lines` array of {text, supportedBy[], confidence, alternatives[]}
 *     so downstream stages can introspect disagreements per line.
 *   • A `disagreements` array of lines where engines diverged significantly.
 *
 * Algorithm:
 *   1. Per branch, tokenize markdown into lines.
 *   2. Use EmbeddingGemma (search-query side) to embed all unique lines once.
 *   3. Cluster lines across branches by cosine similarity ≥ joinThreshold
 *      (default 0.85). Each cluster represents a single semantic line that
 *      multiple engines produced (with possible OCR differences).
 *   4. For each cluster, pick the canonical line via:
 *        a. If any variant has explicit confidence: pick highest-confidence.
 *        b. Else: pick the variant that appears in the most branches
 *           (majority text after light normalization).
 *        c. Tie-break: longest variant (preserves accents/umlauts that
 *           cheaper engines may have dropped).
 *   5. Re-order clusters by the median position of their constituent lines
 *      across branches — preserves reading order.
 *   6. Emit the canonical text and a disagreement report per cluster whose
 *      members differ by more than `disagreementCharThreshold` chars.
 *
 * Why this beats concat: when LightOn reads "Identifikationsnnummer" (typo)
 * and Mistral reads "Identifikationsnummer", they cluster together and the
 * Mistral variant wins by confidence. The downstream Layer-1 prompt sees
 * a single clean line, not 3 noisy variants.
 */
import { defineStage } from '../core/stage.ts';
import type { FanoutOutput } from './compare-fanout.ts';
import { embedQueries, type GemmaEmbedOptions } from '../lib/gemma-embed.ts';

interface BranchPage { index: number; markdown: string; confidence?: unknown }
interface BranchOutput {
  model?: string;
  text?: string;
  pages?: BranchPage[];
  /** mistral-ocr's parsed.pages has `confidence` (page-level f32) and
   *  optional `confidence_scores` (line-level when configured). */
  parsed?: {
    pages?: Array<{
      index: number;
      markdown: string;
      confidence?: number;
      confidence_scores?: unknown;
    }>;
  };
}

interface LineEntry {
  branchId: string;
  pageIndex: number;
  lineIndex: number;
  text: string;
  /** Engine-reported confidence (0..1) when available; undefined otherwise. */
  confidence?: number;
}

export interface MergedLine {
  /** Canonical text chosen for this cluster. */
  text: string;
  /** Which branches contributed a variant to this cluster. */
  supportedBy: string[];
  /** Number of distinct branches in support (1..N). */
  support: number;
  /** Highest engine-reported confidence across cluster members. */
  confidence: number | null;
  /** Other variants observed (non-canonical). */
  alternatives: Array<{ branchId: string; text: string; confidence?: number }>;
}

export interface OcrConsensusMergeOutput {
  /** Final merged markdown — joined by '\n'. */
  text: string;
  /** Per-cluster details, in reading order. */
  lines: MergedLine[];
  /** Subset of `lines` where engines disagreed meaningfully. */
  disagreements: MergedLine[];
  /** Per-branch metadata (which engines contributed how many lines). */
  branchStats: Array<{ branchId: string; lines: number; bytes: number; model?: string }>;
  ms: number;
}

export interface OcrConsensusMergeConfig {
  /** Cosine threshold for grouping lines into one cluster. Default 0.85. */
  joinThreshold?: number;
  /** Min chars after trim for a line to be considered. Default 3. */
  minLineChars?: number;
  /** A cluster is "disagreement" if (longest − shortest member length) ≥ this. */
  disagreementCharThreshold?: number;
  /** Forward to gemma-embed (cpuOnly etc.). */
  embed?: Pick<GemmaEmbedOptions, 'url' | 'model' | 'cpuOnly'>;
}

// ─── helpers ─────────────────────────────────────────────────────────────

function isFanoutOutput(x: unknown): x is FanoutOutput {
  return typeof x === 'object' && x !== null && 'branches' in x;
}

function normalize(s: string): string {
  // Light normalize for clustering only — does NOT mutate the canonical text.
  return s.replace(/\s+/g, ' ').replace(/[*_`#]+/g, '').trim().toLowerCase();
}

function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s; // EmbeddingGemma vectors are unit-norm — cosine == dot.
}

function pickCanonical(members: LineEntry[]): { canonical: string; confidence: number | null } {
  // 1. Highest-confidence variant wins if any variant has confidence.
  const withConf = members.filter((m) => typeof m.confidence === 'number');
  if (withConf.length > 0) {
    withConf.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    return { canonical: withConf[0].text, confidence: withConf[0].confidence ?? null };
  }
  // 2. Else: pick the normalized-text variant with the most branches behind it.
  const counts = new Map<string, { count: number; samples: string[] }>();
  for (const m of members) {
    const k = normalize(m.text);
    const e = counts.get(k);
    if (e) { e.count++; e.samples.push(m.text); } else counts.set(k, { count: 1, samples: [m.text] });
  }
  let best: { count: number; samples: string[] } | undefined;
  for (const v of counts.values()) {
    if (!best || v.count > best.count) best = v;
  }
  if (!best) return { canonical: members[0].text, confidence: null };
  // 3. Tie-break within same vote count: pick the longest sample (preserves
  // German accents the cheaper engines may have stripped).
  best.samples.sort((a, b) => b.length - a.length);
  return { canonical: best.samples[0], confidence: null };
}

// ─── union-find for clustering ──────────────────────────────────────────

class UF {
  parent: Int32Array;
  rank: Int32Array;
  constructor(n: number) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
    this.rank = new Int32Array(n);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return;
    if (this.rank[ra] < this.rank[rb]) this.parent[ra] = rb;
    else if (this.rank[ra] > this.rank[rb]) this.parent[rb] = ra;
    else { this.parent[rb] = ra; this.rank[ra]++; }
  }
}

// ─── stage ───────────────────────────────────────────────────────────────

export const ocrConsensusMergeStage = defineStage<
  unknown,
  OcrConsensusMergeOutput,
  OcrConsensusMergeConfig
>({
  id: 'compare/ocr-consensus-merge',
  name: 'OCR consensus merge (semantic alignment + confidence vote)',
  description:
    'Merges N OCR-branch outputs by semantically aligning lines across engines (via EmbeddingGemma), picking the highest-confidence (or most-supported) variant per aligned cluster. Produces clean markdown + per-line provenance.',
  hints: {
    inputs: 'fanout output: { branches: { branchId: { text|parsed.pages[].markdown[, confidence] } }, ... }',
    outputs: 'text (merged markdown), lines (per-cluster), disagreements, branchStats, ms',
    configExample: JSON.stringify(
      { joinThreshold: 0.85, minLineChars: 3, disagreementCharThreshold: 6, embed: { cpuOnly: true } },
      null,
      2,
    ),
    inputPorts: [{ name: 'fanout', type: 'branches', description: 'compare/fanout output' }],
    outputPorts: [
      { name: 'text', type: 'text' },
      { name: 'lines', type: 'json' },
      { name: 'disagreements', type: 'json' },
    ],
  },

  async run(input, ctx) {
    const cfg = ctx.config ?? {};
    const joinThreshold = cfg.joinThreshold ?? 0.85;
    const minLineChars = cfg.minLineChars ?? 3;
    const disagreementCharThreshold = cfg.disagreementCharThreshold ?? 6;
    const embedOpts: GemmaEmbedOptions = { ...(cfg.embed ?? {}), signal: ctx.signal };

    if (!isFanoutOutput(input)) {
      throw new Error('compare/ocr-consensus-merge: expected compare/fanout output, got ' + typeof input);
    }
    const t0 = Date.now();

    // Pull lines out of each branch.
    const allLines: LineEntry[] = [];
    const branchStats: OcrConsensusMergeOutput['branchStats'] = [];
    for (const [branchId, raw] of Object.entries(input.branches)) {
      const out = raw as BranchOutput;
      const pages =
        out.parsed?.pages
          ? out.parsed.pages.map((p) => ({
              index: p.index,
              markdown: p.markdown ?? '',
              confidence: p.confidence,
            }))
          : (out.pages ?? []).map((p) => ({
              index: p.index,
              markdown: p.markdown ?? '',
              confidence: typeof (p as { confidence?: unknown }).confidence === 'number'
                ? ((p as { confidence?: number }).confidence)
                : undefined,
            }));
      let bytes = 0;
      let lineCount = 0;
      for (const p of pages) {
        const rawLines = p.markdown.split(/\r?\n/);
        rawLines.forEach((line, li) => {
          const t = line.trim();
          if (t.length < minLineChars) return;
          allLines.push({
            branchId,
            pageIndex: p.index,
            lineIndex: li,
            text: t,
            confidence: typeof p.confidence === 'number' ? p.confidence : undefined,
          });
          bytes += t.length;
          lineCount++;
        });
      }
      branchStats.push({ branchId, lines: lineCount, bytes, model: out.model });
    }

    ctx.emit('ocr_merge_lines_collected', {
      total: allLines.length,
      perBranch: Object.fromEntries(branchStats.map((s) => [s.branchId, s.lines])),
    });

    if (allLines.length === 0) {
      return {
        text: '',
        lines: [],
        disagreements: [],
        branchStats,
        ms: Date.now() - t0,
      };
    }

    // Embed all unique line texts (dedupe to cap embed cost).
    const uniqMap = new Map<string, number>(); // text → index in uniqTexts
    const uniqTexts: string[] = [];
    for (const l of allLines) {
      if (!uniqMap.has(l.text)) {
        uniqMap.set(l.text, uniqTexts.length);
        uniqTexts.push(l.text);
      }
    }
    const embeddings = await embedQueries(uniqTexts, embedOpts);
    const embOf = (text: string): Float32Array => embeddings[uniqMap.get(text)!];

    // Cluster via union-find: for each pair (i, j) with cosine ≥ threshold,
    // merge their components. n² is fine for typical document sizes
    // (< 1000 lines/branch × 3 branches = < 3000 entries).
    const uf = new UF(allLines.length);
    for (let i = 0; i < allLines.length; i++) {
      const ei = embOf(allLines[i].text);
      for (let j = i + 1; j < allLines.length; j++) {
        // Don't merge two lines from the same branch (each branch's own
        // lines are assumed distinct rows — clustering same-branch lines
        // would collapse separate document rows into one).
        if (allLines[i].branchId === allLines[j].branchId) continue;
        const sim = cosine(ei, embOf(allLines[j].text));
        if (sim >= joinThreshold) uf.union(i, j);
      }
    }

    // Build clusters.
    const clusters = new Map<number, number[]>();
    for (let i = 0; i < allLines.length; i++) {
      const r = uf.find(i);
      const e = clusters.get(r);
      if (e) e.push(i); else clusters.set(r, [i]);
    }

    // Per cluster: pick canonical + record alternatives, compute reading-order
    // anchor as median lineIndex within the most-represented page.
    interface ClusterInfo {
      orderAnchor: number; // tuple-encoded as a single number for sort: pageIndex * 1e6 + medianLineIndex
      merged: MergedLine;
    }
    const cluster_infos: ClusterInfo[] = [];
    for (const indices of clusters.values()) {
      const members = indices.map((i) => allLines[i]);
      const { canonical, confidence } = pickCanonical(members);
      const branchSet = new Set(members.map((m) => m.branchId));
      const alternatives = members
        .filter((m) => m.text !== canonical)
        .map((m) => ({ branchId: m.branchId, text: m.text, confidence: m.confidence }));
      const pageHist = new Map<number, number[]>();
      for (const m of members) {
        const e = pageHist.get(m.pageIndex);
        if (e) e.push(m.lineIndex); else pageHist.set(m.pageIndex, [m.lineIndex]);
      }
      let topPage = -1, topCount = -1, topMedian = 0;
      for (const [page, idxs] of pageHist.entries()) {
        if (idxs.length > topCount) {
          topCount = idxs.length;
          topPage = page;
          const sorted = [...idxs].sort((a, b) => a - b);
          topMedian = sorted[(sorted.length - 1) >> 1];
        }
      }
      cluster_infos.push({
        orderAnchor: topPage * 1_000_000 + topMedian,
        merged: {
          text: canonical,
          supportedBy: Array.from(branchSet).sort(),
          support: branchSet.size,
          confidence,
          alternatives,
        },
      });
    }
    cluster_infos.sort((a, b) => a.orderAnchor - b.orderAnchor);

    const lines = cluster_infos.map((c) => c.merged);
    const disagreements = lines.filter((l) => {
      if (l.alternatives.length === 0) return false;
      const allLengths = [l.text.length, ...l.alternatives.map((a) => a.text.length)];
      return Math.max(...allLengths) - Math.min(...allLengths) >= disagreementCharThreshold;
    });
    const text = lines.map((l) => l.text).join('\n');

    ctx.emit('ocr_merge_done', {
      clusters: lines.length,
      disagreements: disagreements.length,
      branches: branchStats.length,
    });
    await ctx.artifacts.write('ocr_merged.md', text);
    await ctx.artifacts.write('ocr_merge_report.json', { lines, disagreements, branchStats });

    return { text, lines, disagreements, branchStats, ms: Date.now() - t0 };
  },
});
