/**
 * Workflow-Stats-Aggregator. Liest die letzten N _result.json eines Workflows
 * und rechnet pro Stage:
 *   • avgMs / p95Ms / samples
 *   • avgOutputSize  — heuristisch pro Stage-Type (sehe `outputSizeOf`)
 *   • errorRate
 * Sowie pro Workflow:
 *   • avgMs / runs / successRate
 *   • dropOff  — zwischen aufeinanderfolgenden Stages: avgOutputSize_after / avgOutputSize_before
 *
 * Heuristik bewusst dumm gehalten: wir kennen die Workflow-spezifischen
 * Output-Shapes nicht zur Compile-Time. Stattdessen erkennen wir bekannte
 * Felder (text, per_anlage, canonical_layer, totalFilled, …) und fallen
 * sonst auf "keys count" zurück.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface StageStats {
  stageId: string;
  samples: number;
  errorRate: number;          // 0..1
  avgMs: number | null;
  p95Ms: number | null;
  avgOutputSize: number | null;
  outputSizeUnit: string | null;  // "chars", "items", "ecodes", "filled", "anlagen", "objects"
}

export interface WorkflowStats {
  workflowId: string;
  runs: number;
  successRate: number;        // 0..1
  avgMs: number | null;
  p95Ms: number | null;
  lastRunAt: string | null;
  stages: StageStats[];
}

interface RawStage {
  stageId?: string;
  state?: string;
  ms?: number;
  output?: unknown;
  error?: unknown;
}

interface RawResult {
  state?: string;
  ms?: number;
  finishedAt?: string;
  stages?: Record<string, RawStage>;
}

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx];
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Heuristische Output-Größe einer Stage. Bekannte Felder werden bevorzugt,
 *  Fallback ist die Tiefen-1 keys-Count. Null wenn Output kein Object ist. */
function outputSizeOf(output: unknown): { size: number; unit: string } | null {
  if (output === null || output === undefined) return null;
  if (typeof output !== 'object') return null;
  const o = output as Record<string, unknown>;

  // OCR-text
  if (typeof o.text === 'string') return { size: o.text.length, unit: 'chars' };
  // Klassifizierung
  if (Array.isArray((o as { erkannte_anlagen?: unknown }).erkannte_anlagen)) {
    return { size: (o.erkannte_anlagen as unknown[]).length, unit: 'anlagen' };
  }
  // Quantum-Ground
  if (Array.isArray((o as { kandidatenECodes?: unknown }).kandidatenECodes)) {
    return { size: (o.kandidatenECodes as unknown[]).length, unit: 'ecodes' };
  }
  // Phase 3 LLM Fill
  if (typeof (o as { totalFilled?: unknown }).totalFilled === 'number') {
    return { size: o.totalFilled as number, unit: 'filled' };
  }
  // Phase 5 Merge (canonical_layer)
  const cl = (o as { canonical_layer?: unknown }).canonical_layer;
  if (cl && typeof cl === 'object') {
    return { size: Object.keys(cl as Record<string, unknown>).length, unit: 'ecodes' };
  }
  // Felder-Katalog / Felder-Narrow (per_anlage map)
  const pa = (o as { per_anlage?: unknown }).per_anlage;
  if (pa && typeof pa === 'object') {
    let total = 0;
    for (const v of Object.values(pa as Record<string, unknown>)) {
      if (v && typeof v === 'object') {
        const felder = (v as { felder?: unknown[] }).felder;
        if (Array.isArray(felder)) total += felder.length;
        // Phase-1: regex_hits + missing
        const regexHits = (v as { regex_hits?: Record<string, unknown> }).regex_hits;
        if (regexHits && typeof regexHits === 'object') total += Object.keys(regexHits).length;
        // Phase-3: llm_hits
        const llmHits = (v as { llm_hits?: Record<string, unknown> }).llm_hits;
        if (llmHits && typeof llmHits === 'object') total += Object.keys(llmHits).length;
      }
    }
    if (total > 0) return { size: total, unit: 'ecodes' };
  }
  // Fallback: keys count
  const k = Object.keys(o).length;
  return k > 0 ? { size: k, unit: 'objects' } : null;
}

export async function computeWorkflowStats(
  runsDir: string,
  workflowId: string,
  opts: { maxRuns?: number } = {},
): Promise<WorkflowStats> {
  if (!SAFE_NAME.test(workflowId)) {
    return { workflowId, runs: 0, successRate: 0, avgMs: null, p95Ms: null, lastRunAt: null, stages: [] };
  }
  const dir = path.join(runsDir, workflowId);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return { workflowId, runs: 0, successRate: 0, avgMs: null, p95Ms: null, lastRunAt: null, stages: [] };
  }

  // Letzte N Runs nach mtime
  const maxRuns = opts.maxRuns ?? 50;
  const stats: Array<{ name: string; mtime: number }> = [];
  for (const name of entries) {
    if (!SAFE_NAME.test(name)) continue;
    try {
      const st = await fs.stat(path.join(dir, name));
      if (st.isDirectory()) stats.push({ name, mtime: st.mtimeMs });
    } catch { /* ignore */ }
  }
  stats.sort((a, b) => b.mtime - a.mtime);
  const recent = stats.slice(0, maxRuns);

  const workflowMs: number[] = [];
  const stageSamples = new Map<string, { ms: number[]; errors: number; sizes: number[]; unit: string | null }>();
  let okRuns = 0;
  let lastRunAt: string | null = null;

  for (const r of recent) {
    let parsed: RawResult;
    try {
      const raw = await fs.readFile(path.join(dir, r.name, '_result.json'), 'utf8');
      parsed = JSON.parse(raw) as RawResult;
    } catch {
      continue;
    }
    if (typeof parsed.ms === 'number') workflowMs.push(parsed.ms);
    if (parsed.state === 'ok') okRuns++;
    if (parsed.finishedAt && (!lastRunAt || parsed.finishedAt > lastRunAt)) {
      lastRunAt = parsed.finishedAt;
    }
    const stages = parsed.stages ?? {};
    for (const [stageId, rs] of Object.entries(stages)) {
      let acc = stageSamples.get(stageId);
      if (!acc) {
        acc = { ms: [], errors: 0, sizes: [], unit: null };
        stageSamples.set(stageId, acc);
      }
      if (typeof rs.ms === 'number') acc.ms.push(rs.ms);
      if (rs.state === 'error') acc.errors++;
      const sz = outputSizeOf(rs.output);
      if (sz) {
        acc.sizes.push(sz.size);
        // Unit "lock-in" — erstes nicht-objects-Reading gewinnt
        if (acc.unit === null || (acc.unit === 'objects' && sz.unit !== 'objects')) {
          acc.unit = sz.unit;
        }
      }
    }
  }

  const stageRows: StageStats[] = [];
  for (const [stageId, acc] of stageSamples) {
    const total = acc.ms.length + acc.errors;
    stageRows.push({
      stageId,
      samples: total,
      errorRate: total > 0 ? acc.errors / total : 0,
      avgMs: avg(acc.ms),
      p95Ms: p95(acc.ms),
      avgOutputSize: avg(acc.sizes),
      outputSizeUnit: acc.unit,
    });
  }

  return {
    workflowId,
    runs: recent.length,
    successRate: recent.length > 0 ? okRuns / recent.length : 0,
    avgMs: avg(workflowMs),
    p95Ms: p95(workflowMs),
    lastRunAt,
    stages: stageRows,
  };
}
