/**
 * Cross-model classifier: same prompt + schema as classifyDocument, but
 * routed through Anthropic's claude-haiku-4-5 (vision-capable, fast). Used
 * by the cross-model audit to get a second opinion on extracted KPIs.
 *
 * Anthropic API accepts PDFs and images directly via base64 in the document/
 * image content type — no upload step needed.
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_VERSION = '2023-06-01';

import type { Kpi, ClassificationResult } from './classify.ts';

const CLASSIFY_PROMPT =
  'Analysiere das Dokument und gib EIN JSON-Objekt zurück mit:\n' +
  '- label: kurzer kleingeschriebener Bezeichner für den Dokumenttyp ' +
  '(z.B. "elster", "rechnung", "vertrag", "datenblatt", "kontoauszug", "lohnsteuerbescheinigung"). ' +
  'Nur a-z, 0-9, "_" und "-".\n' +
  '- confidence: 0.0 bis 1.0.\n' +
  '- summary: ein Satz auf Deutsch (max. 240 Zeichen).\n' +
  '- kpis: ALLE extrahierbaren Schlüssel/Wert-Paare aus dem Dokument — Namen, IDs, Beträge, ' +
  'Daten, Adressen, Konten, Beiträge, Sätze, Codes, Referenzen. Pro Wert eigener Eintrag. ' +
  'Format: {"key":"<beschreibender Name>","value":"<Wert im Originalformat>"}. ' +
  'Bei zwei Personen pro Person eigene Einträge mit Suffix " Person A" / " Person B". ' +
  'Ziel: Vollständigkeit, NICHT Auswahl.\n' +
  '- value_count: geschätzte Gesamtzahl extrahierbarer Fakten.\n' +
  'Antworte AUSSCHLIESSLICH als JSON-Objekt mit den Schlüsseln label, confidence, summary, kpis, value_count. ' +
  'Kein Markdown, kein Fließtext drumherum.';

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export async function classifyDocumentClaude(opts: {
  fileBase64: string;
  mediaType: string; // 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
  apiKey: string;
  signal?: AbortSignal;
}): Promise<ClassificationResult> {
  const t0 = Date.now();
  const isPdf = opts.mediaType === 'application/pdf';
  const docPart = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: opts.mediaType, data: opts.fileBase64 } }
    : { type: 'image', source: { type: 'base64', media_type: opts.mediaType, data: opts.fileBase64 } };

  const body = {
    model: MODEL,
    max_tokens: 8000,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [docPart, { type: 'text', text: CLASSIFY_PROMPT }],
      },
    ],
  };

  const resp = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': opts.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`claude classify ${resp.status}: ${text.slice(0, 500)}`);

  let json: AnthropicResponse;
  try { json = JSON.parse(text) as AnthropicResponse; }
  catch { throw new Error(`claude classify ${resp.status}: non-JSON response: ${text.slice(0, 500)}`); }

  const content = json.content?.find((c) => c.type === 'text')?.text;
  if (!content) throw new Error(`claude classify ${resp.status}: empty assistant content`);

  // Claude doesn't enforce schema — strip code-fence if present, find first {...}
  const jsonText = stripFenceAndIsolateJson(content);
  let parsed: {
    label?: string;
    confidence?: number;
    summary?: string;
    kpis?: Kpi[];
    recommended_anlagen?: string[];
    value_count?: number;
  };
  try { parsed = JSON.parse(jsonText); }
  catch { throw new Error(`claude classify: assistant content not JSON: ${content.slice(0, 300)}`); }

  // Claude liefert recommended_anlagen nicht zwingend — Pass 2 wird dann
  // ueber den uebergebenen anlagenHint des Callers gefahren.
  const recommendedAnlagen = Array.isArray(parsed.recommended_anlagen)
    ? parsed.recommended_anlagen.filter((a): a is string => typeof a === 'string')
    : [];

  return {
    label: typeof parsed.label === 'string' ? parsed.label : 'unknown',
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    kpis: Array.isArray(parsed.kpis) ? parsed.kpis.filter((k) => k && typeof k.key === 'string' && typeof k.value === 'string') : [],
    recommendedAnlagen,
    valueCount: typeof parsed.value_count === 'number' ? parsed.value_count : 0,
    mistralUsage: { prompt_tokens: json.usage?.input_tokens, completion_tokens: json.usage?.output_tokens, total_tokens: (json.usage?.input_tokens ?? 0) + (json.usage?.output_tokens ?? 0) },
    ms: Date.now() - t0,
    raw: {
      request: { model: MODEL, promptText: CLASSIFY_PROMPT, documentUrl: `base64:${opts.mediaType}` },
      response: json,
    },
  };
}

function stripFenceAndIsolateJson(s: string): string {
  let t = s.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  // Find first { and matching last } — defensive against any prose around it
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) return t.slice(start, end + 1);
  return t;
}
