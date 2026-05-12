/**
 * pentacam/register — registriert den Scan im Atlas (chain.scan), damit die
 * Atlas-Console-UI ihn unmittelbar in der Scan-Tabelle anzeigt.
 *
 * Wir schreiben **NICHT** direkt in die DB — der Workflow läuft ohne
 * DB-Wissen. Stattdessen POSTen wir an die Atlas-API (`/v1/atlas/scans`,
 * sofern vorhanden), oder schreiben — als Fallback — nur das Artefakt nach
 * `data/pentacam-atlas-payload.json`. Der GitChain-Anchor-Sidecar nimmt den
 * dann beim nächsten Tick mit.
 *
 * Diese Entkopplung ist Absicht: Sturm-Stages müssen pur bezüglich
 * Seiteneffekte sein. Wenn die Atlas-API nicht erreichbar ist, scheitert
 * der Workflow nicht — der Payload bleibt im Artefakt-Bundle und wird
 * später nachgespielt.
 */

import { createHash } from 'node:crypto';
import { defineStage } from '../../../core/stage.ts';
import type { PentacamExtractedDoc } from './extract.ts';
import type { PentacamClassifyOutput } from './classify.ts';

export interface PentacamRegisterConfig {
  /** e.g. "http://atlas-api:4000" — when running inside the universe compose. */
  atlasApiUrl?: string;
  /** Device kind label for the chain.scan row. Default: "pentacam_hr". */
  deviceKind?: string;
}

export interface PentacamRegisterInput {
  extracted: PentacamExtractedDoc;
  classified: PentacamClassifyOutput;
  /** Source filename — used to derive a stable scan_id. */
  filename: string;
}

export interface PentacamRegisterOutput {
  scanId: string;
  payload: Record<string, unknown>;
  registered: 'live' | 'queued';
  registerError?: string;
}

export const pentacamRegisterStage = defineStage<PentacamRegisterInput, PentacamRegisterOutput, PentacamRegisterConfig>({
  id: 'pentacam/register',
  name: 'Atlas-Registrierung',
  description: 'Schreibt extrahierte + klassifizierte Werte als chain.scan-Payload und versucht POST an die Atlas-API.',

  async run(input, ctx) {
    const { extracted, classified, filename } = input ?? {};
    if (!extracted || !classified || !filename) throw new Error('register: extracted/classified/filename required');

    // Stable scan_id from (filename + extracted JSON) hash. Pseudonymisation
    // happens upstream — we never persist names.
    const canonical = JSON.stringify({ extracted, classified, filename });
    const hash = createHash('sha256').update(canonical, 'utf8').digest('hex');
    const scanId = `SCN-${hash.slice(0, 8).toUpperCase()}`;

    const payload = {
      id: scanId,
      patientRef: extracted.patientId ?? `PAT-UNKNOWN-${hash.slice(0, 4)}`,
      deviceKind: ctx.config?.deviceKind ?? 'pentacam_hr',
      domain: 'cornea',
      contentHash: hash,
      score: {
        kind: 'kc',
        value: classified.score10,
        label: `KC ${classified.score10}/10`,
        riskClass: classified.riskClass,
        bandLabel: classified.bandLabel,
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

    await ctx.artifacts.write('data/pentacam-atlas-payload.json', payload);

    const url = ctx.config?.atlasApiUrl;
    if (!url) {
      ctx.logger.warn('pentacam/register: ATLAS_API_URL nicht gesetzt — Payload nur lokal abgelegt');
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
      ctx.logger.info(`pentacam/register: ${scanId} live im Atlas`);
      ctx.emit('pentacam_register_done', { scanId, registered: 'live' });
      return { scanId, payload, registered: 'live' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.logger.warn(`pentacam/register: POST fehlgeschlagen, Payload bleibt queued — ${message}`);
      ctx.emit('pentacam_register_done', { scanId, registered: 'queued', error: message });
      return { scanId, payload, registered: 'queued', registerError: message };
    }
  },
});
