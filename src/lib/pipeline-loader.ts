/**
 * Pipeline-Definition Loader.
 *
 * Reads `<pipelinesDir>/<id>@<version>.json` files into PipelineDefinition objects,
 * resolves a workspace's binding (workspaces/<id>/binding.json) to the chosen
 * pipeline, and falls back to a `default@v0` pipeline when none is bound.
 *
 * No domain knowledge in TS — all per-pipeline data lives declaratively in
 * `src/pipelines-seed/*.json` files. Adding a new pipeline = add a JSON file.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type PipelineNodeKind =
  | 'ingest' | 'classify' | 'route' | 'template' | 'extract' | 'approve';

export interface PipelineNode {
  id: string;
  displayName: string;
  kind: PipelineNodeKind;
  /** Optional model hint, surfaced in UI tooltips and per-step audit. */
  model?: string;
  /** Phase Simplify: optional steps are side-branches (template, extract) — they
   *  don't count toward overall pipeline progress and render gestrichelt.
   *  Core steps (ingest, classify, route, approve) are mandatory. */
  optional?: boolean;
}

/** Controlled-vocabulary triple binding a classifier label to a canonical
 *  template + folder slug + display name. UI renders displayName, filesystem
 *  routes to folderSlug, identity through pipeline = templateId. */
export interface PipelineClassification {
  templateId: string;
  folderSlug: string;
  displayName: string;
  /** Hints used at classify-time to map a raw mistral-small label to this entry.
   *  First hint that matches (case-insensitive substring) wins. */
  classificationHints?: string[];
  /** Phase Simplify: declare whether this doc-class needs a strict-schema OCR-Extract.
   *  Default false — most docs are well-served by classify.kpis. Set true for
   *  formal-submission classes (e.g. ELSTER-Hauptvordruck). UI surfaces a hint
   *  when a doc with requiresExtract=true has not been extracted yet. */
  requiresExtract?: boolean;
}

export interface PipelineCompletenessExpect {
  templateId: string;
  min: number;
  label?: string;
}

export interface PipelineCaseField {
  id: string;
  displayName: string;
  fromPath?: string;
  fromPaths?: string[];
}

export interface PipelineDefinition {
  id: string;
  version: string;
  displayName: string;
  description?: string;
  nodes: PipelineNode[];
  classifications?: PipelineClassification[];
  completeness?: { expects: PipelineCompletenessExpect[] };
  caseFields?: PipelineCaseField[];
}

export interface PipelineBinding {
  pipelineId: string;
  version: string;
  boundAt: string;
  boundBy?: string;
  overrides?: Record<string, unknown>;
}

const DEFAULT_PIPELINE_ID = 'default';
const DEFAULT_PIPELINE_VERSION = 'v0';

const PIPELINE_FILENAME_RE = /^(?<id>[a-z][a-z0-9_-]*)@(?<version>v\d+(?:\.\d+)?)\.json$/i;

export async function loadPipelines(pipelinesDir: string): Promise<PipelineDefinition[]> {
  let entries: string[];
  try { entries = await fs.readdir(pipelinesDir); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: PipelineDefinition[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const m = PIPELINE_FILENAME_RE.exec(name);
    if (!m) continue;
    try {
      const raw = await fs.readFile(path.join(pipelinesDir, name), 'utf8');
      const j = JSON.parse(raw) as PipelineDefinition;
      // Defensive: filename id/version must match payload to avoid silent drift
      if (j.id !== m.groups!.id || j.version !== m.groups!.version) continue;
      if (!Array.isArray(j.nodes) || j.nodes.length === 0) continue;
      out.push(j);
    } catch {
      /* skip malformed */
    }
  }
  return out.sort((a, b) => `${a.id}@${a.version}`.localeCompare(`${b.id}@${b.version}`));
}

/** Read a workspace's binding sidecar; returns null if absent. */
export async function getBinding(workspaceRoot: string, wsId: string): Promise<PipelineBinding | null> {
  const bp = path.join(workspaceRoot, wsId, 'binding.json');
  try {
    const raw = await fs.readFile(bp, 'utf8');
    const j = JSON.parse(raw) as PipelineBinding;
    if (!j.pipelineId || !j.version) return null;
    return j;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** Atomic-ish write of binding.json. Caller is responsible for directory existence. */
export async function setBinding(workspaceRoot: string, wsId: string, binding: PipelineBinding): Promise<void> {
  const bp = path.join(workspaceRoot, wsId, 'binding.json');
  const tmp = `${bp}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(binding, null, 2));
  await fs.rename(tmp, bp);
}

/** Remove the binding sidecar; no-op if absent. */
export async function deleteBinding(workspaceRoot: string, wsId: string): Promise<boolean> {
  const bp = path.join(workspaceRoot, wsId, 'binding.json');
  try { await fs.unlink(bp); return true; }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

/** Resolve which pipeline a workspace uses. Looks up binding, falls back to
 *  default@v0. Throws only if neither the bound pipeline nor a default exists. */
export function resolvePipeline(
  pipelines: PipelineDefinition[],
  binding: PipelineBinding | null,
): PipelineDefinition {
  const byKey = new Map<string, PipelineDefinition>();
  for (const p of pipelines) byKey.set(`${p.id}@${p.version}`, p);

  if (binding) {
    const bound = byKey.get(`${binding.pipelineId}@${binding.version}`);
    if (bound) return bound;
    // Bound pipeline missing — log via thrown sentinel; caller can choose to
    // fall back to default vs error. We return default if available.
  }
  const def = byKey.get(`${DEFAULT_PIPELINE_ID}@${DEFAULT_PIPELINE_VERSION}`);
  if (def) return def;
  // Last resort: pick first pipeline alphabetically.
  if (pipelines.length > 0) return pipelines[0];
  throw new Error(`Keine Pipeline-Definition gefunden (weder gebunden noch default).`);
}

/** Best-effort label → classification lookup. Used in Phase B for folder routing.
 *  In Phase A this is unused; kept here so the loader is the single source. */
export function classifyLabelToCanonical(
  pipeline: PipelineDefinition,
  rawLabel: string,
): PipelineClassification | null {
  if (!pipeline.classifications || !rawLabel) return null;
  const lc = rawLabel.toLowerCase();
  // Exact folderSlug match wins
  let hit = pipeline.classifications.find((c) => c.folderSlug.toLowerCase() === lc);
  if (hit) return hit;
  // Then check classificationHints (any hint substring-match in either direction)
  hit = pipeline.classifications.find((c) =>
    (c.classificationHints ?? []).some((h) => {
      const hl = h.toLowerCase();
      return lc.includes(hl) || hl.includes(lc);
    })
  );
  return hit ?? null;
}
