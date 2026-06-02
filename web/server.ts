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
import { loadCandidates, buildIndex, type Candidate } from '../src/server/harmonize.ts';
import { extractBeleg, type ExtractOutput } from './extract-client.ts';
import { harmonize, type Mastercase, type Household } from './mastercase-harmonize.ts';
import { rename } from 'node:fs/promises';

const { Pool } = pg;
const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 7190);
const baseUrl = process.env.TORNADO_ORCHESTRATOR_URL ?? 'http://127.0.0.1:7180';
const pgUrl = process.env.ELSTER_CATALOG_PG_URL ?? 'postgresql://elster:elster_dev_pw@127.0.0.1:11111/elster_catalog';
const HEBESATZ = 0.09;

const pool = new Pool({ connectionString: pgUrl, max: 4 });

// Katalog-Meta (Vordruckzeile + kontextPath je eCode): reichert jedes Ingestion-Feld
// mit seinem deterministischen Struktur-Schlüssel an — einmal lazy aus atoms.json.
let _catByECode: Map<string, Candidate> | null = null;
const catByECode = (): Map<string, Candidate> => (_catByECode ??= buildIndex(loadCandidates()).byECode);

// Stammdaten-eCodes, die der Mastercase-Recalc aus dem harmonisierten Mastercase
// übernehmen DARF (Identität/Adresse — vervollständigen die ELSTER-Form, steuer-
// neutral). Einkommen (KAP/N/VOR) bleibt BEWUSST Pre-Calc: die rohen /extract-
// Bank-Werte sind verrauscht (Bruttoarbeitslohn-Mis-Maps), würden die Steuer kippen.
const MC_STAMMDATEN = new Set([
  'E0100201', 'E0100301', 'E0100401', 'E0100081',  // Name, Vorname, Geburtsdatum, IdNr (A)
  'E0100901', 'E0100801', 'E0101001', 'E0100082',  // Name, Vorname, Geburtsdatum, IdNr (B)
  'E0101104', 'E0101206', 'E0100601', 'E0100602',  // Straße, Hausnr, PLZ, Ort
  'E0100701', 'E0102102',                           // Verheiratet-seit, IBAN
]);

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

// ── Mastercase: asynchroner Hintergrund-Harmonizer (read-only ggü. Pre-Calc) ──
// Die Pre-Calc-Antwort (runSteuerfall) geht SOFORT raus. Danach läuft fire-and-
// forget ein Job, der JEDEN Beleg neu durch den ECHTEN deterministischen
// Orchestrator-Extraktor (/api/v1/extract) schickt, die Felder harmonisiert
// (Person-A/B-Split + Bank-/Gläubiger-Filter + Multi-Quellen-Vote) und das
// Ergebnis als Sidecar-JSON je caseId persistiert. Der Browser pollt den
// Mastercase via GET /api/mastercase nach. Kein Einfluss auf die Antwort-Latenz.
const MASTERCASE_DIR = process.env.MASTERCASE_DIR ?? join(tmpdir(), 'sturm-mastercase');
mkdirSync(MASTERCASE_DIR, { recursive: true });
interface MastercaseEnvelope {
  caseId: string; status: 'pending' | 'ready' | 'error';
  updatedAt: string; mastercase?: Mastercase; error?: string;
}
// caseId härten (kein Path-Traversal) — gleiche Härtung wie /api/page + Upload-Name.
const mcFile = (caseId: string) => join(MASTERCASE_DIR, (caseId.replace(/[^\w.-]/g, '_') || 'case') + '.json');
// Atomar schreiben: erst .tmp, dann rename — das Polling liest nie eine halbe Datei.
async function writeEnvelope(env: MastercaseEnvelope): Promise<void> {
  const f = mcFile(env.caseId); const tmp = f + '.tmp';
  writeFileSync(tmp, JSON.stringify(env));
  await rename(tmp, f);
}
// Content-addressierter Cache der rohen /extract-Antworten (wie OCR-Cache):
// Re-Compute eines Falls überspringt den Orchestrator-Roundtrip pro Beleg.
const extractCacheFile = (p: string) => join(MASTERCASE_DIR, contentHash(p) + '.extract.json');
async function extractCached(path: string): Promise<ExtractOutput> {
  const cf = extractCacheFile(path);
  if (existsSync(cf)) { try { return JSON.parse(readFileSync(cf, 'utf8')) as ExtractOutput; } catch { /* korrupt → neu holen */ } }
  const out = await extractBeleg(path, { baseUrl });
  try { writeFileSync(cf, JSON.stringify(out)); } catch { /* best-effort */ }
  return out;
}

