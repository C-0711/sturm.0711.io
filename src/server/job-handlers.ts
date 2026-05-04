/**
 * Job handlers — wrap existing operations (reclassify, extract, audit) so
 * they can run as background jobs with persistent event logs.
 *
 * Handlers receive a JobContext from JobRunner with emit() and bumpProgress().
 * They call the existing functionality (factored where needed) and translate
 * intermediate states into job events.
 *
 * Phase C scope: only the "batch" handler is fully wired here — it iterates
 * over docUuids and dispatches to per-doc helpers via fetch loopback. This
 * keeps the migration small (no refactor of existing route handlers) while
 * giving us bulk operations from day one.
 */

import type { JobRunner } from '../lib/job-runner.ts';
import type { JobContext, JobInputs } from '../lib/job-types.ts';

interface RegisterOpts {
  /** Base URL for self-loopback, e.g. http://localhost:7800. Used by handlers
   *  that re-invoke existing HTTP endpoints. */
  selfBaseUrl: string;
  /** Auth token (Bearer) for self-loopback. Empty string when no auth required. */
  selfAuthToken?: string;
  /** Filesystem root for direct webhook + meta access (Phase D + H). */
  workspacesDir?: string;
}

export function registerJobHandlers(runner: JobRunner, opts: RegisterOpts): void {
  runner.registerHandler('reclassify', (ctx) => handleSimpleStep(ctx, 'reclassify', opts));
  runner.registerHandler('extract',    (ctx) => handleSimpleStep(ctx, 'extract', opts));
  runner.registerHandler('audit',      (ctx) => handleSimpleStep(ctx, 'audit', opts));
  runner.registerHandler('batch',      (ctx) => handleBatch(ctx, opts));
  runner.registerHandler('import-cb-chat-case', (ctx) => handleImportCbChatCase(ctx, opts));
  runner.registerHandler('citations', (ctx) => handleCitations(ctx, opts));
}

/** Single-doc step (or first-doc-of-list) — calls the existing endpoint and
 *  streams its SSE events into the job event log. */
async function handleSimpleStep(ctx: JobContext, step: 'reclassify' | 'extract' | 'audit', opts: RegisterOpts): Promise<unknown> {
  const wsId = ctx.job.workspaceId;
  const uuids = ctx.job.inputs.docUuids ?? [];
  if (uuids.length === 0) throw new Error(`${step}: inputs.docUuids must be non-empty`);
  const results: Array<{ uuid: string; ok: boolean; result?: unknown; error?: string }> = [];
  await ctx.bumpProgress(0, uuids.length);
  for (let i = 0; i < uuids.length; i++) {
    if (ctx.cancelRequested()) {
      await ctx.emit('cancelled_partial', { processed: i, total: uuids.length });
      break;
    }
    const uuid = uuids[i];
    await ctx.emit('doc_started', { uuid, step });
    try {
      const result = await runStepOnDoc(opts, wsId, uuid, step, ctx.job.inputs);
      results.push({ uuid, ok: true, result });
      await ctx.emit('doc_done', { uuid, step, result });
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      results.push({ uuid, ok: false, error: msg });
      await ctx.emit('doc_failed', { uuid, step, error: msg });
    }
    await ctx.bumpProgress(i + 1, uuids.length);
  }
  return { processed: results.length, results };
}

/** Batch handler: iterates docUuids and applies inputs.step to each. */
async function handleBatch(ctx: JobContext, opts: RegisterOpts): Promise<unknown> {
  const step = ctx.job.inputs.step;
  if (!step || !['reclassify', 'extract', 'audit'].includes(step)) {
    throw new Error(`batch: inputs.step must be one of reclassify|extract|audit`);
  }
  return handleSimpleStep(ctx, step as 'reclassify' | 'extract' | 'audit', opts);
}

async function runStepOnDoc(opts: RegisterOpts, wsId: string, uuid: string, step: 'reclassify' | 'extract' | 'audit', inputs: JobInputs): Promise<unknown> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.selfAuthToken) headers['Authorization'] = `Bearer ${opts.selfAuthToken}`;

  const url = `${opts.selfBaseUrl}/api/workspaces/${encodeURIComponent(wsId)}/documents/${encodeURIComponent(uuid)}/${step}`;
  const body = step === 'audit'
    ? { kind: inputs.auditKind ?? 'consistency' }
    : {};

  const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`${step} HTTP ${resp.status}: ${txt.slice(0, 200)}`);
  }
  // SSE-streaming endpoints (extract, audit) return text/event-stream; we
  // consume the whole stream and extract the terminal "done" event payload.
  const ct = resp.headers.get('content-type') ?? '';
  if (ct.includes('text/event-stream')) {
    const text = await resp.text();
    return parseSseTerminal(text);
  }
  return await resp.json();
}

