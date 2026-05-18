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

/** Compute the aggregated state for a case and persist as master.json.
 *
 *  Self-healing race fix: when the upload handler calls writeCaseMaster
 *  immediately after `await run.result`, the runner's stage outputs
 *  (phase6BmfRechner/output.json, phase5Merge/output.json) may still be
 *  flushing to disk. The first aggregateCase pass then reads empty files
 *  and returns merged_layer={}. We detect that — at least one inst.run is
 *  state=ok but no layers loaded — and retry after a short delay.
 *  Eliminates the "0 fields" master we observed on the v6 production run.
 */
export async function writeCaseMaster(
  inst: ApplicationInstance,
  opts: CaseMasterOptions,
): Promise<CaseMasterResult> {
  const { aggregateCase } = await import('./aggregation.ts');
  let agg = await aggregateCase(inst, {
    runsDir: opts.runsDir,
    extractionWorkflowId: opts.extractionWorkflowId,
  });
  // Retry guard: empty merged_layer but ≥1 ok-state run → wahrscheinlich
  // Stage-Output-Flush-Race (writeCaseMaster lief bevor phase5Merge oder
  // phase7Validator JSON auf Disk geschrieben war). Mehrfach mit Backoff.
  let attempt = 0;
  while (Object.keys(agg.merged_layer).length === 0 && (inst.runs?.length ?? 0) > 0 && attempt < 4) {
    const anyOk = agg.documents?.some((d) => d.state === 'ok' || d.state === 'partial');
    if (!anyOk) break;
    attempt++;
    await new Promise((r) => setTimeout(r, 500 * attempt));
    agg = await aggregateCase(inst, {
      runsDir: opts.runsDir,
      extractionWorkflowId: opts.extractionWorkflowId,
    });
  }
  // Wenn IMMER NOCH leer obwohl runs existieren → master NICHT überschreiben,
  // sondern existierende (möglicherweise teilbefüllte) master.json behalten.
  // Verhindert dass per-doc Race die UI auf 0 setzt.
  if (Object.keys(agg.merged_layer).length === 0 && (inst.runs?.length ?? 0) > 0) {
    const existingPath = path.join(opts.workspaceBase, inst.workspacePath, 'master.json');
    try {
      const existingRaw = await fs.readFile(existingPath, 'utf-8');
      const existing = JSON.parse(existingRaw) as { merged_layer?: Record<string, unknown> };
      if (existing.merged_layer && Object.keys(existing.merged_layer).length > 0) {
        return { path: existingPath, master: existing as Record<string, unknown> };
      }
    } catch { /* no existing master, continue and write empty */ }
  }

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
              origin: (v as { origin?: string }).origin,
            },
          ]),
        ),
      );
      const client = new BmfMcpClient({ timeoutMs: 15_000 });
      bmf = await client.berechneVollstaendigeSteuerV2({
        erklaerungsjahr: inst.veranlagungsjahr ?? 2024,
        elster_felder: felder,
      });
      // Falls BMF berechnete eCodes liefert (zvE, ESt, Soli, Erstattung),
      // wieder ins merged_layer mergen — damit der eric_xml die berechneten
      // Felder mit-enthält, nicht nur die deklarierten Eingaben.
      const bmfErgebnis = bmf as { daten?: { berechnungsdetails?: { rechenschritte?: Array<{ ecode?: string; wert?: number | string }> } } };
      const rechenschritte = bmfErgebnis?.daten?.berechnungsdetails?.rechenschritte ?? [];
      for (const rs of rechenschritte) {
        if (!rs?.ecode || rs.wert == null || agg.merged_layer[rs.ecode]) continue;
        agg.merged_layer[rs.ecode] = {
          eCode: rs.ecode,
          value: String(rs.wert),
          normalized: String(rs.wert),
          normalizedNumber: typeof rs.wert === 'number' ? rs.wert : Number(rs.wert) || undefined,
          datentyp: 'currency',
          origin: 'BMF_RECHNER',
          trust: 'high',
          anlage: 'BMF',
          drucktext: '',
          vordruckzeile: '',
          confirmed_by: [],
        } as never;
      }
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

  // Case-weite ERiC-XML aus dem aggregierten + BMF-erweiterten merged_layer.
  // Bisher wurde xml_payload nur pro per-Dokument-Run gebaut → master.eric_xml
  // war leer. Jetzt sortiert nach Anlage + vordruckzeile + eCode (deterministisch).
  let eric_xml = '';
  if (Object.keys(agg.merged_layer).length > 0) {
    try {
      const { buildEricXml } = await import('../verticals/elster-v3/stages/phase5-merge.ts');
      eric_xml = buildEricXml(agg.merged_layer as never);
    } catch (err) {
      console.error('[case-master] buildEricXml failed:', (err as Error).message);
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
      indikation: d.indikation ?? null,
    })),
    merged_layer: agg.merged_layer,
    conflicts: agg.conflicts,
    pflicht_coverage: agg.pflicht_coverage,
    pflicht_missing: agg.pflicht_missing,
    stats: agg.stats,
    bmf,
    eric_xml,
  };

  // Cross-Document Reasoning via Gemma-4 — läuft EINMAL pro Master-Refresh,
  // NICHT pro Doc. Liefert Warnings + Year-Carry-over-Entscheidungen +
  // Person-A/B-Zuordnung + Konsistenz-Checks. Non-blocking: bei Fehler
  // bleibt cross_doc_audit als leeres Result mit reason im master.
  try {
    const { runCrossDocAudit } = await import('./cross-doc-audit.ts');
    const audit = await runCrossDocAudit(master as never);
    (master as { cross_doc_audit?: unknown }).cross_doc_audit = audit;
  } catch (err) {
    (master as { cross_doc_audit?: unknown }).cross_doc_audit = {
      ran: false, reason: (err as Error).message, warnings: [], summary: '',
    };
  }

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