/** Hintergrund-Job: Belege → /extract → harmonize → Sidecar persistieren.
 *  out = Pre-Calc-Ergebnis (liefert belege[].source + household); paths = roher
 *  Handler-Input (Fallback). Jeder Beleg isoliert: ein /extract-Fehler kippt den
 *  Job nicht, der Mastercase entsteht aus den erfolgreichen Belegen. */
async function kickMastercase(caseId: string, out: { belege?: Array<{ source?: string; vorjahr?: boolean }>; household?: Household }, paths: string[]): Promise<void> {
  await writeEnvelope({ caseId, status: 'pending', updatedAt: new Date().toISOString() });
  // Fremdjährige (Vorjahres-)Belege gehören NICHT in den harmonisierten Mastercase
  // — konsistent zur Berechnung, die sie ebenfalls ausschließt. Ihre Pfade werden
  // sowohl aus den Beleg-Quellen als auch aus dem rohen paths-Fallback gefiltert.
  const vorjahrPfade = new Set((out.belege ?? []).filter((b) => b.vorjahr).map((b) => String(b.source).split('#')[0]));
  // Beleg-Pfade: aus belege[].source (VaSt-Section-Suffix '#…' abschneiden),
  // Fallback auf den rohen Handler-Input; uniq + existsSync; ohne Vorjahr.
  const fromBelege = (out.belege ?? []).filter((b) => !b.vorjahr).map((b) => String(b.source).split('#')[0]);
  const candidates = [...new Set([...fromBelege, ...paths])].filter((p) => p && existsSync(p) && !vorjahrPfade.has(p));
  const outputs: ExtractOutput[] = [];
  for (const p of candidates) {
    try { outputs.push(await extractCached(p)); }
    catch (e) { console.error('MASTERCASE/extract', basename(p), (e as Error).message); }
  }
  if (!outputs.length) {
    await writeEnvelope({ caseId, status: 'error', updatedAt: new Date().toISOString(), error: 'kein Beleg extrahierbar' });
    return;
  }
  const mastercase = harmonize(outputs, out.household ?? {});
  await writeEnvelope({ caseId, status: 'ready', updatedAt: new Date().toISOString(), mastercase });
}

async function runSteuerfall(paths: string[], vz: number) {
  const t0 = process.hrtime.bigint();
  const orchUp = await pingOrchestrator(baseUrl);
  const r = await runLane1(paths, { vz, pool, parseDoc, parseImage: orchUp ? parseImage : undefined });
  const lane1Ms = Number(process.hrtime.bigint() - t0) / 1e6;

  const ocrSet = new Set(r.ocrFields);
  let fields: Array<Record<string, unknown>> = r.aggregated.map((f) => {
    const cat = catByECode().get(f.eCode);
    return {
      eCode: f.eCode, label: f.pdfLabel, wert: f.wert, person: String(f.person),
      anlage: f.anlage, method: ocrSet.has(`${f.eCode}|${f.person}`) ? 'ocr' : 'text',
      zeile: cat?.zeile || null, kontextPath: cat?.kontextPath || null,
    };
  });
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
    // Fremdjährige Belege (≠ VZ): NICHT in der Berechnung — Quelle für Prefill +
    // gezielte Rückfragen (vom Auditor zu Findings verarbeitet). null wenn keine.
    vorjahr: r.vorjahr ?? null,
  };
}

