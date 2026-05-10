/**
 * elster-v3 Layer 1 — strict json_schema nested extraction via vLLM Gemma-4.
 *
 * Reads OCR text + (optional) classifier KPI hints + the doc-class-specific
 * nested JSON schema, then asks Gemma-4 to fill it. vLLM's response_format
 * json_schema mode constrains the FSM token-by-token so the output is
 * guaranteed to match the schema (no post-hoc parsing/cleanup).
 *
 * Output: nested JSON (donations[], donor, employer, income, ...).
 * Subsequent stages: layer2-resolve (entity normalization) → layer4-project.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineStage } from '../../../core/stage.ts';
import { chatJson } from '../../../lib/llm-chat.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = join(HERE, '..', 'data', 'nested_schemas');

export interface Layer1Input {
  /** OCR markdown from the mistral-ocr stage. */
  text: string;
  /** Doc class id from the dokument-typ stage (e.g. "lohnsteuerbescheinigung"). */
  docClass: string;
  /**
   * Optional KPI hints (key:value pairs from a classifier upstream).
   * The workspace pipeline produces these via Mistral classification —
   * if present they massively speed up + harden Gemma's extraction.
   */
  kpis?: Array<{ key: string; value: unknown }>;
}

export interface Layer1Output {
  nested: unknown;
  schemaName: string;
  schemaId: string;
  llmMs: number;
  ms: number;
}

