/**
 * case-master — persist the case-level aggregated state to disk as a
 * single source of truth ("master.json").
 *
 * Written:
 *   - after each per-doc run completes (upload + upload-bulk handlers)
 *   - on demand via GET /api/applications/.../master?refresh=1
 *
 * Schema:
 *   {
 *     caseId, appId, mandantId, jahr,
 *     updatedAt,
 *     sources: [{ runId, filename, sha256, anlagen, fieldsExtracted }],
 *     merged_layer: Record<eCode, MergedField>,   // P1 citations on each entry
 *     conflicts: ConflictEntry[],
 *     pflicht_coverage: { ... },
 *     pflicht_missing: [...],
 *     bmf?: { erfolg, daten }                    // optional, present when BMF MCP reachable
 *   }
 *
 * Pure-ish: I/O via fs + dynamic-imports for aggregateCase and BmfMcpClient
 * to keep startup graph small. No side effects beyond the file write.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ApplicationInstance } from './applications.ts';
import { deriveSteuerjahrFromRuns } from './derive-steuerjahr.ts';

export interface CaseMasterOptions {
  runsDir: string;
  extractionWorkflowId: string;
  /** If true, also POST to BMF Lane-1 MCP with the merged layer and embed
   *  the result. Default true. Failures are caught and stored as
   *  bmf:{erfolg:false}. */
  computeBmf?: boolean;
  /** Absolute base path for resolving inst.workspacePath. Typically
   *  process.cwd() — passed in so tests can redirect. */
  workspaceBase: string;
}

export interface CaseMasterResult {
  /** Absolute path the master.json was written to. */
  path: string;
  /** The serialized master object. */
  master: Record<string, unknown>;
}

/** Compute the aggregated state for a case and persist as master.json. */
export async function writeCaseMaster(
  inst: ApplicationInstance,
  opts: CaseMasterOptions,
): Promise<CaseMasterResult> {
  const { aggregateCase } = await import('./aggregation.ts');
  const agg = await aggregateCase(inst, {
    runsDir: opts.runsDir,
    extractionWorkflowId: opts.extractionWorkflowId,
  });

  // Optional BMF re-compute over the merged layer.
  let bmf: unknown = null;
  if ((opts.computeBmf ?? true) && Object.keys(agg.merged_layer).length > 0) {
    try {
      const { BmfMcpClient, canonicalLayerToElsterFelder } =
        await import('../lib/bmf-mcp-client.ts');
      const felder = canonicalLayerToElsterFelder(
        Object.fromEntries(
          Object.entries(agg.merged_layer).map(([k, v]) => [
            k,
            {
              value: v.value,
              normalized: v.normalized,
              normalizedNumber: (v as { normalizedNumber?: number }).normalizedNumber,
              datentyp: (v.datentyp as 'string' | 'date' | 'currency') ?? 'string',
              trust: (v as { trust?: 'high' | 'medium' | 'low' | 'suspicious' }).trust,
            },
          ]),
        ),
      );
      const client = new BmfMcpClient({ timeoutMs: 15_000 });
      const erklaerungsjahr =
        inst.veranlagungsjahr ??
        (await deriveSteuerjahrFromRuns(opts.runsDir, opts.extractionWorkflowId, inst.runs)) ??
        new Date().getFullYear() - 1;
      bmf = await client.berechneVollstaendigeSteuerV2({
        erklaerungsjahr,
        elster_felder: felder,
      });
    } catch (err) {
      const e = err as Error & { cause?: unknown };
      const cause = e.cause instanceof Error ? e.cause.message : e.cause;
      bmf = {
        erfolg: false,
        reason: 'mcp-error',
        message: e.message,
        cause: cause ?? null,
      };
    }
  }

  const master: Record<string, unknown> = {
    schemaVersion: 1,
    caseId: inst.caseId,
    appId: inst.appId,
    mandantId: inst.mandantId,
    displayName: inst.displayName,
    jahr: inst.veranlagungsjahr ?? null,
    updatedAt: new Date().toISOString(),
    documents: (inst.documents ?? []).map((d) => ({
      runId: d.runId,
      filename: d.filename,
      sha256: d.sha256,
      anlagen: d.anlagen ?? [],
      fieldsExtracted: d.fieldsExtracted ?? null,
      uploadedAt: d.uploadedAt,
    })),
    merged_layer: agg.merged_layer,
    conflicts: agg.conflicts,
    pflicht_coverage: agg.pflicht_coverage,
    pflicht_missing: agg.pflicht_missing,
    stats: agg.stats,
    bmf,
  };

  const masterPath = path.join(opts.workspaceBase, inst.workspacePath, 'master.json');
  await fs.mkdir(path.dirname(masterPath), { recursive: true });
  await fs.writeFile(masterPath, JSON.stringify(master, null, 2));
  return { path: masterPath, master };
}

/** Read the persisted master.json (returns null if missing / unreadable). */
export async function readCaseMaster(
  inst: ApplicationInstance,
  workspaceBase: string,
): Promise<Record<string, unknown> | null> {
  const masterPath = path.join(workspaceBase, inst.workspacePath, 'master.json');
  try {
    const raw = await fs.readFile(masterPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
