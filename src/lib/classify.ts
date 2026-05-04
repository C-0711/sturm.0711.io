/**
 * Document classification + KPI extraction via one Mistral Small chat call.
 *
 * Mirrors the playground pattern: model = mistral-small-latest, document_url
 * content part, response_format json_schema constraining the output to a
 * strict {label, confidence, summary, kpis, value_count} shape. The label is
 * pattern-restricted to folder-safe chars so we can route the file directly
 * into <label>/.
 *
 * The chat backend OCRs the document internally as a side effect of fulfilling
 * the request — same as schema-generate. mistral-ocr-latest is NOT invoked.
 */

const CHAT_URL = 'https://api.mistral.ai/v1/chat/completions';
const MODEL = 'mistral-small-latest';

export interface MistralUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface Kpi {
  key: string;
  value: string;
  /** Optional ELSTER code annotation if Mistral recognises the field (Pass 1
   *  is best-effort; the authoritative ELSTER mapping happens in Pass 2). */
  elster_code?: string;
  anlage?: string;
}

export interface ClassificationResult {
  label: string;
  confidence: number;
  summary: string;
  kpis: Kpi[];
  /** Anlagen-Codes (ELSTER 2024) die laut Klassifizierung relevant sind.
   *  Pass 2 (elster-extract) lädt für genau diese Anlagen den Feldkatalog
   *  und baut daraus das Mistral-Schema mit allen ELSTER-Codes. */
  recommendedAnlagen: string[];
  valueCount: number;
  mistralUsage: MistralUsage;
  ms: number;
  /** Full unredacted Mistral chat-completion envelope, exactly as received.
   *  Persisted so the user can inspect what the model actually returned (raw
   *  prompt + response) at the upload step. */
  raw: {
    request: { model: string; promptText: string; documentUrl: string };
    response: unknown;
  };
}

/** ELSTER 2024 Anlagen-Codes — Quelle: workflows/elster/data/2024/anlagen.json.
 *  Wird im Pass-1-Schema als enum genutzt, damit Mistral nur valide Codes ausgibt. */
export const ANLAGEN_CODES_2024 = [
  'ESt1A', 'SA', 'AgB', 'HA_35a', 'EM_35c', 'Sonst', 'WA_ESt', 'ESt1A_U',
  'Kind', 'L', 'Anl_34b', 'G', 'Zins', 'S', 'Corona', 'N_GRE', 'N', 'N_DHH',
  'N_AUS', 'KAP', 'KAP_BET', 'KAP_I', 'AUS', 'R', 'RAV_bAV', 'R_AUS', 'SO',
  'V', 'V_FeWo', 'V_Sonstige', 'FW', 'VOR', 'AV', 'Mob', 'Vorsatz',
] as const;

const CLASSIFY_PROMPT =
  'Analysiere das Dokument und gib EIN JSON-Objekt zurück mit:\n' +
  '- label: kurzer kleingeschriebener Bezeichner für den Dokumenttyp ' +
  '(z.B. "elster", "rechnung", "vertrag", "datenblatt", "kontoauszug", "lohnsteuerbescheinigung"). ' +
  'Nur a-z, 0-9, "_" und "-" — er wird als Ordnername benutzt.\n' +
  '- confidence: 0.0 bis 1.0 — wie sicher die Klassifikation ist.\n' +
  '- summary: ein Satz auf Deutsch (max. 240 Zeichen) der den Dokumentinhalt zusammenfasst.\n' +
  '- recommended_anlagen: Liste der ELSTER-Anlagen 2024 die zu diesem Dokument passen. ' +
  'NUR Codes aus dem Schema-Enum verwenden. Beispiele: ' +
  '"Lohnsteuerbescheinigung" → ["N", "Vorsorgeaufwendungen" wenn Sozialvers.-Beiträge enthalten]. ' +
  '"Rentenbescheid/-anpassung" → ["R"]. ' +
  '"Steuerbescheinigung Kapitalerträge / VAST" → ["KAP"]. ' +
  '"Spendenquittung" → ["SA"]. ' +
  'Mehrere Anlagen sind erlaubt. Bei reinem Ausweis/Nicht-Steuerdokument: leere Liste [].\n' +
  '- kpis: ALLE extrahierbaren Schlüssel/Wert-Paare aus dem Dokument — Namen, IDs, Beträge, ' +
  'Daten, Adressen, Konten, Beiträge, Sätze, Codes, Referenzen. Pro Wert eigener Eintrag. ' +
  'Format: {key:"<beschreibender Name>",value:"<Wert im Originalformat des Dokuments>"}. ' +
  'Bei zwei Personen pro Person eigene Einträge mit Suffix " Person A" / " Person B". ' +
  'Ziel: Vollständigkeit, NICHT Auswahl. Erwartung typischerweise 20-80 Einträge je nach Dichte.\n' +
  '- value_count: geschätzte Gesamtzahl extrahierbarer Fakten/Werte im Dokument (kann höher sein als kpis.length).\n' +
  'Keine Erklärungen, kein Markdown, nur das JSON-Objekt gemäß dem vorgegebenen Schema.';

