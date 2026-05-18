/**
 * beleg-indikation — fast first-look stage. Runs IN PARALLEL with OCR.
 *
 * Schickt direkt das Bild (oder PDF-Seiten) an Gemma-4 vLLM Vision
 * und fragt nach (a) den relevanten ELSTER-Anlagen und (b) den wichtigsten
 * im Dokument sichtbaren Werten (Beträge, Namen, Datum, Belegtyp).
 *
 * Ziel: Das UI hat innerhalb von ~3-6 s eine Indikation in der Form
 *   "<Anlagen> · <Belegtyp> · <Empfänger> · <Schlüsselwerte>"
 * während die Voll-Extraktion noch läuft. Im UI taucht NIE
 * der Modellname auf — nur Anlagen + Werte aus dem konkreten Beleg.
 *
 * 2026-05-18: alles auf Gemma-4 vLLM (lokal) vereinheitlicht.
 * vLLM continuous-batching + max-num-seqs=16 + image-limit=10 verträgt
 * parallele Upload-Indikationen ohne Queue-Stau.
 *
 * STRICT: kein Fallback. Fehler bubbeln (das Round-1-Signal entfällt, der
 * Rest der Pipeline läuft unverändert weiter — Indikation ist nicht
 * blockierend für die Extraktion).
 */
import { readFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defineStage } from '../core/stage.ts';

const execFileP = promisify(execFile);

export interface BelegIndikationInput {
  filePath: string;
  filename: string;
}

export interface BelegIndikationConfig {
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  /** PDF render dpi. Default 150 (schneller als OCR's 200). */
  dpi?: number;
  /** Timeout pro Call. Default 30s + 5s pro zusätzlicher Seite. */
  timeoutMs?: number;
  /** Maximale Seiten die an Mistral geschickt werden (eine Multi-Page-Call).
   *  Default 32 — Mistral Small Vision verträgt das problemlos. */
  maxPages?: number;
}

export interface BelegIndikationOutput {
  /** Union aller anlagen über alle erkannten Belege. */
  anlagen: string[];
  /** Belegtyp — aggregiert wenn Multi-Doc-PDF (z.B. "2× Kapitalerträge +
   *  Religionsbescheinigung"), sonst einzelner Belegtyp. null wenn nichts. */
  belegtyp: string | null;
  /** Wichtige Werte aus dem gesamten Dokument (max 6). */
  wichtige_werte: Array<{ label: string; value: string }>;
  /** Steuerjahr des Belegs (z.B. 2024) — aus OCR-Text extrahiert.
   *  null wenn nicht eindeutig ableitbar. Multi-Doc-PDFs mit gemischten
   *  Jahren liefern das DOMINIERENDE Jahr. */
  steuerjahr: number | null;
  /** Anzahl gerenderter/analysierter Seiten. */
  seiten_analysiert: number;
  ms: number;
}

const ALLOWED_ANLAGEN = [
  'ESt1A', 'ESt1A_U', 'Vorsatz',
  'N', 'N_AUS', 'N_DHH', 'N_GRE',
  'KAP', 'KAP_BET', 'KAP_I',
  'SA', 'VOR', 'AV', 'RAV_bAV',
  'AgB', 'HA_35a', 'EM_35c',
  'V', 'V_FeWo', 'V_Sonstige',
  'G', 'S', 'L', 'FW',
  'R', 'R_AUS', 'AUS', 'SO',
  'Kind', 'Mob', 'WA_ESt', 'Anl_34b',
  'Zins', 'Corona', 'Sonst',
];

