/**
 * Cross-workspace Jobs API. Mounts at /api/jobs.
 *
 * Workspace-scoped operations (POST /:ws/jobs, GET /:ws/jobs) live in the
 * workspaces router — they need workspace existence checks. This router
 * handles operations on a known jobId (find by jobId, no workspace prefix
 * required) and the cross-workspace list endpoint for the global UI.
 */

import { Router } from 'express';
import type { JobRunner } from '../lib/job-runner.ts';

export function createJobsRouter(jobRunner: JobRunner): Router {
  const router = Router();

  /** Cross-workspace job list. UI uses this for a global Jobs panel.
   *  ?status=running&limit=50 etc. */
  router.get('/', async (req, res) => {
    try {
      const status = (req.query?.status as string | undefined) as Parameters<JobRunner['list']>[1]['status'] | undefined;
      const kind = req.query?.kind as Parameters<JobRunner['list']>[1]['kind'] | undefined;
      const limit = req.query?.limit ? parseInt(String(req.query.limit), 10) : 50;
      const jobs = await jobRunner.list(undefined, { status, kind, limit });
      res.json(jobs);
    } catch (e) {
      res.status(500).json({ error: 'list_failed', message: (e as Error).message });
    }
  });

  /** Get a single job by jobId — looked up across all workspaces. */
  router.get('/:jobId', async (req, res) => {
    try {
      const found = await jobRunner.find(req.params.jobId);
      if (!found) { res.status(404).json({ error: 'job_not_found', jobId: req.params.jobId }); return; }
      res.json(found.job);
    } catch (e) {
      res.status(500).json({ error: 'job_read_failed', message: (e as Error).message });
    }
  });

  /** Stream events for a job. Default: history-replay (closes after replay).
   *  ?live=true: keeps connection open for new events.
   *  ?fromSeq=N: skip events < N. */
  router.get('/:jobId/events', async (req, res) => {
    const jobId = req.params.jobId;
    const fromSeq = req.query?.fromSeq ? parseInt(String(req.query.fromSeq), 10) : 0;
    const live = String(req.query?.live ?? '') === 'true';

    const found = await jobRunner.find(jobId);
    if (!found) { res.status(404).json({ error: 'job_not_found', jobId }); return; }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (type: string, data: unknown) => {
      res.write(`event: ${type}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Replay history
    const events = await jobRunner.readEvents(found.wsId, jobId, fromSeq);
    for (const ev of events) send(ev.type, ev);

    if (!live) {
      send('replay_complete', { count: events.length });
      res.end();
      return;
    }

    // Live tail
    const unsubscribe = jobRunner.subscribeLive(jobId, (ev) => {
      if (ev.seq < fromSeq) return;
      send(ev.type, ev);
      // Auto-close after a terminal event so clients don't dangle
      if (ev.type === 'completed' || ev.type === 'failed' || ev.type === 'cancelled') {
        setTimeout(() => { unsubscribe(); res.end(); }, 100);
      }
    });
    req.on('close', () => unsubscribe());
  });

  router.post('/:jobId/cancel', async (req, res) => {
    try {
      const ok = await jobRunner.cancel(req.params.jobId);
      if (!ok) { res.status(404).json({ error: 'job_not_found' }); return; }
      res.json({ jobId: req.params.jobId, cancelRequested: true });
    } catch (e) {
      res.status(500).json({ error: 'cancel_failed', message: (e as Error).message });
    }
  });

  return router;
}
