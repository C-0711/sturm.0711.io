import { createHash } from 'node:crypto';
import { defineStage } from '../../../core/stage.ts';
import type { MyopiaExtractedDoc } from './extract.ts';
import type { MyopiaClassifyOutput } from './classify.ts';

export interface MyopiaRegisterConfig {
  atlasApiUrl?: string;
  deviceKind?: string;
}

export interface MyopiaRegisterInput {
  extracted: MyopiaExtractedDoc;
  classified: MyopiaClassifyOutput;
  filename: string;
}

export interface MyopiaRegisterOutput {
  scanId: string;
  payload: Record<string, unknown>;
  registered: 'live' | 'queued';
  registerError?: string;
}

export const myopiaRegisterStage = defineStage<MyopiaRegisterInput, MyopiaRegisterOutput, MyopiaRegisterConfig>({
  id: 'myopia/register',
  name: 'Atlas-Registrierung (Myopia)',
  description: 'Schreibt Myopia-Master-Ergebnis als chain.scan-Payload und POSTet an Atlas-API.',

  async run(input, ctx) {
    const { extracted, classified, filename } = input ?? {};
    if (!extracted || !classified || !filename) throw new Error('register: extracted/classified/filename required');

    const canonical = JSON.stringify({ extracted, classified, filename });
    const hash = createHash('sha256').update(canonical, 'utf8').digest('hex');
    const scanId = `SCN-${hash.slice(0, 8).toUpperCase()}`;

    const payload = {
      id: scanId,
      patientRef: extracted.patientId ?? `PAT-UNKNOWN-${hash.slice(0, 4)}`,
      deviceKind: ctx.config?.deviceKind ?? 'myopia_master',
      domain: 'myopia',
      contentHash: hash,
      score: {
        kind: 'progression',
        value: classified.score10,
        label: `prog ${classified.score10}/10`,
        riskClass: classified.riskClass,
        bandLabel: classified.bandLabel,
        deltaAlPerYear: classified.deltaAlPerYear,
        tags: classified.tags,
      },
      provenance: {
        workflowRunId: ctx.runId,
        workflowId: ctx.workflowId,
        sourceFilename: filename,
        rationale: classified.rationale,
        caveats: classified.caveats,
        disclaimer: classified.disclaimer,
      },
      capturedAt: extracted.examDate ?? new Date().toISOString(),
    };

    await ctx.artifacts.write('data/myopia-atlas-payload.json', payload);

    const url = ctx.config?.atlasApiUrl;
    if (!url) {
      ctx.logger.warn('myopia/register: ATLAS_API_URL nicht gesetzt — Payload nur lokal abgelegt');
      return { scanId, payload, registered: 'queued' };
    }
    try {
      const r = await fetch(`${url.replace(/\/$/, '')}/v1/atlas/scans`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctx.signal,
      });
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        throw new Error(`atlas-api ${r.status}: ${body.slice(0, 200)}`);
      }
      ctx.logger.info(`myopia/register: ${scanId} live im Atlas`);
      ctx.emit('myopia_register_done', { scanId, registered: 'live' });
      return { scanId, payload, registered: 'live' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.warn(`myopia/register: POST fehlgeschlagen, queued — ${msg}`);
      ctx.emit('myopia_register_done', { scanId, registered: 'queued', error: msg });
      return { scanId, payload, registered: 'queued', registerError: msg };
    }
  },
});
