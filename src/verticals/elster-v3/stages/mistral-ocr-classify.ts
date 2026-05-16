/**
 * elster/mistral-ocr-classify — OCR + ELSTER-Anlagen-Klassifikation in EINEM
 * Mistral-Cloud-Call. Nutzt die native `documentAnnotation`-Facility der
 * Mistral-OCR-API (kein Zweit-Roundtrip, keine doppelte File-Upload).
 *
 * Output ist Drop-in-kompatibel zur bestehenden `mistral-ocr`-Stage
 * (model/pages/text/chars/ms/parsed) — zusätzlich liefert sie:
 *   • erkannte_anlagen: string[]   (ELSTER-Anlagen-IDs)
 *   • primaryForm: string | null   (Hauptvordruck wenn klar erkennbar)
 *   • classifyConfidence: number   (0..1, vom Modell selbstgemeldet)
 *
 * Damit kann der downstream-`klassifizierung`-Stage in v5_2-rag den
 * Pass-1-Regex-Lauf skippen und direkt `erkannte_anlagen` konsumieren.
 *
 * Warum hier (im elster-Vertical) statt in src/stages/?
 *   Die Anlagen-Enum ist ELSTER-spezifisch. Generische OCR bleibt agnostisch.
 */
import { defineStage } from '../../../core/stage.ts';
import {
  callMistralOcrWithFallback,
  configToApiRequest,
  getFileSignedUrl,
  mimeFromFilename,
  parseApiResponse,
  uploadFile,
  type DocumentChunk,
  type MistralOcrConfig as FullConfig,
  type ParsedOcrResponse,
} from '../../../lib/mistral-ocr/index.ts';

// Kanonische Anlagen-IDs (synchron mit src/verticals/elster/stages/klassifizierung.ts PATTERNS-Map).
// Hauptvordrucke + alle Anlagen die der Pass-1-Regex kennt.
const ELSTER_ANLAGEN_IDS = [
  // Hauptvordruck
  'ESt1A', 'ESt1A_U', 'Vorsatz',
  // N-Familie (Arbeitslohn)
  'N', 'N_AUS', 'N_DHH', 'N_GRE',
  // Kapitalerträge
  'KAP', 'KAP_I', 'KAP_BET',
  // Sonderausgaben / Vorsorge / Altersvorsorge
  'SA', 'VOR', 'AV', 'RAV_bAV',
  // Außergewöhnliche Belastungen / Handwerker
  'AgB', 'HA_35a', 'EM_35c',
  // Vermietung
  'V', 'V_FeWo', 'V_Sonstige',
  // Gewerbe / Selbständig / Land
  'G', 'S', 'L', 'FW',
  // Renten
  'R', 'R_AUS',
  // Ausland / Sonstige
  'AUS', 'SO',
  // Kinder / Mobilität
  'Kind', 'Mob',
] as const;

// Schema deliberately konservativ: Mistral-OCR-API lehnt `uniqueItems`,
// `type: [..., 'null']`-Unions und `minimum/maximum` als "Invalid structured
// output syntax" (3700). Hier nur primitive types + enum + required.
const DOCUMENT_ANNOTATION_SCHEMA = {
  type: 'object',
  properties: {
    erkannte_anlagen: {
      type: 'array',
      description:
        'Liste ALLER ELSTER-Anlagen-IDs in diesem Dokument. Multiseiten-Erklärungen enthalten mehrere Anlagen (z.B. ESt1A + N + KAP + AV). Hauptindikator: Form-Header "Anlage N", "Anlage KAP", "Hauptvordruck ESt 1 A".',
      items: { type: 'string', enum: ELSTER_ANLAGEN_IDS as unknown as string[] },
    },
    primary_form: {
      type: 'string',
      description:
        'Hauptvordruck wenn klar erkennbar (z.B. "ESt1A" bei kompletter Erklärung). Bei reinem Beleg wie Lohnsteuerbescheinigung leer/weglassen.',
    },
    classify_confidence: {
      type: 'number',
      description: 'Sicherheit 0..1 (0=raten, 1=eindeutiger Form-Header sichtbar).',
    },
  },
  required: ['erkannte_anlagen', 'classify_confidence'],
} as const;

const DOCUMENT_ANNOTATION_PROMPT =
  'Identifiziere ALLE ELSTER-Steuerformulare und Anlagen, die in diesem Dokument vorkommen. ' +
  'Achte auf Form-Header wie "Anlage N", "Anlage KAP", "Anlage KAP-INV", "Hauptvordruck ESt 1 A". ' +
  'Bei Belegen ohne expliziten Form-Header (z.B. Lohnsteuerbescheinigung, Bankauszug) ordne der ' +
  'passenden Anlage zu (Lohnsteuerbescheinigung → "N", Steuerbescheinigung Bank → "KAP"). ' +
  'Liste ALLE gefundenen Anlagen in erkannte_anlagen — auch wenn nur eine Seite zu einer Anlage gehört.';

export interface MistralOcrClassifyInput {
  filePath: string;
  filename: string;
  /** Optional: bereits hochgeladene file_id wiederverwenden. */
  fileId?: string;
}

