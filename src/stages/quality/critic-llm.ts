/**
 * Critic — LLM-as-judge.
 *
 * Runs a second LLM that scores an extraction against the source text and an
 * optional rubric. Output is a strict-schema'd report: `{score, accept,
 * rationale, per_field_issues[]}`. Used to:
 *   - flag fields the extractor hallucinated (not in source)
 *   - flag empty required fields
 *   - feed eval/kpi with a quality signal (separate from cross-branch agreement)
 *
 * Design notes:
 *   - Independence: best practice is to run the critic on a DIFFERENT provider
 *     than the extractor (e.g. extractor=vLLM Gemma, critic=Mistral cloud).
 *     The designer exposes provider-dropdown to make this easy.
 *   - We use strict JSON-schema so the critic itself can't drift.
 *   - Severity scale: 'block' (must-fix), 'warn' (review), 'info' (note).
 */
import { defineStage } from '../../core/stage.ts';
import { chatJson, type ChatProvider } from '../../lib/llm-chat.ts';

export interface CriticInput {
  /** The object the extractor produced. */
  extracted: unknown;
  /** Source text the extraction was made from (OCR markdown). */
  source: string;
  /** Optional schema — surfaces to the critic as field-name reference. */
  schema?: Record<string, unknown>;
  /** Per-call rubric override (preferred over config.rubric when given). */
  rubric?: string;
  /**
   * Optional per-leaf metadata from container-field-mapper. When provided, the
   * critic gets a per-field reference table (eCode, BMF-Anleitung, formatRegex)
   * and is instructed to cite eCode + Anleitung in each issue — making the
   * audit trail legally traceable.
   */
  field_meta?: Record<string, {
    ecode?: string;
    drucktext?: string;
    anlage?: string;
    vordruckzeile?: string;
    datentyp?: string;
    formatRegex?: string | null;
    pflicht?: boolean;
    anleitung?: { document?: string; section?: string };
  } | null>;
}

export interface CriticIssue {
  field: string;
  severity: 'block' | 'warn' | 'info';
  msg: string;
}

export interface CriticOutput {
  score: number;       // 0..1
  accept: boolean;     // score >= passThreshold && no 'block'
  rationale: string;
  per_field_issues: CriticIssue[];
  ms: number;
  /** Echoed for downstream span-linker / cross-validator. */
  extracted: unknown;
  source: string;
}

export interface CriticConfig {
  provider?: ChatProvider;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  rubric?: string;
  passThreshold?: number;
}

const DEFAULT_RUBRIC = `Prüfe die Extraktion gegen den Quelltext. Bewerte:
1. Vollständigkeit: alle erkennbaren Felder gefüllt?
2. Wörtlichkeit: jeder Wert findet sich (auch mit Toleranz für Whitespace/Umlaute) im Quelltext?
3. Halluzinationen: keine Werte erfunden die nicht aus dem Beleg ableitbar sind?
4. Format-Plausibilität: Beträge mit Komma, IDs in richtiger Länge, Daten plausibel?
Markiere Probleme mit Severity 'block' (kritisch), 'warn' (Review nötig), 'info' (Hinweis).`;

const CRITIC_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'accept', 'rationale', 'per_field_issues'],
  properties: {
    score: { type: 'number', minimum: 0, maximum: 1 },
    accept: { type: 'boolean' },
    rationale: { type: 'string' },
    per_field_issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field', 'severity', 'msg'],
        properties: {
          field: { type: 'string' },
          severity: { type: 'string', enum: ['block', 'warn', 'info'] },
          msg: { type: 'string' },
        },
      },
    },
  },
};

