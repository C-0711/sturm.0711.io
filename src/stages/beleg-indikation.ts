/**
 * beleg-indikation — fast first-look stage. Runs IN PARALLEL with OCR.
 *
 * Schickt direkt das Bild (oder erste PDF-Seite) an Mistral Small Vision
 * und fragt nach (a) den relevanten ELSTER-Anlagen und (b) den wichtigsten
 * im Dokument sichtbaren Werten (Beträge, Namen, Datum, Belegtyp).
 *
 * Ziel: Das UI hat innerhalb von ~1-3 s eine Indikation
 *   "KAP, VOR · Sparkasse Westerwald-Sieg · 5,06 € Kapitalerträge"
 * während Gemma-4 OCR noch ~25 s am Volltext arbeitet. Im UI taucht NIE
 * der Modellname auf — nur Anlagen + Werte.
 *
 * STRICT: kein Fallback. Fehler bubbeln (das Round-1-Signal entfällt, der
 * Rest der Pipeline läuft unverändert weiter — Indikation ist nicht
 * blockierend für die Extraktion).
 */
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { defineStage } from '../core/stage.ts';
import { renderPdfToPng } from '../lib/pdf-render.ts';

export interface BelegIndikationInput {
  filePath: string;
  filename: string;
}

export interface BelegIndikationConfig {
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  /** PDF render dpi für erste Seite. Default 150 (schneller als OCR's 200). */
  dpi?: number;
  /** Timeout pro Call. Default 15s. */
  timeoutMs?: number;
}

export interface BelegIndikationOutput {
  anlagen: string[];
  belegtyp: string | null;
  wichtige_werte: Array<{ label: string; value: string }>;
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

const PROMPT = [
  'Du bekommst ein Foto / Scan eines Steuer-Belegs. Liefere SCHNELL eine',
  'Voranzeige für den Nutzer, während die richtige OCR-Pipeline noch läuft.',
  '',
  'Antworte mit STRICT JSON:',
  '{',
  '  "belegtyp": "<knapp, z.B. Lohnsteuerbescheinigung, Steuerbescheinigung Bank, Rentenbezugsmitteilung, Quittung, Rechnung, Stammdaten>",',
  '  "anlagen": ["<CODE>", ...],',
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
  '- 1-3 Anlagen sind typisch; nie raten, nur was klar belegt ist',
  '- wichtige_werte: 2-5 Einträge, das was ein Nutzer auf einen Blick erfasst',
  '- Beträge mit Währung (z.B. "5,06 €"), Daten als DD.MM.YYYY',
  '- KEINE Erklärung, KEIN Markdown, NUR das JSON-Objekt',
].join('\n');

async function firstPageImage(filePath: string, filename: string, dpi: number): Promise<Buffer> {
  const ext = extname(filename).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
    return readFile(filePath);
  }
  if (ext !== '.pdf') {
    throw new Error(`beleg-indikation: unsupported extension ${ext}`);
  }
  const rendered = await renderPdfToPng(filePath, { dpi, maxPages: 1 });
  if (rendered.pngPaths.length === 0) throw new Error('beleg-indikation: no pages rendered');
  return readFile(rendered.pngPaths[0]);
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
    const t0 = Date.now();
    const baseUrl = ctx.config?.baseUrl ?? 'https://api.mistral.ai';
    const model = ctx.config?.model ?? 'mistral-small-latest';
    const dpi = ctx.config?.dpi ?? 150;
    const maxTokens = ctx.config?.maxTokens ?? 800;
    const timeoutMs = ctx.config?.timeoutMs ?? 15_000;
    const apiKey = process.env['MISTRAL_API_KEY']; // lint-no-env: round-1 indication uses Mistral API directly
    if (!apiKey) throw new Error('beleg-indikation: MISTRAL_API_KEY env nicht gesetzt');

    const img = await firstPageImage(input.filePath, input.filename, dpi);
    const b64 = img.toString('base64');

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: PROMPT },
              { type: 'image_url', image_url: `data:image/png;base64,${b64}` },
            ],
          }],
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`beleg-indikation HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const raw = data.choices?.[0]?.message?.content ?? '{}';
      let parsed: { belegtyp?: string; anlagen?: string[]; wichtige_werte?: Array<{ label?: string; value?: string }> } = {};
      try { parsed = JSON.parse(raw); } catch { /* keep empty */ }
      const allowed = new Set(ALLOWED_ANLAGEN);
      const anlagen = (parsed.anlagen ?? [])
        .map((a) => String(a).trim())
        .filter((a) => allowed.has(a));
      const belegtyp = typeof parsed.belegtyp === 'string' ? parsed.belegtyp.trim() : null;
      const wichtige_werte = (parsed.wichtige_werte ?? [])
        .filter((e) => e && typeof e === 'object')
        .map((e) => ({
          label: String(e.label ?? '').trim(),
          value: String(e.value ?? '').trim(),
        }))
        .filter((e) => e.label && e.value)
        .slice(0, 6);

      const ms = Date.now() - t0;
      const result = { anlagen, belegtyp, wichtige_werte, ms };
      ctx.emit('beleg_indikation', result);
      await ctx.artifacts.write('indikation.json', result);
      return result;
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
    }
  },
});
