/**
 * Integration endpoints for external systems (cb-chat, etc.).
 *
 * cb-chat case import:
 *   POST /api/integrations/cb-chat/import
 *     Headers: X-CBChat-Cookie: <session cookie value>
 *     Body:    { fallId, workspaceName?, pipelineBinding?, baseUrl? }
 *     →        { jobId, workspaceId, status }
 *
 *   The cookie is forwarded only into the job's inputs (sidecar storage,
 *   purged with the job). It is not persisted in any other table.
 */

import { Router } from 'express';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { JobRunner } from '../lib/job-runner.ts';
import type { WorkspaceRecord } from './workspaces.ts';
import { setBinding, loadPipelines } from '../lib/pipeline-loader.ts';
import { listCases } from '../lib/cb-chat-client.ts';

interface IntegrationsOpts {
  workspacesDir: string;
  pipelinesDir: string;
  jobRunner: JobRunner;
}

export function createIntegrationsRouter(opts: IntegrationsOpts): Router {
  const router = Router();

  // Liste der Faelle des hinterlegten cb-chat-Kontos. Wird vom Import-Modal
  // aufgerufen, sobald der Berater seinen Cookie eingibt — der Cookie wird
  // hier nur durchgereicht, nicht persistiert.
  router.get('/cb-chat/faelle', async (req, res) => {
    try {
      const cookie = req.header('x-cbchat-cookie');
      const baseUrl = typeof req.query.baseUrl === 'string' && req.query.baseUrl.trim()
        ? req.query.baseUrl.trim()
        : 'https://cb-chat.0711.io';
      if (!cookie) {
        res.status(400).json({ error: 'missing_cookie', message: 'X-CBChat-Cookie header required' });
        return;
      }
      const faelle = await listCases({ cookie, baseUrl });
      res.json({ faelle });
    } catch (e) {
      res.status(502).json({ error: 'cb_chat_unreachable', message: (e as Error).message });
    }
  });

  router.post('/cb-chat/import', async (req, res) => {
    try {
      const cookie = req.header('x-cbchat-cookie') ?? req.body?.cbChatCookie;
      const fallId = typeof req.body?.fallId === 'string' ? req.body.fallId.trim() : '';
      const baseUrl = typeof req.body?.baseUrl === 'string' ? req.body.baseUrl.trim() : 'https://cb-chat.0711.io';
      const wantedName = typeof req.body?.workspaceName === 'string' ? req.body.workspaceName.trim() : '';
      const pipelineBinding = req.body?.pipelineBinding as { pipelineId?: string; version?: string } | undefined;

      if (!cookie) { res.status(400).json({ error: 'missing_cookie', message: 'X-CBChat-Cookie header (or body.cbChatCookie) required' }); return; }
      if (!fallId) { res.status(400).json({ error: 'missing_fallId' }); return; }

      // Auto-create workspace named after the case (or user-provided name).
      const wsName = wantedName || `cb-chat ${fallId.slice(0, 8)}`;
      const wsId = await ensureWorkspace(opts.workspacesDir, wsName);

      // Optional pipeline binding (default: tax-de-2024@v0 if present).
      const pipelines = await loadPipelines(opts.pipelinesDir);
      const wantedPipeline = pipelineBinding?.pipelineId
        ? { id: pipelineBinding.pipelineId, version: pipelineBinding.version ?? 'v0' }
        : pipelines.find((p) => p.id === 'tax-de-2024');
      if (wantedPipeline) {
        const exists = pipelines.some((p) => p.id === wantedPipeline.id && p.version === (wantedPipeline as { version: string }).version);
        if (exists) {
          await setBinding(opts.workspacesDir, wsId, {
            pipelineId: wantedPipeline.id,
            version: (wantedPipeline as { version: string }).version,
            boundAt: new Date().toISOString(),
            boundBy: 'cb-chat-import',
            overrides: {},
          });
        }
      }

      // Enqueue the import job.
      const { job } = await opts.jobRunner.enqueue({
        workspaceId: wsId,
        kind: 'import-cb-chat-case',
        inputs: { cbChatFallId: fallId, cbChatCookie: cookie, cbChatBaseUrl: baseUrl },
        pipelineRef: wantedPipeline ? `${wantedPipeline.id}@${(wantedPipeline as { version: string }).version}` : undefined,
        createdBy: 'cb-chat-integration',
      });

      res.status(201).json({
        jobId: job.jobId,
        workspaceId: wsId,
        workspaceUrl: `/workspace.html?ws=${encodeURIComponent(wsId)}`,
        jobEventsUrl: `/api/jobs/${encodeURIComponent(job.jobId)}/events?live=true`,
        status: job.status,
      });
    } catch (e) {
      res.status(500).json({ error: 'import_failed', message: (e as Error).message });
    }
  });

  return router;
}

async function ensureWorkspace(workspacesDir: string, name: string): Promise<string> {
  const indexPath = path.join(workspacesDir, 'index.json');
  let records: WorkspaceRecord[] = [];
  try { records = JSON.parse(await fs.readFile(indexPath, 'utf8')); } catch { /* empty */ }
  const id = slugify(name);
  // If already exists, reuse
  const existing = records.find((r) => r.id === id);
  if (existing) return existing.id;
  const record: WorkspaceRecord = { id, name, createdAt: new Date().toISOString() };
  await fs.mkdir(path.join(workspacesDir, id, 'inbox'), { recursive: true });
  await fs.mkdir(path.join(workspacesDir, id, 'meta'), { recursive: true });
  records.push(record);
  await fs.writeFile(indexPath, JSON.stringify(records, null, 2));
  return id;
}

function slugify(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 50);
}
