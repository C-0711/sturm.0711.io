/**
 * Stage config overrides — runtime layer over workflow source code.
 *
 * Workflows are TypeScript modules and the source of truth. Overrides let the
 * OCR Studio (and other tuners) write modified stage configs without rewriting
 * code. They're stored as JSON under <root>/config-overrides/<workflowId>.json
 * and merged onto each stage's config at read/run time.
 *
 * Shape:
 *   { workflowId, updatedAt, stages: { <stageId>: <partial-config>, ... } }
 *
 * Merge semantics: shallow merge per stage (override-key wins). Deep merge
 * intentionally avoided — keeps semantics predictable.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WorkflowDef } from './types.ts';

const DIR_NAME = 'config-overrides';

export interface OverridesFile {
  workflowId: string;
  updatedAt: string;
  stages: Record<string, Record<string, unknown>>;
}

export function getOverridesDir(rootDir: string): string {
  return path.join(rootDir, DIR_NAME);
}

function fileFor(rootDir: string, workflowId: string): string {
  return path.join(getOverridesDir(rootDir), `${workflowId}.json`);
}

export async function readOverrides(rootDir: string, workflowId: string): Promise<OverridesFile | null> {
  try {
    const raw = await fs.promises.readFile(fileFor(rootDir, workflowId), 'utf8');
    return JSON.parse(raw) as OverridesFile;
  } catch {
    return null;
  }
}

export function readOverridesSync(rootDir: string, workflowId: string): OverridesFile | null {
  try {
    const raw = fs.readFileSync(fileFor(rootDir, workflowId), 'utf8');
    return JSON.parse(raw) as OverridesFile;
  } catch {
    return null;
  }
}

export async function writeStageOverride(
  rootDir: string,
  workflowId: string,
  stageId: string,
  config: Record<string, unknown>,
): Promise<OverridesFile> {
  await fs.promises.mkdir(getOverridesDir(rootDir), { recursive: true });
  const existing = (await readOverrides(rootDir, workflowId)) ?? {
    workflowId,
    updatedAt: new Date().toISOString(),
    stages: {},
  };
  existing.stages[stageId] = config;
  existing.updatedAt = new Date().toISOString();
  await fs.promises.writeFile(fileFor(rootDir, workflowId), JSON.stringify(existing, null, 2));
  return existing;
}

export async function deleteStageOverride(
  rootDir: string,
  workflowId: string,
  stageId: string,
): Promise<OverridesFile | null> {
  const existing = await readOverrides(rootDir, workflowId);
  if (!existing) return null;
  if (!(stageId in existing.stages)) return existing;
  delete existing.stages[stageId];
  existing.updatedAt = new Date().toISOString();
  if (Object.keys(existing.stages).length === 0) {
    try { await fs.promises.unlink(fileFor(rootDir, workflowId)); } catch { /* ignore */ }
    return existing;
  }
  await fs.promises.writeFile(fileFor(rootDir, workflowId), JSON.stringify(existing, null, 2));
  return existing;
}

/** Returns a NEW WorkflowDef with overrides shallow-merged onto each stage's config. */
export function applyOverrides(def: WorkflowDef, overrides: OverridesFile | null): WorkflowDef {
  if (!overrides || Object.keys(overrides.stages).length === 0) return def;
  const stages: typeof def.stages = { ...def.stages };
  for (const [stageId, override] of Object.entries(overrides.stages)) {
    const existing = stages[stageId];
    if (!existing) continue;
    stages[stageId] = {
      ...existing,
      config: { ...((existing.config as Record<string, unknown>) ?? {}), ...override },
    };
  }
  return { ...def, stages };
}