// EIN Prompt für single + multi page. Mistral sieht alle Bilder gleichzeitig
// und liefert EIN aggregiertes Ergebnis: Belegtyp-Beschreibung (bei multi
// als "2× X + Y" formuliert), Union der Anlagen, wichtige Werte.
const PROMPT = (pageCount: number) => [
  pageCount > 1
    ? `Du bekommst die ${pageCount} Seiten eines Steuer-Belegs-PDFs in Reihenfolge.`
    : 'Du bekommst ein Foto / Scan eines Steuer-Belegs.',
  pageCount > 1
    ? 'WICHTIG: das PDF kann mehrere unabhängige Belege enthalten (z.B. VAST-Bundle'
      + ' mit Religionsbescheinigung + Kapitalertrag-Mitteilungen + Lohnsteuer-'
      + 'bescheinigung gemischt).'
    : '',
  'Liefere eine kompakte Voranzeige für den Nutzer.',
  '',
  'Antworte mit STRICT JSON:',
  '{',
  '  "belegtyp": "<knapper Belegtyp; bei mehreren Belegen aggregiert, z.B.',
  '                \'Lohnsteuerbescheinigung\' oder \'2× Mitteilung Kapitalerträge + Religionsbescheinigung\'>",',
  '  "anlagen": ["<CODE>", ...],',
  '  "steuerjahr": <YYYY oder null>,',
  '  "wichtige_werte": [',
  '    {"label": "Empfänger", "value": "..."},',
  '    {"label": "Aussteller", "value": "..."},',
  '    {"label": "Betrag", "value": "..."},',
  '    {"label": "Datum", "value": "..."}',
  '  ]',
  '}',
  '',
  'Regeln:',
  '- anlagen NUR aus dieser Liste: ' + ALLOWED_ANLAGEN.join(', '),
  '- anlagen ist UNION aller Belege im Dokument, OHNE Duplikate (z.B. ["KAP","ESt1A"])',
  '- belegtyp: bei mehreren Belegen Form "N× Typ + Typ" verwenden',
  '  (Wiederholungen mit N×, gleiche Bezeichnungen zusammenfassen)',
  '- wichtige_werte: 2-5 Einträge die der Nutzer auf einen Blick erfasst',
  '- Beträge mit Währung (z.B. "5,06 €"), Daten als DD.MM.YYYY',
  '- KEINE Erklärung, KEIN Markdown, NUR das JSON-Objekt',
  '',
  'WICHTIGES Mapping (Bescheinigung → Anlage-Code):',
  '  Religionsbescheinigung / Kirchensteuer-Stammdaten  → "ESt1A"  (NICHT "R"!)',
  '  Lohnsteuerbescheinigung / Brutto-Arbeitslohn       → "N"      (NICHT "L"!)',
  '  Lohnsteuerbeschein. mit Nr. 22-26 (SV-Beiträge)    → "N" + "VOR"',
  '  Mitteilung Kapitalerträge / Steuerbesch. Bank      → "KAP"',
  '  Rentenbezugsmitteilung (DRV)                        → "R"',
  '  Anlage Land- und Forstwirtschaft                    → "L"',
  '  Spendenquittung / KV-Beitragsbescheinigung          → "SA" / "VOR"',
  '  ELSTER-Hauptvordruck Einkommensteuererklärung       → "ESt1A"',
  '',
  'Steuerjahr-Erkennung:',
  '  - Lohnsteuerbescheinigung "für 2024" → 2024',
  '  - Mitteilung Kapitalerträge "Kalenderjahr 2023" → 2023',
  '  - ELSTER-Erklärung "Einkommensteuererklärung 2023" → 2023',
  '  - Stammdaten ohne klares Jahr (Religionsbescheinigung allgemein) → null',
  '  - Bei Mehrfach-Belegen mit gemischten Jahren: das DOMINIERENDE Jahr',
].filter(Boolean).join('\n');