const META_SCHEMA = {
  type: 'object',
  required: ['label', 'confidence', 'summary', 'recommended_anlagen', 'kpis', 'value_count'],
  additionalProperties: false,
  properties: {
    label: {
      type: 'string',
      pattern: '^[a-z][a-z0-9_-]{0,30}$',
      description: 'Folder-safe document type identifier',
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    summary: { type: 'string', maxLength: 240 },
    recommended_anlagen: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'string',
        enum: [...ANLAGEN_CODES_2024],
      },
      description:
        'ELSTER-Anlagen 2024 die zu diesem Dokument passen. Pass 2 lädt für ' +
        'genau diese Anlagen den Feldkatalog und baut daraus das Mistral-Schema.',
    },
    kpis: {
      type: 'array',
      maxItems: 200,
      items: {
        type: 'object',
        required: ['key', 'value'],
        additionalProperties: false,
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
        },
      },
    },
    value_count: { type: 'integer', minimum: 0 },
  },
};

interface MistralChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: MistralUsage;
}

export async function classifyDocument(opts: {
  documentUrl: string;
  apiKey: string;
  signal?: AbortSignal;
  baseUrl?: string;
  /** Optional MIME-Type oder Filename — entscheidet ueber Mistral-Content-
   *  Type. Bilder muessen 'image_url' verwenden, sonst antwortet die API
   *  mit "unsupported document format". PDFs / Office-Dokumente bleiben
   *  bei 'document_url' (Mistral OCR-t intern). */
  mime?: string;
  filename?: string;
}): Promise<ClassificationResult> {
  const t0 = Date.now();

  // Bild-Detection: Mistral verlangt 'image_url' fuer JPG/PNG/WEBP/GIF/HEIC.
  const mimeLower = (opts.mime ?? '').toLowerCase();
  const nameLower = (opts.filename ?? '').toLowerCase();
  const isImage =
    mimeLower.startsWith('image/') ||
    /\.(jpg|jpeg|png|webp|gif|heic|heif|bmp|tiff?)$/.test(nameLower);
  const docContent = isImage
    ? { type: 'image_url' as const, image_url: opts.documentUrl }
    : { type: 'document_url' as const, document_url: opts.documentUrl };

  const body = {
    model: MODEL,
    stream: false,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: CLASSIFY_PROMPT },
          docContent,
        ],
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'document_classification',
        schema: META_SCHEMA,
        strict: true,
      },
    },
  };

  const url = opts.baseUrl ?? CHAT_URL;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`mistral classify ${resp.status}: ${text.slice(0, 500)}`);

  let json: MistralChatResponse;
  try { json = JSON.parse(text) as MistralChatResponse; }
  catch { throw new Error(`mistral classify ${resp.status}: non-JSON response: ${text.slice(0, 500)}`); }
  const content = json.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    throw new Error(`mistral classify ${resp.status}: empty assistant content`);
  }
  let parsed: {
    label: string;
    confidence: number;
    summary: string;
    recommended_anlagen?: string[];
    kpis: Kpi[];
    value_count: number;
  };
  try { parsed = JSON.parse(content); }
  catch { throw new Error(`mistral classify ${resp.status}: assistant content not JSON: ${content.slice(0, 300)}`); }

  // Defensive: model schema enforces this, but guard anyway since folder names matter.
  if (typeof parsed.label !== 'string' || !/^[a-z][a-z0-9_-]{0,30}$/.test(parsed.label)) {
    throw new Error(`mistral classify: invalid label "${parsed.label}"`);
  }

  // Defensive: filter recommended_anlagen against the known 2024 enum.
  // Strict mode SHOULD enforce this, aber wir validieren trotzdem (Schema-Drift,
  // Modellupgrade, Halluzination). Ungueltige Eintraege werden verworfen.
  const validAnlagen = new Set(ANLAGEN_CODES_2024);
  const recommendedAnlagen = Array.isArray(parsed.recommended_anlagen)
    ? parsed.recommended_anlagen.filter((a) => validAnlagen.has(a as typeof ANLAGEN_CODES_2024[number]))
    : [];

  return {
    label: parsed.label,
    confidence: parsed.confidence,
    summary: parsed.summary,
    kpis: Array.isArray(parsed.kpis) ? parsed.kpis : [],
    recommendedAnlagen,
    valueCount: parsed.value_count ?? 0,
    mistralUsage: json.usage ?? {},
    ms: Date.now() - t0,
    raw: {
      request: { model: MODEL, promptText: CLASSIFY_PROMPT, documentUrl: opts.documentUrl },
      response: json,
    },
  };
}