// ── Kurator-Chat: LLM über den GANZEN Fall (Optimierung + Jahresvergleich) ──
// Provider-agnostisch. Default: vLLM gemma4-mm (OpenAI-kompatibel, on-prem,
// 65K Kontext) — läuft sofort, kein Mock. Sobald ein gültiger Opus-Key
// vorliegt: KURATOR_MODEL=claude-… + KURATOR_API_KEY setzen → Anthropic-Pfad.
// Der zugrundeliegende Modellname erscheint NIE im UI ("der Kurator").
// Gemma-Pfad (on-prem, Default): OpenAI-kompatibel via vLLM.
const KURATOR_URL = process.env.KURATOR_URL ?? 'http://127.0.0.1:11435/v1/chat/completions';
const KURATOR_MODEL = process.env.KURATOR_MODEL ?? 'gemma4-mm';
// Opus-Pfad (Anthropic): nur aktiv, wenn der Client „opus" wählt UND ein
// gültiger Key vorliegt. Modell-ID env-überschreibbar (kein Modellname im UI).
const KURATOR_OPUS_MODEL = process.env.KURATOR_OPUS_MODEL ?? 'claude-opus-4-8';
const KURATOR_KEY = process.env.KURATOR_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? '';
const KURATOR_ANTHROPIC_URL = process.env.KURATOR_ANTHROPIC_URL ?? 'https://api.anthropic.com/v1/messages';
const KURATOR_MAX_TOKENS = Number(process.env.KURATOR_MAX_TOKENS ?? 1500);

const KURATOR_SYSTEM = [
  'Du bist „der Kurator" — ein erfahrener deutscher Steuerberater, der einen',
  'konkreten, bereits berechneten Steuerfall ganzheitlich prüft. Du bekommst',
  'den vollständigen Fall als JSON (Felder mit E-Codes/Werten, Bescheide/',
  'Erstattung, Haushalt, Veranlagungsart, Warnungen) und — falls vorhanden —',
  'die Belege des VORJAHRES als Vergleichsbasis.',
  '',
  'Deine Aufgaben:',
  '• Beantworte Fragen zum Fall präzise und in klarem Deutsch, mit Bezug auf',
  '  die konkreten Werte/Felder (nenne E-Codes/Beträge, wenn es hilft).',
  '• Schlage konkrete steuerliche OPTIMIERUNGEN vor (nicht ausgeschöpfte',
  '  Pauschalen, Werbungskosten, Sonderausgaben, …) — immer begründet.',
  '• Vergleiche VORJAHR ↔ Fall-Jahr: benenne auffällige Abweichungen und',
  '  Posten, die letztes Jahr da waren und diesmal fehlen; leite daraus',
  '  gezielte Rückfragen ab.',
  '• Fehlen Daten, fordere genau die fehlende Information an.',
  '',
  'Wichtig: Du gibst Hinweise, keine verbindliche Rechtsberatung — sag das bei',
  'Grenzfällen. Erfinde keine Werte; was nicht im Fall steht, benennst du als',
  'unbekannt. Antworte kompakt und strukturiert (kurze Absätze/Listen).',
].join('\n');

// Kompakter Fall-Kontext fürs Modell: nur entscheidungsrelevante Felder,
// keine schweren Blobs (PNG-Seiten, Box-Listen). Vorjahr separat ausgewiesen.
function kuratorContext(data: Record<string, unknown> | null | undefined): string {
  if (!data || typeof data !== 'object') return '{}';
  const d = data as Record<string, any>;
  const slim = {
    veranlagungsjahr: d.vz ?? null,
    veranlagungsart: d.veranlagungsart ?? null,
    begruendung: d.begruendung ?? null,
    haushalt: d.household ?? null,
    bescheide: Array.isArray(d.calcs) ? d.calcs.map((c: any) => ({
      einheit: c.einheit, erstattung: c.erstattung, angerechnet: c.angerechnet,
      bindend: c.bindend, abgleich: c.abgleich ?? null,
    })) : [],
    felder: Array.isArray(d.fields) ? d.fields.map((f: any) => ({
      eCode: f.eCode, label: f.label, wert: f.wert, person: f.person, anlage: f.anlage,
    })) : [],
    warnungen: d.warnings ?? [],
    vorjahr: d.vorjahr ?? null,
  };
  try { return JSON.stringify(slim); } catch { return '{}'; }
}