/** Rendert bis zu maxPages des PDFs/Bilds und gibt PNG-Buffers + page-count zurück. */
async function pagesAsImages(
  filePath: string, filename: string, dpi: number, maxPages: number,
): Promise<{ buffers: Buffer[]; totalPages: number }> {
  const ext = extname(filename).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
    return { buffers: [await readFile(filePath)], totalPages: 1 };
  }
  if (ext !== '.pdf') {
    throw new Error(`beleg-indikation: unsupported extension ${ext}`);
  }
  // Erst pdfinfo um Gesamtseitenzahl zu bestimmen (für Multi-Doc-Erkennung).
  let totalPages = 1;
  try {
    const { stdout } = await execFileP('pdfinfo', [filePath]);
    const m = stdout.match(/^Pages:\s+(\d+)/m);
    if (m) totalPages = Number(m[1]);
  } catch { /* fallback: rendere bis max und zähle */ }
  const renderPages = Math.min(totalPages, maxPages);
  const dir = await mkdtemp(join(tmpdir(), 'sturm-indikation-'));
  try {
    await execFileP('pdftoppm', [
      '-r', String(dpi),
      '-f', '1', '-l', String(renderPages),
      '-png',
      filePath,
      join(dir, 'p'),
    ]);
    const entries = (await readdir(dir)).filter((f) => f.endsWith('.png')).sort();
    if (entries.length === 0) throw new Error('beleg-indikation: pdftoppm produced no PNG');
    const buffers = await Promise.all(entries.map((e) => readFile(join(dir, e))));
    return { buffers, totalPages };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Pure helper: runs the same Mistral Small Vision call as the stage but
 * without StageContext. Used by the bulk-upload handler to fire eager
 * indications for ALL uploaded files in parallel (ungethrottelt) so the
 * UI sees Anlagen + wichtige Werte within ~3s for the whole batch.
 */
export async function runBelegIndikation(
  input: BelegIndikationInput,
  cfg?: BelegIndikationConfig,
  signal?: AbortSignal,
): Promise<BelegIndikationOutput> {
  const t0 = Date.now();
  // Default: Gemma-4 vLLM lokal. VLLM_URL aus env (Container-Setup).
  // vLLM-Image-Limit aktuell 10 → maxPages 10 (war Mistral 32).
  const baseUrl = cfg?.baseUrl ?? process.env['VLLM_URL'] ?? 'http://host.docker.internal:11435'; // lint-no-env: beleg-indikation
  const model = cfg?.model ?? 'gemma4-mm';
  const dpi = cfg?.dpi ?? 150;
  const maxPages = cfg?.maxPages ?? 10;

  const { buffers } = await pagesAsImages(input.filePath, input.filename, dpi, maxPages);
  const pageCount = buffers.length;
  // Token-budget + Timeout skalieren mit Seitenzahl.
  const maxTokens = cfg?.maxTokens ?? Math.min(2000, 600 + 60 * pageCount);
  const timeoutMs = cfg?.timeoutMs ?? Math.min(180_000, 30_000 + 5_000 * pageCount);

  const allowed = new Set(ALLOWED_ANLAGEN);
  const imageContents = buffers.map((buf) => ({
    type: 'image_url' as const,
    image_url: { url: `data:image/png;base64,${buf.toString('base64')}` },
  }));

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, max_tokens: maxTokens, temperature: 0,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: [
          { type: 'text', text: PROMPT(pageCount) },
          ...imageContents,
        ] }],
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`beleg-indikation HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = data.choices?.[0]?.message?.content ?? '{}';
    let parsed: {
      belegtyp?: string; anlagen?: string[];
      steuerjahr?: number | string | null;
      wichtige_werte?: Array<{ label?: string; value?: string }>;
    } = {};
    try { parsed = JSON.parse(raw); } catch { /* keep empty */ }
    const anlagen = [...new Set(
      (parsed.anlagen ?? []).map((a) => String(a).trim()).filter((a) => allowed.has(a))
    )];
    const belegtyp = typeof parsed.belegtyp === 'string' ? parsed.belegtyp.trim() : null;
    // steuerjahr: number, oder string-Number wie "2024", oder null. Range-check.
    let steuerjahr: number | null = null;
    if (parsed.steuerjahr != null) {
      const n = Number(parsed.steuerjahr);
      if (Number.isFinite(n) && n >= 2000 && n <= 2100) steuerjahr = Math.floor(n);
    }
    const wichtige_werte = (parsed.wichtige_werte ?? [])
      .filter((e) => e && typeof e === 'object')
      .map((e) => ({ label: String(e.label ?? '').trim(), value: String(e.value ?? '').trim() }))
      .filter((e) => e.label && e.value)
      .slice(0, 6);
    return {
      anlagen, belegtyp, wichtige_werte, steuerjahr,
      seiten_analysiert: pageCount,
      ms: Date.now() - t0,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export const belegIndikationStage = defineStage<
  BelegIndikationInput,
  BelegIndikationOutput,
  BelegIndikationConfig
>({
  id: 'beleg-indikation',
  name: 'Beleg-Indikation (Round-1 Vorschau)',
  description:
    'Schnelle Vorschau: schickt das Bild (oder erste PDF-Seite) an ein Vision-LLM ' +
    'und liefert binnen ~1-3 s erkannte Anlagen + die wichtigsten Werte. Läuft ' +
    'parallel zur OCR — das UI bekommt sofort Feedback, während die echte ' +
    'Extraktion noch arbeitet. NICHT die Quelle für die finale Extraktion.',
  hints: {
    inputs: 'filePath, filename',
    outputs: 'anlagen, belegtyp, wichtige_werte[{label,value}], ms',
    inputPorts: [
      { name: 'filePath', type: 'file-path' },
      { name: 'filename', type: 'string' },
    ],
    outputPorts: [
      { name: 'anlagen', type: 'json' },
      { name: 'belegtyp', type: 'string' },
      { name: 'wichtige_werte', type: 'json' },
    ],
  },

  async run(input, ctx) {
    // Stage-Pfad delegiert an die pure Funktion (gleicher Code-Pfad wie
    // upload-bulk eager Indikation) — vermeidet Duplikat-Logic für
    // single- vs. multi-page handling.
    const result = await runBelegIndikation(
      input,
      {
        baseUrl: ctx.config?.baseUrl,
        model: ctx.config?.model,
        dpi: ctx.config?.dpi,
        maxTokens: ctx.config?.maxTokens,
        timeoutMs: ctx.config?.timeoutMs,
        maxPages: ctx.config?.maxPages,
      },
      ctx.signal,
    );
    ctx.emit('beleg_indikation', result);
    await ctx.artifacts.write('indikation.json', result);
    return result;
  },
});
