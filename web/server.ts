#!/usr/bin/env -S npx tsx
/**
 * web/server — Steuerfall-Web: Datei rein → Extraktion + ELSTER-Mapping +
 * MCP-autoritative Berechnung. Kein Framework (Node http), keine Multipart-
 * Parserei: Dateien kommen als rohe Bytes auf /api/upload (Name im Header),
 * dann /api/steuerfall {paths} → vollständiges Ergebnis-JSON.
 *
 *   ELSTER_CATALOG_PG_URL=… TORNADO_ORCHESTRATOR_URL=… npx tsx web/server.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { runLane1 } from '../src/workflows/elster/lib/lane1.ts';
import { ocrEnsembleFromPath, pingOrchestrator } from '../src/workflows/elster/lib/field-mapper/ocr-ensemble-client.ts';
import { ocrEnsembleToRawText } from '../src/workflows/elster/lib/field-mapper/lane2-adapter.ts';
import { berechneSteuerfallAuthoritativ } from '../src/workflows/elster/lib/steuer/authoritative.ts';
import type { SteuerFeld } from '../src/workflows/elster/lib/steuer/adapter.ts';

const { Pool } = pg;
const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 7190);
const baseUrl = process.env.TORNADO_ORCHESTRATOR_URL ?? 'http://127.0.0.1:7180';
const pgUrl = process.env.ELSTER_CATALOG_PG_URL ?? 'postgresql://elster:elster_dev_pw@127.0.0.1:11111/elster_catalog';
const HEBESATZ = 0.09;

const pool = new Pool({ connectionString: pgUrl, max: 4 });
const parseImage = async (p: string) => ocrEnsembleToRawText(await ocrEnsembleFromPath(p, { baseUrl }));

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}
function json(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

async function runSteuerfall(paths: string[], vz: number) {
  const t0 = process.hrtime.bigint();
  const orchUp = await pingOrchestrator(baseUrl);
  const r = await runLane1(paths, { vz, pool, parseImage: orchUp ? parseImage : undefined });
  const lane1Ms = Number(process.hrtime.bigint() - t0) / 1e6;

  const ocrSet = new Set(r.ocrFields);
  const fields = r.aggregated.map((f) => ({
    eCode: f.eCode, label: f.pdfLabel, wert: f.wert, person: String(f.person),
    anlage: f.anlage, method: ocrSet.has(`${f.eCode}|${f.person}`) ? 'ocr' : 'text',
  }));
  const felder: SteuerFeld[] = r.aggregated.map((f) => ({ eCode: f.eCode, wert: f.wert, person: f.person, anlage: f.anlage, pdfLabel: f.pdfLabel }));

  const calcs: unknown[] = [];
  for (const person of ['A', 'B'] as const) {
    const pf = felder.filter((f) => f.person === person).map((f) => ({ ...f, person: 'A' as const }));
    if (pf.length === 0) continue;
    const res = await berechneSteuerfallAuthoritativ({ felder: pf, vz, kirchensteuerHebesatz: HEBESATZ });
    calcs.push({
      person, felder: pf.length, quelle: res.quelle, bindend: res.bindend,
      angerechnet: res.angerechnet, erstattung: res.erstattung,
      abgleich: res.abgleich ?? null, latenzMs: res.latenzMs, konflikte: res.konflikte.length,
    });
  }
  return {
    ok: true, vz, lane1Ms: Math.round(lane1Ms),
    belege: r.belege, fields, ocrCount: r.belege.filter((b) => b.method === 'ocr').length,
    household: r.household, warnings: r.warnings ?? [], calcs,
  };
}

createServer(async (req, res) => {
  try {
    const url = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(join(HERE, 'index.html'), 'utf8'));
      return;
    }
    if (req.method === 'POST' && url === '/api/upload') {
      const buf = await body(req);
      if (buf.length === 0 || buf.length > 40 * 1024 * 1024) return json(res, 413, { error: 'leer oder zu groß' });
      const raw = String(req.headers['x-filename'] ?? 'upload.pdf');
      const safe = raw.replace(/[^\w.\-]+/g, '_').slice(-80) || 'upload.pdf';
      const dir = mkdtempSync(join(tmpdir(), 'steuerweb-'));
      const path = join(dir, safe);
      writeFileSync(path, buf);
      return json(res, 200, { path, name: raw, bytes: buf.length });
    }
    if (req.method === 'POST' && url === '/api/steuerfall') {
      const { paths, vz } = JSON.parse((await body(req)).toString('utf8'));
      if (!Array.isArray(paths) || paths.length === 0) return json(res, 400, { error: 'keine Dateien' });
      const out = await runSteuerfall(paths, Number(vz) || 2023);
      return json(res, 200, out);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
  } catch (e) {
    console.error('ERR', (e as Error).stack);
    json(res, 500, { ok: false, error: (e as Error).message });
  }
}).listen(PORT, '0.0.0.0', () => console.log(`Steuerfall-Web on http://0.0.0.0:${PORT} (orchestrator ${baseUrl})`));