export const criticLlmStage = defineStage<CriticInput, CriticOutput, CriticConfig>({
  id: 'eval/critic-llm',
  name: 'Critic — LLM-as-Judge',
  description:
    'Zweiter LLM bewertet eine Extraktion gegen Quelltext und Schema. Liefert ' +
    'Score (0..1), Accept-Flag, Begründung, und per-Feld-Issues mit Severity. ' +
    'Für Audit-Independence am besten auf anderem Provider als der Extractor.',
  hints: {
    inputs: 'extracted (nested-json), source (text), schema? (json-schema), rubric?',
    outputs: 'score (0..1), accept (bool), rationale, per_field_issues[], extracted (echo), source (echo)',
    configExample: '{"provider": "mistral", "model": "mistral-small-latest", "passThreshold": 0.85, "rubric": "Prüfe ob jeder Wert exakt im Quelltext steht."}',
    llm: { providers: ['mistral', 'vllm', 'ollama'], default: 'mistral' },
    inputPorts: [
      { name: 'extracted', type: 'nested-json' },
      { name: 'source', type: 'text' },
      { name: 'schema', type: 'json-schema', description: 'Optional schema reference' },
      { name: 'rubric', type: 'text', description: 'Optional extra rubric' },
      { name: 'field_meta', type: 'json', description: 'Optional per-leaf container metadata — enables eCode + Anleitung citation in issues' },
    ],
    outputPorts: [
      { name: 'score', type: 'number' },
      { name: 'accept', type: 'boolean' },
      { name: 'rationale', type: 'text' },
      { name: 'per_field_issues', type: 'json' },
      { name: 'extracted', type: 'nested-json', description: 'Echoed for span-linker downstream' },
      { name: 'source', type: 'text' },
    ],
  },

  async run(input, ctx) {
    if (!input?.extracted) throw new Error('critic-llm: input.extracted fehlt');
    if (!input?.source || typeof input.source !== 'string') {
      throw new Error('critic-llm: input.source fehlt');
    }
    const cfg = ctx.config ?? ({} as CriticConfig);
    const provider: ChatProvider = cfg.provider ?? 'mistral';
    const passThreshold = cfg.passThreshold ?? 0.85;
    const rubric = input.rubric || cfg.rubric || DEFAULT_RUBRIC;

    const t0 = Date.now();
    // Constrain source preview so the critic's prompt stays under reasonable token budget.
    const sourcePreview = input.source.slice(0, 12000);
    const schemaSnippet = input.schema
      ? `\n\n--- ERWARTETES SCHEMA (für Feldnamen-Referenz) ---\n${JSON.stringify(input.schema, null, 2).slice(0, 3000)}`
      : '';

    // Render the expected output shape inline so providers without strict JSON-
    // schema (Mistral, Ollama) still produce parseable output.
    const responseShape = `{
  "score": <Zahl zwischen 0 und 1>,
  "accept": <true|false>,
  "rationale": "<Kurzbegründung, 1-2 Sätze>",
  "per_field_issues": [
    {"field": "<dotted.path>", "severity": "block|warn|info", "msg": "<Problembeschreibung mit eCode + Anleitung-Verweis>"}
  ]
}`;

    // Container-aware: if we have field metadata, render a per-field reference
    // table so the critic can cite eCode + BMF-Anleitung-Zeile in each issue.
    let fieldRefSnippet = '';
    let citationInstruction = '';
    if (input.field_meta && Object.keys(input.field_meta).length > 0) {
      const lines: string[] = [];
      for (const [path, m] of Object.entries(input.field_meta)) {
        if (!m) continue;
        const parts = [`${path}`];
        if (m.ecode) parts.push(`eCode ${m.ecode}`);
        if (m.anlage && m.vordruckzeile) parts.push(`Anlage ${m.anlage} Z.${m.vordruckzeile}`);
        if (m.datentyp) parts.push(`Typ: ${m.datentyp}`);
        if (m.pflicht) parts.push('PFLICHT');
        if (m.formatRegex) parts.push(`FormatRegex: \`${m.formatRegex}\``);
        if (m.drucktext) parts.push(`"${m.drucktext}"`);
        lines.push('  ' + parts.join(' · '));
      }
      if (lines.length > 0) {
        fieldRefSnippet = '\n\n--- FELD-REFERENZ (eCode + BMF-Anleitung) ---\n' + lines.join('\n');
        citationInstruction = '\nWICHTIG: in jeder per_field_issue MUSS der eCode + Anlage Z.X aus der Feld-Referenz mit-zitiert werden (Beispiel msg: "E0200201 (Anlage N Z.5, Bruttoarbeitslohn): Wert weicht von Quelltext ab").';
      }
    }

    const prompt = [
      rubric + citationInstruction,
      '',
      '--- EXTRAKTION ---',
      JSON.stringify(input.extracted, null, 2).slice(0, 6000),
      schemaSnippet,
      fieldRefSnippet,
      '',
      '--- QUELLTEXT ---',
      sourcePreview,
      '',
      'Antworte mit EXAKT diesem JSON-Shape (keine Erklärung davor/danach, keine Markdown-Fences):',
      responseShape,
    ].join('\n');

    ctx.emit('critic_started', { provider, model: cfg.model });
    const result = await chatJson<{
      score: number;
      accept: boolean;
      rationale: string;
      per_field_issues: CriticIssue[];
    }>(prompt, {
      provider,
      model: cfg.model,
      temperature: cfg.temperature ?? 0,
      maxTokens: cfg.maxTokens ?? 1500,
      // Strict schema is only enforced by vLLM; Mistral/Ollama still get json_object.
      jsonSchema: { name: 'critic-report', schema: CRITIC_SCHEMA, strict: true },
      signal: ctx.signal,
    });

    const parsed = result.parsed ?? {} as Record<string, unknown>;
    const score = typeof parsed.score === 'number' ? parsed.score : 0;
    const issues: CriticIssue[] = Array.isArray(parsed.per_field_issues) ? parsed.per_field_issues : [];
    const hasBlocker = issues.some((i) => i?.severity === 'block');
    const accept = !hasBlocker && score >= passThreshold;

    const ms = Date.now() - t0;
    ctx.emit('critic_done', {
      ms,
      score,
      accept,
      issueCount: issues.length,
      blockCount: issues.filter((i) => i.severity === 'block').length,
    });

    return {
      score,
      accept,
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
      per_field_issues: issues,
      ms,
      extracted: input.extracted,
      source: input.source,
    };
  },
});