export interface MistralOcrClassifyOutput {
  // Drop-in-kompatibel zur mistral-ocr Stage
  model: string;
  pages: Array<{ index: number; markdown: string; chars: number }>;
  text: string;
  chars: number;
  annotation: unknown | null;
  ms: number;
  parsed: ParsedOcrResponse;
  // Neue Klassifikations-Outputs
  erkannte_anlagen: string[];
  primary_form: string | null;
  classify_confidence: number;
  classify_source: 'ocr_annotation' | 'fallback_empty';
}

export type MistralOcrClassifyConfig = Omit<FullConfig, 'documentAnnotation'>;

export const mistralOcrClassifyStage = defineStage<
  MistralOcrClassifyInput,
  MistralOcrClassifyOutput,
  MistralOcrClassifyConfig
>({
  id: 'elster/mistral-ocr-classify',
  name: 'Mistral OCR + Klassifizierung',
  description:
    'OCR via Mistral mit gleichzeitiger ELSTER-Anlagen-Klassifikation. ' +
    'Spart einen separaten Pass-1-Regex-Lauf — die Anlagen-IDs kommen ' +
    'direkt aus dem documentAnnotation der OCR-Response.',
  hints: {
    inputs: 'filePath, filename · optional: fileId',
    outputs:
      'text, pages, chars, erkannte_anlagen[], primary_form, classify_confidence, ms, parsed',
    configExample: '{"model": "mistral-ocr-latest"}',
    inputPorts: [
      { name: 'filePath', type: 'file-path', description: 'Absolute filesystem path' },
      { name: 'filename', type: 'string', description: 'Original filename' },
    ],
    outputPorts: [
      { name: 'text', type: 'text', description: 'Concatenated markdown of all pages' },
      { name: 'pages', type: 'pages' },
      { name: 'erkannte_anlagen', type: 'json', description: 'Detected ELSTER Anlage IDs' },
      { name: 'primary_form', type: 'string' },
      { name: 'classify_confidence', type: 'number' },
    ],
  },

  async run(input, ctx) {
    if (!input?.filePath) throw new Error('mistral-ocr-classify: filePath fehlt');
    if (!input?.filename) throw new Error('mistral-ocr-classify: filename fehlt');

    const cfg: FullConfig = {
      ...(ctx.config ?? {}),
      // ELSTER-spezifisches Annotation-Schema fest einbacken — User-Config
      // darf das NICHT überschreiben (wäre ein anderes Feature).
      documentAnnotation: {
        schema: DOCUMENT_ANNOTATION_SCHEMA as unknown as Record<string, unknown>,
        name: 'elster_classification',
        prompt: DOCUMENT_ANNOTATION_PROMPT,
      },
    };
    if (cfg.confidenceScoresGranularity === undefined) cfg.confidenceScoresGranularity = 'page';

    const fileId =
      input.fileId ??
      (await uploadFile(input.filePath, input.filename, { signal: ctx.signal })).file_id;
    const { url: signedUrl } = await getFileSignedUrl(fileId, { signal: ctx.signal });
    const isImage = mimeFromFilename(input.filename).startsWith('image/');
    const document: DocumentChunk = isImage
      ? { type: 'image_url', image_url: signedUrl }
      : { type: 'document_url', document_url: signedUrl, document_name: input.filename };
    ctx.logger.debug(`OCR+classify Eingabe: ${input.filename} (file_id=${fileId})`);

    const req = configToApiRequest(cfg, document, { runId: ctx.runId, stageId: ctx.stageId });
    const t0 = Date.now();
    ctx.emit('ocr_started', { filename: input.filename, fileId, classify: true });
    const { response, degradation } = await callMistralOcrWithFallback(req, { signal: ctx.signal });
    const parsed = parseApiResponse(response, cfg, t0, degradation);

    if (degradation) ctx.emit('ocr_degraded', degradation);

    // Annotation → unsere Klassifikations-Felder rausholen.
    const ann = parsed.documentAnnotation as
      | { erkannte_anlagen?: unknown; primary_form?: unknown; classify_confidence?: unknown }
      | null;
    let erkannte_anlagen: string[] = [];
    let primary_form: string | null = null;
    let classify_confidence = 0;
    let classify_source: 'ocr_annotation' | 'fallback_empty' = 'fallback_empty';

    if (ann && Array.isArray(ann.erkannte_anlagen)) {
      erkannte_anlagen = (ann.erkannte_anlagen as unknown[])
        .filter((x): x is string => typeof x === 'string' && (ELSTER_ANLAGEN_IDS as readonly string[]).includes(x));
      classify_source = 'ocr_annotation';
    }
    if (ann && typeof ann.primary_form === 'string' && (ELSTER_ANLAGEN_IDS as readonly string[]).includes(ann.primary_form)) {
      primary_form = ann.primary_form;
    }
    if (ann && typeof ann.classify_confidence === 'number') {
      classify_confidence = Math.max(0, Math.min(1, ann.classify_confidence));
    }

    ctx.emit('ocr_done', { pages: parsed.pages.length, chars: parsed.chars, ms: parsed.ms });
    ctx.emit('ocr_classified', {
      erkannte_anlagen,
      primary_form,
      confidence: classify_confidence,
      source: classify_source,
    });

    return {
      model: parsed.model,
      pages: parsed.pages.map((p) => ({ index: p.index, markdown: p.markdown, chars: p.chars })),
      text: parsed.text,
      chars: parsed.chars,
      annotation: parsed.documentAnnotation,
      ms: parsed.ms,
      parsed,
      erkannte_anlagen,
      primary_form,
      classify_confidence,
      classify_source,
    };
  },
});