/** Import all documents from a cb-chat Fall (case) into the workspace.
 *  Workspace must already exist (created by the endpoint before enqueueing).
 *  cbChatCookie is held only in the job sidecar's inputs (purged when job
 *  is GCed after 30 days). Nothing else persists the credential. */
async function handleImportCbChatCase(ctx: JobContext, opts: RegisterOpts): Promise<unknown> {
  const fallId = ctx.job.inputs.cbChatFallId;
  const cookie = ctx.job.inputs.cbChatCookie;
  const baseUrl = (ctx.job.inputs.cbChatBaseUrl as string | undefined) ?? 'https://cb-chat.0711.io';
  if (!fallId || !cookie) throw new Error('import-cb-chat-case: cbChatFallId and cbChatCookie required');

  const { listCaseDocuments, dedupeByCtaxId, downloadDocument } = await import('../lib/cb-chat-client.ts');
  await ctx.emit('cb_chat_list_started', { fallId, baseUrl });
  const rowsRaw = await listCaseDocuments(fallId, { cookie, baseUrl });
  const rows = dedupeByCtaxId(rowsRaw);
  await ctx.emit('cb_chat_list_done', { rawCount: rowsRaw.length, uniqueCount: rows.length });
  await ctx.bumpProgress(0, rows.length);

  const wsId = ctx.job.workspaceId;
  const results: Array<{ ctaxId: string; filename: string; ok: boolean; sturmUuid?: string; error?: string }> = [];
  for (let i = 0; i < rows.length; i++) {
    if (ctx.cancelRequested()) {
      await ctx.emit('cancelled_partial', { processed: i, total: rows.length });
      break;
    }
    const row = rows[i];
    await ctx.emit('doc_started', { ctaxId: row.ctax_document_id, filename: row.filename, idx: i });
    try {
      const { buffer, mimeType } = await downloadDocument(row.ctax_document_id, { cookie, baseUrl });
      // Multipart-upload to STURM's own /:ws/upload (Tier-2 loopback) — gives us
      // the full ingest+classify+route pipeline including Phase A/B routing.
      const formData = new FormData();
      const blob = new Blob([buffer], { type: row.mime_type ?? mimeType });
      formData.append('file', blob, row.filename);
      const headers: Record<string, string> = {};
      if (opts.selfAuthToken) headers['Authorization'] = `Bearer ${opts.selfAuthToken}`;
      const resp = await fetch(`${opts.selfBaseUrl}/api/workspaces/${encodeURIComponent(wsId)}/upload`, {
        method: 'POST', headers, body: formData,
      });
      if (!resp.ok) throw new Error(`STURM upload HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      // Parse SSE to find the assigned uuid
      const sseText = await resp.text();
      let sturmUuid: string | undefined;
      for (const block of sseText.split('\n\n')) {
        const m = block.match(/^event:\s*ingested\s*\ndata:\s*(\{.*\})/);
        if (m) {
          try { sturmUuid = (JSON.parse(m[1]) as { uuid?: string }).uuid; } catch { /* skip */ }
          break;
        }
      }
      results.push({ ctaxId: row.ctax_document_id, filename: row.filename, ok: true, sturmUuid });
      await ctx.emit('doc_done', { ctaxId: row.ctax_document_id, filename: row.filename, sturmUuid, bytes: buffer.length });
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      results.push({ ctaxId: row.ctax_document_id, filename: row.filename, ok: false, error: msg });
      await ctx.emit('doc_failed', { ctaxId: row.ctax_document_id, filename: row.filename, error: msg });
    }
    await ctx.bumpProgress(i + 1, rows.length);
  }
  return {
    fallId,
    rawCount: rowsRaw.length,
    uniqueCount: rows.length,
    imported: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

/** Citation pass: für jeden Doc in inputs.docUuids → falls kein OCR-Text vorhanden,
 *  triggere visual-audit (lazy OCR), dann findCitation pro KPI, persistiere
 *  citations zurück in meta.classification.kpis[].citation.
 *
 *  Lookback per HTTP loopback statt direkter fs-Mutation, damit existing webhook
 *  emission bei classify-Mutationen nicht doppelt feuert. */
async function handleCitations(ctx: JobContext, opts: RegisterOpts): Promise<unknown> {
  const wsId = ctx.job.workspaceId;
  const uuids = ctx.job.inputs.docUuids ?? [];
  if (uuids.length === 0) throw new Error('citations: docUuids must be non-empty');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.selfAuthToken) headers['Authorization'] = `Bearer ${opts.selfAuthToken}`;

  const { findAllCitations, citationCoverage } = await import('../lib/citation-finder.ts');
  const results: Array<{ uuid: string; ok: boolean; coverage?: ReturnType<typeof citationCoverage>; error?: string }> = [];
  await ctx.bumpProgress(0, uuids.length);

  for (let i = 0; i < uuids.length; i++) {
    if (ctx.cancelRequested()) {
      await ctx.emit('cancelled_partial', { processed: i, total: uuids.length });
      break;
    }
    const uuid = uuids[i];
    await ctx.emit('doc_started', { uuid });
    try {
      // 1. Read meta
      let meta = await fetch(`${opts.selfBaseUrl}/api/workspaces/${encodeURIComponent(wsId)}/documents/${encodeURIComponent(uuid)}`, { headers })
        .then((r) => r.json()) as { classification?: { kpis?: Array<{ key: string; value: string }> }; extraction?: { markdown?: string; pagesMarkdown?: string[] } };

      // 2. Lazy-OCR if needed: trigger visual-audit which fetches OCR text without a schema
      const hasOcr = !!(meta.extraction?.markdown || (meta.extraction?.pagesMarkdown && meta.extraction.pagesMarkdown.length > 0));
      if (!hasOcr) {
        await ctx.emit('ocr_started', { uuid });
        await fetch(`${opts.selfBaseUrl}/api/workspaces/${encodeURIComponent(wsId)}/documents/${encodeURIComponent(uuid)}/audit`, {
          method: 'POST', headers, body: JSON.stringify({ kind: 'visual' }),
        }).then((r) => r.text()); // SSE - we just need it to complete
        // Re-read meta with the new OCR data
        meta = await fetch(`${opts.selfBaseUrl}/api/workspaces/${encodeURIComponent(wsId)}/documents/${encodeURIComponent(uuid)}`, { headers })
          .then((r) => r.json()) as typeof meta;
        await ctx.emit('ocr_done', { uuid });
      }

      const kpis = meta.classification?.kpis ?? [];
      if (kpis.length === 0) {
        results.push({ uuid, ok: true, coverage: citationCoverage([]) });
        await ctx.emit('doc_done', { uuid, coverage: citationCoverage([]) });
        await ctx.bumpProgress(i + 1, uuids.length);
        continue;
      }

      // 3. Find citations for all KPIs
      const cits = findAllCitations(kpis, { markdown: meta.extraction?.markdown, pagesMarkdown: meta.extraction?.pagesMarkdown });
      const updatedKpis = kpis.map((k, idx) => ({ ...k, citation: cits[idx].citation }));
      const coverage = citationCoverage(updatedKpis);

      // 4. Persist via PATCH (preserves history + emits proper webhook events)
      // We patch classification.kpis directly since PATCH supports partial updates.
      const patch = { classification: { ...meta.classification, kpis: updatedKpis }, source: 'api', summary: `citations: ${coverage.cited}/${coverage.total} (${coverage.uncitable} uncitable)` };
      const patchResp = await fetch(`${opts.selfBaseUrl}/api/workspaces/${encodeURIComponent(wsId)}/documents/${encodeURIComponent(uuid)}`, {
        method: 'PATCH', headers, body: JSON.stringify(patch),
      });
      if (!patchResp.ok) throw new Error(`PATCH HTTP ${patchResp.status}`);

      results.push({ uuid, ok: true, coverage });
      await ctx.emit('doc_done', { uuid, coverage });
      // Webhook: document.citations_generated (per doc)
      if (opts.workspacesDir) {
        try {
          const { emitWebhookEvent } = await import('../lib/webhooks.ts');
          await emitWebhookEvent(opts.workspacesDir, wsId, {
            type: 'document.citations_generated',
            data: { docUuid: uuid, coverage },
          });
        } catch { /* webhook delivery is fire-and-forget; do not fail the job */ }
      }
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      results.push({ uuid, ok: false, error: msg });
      await ctx.emit('doc_failed', { uuid, error: msg });
    }
    await ctx.bumpProgress(i + 1, uuids.length);
  }
  return { processed: results.length, results };
}

/** Extract the payload of the last "done" or kind-specific *_done event. */
function parseSseTerminal(text: string): unknown {
  let last: { type: string; data: unknown } | null = null;
  for (const block of text.split('\n\n')) {
    const m = block.match(/^event:\s*(\S+)\s*\ndata:\s*(\{.*\})/);
    if (!m) continue;
    try { last = { type: m[1], data: JSON.parse(m[2]) }; } catch { /* skip */ }
  }
  return last?.data ?? null;
}