// SSE-Streaming des Kurators an den Browser. Normalisiert beide Provider auf
// EIN Wire-Format: `data: {"delta":"…"}` je Token, Abschluss `data: {"done":true}`,
// Fehler `data: {"error":"…"}`. Der Client bleibt dadurch provider-agnostisch.
async function streamKurator(
  res: ServerResponse,
  messages: Array<{ role: string; content: string }>,
  caseData: Record<string, unknown> | null,
  choice: string,
): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  let closed = false;
  res.on('close', () => { closed = true; });
  const ctx = kuratorContext(caseData);
  const useOpus = choice === 'opus';                       // Modellwahl des Clients
  const model = useOpus ? KURATOR_OPUS_MODEL : KURATOR_MODEL;
  const turns = messages
    .filter((m) => m && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
  try {
    let r: Response;
    if (useOpus) {
      if (!KURATOR_KEY) { send({ error: 'Opus 4.8: kein gültiger API-Key gesetzt (KURATOR_API_KEY/ANTHROPIC_API_KEY). Auf „Gemma" umschalten.' }); send({ done: true }); return void res.end(); }
      r = await fetch(KURATOR_ANTHROPIC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': KURATOR_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: KURATOR_MAX_TOKENS, stream: true,
          system: `${KURATOR_SYSTEM}\n\nFALL (JSON):\n${ctx}`, messages: turns }),
      });
    } else {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (KURATOR_KEY) headers.Authorization = `Bearer ${KURATOR_KEY}`;
      r = await fetch(KURATOR_URL, {
        method: 'POST', headers,
        body: JSON.stringify({ model, max_tokens: KURATOR_MAX_TOKENS, temperature: 0.3, stream: true,
          messages: [{ role: 'system', content: `${KURATOR_SYSTEM}\n\nFALL (JSON):\n${ctx}` }, ...turns] }),
      });
    }
    if (!r.ok || !r.body) {
      const detail = r.ok ? 'kein Stream' : `HTTP ${r.status}`;
      send({ error: `Kurator-LLM nicht verfügbar (${detail}).` }); send({ done: true }); return void res.end();
    }
    // Web-Stream-Reader (versions-robust, kein for-await auf res.body nötig).
    const reader = (r.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      if (closed) { try { await reader.cancel(); } catch { /* socket weg */ } break; }
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;            // SSE: nur data-Zeilen
        const payload = line.slice(5).trim();
        if (payload === '[DONE]' || !payload) continue;     // OpenAI-Sentinel
        try {
          const ev = JSON.parse(payload);
          const delta = useOpus
            ? (ev.type === 'content_block_delta' ? ev.delta?.text : '')   // Anthropic
            : ev.choices?.[0]?.delta?.content;                            // OpenAI/vLLM
          if (delta) send({ delta });
        } catch { /* Ping/Keep-alive-Zeile → ignorieren */ }
      }
    }
    send({ done: true });
  } catch (e) {
    send({ error: 'Kurator nicht erreichbar: ' + (e as Error).message }); send({ done: true });
  }
  res.end();
}

