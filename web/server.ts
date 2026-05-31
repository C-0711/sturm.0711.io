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
import { writeFileSync, mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { runLane1 } from '../src/workflows/elster/lib/lane1.ts';
import { ocrEnsembleFromPath, pingOrchestrator } from '../src/workflows/elster/lib/field-mapper/ocr-ensemble-client.ts';
import { ocrEnsembleToRawText } from '../src/workflows/elster/lib/field-mapper/lane2-adapter.ts';
import { berechneHaushaltAuthoritativ } from '../src/workflows/elster/lib/steuer/authoritative.ts';
import { normalisiereSteuerfall } from '../src/workflows/elster/lib/steuer/fallnormalizer.ts';
import type { SteuerFeld } from '../src/workflows/elster/lib/steuer/adapter.ts';
import { auditCase } from './audit.ts';
import { phraseFindings, interpretAnswer } from './auditor.ts';
import { buildAuditProtocol, sealProtocol } from './protocol.ts';

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
// ── Content-addressed OCR cache ──────────────────────────────────────────
// OCR ist GPU-gebunden und serialisiert (~100–145 ms/Seite); der teure Teil
// jeder Berechnung. OCR/pdftotext sind aber DETERMINISTISCH pro Dokument-
// Inhalt → wir cachen das Ergebnis unter sha256(Datei-Bytes). Re-Compute
// eines Falls oder wiederholt gedroppte Belege (gleicher Inhalt, neuer Temp-
// Pfad) überspringen die OCR komplett. Persistiert auf Platte (überlebt
// Neustart). `parseDoc` (Cache-Lesen) läuft VOR pdftotext/OCR in runLane1.
const OCR_CACHE_DIR = process.env.OCR_CACHE_DIR ?? join(tmpdir(), 'sturm-ocr-cache');
mkdirSync(OCR_CACHE_DIR, { recursive: true });
const contentHash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const cacheFile = (p: string) => join(OCR_CACHE_DIR, contentHash(p) + '.json');
const parseDoc = async (p: string): Promise<{ rawText: string; method: 'text' | 'ocr' } | null> => {
  try { const f = cacheFile(p); if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8')); } catch { /* miss */ }
  return null;
};
const parseImage = async (p: string) => {
  const src = IMAGE_EXT.has(extname(p).toLowerCase()) ? imageToPdf(p) : p;
  const rawText = ocrEnsembleToRawText(await ocrEnsembleFromPath(src, { baseUrl }));
  try { writeFileSync(cacheFile(p), JSON.stringify({ rawText, method: 'ocr' })); } catch { /* best-effort */ }
  return rawText;
};

// ── Provenienz: Feld → Bounding-Box im Dokument ──────────────────────────
// Für den Viewer: jedes OCR'te Dokument wird (cache-getrieben) zu PNG(s)
// gerastert UND genau dieses PNG via :11440 ge-OCRt — so liegen die bboxes im
// selben Pixelraum wie das angezeigte Bild (pixelgenaue gelbe Overlays). Pro
// Feld wird der Record gesucht, dessen Text dem Feld-Wert entspricht (Beträge:
// Ziffern-Containment; Text: Substring) → dessen Box ist die Feld-Position.
const PROV_CACHE_DIR = process.env.PROV_CACHE_DIR ?? join(tmpdir(), 'sturm-prov-cache');
mkdirSync(PROV_CACHE_DIR, { recursive: true });
interface ProvPage { w: number; h: number; png: string; records: { text: string; bbox: [number, number, number, number] }[]; }
const provMem = new Map<string, ProvPage[]>();
function provenanceFor(path: string): { hash: string; pages: ProvPage[] } {
  const hash = contentHash(path);
  let pages = provMem.get(hash);
  if (!pages) {
    const outdir = join(PROV_CACHE_DIR, hash);
    const metaFile = join(outdir, 'meta.json');
    if (existsSync(metaFile)) { pages = JSON.parse(readFileSync(metaFile, 'utf8')); }
    else {
      mkdirSync(outdir, { recursive: true });
      const out = execFileSync(PY, [join(HERE, 'provenance.py'), path, outdir], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).toString();
      pages = (JSON.parse(out).pages as ProvPage[]);
      writeFileSync(metaFile, JSON.stringify(pages));
    }
    provMem.set(hash, pages!);
  }
  return { hash, pages: pages! };
}
const digitsOf = (s: string) => (s || '').replace(/\D/g, '');
interface FieldProv { hash: string; page: number; box: [number, number, number, number]; pageW: number; pageH: number; }
/** Zwei Durchgänge: erst EXAKT (Ziffern-Gleichheit bzw. Text==), dann lockeres
 *  Containment. Exakt zuerst verhindert, dass „0,24" in einem fremden Dokument
 *  als Substring vor dem echten Beleg greift. */
const boxKey = (hash: string, pi: number, box: [number, number, number, number]) => `${hash}:${pi}:${box.join(',')}`;
function matchProv(value: string, docs: { hash: string; pages: ProvPage[] }[], used?: Set<string>): FieldProv | null {
  const v = (value || '').trim();
  if (v.length < 2) return null;
  const vd = digitsOf(v);
  const isNum = vd.length >= 2 && /\d/.test(v);
  const scan = (pred: (rt: string, rd: string) => boolean): FieldProv | null => {
    for (const doc of docs)
      for (let pi = 0; pi < doc.pages.length; pi++)
        for (const rec of doc.pages[pi].records) {
          if (used && used.has(boxKey(doc.hash, pi, rec.bbox))) continue;  // schon vergebener Record → überspringen
          if (pred(rec.text || '', digitsOf(rec.text || '')))
            return { hash: doc.hash, page: pi, box: rec.bbox, pageW: doc.pages[pi].w, pageH: doc.pages[pi].h };
        }
    return null;
  };
  // Dezimalbetrag ("7.532,00", "0,24"): NUR gegen einen Record matchen, der
  // selbst eine „…,dd"-Zahl mit identischen Ziffern trägt. Verhindert, dass
  // „1155" aus „Postfach1155" oder „102" aus „21.02.2025" fälschlich greift.
  if (isNum && /\d,\d/.test(v)) {
    return scan((rt, rd) => rd === vd && /\d[.,]\d{2}(?!\d)/.test(rt));
  }
  // Distinktive Ganzzahl (IdNr, große Beträge ≥5 Stellen): exakt, sonst
  // Containment mit enger Längen-Schranke (Währungsformatierung, keine IBAN).
  if (isNum && vd.length >= 5) {
    return scan((_rt, rd) => rd === vd)
        ?? scan((_rt, rd) => rd.length >= 5 && (rd.includes(vd) || vd.includes(rd)) && Math.abs(rd.length - vd.length) <= 3);
  }
  // Kurze Ganzzahl (300, 915, 11): zu mehrdeutig → NUR wenn ein Record exakt
  // diese Zahl ist (kein Teilstring — „11" steckt sonst in „Seite 1 von 1").
  // Exakt zuerst; erst danach die ausgeschriebene „,00"-Form (Feldwert „36" ↔
  // Beleg „36,00") — so verliert ein echtes „300" nicht gegen ein fremdes „300,00".
  if (isNum) {
    return scan((rt) => rt.trim() === v)
        ?? scan((rt) => { const t = rt.trim(); return t === `${v},00` || t === `${v}.00`; });
  }
  const lv = v.toLowerCase();
  return scan((rt) => v.length >= 3 && rt.toLowerCase() === lv)      // exakter Text
      ?? scan((rt) => v.length >= 4 && rt.toLowerCase().includes(lv));
}

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
  const r = await runLane1(paths, { vz, pool, parseDoc, parseImage: orchUp ? parseImage : undefined });
  const lane1Ms = Number(process.hrtime.bigint() - t0) / 1e6;

  const ocrSet = new Set(r.ocrFields);
  let fields: Array<Record<string, unknown>> = r.aggregated.map((f) => ({
    eCode: f.eCode, label: f.pdfLabel, wert: f.wert, person: String(f.person),
    anlage: f.anlage, method: ocrSet.has(`${f.eCode}|${f.person}`) ? 'ocr' : 'text',
  }));
  const felder: SteuerFeld[] = r.aggregated.map((f) => ({ eCode: f.eCode, wert: f.wert, person: f.person, anlage: f.anlage, pdfLabel: f.pdfLabel }));

  // Provenienz-Pass: pro OCR'tem Dokument PNG+bboxes (cache), dann je Feld den
  // Record mit passendem Wert finden → prov (Box im Bild). Best-effort: ein
  // Fehler hier darf den Bescheid nie kippen.
  let docs: Array<{ hash: string; name: string; pages: Array<{ w: number; h: number }> }> = [];
  try {
    // OCR-Belege (Bild/Scan) UND Text-PDFs: provenance.py liefert für PDFs mit
    // Textebene die Wort-Boxen direkt (OCR-frei), sonst OCR — gleiche Records.
    const provSources = new Set<string>();
    for (const b of r.belege) {
      const src = String(b.source).split('#')[0];
      if (b.method === 'ocr') provSources.add(src);
      else if (b.method === 'text' && src.toLowerCase().endsWith('.pdf')) provSources.add(src);
    }
    // Pro Dokument isoliert: ein korruptes PDF/Bild (provenance.py-Fehler) darf
    // nicht die Boxen ALLER Belege kippen → per-Doc try/catch, dann ausfiltern.
    const provDocs = [...provSources].filter((p) => existsSync(p)).map((p) => {
      try { const { hash, pages } = provenanceFor(p); return { path: p, hash, pages }; }
      catch (e) { console.error('PROV-DOC', basename(p), (e as Error).message); return null; }
    }).filter((d): d is { path: string; hash: string; pages: ProvPage[] } => d !== null);
    const byHash = new Map<string, { hash: string; name: string; pages: Array<{ w: number; h: number }> }>();
    for (const d of provDocs) byHash.set(d.hash, { hash: d.hash, name: basename(d.path), pages: d.pages.map((pg) => ({ w: pg.w, h: pg.h })) });
    docs = [...byHash.values()];
    // Per-Beleg-Provenienz ZUERST: jedes Feld gegen die Records SEINES EIGENEN
    // Belegs matchen (eindeutig, kein Greedy-Cross-Doc). Treibt die Beleg-Detail-
    // ansicht UND — via provByField — die Provenienz der aggregierten Felder.
    const provBySource = new Map(provDocs.map((d) => [d.path, d]));
    const provByField = new Map<string, FieldProv>();
    for (const b of r.belege) {
      if (!Array.isArray(b.felderListe)) continue;
      const pd = provBySource.get(String(b.source).split('#')[0]);
      if (!pd) continue;  // kein Prov-Dokument (z.B. image-only ohne Treffer) → keine Box
      // Records pro Beleg verbrauchen: zwei Felder mit gleichem Wert (z.B. zwei
      // „0,00") bekommen je einen EIGENEN Record-Treffer; nur wenn keiner mehr
      // frei ist, teilen sie sich (Fallback) — statt beide auf denselben zu legen.
      const used = new Set<string>();
      for (const f of b.felderListe) {
        const m = matchProv(String(f.wert ?? ''), [pd], used) ?? matchProv(String(f.wert ?? ''), [pd]);
        if (m) { f.prov = { hash: m.hash, page: m.page, box: m.box };
                 used.add(boxKey(m.hash, m.page, m.box));
                 provByField.set(`${f.eCode}|${f.person}|${f.wert}`, m); }
      }
    }
    // Aggregierte Felder (Dashboard-Viewer „im Beleg zeigen"): Box aus der
    // eindeutigen Per-Beleg-Zuordnung übernehmen — kein Cross-Doc-Greifen. Nur
    // wenn kein Beleg-Treffer (z.B. aggregiert abweichender Wert) global matchen.
    fields = fields.map((f) => {
      const byBeleg = provByField.get(`${f.eCode}|${f.person}|${String(f.wert)}`);
      if (byBeleg) return { ...f, prov: byBeleg };
      const m = matchProv(String(f.wert ?? ''), provDocs);
      return m ? { ...f, prov: m } : f;
    });
  } catch (e) {
    console.error('PROV', (e as Error).message);
  }

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
    household: r.household, docs,
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
    if (req.method === 'GET' && url === '/api/page') {
      // Rasterisierte Dokumentseite für den Viewer (gelbe Overlay-Boxen liegen
      // im selben Pixelraum). Nur hex-Hash + int-Seite → kein Path-Traversal.
      const q = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
      const h = (q.get('h') ?? '').replace(/[^a-f0-9]/g, '');
      const p = String(parseInt(q.get('p') ?? '0', 10) || 0);
      const png = join(PROV_CACHE_DIR, h, `p${p}.png`);
      if (!h || !existsSync(png)) { res.writeHead(404); res.end('no page'); return; }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
      res.end(readFileSync(png));
      return;
    }
    if (req.method === 'POST' && url === '/api/steuerfall') {
      const { paths, vz } = JSON.parse((await body(req)).toString('utf8'));
      if (!Array.isArray(paths) || paths.length === 0) return json(res, 400, { error: 'keine Dateien' });
      const out = await runSteuerfall(paths, Number(vz) || 2023);
      return json(res, 200, out);
    }
    // Auditor: gerechneter Fall → verifizierte Befunde (deterministisch) +
    // user-gerichtete Fragen (lokales Gemma, on-prem). „der Auditor" — das
    // zugrundeliegende Modell wird nie nach außen genannt.
    if (req.method === 'POST' && url === '/api/audit') {
      const { data } = JSON.parse((await body(req)).toString('utf8'));
      if (!data || typeof data !== 'object') return json(res, 400, { error: 'kein Fall' });
      const rep = auditCase(data);
      const findings = await phraseFindings(rep.findings);
      return json(res, 200, { ok: true, findings, score: rep.score });
    }
    if (req.method === 'POST' && url === '/api/audit/answer') {
      const { finding, antwort } = JSON.parse((await body(req)).toString('utf8'));
      if (!finding || typeof antwort !== 'string') return json(res, 400, { error: 'unvollständig' });
      const verdict = await interpretAnswer(finding, antwort);
      return json(res, 200, { ok: true, verdict });
    }
    // Gemeinsamer Abschluss: Audit-Protokoll bauen + blake2b-256 versiegeln.
    if (req.method === 'POST' && url === '/api/audit/seal') {
      const { caseId, label, vz, data, audit } = JSON.parse((await body(req)).toString('utf8'));
      if (!data || !audit) return json(res, 400, { error: 'unvollständig' });
      const protocol = buildAuditProtocol({ caseId: String(caseId ?? ''), label: String(label ?? ''), vz: Number(vz) || 0, data, audit });
      const seal = sealProtocol(protocol, new Date().toISOString());
      return json(res, 200, { ok: true, protocol, seal });
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
  } catch (e) {
    console.error('ERR', (e as Error).stack);
    json(res, 500, { ok: false, error: (e as Error).message });
  }
}).listen(PORT, '0.0.0.0', () => console.log(`Steuerfall-Web on http://0.0.0.0:${PORT} (orchestrator ${baseUrl})`));
