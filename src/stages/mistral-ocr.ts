import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { defineStage } from '../core/stage.ts';

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export interface MistralOcrInput {
  /** Absoluter Dateipfad (vom Workflow-Input durchgereicht). */
  filePath: string;
  /** Ursprünglicher Dateiname — bestimmt MIME-Type über Extension. */
  filename: string;
  /**
   * Optionales dynamisches Schema-Override. Wenn gesetzt, überschreibt es
   * `config.schema`. Nützlich wenn eine vorherige Stage das Schema baut
   * (z.B. Schema-Bau → Mistral kuratiert).
   */
  schema?: Record<string, unknown>;
  /** Optionaler Schema-Name-Override. */
  schemaName?: string;
}

export interface MistralOcrConfig {
  /** Optionales JSON-Schema für strukturierte Annotation. */
  schema?: Record<string, unknown>;
  /** Name für die Schema-Annotation. */
  schemaName?: string;
  /** Modell-Override; default mistral-ocr-latest. */
  model?: string;
}

export interface MistralOcrOutput {
  model: string;
  pages: Array<{ index: number; markdown: string; chars: number }>;
  text: string;
  chars: number;
  annotation: unknown | null;
  ms: number;
}

/**
 * Generische Mistral-OCR-Stage. Liefert Markdown + optional strukturierte JSON-Annotation.
 * Port aus legacy/elster-mvp/server.mjs:200-274.
 */
export const mistralOcrStage = defineStage<MistralOcrInput, MistralOcrOutput, MistralOcrConfig>({
  id: 'mistral-ocr',
  name: 'Mistral OCR',
  description: 'OCR via Mistral, optional mit JSON-Schema-Annotation',

  async run(input, ctx) {
    const apiKey = process.env.MISTRAL_API_KEY;
    if (!apiKey) throw new Error('MISTRAL_API_KEY nicht gesetzt');
    if (!input?.filePath) throw new Error('mistral-ocr: filePath fehlt');
    if (!input?.filename) throw new Error('mistral-ocr: filename fehlt');

    const ext = path.extname(input.filename).toLowerCase();
    const mime = MIME[ext] ?? 'application/octet-stream';
    const isImage = mime.startsWith('image/');

    const buf = await fs.readFile(input.filePath);
    const dataUri = `data:${mime};base64,${buf.toString('base64')}`;
    ctx.logger.debug(`OCR eingabe: ${input.filename} (${buf.length} Bytes, ${mime})`);

    const document = isImage
      ? { type: 'image_url', image_url: dataUri }
      : { type: 'document_url', document_url: dataUri };

    const body: Record<string, unknown> = {
      model: ctx.config.model ?? 'mistral-ocr-latest',
      document,
    };
    const schema = input.schema ?? ctx.config.schema;
    const schemaName = input.schemaName ?? ctx.config.schemaName;
    if (schema) {
      body.document_annotation_format = {
        type: 'json_schema',
        json_schema: {
          name: schemaName ?? 'Extraction',
          schema,
          strict: true,
        },
      };
    }

    const t0 = Date.now();
    const resp = await fetch('https://api.mistral.ai/v1/ocr', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctx.signal,
    });
    const ms = Date.now() - t0;
    const raw = await resp.text();

    if (!resp.ok) {
      throw new Error(`Mistral OCR HTTP ${resp.status}: ${raw.slice(0, 400)}`);
    }

    let json: any;
    try { json = JSON.parse(raw); } catch { throw new Error(`Mistral OCR: kein valides JSON (${raw.slice(0, 200)})`); }

    const pages = (json.pages ?? []).map((p: any, i: number) => ({
      index: p.index ?? i,
      markdown: p.markdown ?? p.text ?? '',
      chars: (p.markdown ?? p.text ?? '').length,
    }));
    const text = pages.map((p: any) => p.markdown).join('\n\n');

    let annotation: unknown = null;
    if (json.document_annotation) {
      annotation = json.document_annotation;
      // Mistral doppel-encodet manchmal; bis zu 3x parsen
      for (let i = 0; i < 3 && typeof annotation === 'string'; i++) {
        try { annotation = JSON.parse(annotation as string); } catch { break; }
      }
    }

    ctx.emit('ocr_pages', { count: pages.length, chars: text.length });

    return {
      model: json.model ?? 'mistral-ocr-latest',
      pages,
      text,
      chars: text.length,
      annotation,
      ms,
    };
  },
});