createServer(async (req, res) => {
  try {
    const url = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      // no-cache: Browser muss die HTML-Shell revalidieren → Deploys schlagen
      // sofort durch (sonst hält der Browser eine alte index.html und neue
      // Features wie der Mastercase-Poller laden nie).
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' });
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
    if (req.method === 'GET' && url === '/api/trace') {
      // Prozess-Trace eines Runs für den Flow-Tab: reicht tornados
      // GET /api/v1/trace/:dochash durch (Phasen 0–4 + Lane-2 vLLM-
      // Prompts/Antworten + Timing). ?h=<dochash> (hex). Token-frei,
      // gleicher Scope wie /api/page.
      const q = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
      const h = (q.get('h') ?? '').replace(/[^a-f0-9]/g, '').slice(0, 64);
      if (!h) return json(res, 400, { error: 'trace: ?h=<dochash> fehlt' });
      // Bild-Belege (JPG/PNG/…) werden vor /extract zu einem asimg.pdf gerastert;
      // tornado schlüsselt den Trace nach document_sha256 = sha DIESER Bytes, NICHT
      // nach der Original-Datei-sha, die das Frontend als docs[].hash führt. Über den
      // Extract-Cache (derselbe Aufruf, der auch den Trace erzeugt) Original-Hash →
      // document_sha256 auflösen. PDFs: sha identisch → no-op; kein Cache → Original.
      let traceHash = h;
      try {
        const ecf = join(MASTERCASE_DIR, h + '.extract.json');
        if (existsSync(ecf)) {
          const eo = JSON.parse(readFileSync(ecf, 'utf8')) as { document_sha256?: string };
          const ds = (eo.document_sha256 ?? '').replace(/[^a-f0-9]/gi, '').toLowerCase();
          if (ds.length === 64) traceHash = ds;
        }
      } catch { /* Cache fehlt/korrupt → Original-Hash versuchen */ }
      try {
        const r = await fetch(`${baseUrl}/api/v1/trace/${traceHash}`);
        const text = await r.text();
        res.writeHead(r.status, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        res.end(text);
      } catch (e) {
        return json(res, 502, { error: 'tornado trace unreachable: ' + (e as Error).message });
      }
      return;
    }
    if (req.method === 'POST' && url === '/api/steuerfall') {
      const { paths, vz, caseId } = JSON.parse((await body(req)).toString('utf8'));
      if (!Array.isArray(paths) || paths.length === 0) return json(res, 400, { error: 'keine Dateien' });
      const cid = String(caseId ?? ('c' + Date.now()));
      const out = await runSteuerfall(paths, Number(vz) || 2023);
      // Hintergrund-Harmonizer fire-and-forget: KEIN await → die Pre-Calc-Antwort
      // geht sofort raus. Promise selbst mit .catch absichern, weil ein unhandled
      // rejection nach gesendeter Antwort den Prozess kippen könnte (der Handler-
      // try/catch greift dann nicht mehr).
      void kickMastercase(cid, out, paths).catch((e) => console.error('MASTERCASE', (e as Error).message));
      return json(res, 200, { ...out, caseId: cid, mastercaseStatus: 'pending' });
    }
    if (req.method === 'GET' && url === '/api/mastercase') {
      // Polling-Endpoint (read-only): harmonisierter Mastercase je caseId.
      // caseId härten wie /api/page → kein Path-Traversal.
      const q = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
      const id = (q.get('id') ?? '').replace(/[^\w.-]/g, '_');
      const f = id ? mcFile(id) : '';
      if (!id || !existsSync(f)) return json(res, 200, { status: 'pending' });
      try { return json(res, 200, JSON.parse(readFileSync(f, 'utf8'))); }
      catch { return json(res, 200, { status: 'pending' }); }
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
    // Kurator-Chat (SSE): ganzer Fall + Verlauf → gestreamte Antwort. Modell
    // on-prem (vLLM), per Env auf Opus umstellbar. Siehe streamKurator.
    if (req.method === 'POST' && url === '/api/chat') {
      let payload: { messages?: Array<{ role: string; content: string }>; case?: Record<string, unknown>; model?: string };
      try { payload = JSON.parse((await body(req)).toString('utf8')); }
      catch { return json(res, 400, { error: 'kein JSON' }); }
      const messages = Array.isArray(payload?.messages)
        ? payload.messages.filter((m) => m && typeof m.content === 'string').slice(-20)
        : [];
      if (!messages.length) return json(res, 400, { error: 'keine Nachricht' });
      const choice = payload?.model === 'opus' ? 'opus' : 'gemma';
      await streamKurator(res, messages, payload?.case ?? null, choice);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
  } catch (e) {
    console.error('ERR', (e as Error).stack);
    json(res, 500, { ok: false, error: (e as Error).message });
  }
}).listen(PORT, '0.0.0.0', () => console.log(`Steuerfall-Web on http://0.0.0.0:${PORT} (orchestrator ${baseUrl})`));