export interface Layer1Config {
  /** vLLM URL — defaults to env VLLM_URL or http://localhost:11435. */
  vllmUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

const DOC_GUIDANCE: Record<string, string[]> = {
  spendenquittung: [
    'WICHTIG für spenden[].art:',
    '  - "Spende" = freiwillige Zuwendung ohne Gegenleistung (default)',
    '  - "Mitgliedsbeitrag" = wenn das Dokument explizit "Mitgliedsbeitrag" angibt',
    '  - "Sachspende" = Naturalspende',
    '  - "Aufwandsspende" = Verzicht auf Aufwandserstattung',
  ],
  lohnsteuerbescheinigung: [
    'WICHTIG für arbeitgeber.art:',
    '  - "versorgungstraeger" = Beamtenversorgung (LBV, Versorgungswerk), Witwenpension, Pensionskasse, Betriebsrente',
    '  - "arbeitgeber" = aktive Beschäftigung',
    '  - "rentenversicherer" = gesetzliche/private Rentenkasse (DRV)',
    '  - "unbekannt" = NUR wenn Dokument keinen Hinweis liefert',
    'Hinweis: "LBV NRW" = Landesamt für Besoldung und Versorgung NRW = Versorgungsträger.',
    '',
    'WICHTIG für versorgungsbezug.*:',
    '  - IMMER ausfüllen wenn der Beleg "Versorgungsbezüge" oder "Bemessungsgrundlage Versorgungsfreibetrag" erwähnt.',
    '  - versorgungsbezug_brutto = Wert aus "steuerbegünstigte Versorgungsbezüge"',
    '  - bemessungsgrundlage_freibetrag = Wert aus "Bemessungsgrundlage für Versorgungsfreibetrag"',
    '',
    'WICHTIG für lohn.kirchensteuer_arbeitnehmer_einbehalten:',
    '  - aus "einbehaltene Kirchensteuer des Arbeitnehmers" (NICHT Ehegatten-KiSt).',
    '',
    'WICHTIG für arbeitnehmer.konfession:',
    '  - "Evangelisch"→ev, "römisch-katholisch"→rk, "altkatholisch"→ak.',
  ],
  pension_versorgung: [
    'Behandle wie lohnsteuerbescheinigung (siehe Schema).',
  ],
  rentenbezug: [
    'WICHTIG für rente:',
    '  - rentenbetrag = aus "Renten-/Leistungsbetrag" oder "Rentenbetrag"',
    '  - anpassungsbetrag = "Rentenanpassungsbetrag" (separat ausweisen)',
  ],
};

/** Map dokument-typ ids (output of klassifizierung stage) to schema filenames. */
function resolveSchemaName(docClass: string): string {
  // Lohnsteuerbescheinigung family
  if (docClass === 'pension_versorgung') return 'lohnsteuerbescheinigung';
  if (docClass === 'lohnsteuerbescheinigung_kapital') return 'lohnsteuerbescheinigung';
  if (docClass === 'lohnsteuerbescheinigung_aktiv') return 'lohnsteuerbescheinigung';

  // Rentenbezug
  if (docClass === 'rentenbezug') return 'rentenbezugsmitteilung';
  if (docClass === 'rentenbezugsmitteilung') return 'rentenbezugsmitteilung';

  // Spendenquittung
  if (docClass === 'spendenquittung') return 'spendenquittung';
  if (docClass === 'spende') return 'spendenquittung';
  if (docClass === 'mitgliedsbeitrag') return 'spendenquittung';

  // Religionszugehörigkeit (VaSt-Auszug)
  if (docClass === 'religionszugehoerigkeit') return 'religionszugehoerigkeit';
  if (docClass === 'religion') return 'religionszugehoerigkeit';
  if (docClass === 'kirchensteuermerkmal') return 'religionszugehoerigkeit';

  // Mitteilung über freigestellte Kapitalerträge (VaSt, nur Freistellungs-Betrag)
  if (docClass === 'mitteilung_kapitalertraege') return 'mitteilung_kapitalertraege';
  if (docClass === 'kapitalertragsbescheinigung') return 'mitteilung_kapitalertraege';
  if (docClass === 'freistellungsauftrag') return 'mitteilung_kapitalertraege';
  if (docClass === 'mitteilung_freigestellte_kapitalertraege') return 'mitteilung_kapitalertraege';

  // Steuerbescheinigung Kapitalerträge (volle Bankbescheinigung mit KapESt + SolZ + KiSt)
  if (docClass === 'steuerbescheinigung_kapitalertraege') return 'steuerbescheinigung_kapitalertraege';
  if (docClass === 'steuerbescheinigung_kapitalertr') return 'steuerbescheinigung_kapitalertraege';
  if (docClass === 'jahressteuerbescheinigung') return 'steuerbescheinigung_kapitalertraege';
  if (docClass === 'kapitalertrag_jahressteuerbescheinigung') return 'steuerbescheinigung_kapitalertraege';

  // ESt1A Hauptvordruck (Stammdaten + Adresse + Bankverbindung)
  if (docClass === 'personaldaten_hauptvordruck') return 'personaldaten_hauptvordruck';
  if (docClass === 'elster_einkommensteuererkl_2023') return 'personaldaten_hauptvordruck';
  if (docClass === 'elster_einkommensteuererkl') return 'personaldaten_hauptvordruck';
  if (docClass === 'est1a_hauptvordruck') return 'personaldaten_hauptvordruck';
  if (docClass === 'hauptvordruck') return 'personaldaten_hauptvordruck';

  return docClass;
}

export const layer1ExtractStage = defineStage<Layer1Input, Layer1Output, Layer1Config>({
  id: 'elster-v3/layer1-extract',
  name: 'ELSTER-v3 Layer 1 — Gemma-4 strict json_schema nested extraction',
  description:
    'Picks the doc-class nested JSON schema, builds a guidance prompt with optional KPI ' +
    'hints, and calls vLLM Gemma-4 with response_format=json_schema(strict). The FSM-' +
    'constrained decoding guarantees the output JSON conforms to the schema — no post-hoc ' +
    'parsing/cleanup. Produces the canonical nested JSON consumed by Layers 2-4.',

  async run(input, ctx) {
    const t0 = Date.now();
    const schemaName = resolveSchemaName(input.docClass);
    let schemaJson: { name: string; schema: Record<string, unknown> };
    try {
      schemaJson = JSON.parse(await readFile(join(SCHEMAS_DIR, `${schemaName}.json`), 'utf-8'));
    } catch (err) {
      throw new Error(
        `elster-v3/layer1-extract: no nested schema for docClass="${input.docClass}" ` +
        `(looked for ${schemaName}.json). ${(err as Error).message}`,
      );
    }
    const fieldHints = (input.kpis ?? [])
      .filter((k) => k.key && k.value !== null && k.value !== undefined && k.value !== '')
      .map((k) => `  ${k.key}: ${k.value}`)
      .join('\n');
    const guidance = DOC_GUIDANCE[input.docClass] ?? DOC_GUIDANCE[schemaName] ?? [];

    const prompt = [
      `Du bekommst einen deutschen Steuer-Beleg (Klasse: ${input.docClass}).`,
      `Extrahiere alle relevanten Daten EXAKT nach dem JSON-Schema. Bewahre Originalnamen (auch bei OCR-Fehlern).`,
      '',
      ...guidance,
      ...(fieldHints
        ? ['',
           '--- VORANALYSIERTE FORM-FIELD-HINTS (aus Klassifizierungs-KPIs) ---',
           '(Bereits korrekt aus dem Dokument extrahiert — als Primärquelle nutzen.)',
           fieldHints]
        : []),
      '',
      '--- OCR-VOLLTEXT (zur Querprüfung) ---',
      input.text.slice(0, 5000),
    ].join('\n');

    ctx.emit('layer1_started', { schemaName, docClass: input.docClass, hasKpiHints: fieldHints.length > 0 });

    const tLlm = Date.now();
    const result = await chatJson(prompt, {
      provider: 'vllm',
      model: ctx.config.model ?? 'gemma4-mm',
      vllmUrl: ctx.config.vllmUrl,
      temperature: ctx.config.temperature ?? 0,
      maxTokens: ctx.config.maxTokens ?? 2000,
      jsonSchema: { name: schemaJson.name, schema: schemaJson.schema, strict: true },
      signal: ctx.signal,
    });
    const llmMs = Date.now() - tLlm;

    await ctx.artifacts.write('layer1_nested.json', result.parsed);
    ctx.emit('layer1_done', {
      schemaId: schemaJson.name,
      llmMs,
      // Compact summary so SSE clients can render without huge payloads.
      preview: typeof result.parsed === 'object' && result.parsed !== null
        ? Object.keys(result.parsed as Record<string, unknown>).slice(0, 12)
        : [],
    });
    return {
      nested: result.parsed,
      schemaName,
      schemaId: schemaJson.name,
      llmMs,
      ms: Date.now() - t0,
    };
  },
});
