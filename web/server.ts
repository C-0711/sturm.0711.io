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
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { runLane1 } from '../src/workflows/elster/lib/lane1.ts';
import { ocrEnsembleFromPath, pingOrchestrator } from '../src/workflows/elster/lib/field-mapper/ocr-ensemble-client.ts';
import { ocrEnsembleToRawText } from '../src/workflows/elster/lib/field-mapper/lane2-adapter.ts';
import { berechneHaushaltAuthoritativ } from '../src/workflows/elster/lib/steuer/authoritative.ts';
import { normalisiereSteuerfall } from '../src/workflows/elster/lib/steuer/fallnormalizer.ts';
import type { SteuerFeld } from '../src/workflows/elster/lib/steuer/adapter.ts';

const { Pool } = pg;
const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 7190);
const baseUrl = process.env.TORNADO_ORCHESTRATOR_URL ?? 'http://127.0.0.1:7180';
const pgUrl = process.env.ELSTER_CATALOG_PG_URL ?? 'postgresql://elster:elster_dev_pw@127.0.0.1:11111/elster_catalog';
const HEBESATZ = 0.09;

const pool = new Pool({ connectionString: pgUrl, max: 4 });

// Dropped phone photos (JPG/PNG) are not PDFs → the orchestrator's pdfium
// rasterizer throws FormatError. Wrap them in a one-page PDF first (Pillow,
// 200 dpi) so the OCR ensemble sees a page it can raster.
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.webp', '.bmp', '.gif']);
const PY = process.env.PDL3_PY ?? `${process.env.HOME}/.venvs/pdl3/bin/python`;
function imageToPdf(img: string): string {
  const pdf = img.replace(/\.[^.]+$/, '') + '.asimg.pdf';
  execFileSync(PY, ['-c',
    "from PIL import Image;import sys;Image.open(sys.argv[1]).convert('RGB').save(sys.argv[2],'PDF',resolution=200.0)",
    img, pdf], { stdio: 'pipe' });
  return pdf;
}
const parseImage = async (p: string) => {
  const src = IMAGE_EXT.has(extname(p).toLowerCase()) ? imageToPdf(p) : p;
  return ocrEnsembleToRawText(await ocrEnsembleFromPath(src, { baseUrl }));
};

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

  // Fallnormalizer: Veranlagungsart erkennen + Felder reattribuieren, DANN
  // verbindlich rechnen (Zusammenveranlagung = ein Splitting-Bescheid).
  const fall = normalisiereSteuerfall(felder, r.household);
  const haushalt = await berechneHaushaltAuthoritativ(fall, { vz, kirchensteuerHebesatz: HEBESATZ });
  const calcs = haushalt.bescheide.map((bx) => ({
    person: bx.einheit, einheit: bx.einheit, felder: bx.felder,
    quelle: bx.res.quelle, bindend: bx.res.bindend,
    angerechnet: bx.res.angerechnet, erstattung: bx.res.erstattung,
    abgleich: bx.res.abgleich ?? null, latenzMs: bx.res.latenzMs, konflikte: bx.res.konflikte.length,
  }));
  return {
    ok: true, vz, lane1Ms: Math.round(lane1Ms),
    belege: r.belege, fields, ocrCount: r.belege.filter((b) => b.method === 'ocr').length,
    household: r.household,
    veranlagungsart: haushalt.veranlagungsart, begruendung: haushalt.begruendung,
    warnings: [...(r.warnings ?? []), ...haushalt.warnungen], calcs,
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
      const hdr = String(req.headers['x-filename'] ?? 'upload.pdf');
      let raw = hdr;
      try { raw = decodeURIComponent(hdr); } catch { /* header not percent-encoded → use as-is */ }
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
