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
import { searchVariants } from '../../lib/quality/datentyp-normalize.ts';

/** Heuristic: does this critic-message complain about formatting/typography only? */
function isFormatOnlyComplaint(msg: string): boolean {
  if (typeof msg !== 'string') return false;
  const lower = msg.toLowerCase();
  return /\bformat\b|punkt|komma|interpunktion|trennzeichen|dezimal|tausender|thousand|decimal|leerzeichen|whitespace|notation/.test(lower);
}

/** Walk dotted path on a plain JSON tree (ignores annotation siblings). */
function getAtPath(obj: unknown, dotted: string): unknown {
  if (!dotted) return obj;
  let cur: unknown = obj;
  for (const part of dotted.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * For each path in field_meta, decide whether the extracted value can be
 * found in the source under *any* datentyp-aware rendering. If yes, the
 * critic shouldn't be allowed to flag it for "Punkt vs. Komma" / "Format"
 * reasons — the container-normalized representations all map to the same
 * semantic value.
 *
 * Returns:
 *   verifiedFields[]  paths whose value matches a German/JSON variant in source
 *   verifiedSummary   short table for the prompt (max 30 rows) showing the
 *                     accepted forms — helps the LLM understand the convention
 */
function computeVerifiedFields(
  extracted: unknown,
  source: string,
  fieldMeta: Record<string, { datentyp?: string } | null> | undefined,
): { verifiedFields: Set<string>; verifiedSummary: string } {
  const verified = new Set<string>();
  const rows: string[] = [];
  if (!fieldMeta || !source) return { verifiedFields: verified, verifiedSummary: '' };
  const srcLower = source.toLowerCase();
  for (const [path, meta] of Object.entries(fieldMeta)) {
    if (!meta) continue;
    const value = getAtPath(extracted, path);
    if (value == null || value === '') continue;
    const variants = searchVariants(value, meta.datentyp);
    const hit = variants.find((v) => srcLower.includes(v.toLowerCase()));
    if (hit) {
      verified.add(path);
      if (rows.length < 30) rows.push(`  ${path} = ${JSON.stringify(value)}  ⇔  Quelltext: "${hit}"`);
    }
  }
  const verifiedSummary = rows.length > 0
    ? '\n\n--- FORMAT-VERIFIZIERT (Wert ist im Quelltext, ggf. in deutscher Schreibweise) ---\n' + rows.join('\n')
    : '';
  return { verifiedFields: verified, verifiedSummary };
}

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

    // Container-driven: pre-verify any extracted leaf whose value (under
    // datentyp-aware German/JSON rendering) is found in the OCR source. The
    // critic gets these paths upfront and is forbidden from flagging them
    // for typography reasons ("Punkt vs. Komma" etc.). A second post-process
    // pass drops format-only issues on the same fields as a safety net, so
    // the rule holds even when the LLM ignores the instruction.
    const { verifiedFields, verifiedSummary } = computeVerifiedFields(
      input.extracted, input.source, input.field_meta,
    );
    const germanNumberRule =
      '\nWICHTIG — DEUTSCHE ZAHLENNOTATION:' +
      '\n  Die Extraktion serialisiert Beträge als JSON-Zahl (z.B. 914.71).' +
      '\n  Der Quelltext nutzt deutsche Schreibweise (z.B. "914,71 €" oder "1.234,56").' +
      '\n  Diese sind SEMANTISCH IDENTISCH — kein Format-Issue, keine Severity.' +
      '\n  Beispiele die NIE geflaggt werden dürfen:' +
      '\n    914.71  ⇔  "914,71"  ⇔  "914,71 €"' +
      '\n    69291.8 ⇔  "69.291,80 €"' +
      '\n    7532    ⇔  "7.532,00 €"  (Felder ohne Cent-Stelle werden gerundet)' +
      '\n  Ebenso: Datum "2024-01-01" ⇔ "01.01.2024", IDNr ohne/mit Leerzeichen.';
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
      rubric + germanNumberRule + citationInstruction,
      '',
      '--- EXTRAKTION ---',
      JSON.stringify(input.extracted, null, 2).slice(0, 6000),
      schemaSnippet,
      fieldRefSnippet,
      verifiedSummary,
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
    let score = typeof parsed.score === 'number' ? parsed.score : 0;
    const rawIssues: CriticIssue[] = Array.isArray(parsed.per_field_issues) ? parsed.per_field_issues : [];

    // Post-filter: drop format-only complaints on container-verified fields.
    // Each dropped 'block' frees the score from the blocker-penalty; each
    // dropped 'warn' nudges the score back up by a small fraction (cap at 1).
    let droppedBlock = 0, droppedWarn = 0, droppedInfo = 0;
    const issues = rawIssues.filter((iss) => {
      if (!iss?.field || !iss?.severity) return true;
      if (!verifiedFields.has(iss.field)) return true;
      if (!isFormatOnlyComplaint(iss.msg || '')) return true;
      if (iss.severity === 'block') droppedBlock++;
      else if (iss.severity === 'warn') droppedWarn++;
      else droppedInfo++;
      return false;
    });
    if (droppedBlock + droppedWarn > 0) {
      // Soft score-correction: format-noise shouldn't punish the run.
      const bump = droppedBlock * 0.10 + droppedWarn * 0.03;
      score = Math.min(1, score + bump);
    }
    const hasBlocker = issues.some((i) => i?.severity === 'block');
    const accept = !hasBlocker && score >= passThreshold;

    const ms = Date.now() - t0;
    ctx.emit('critic_done', {
      ms,
      score,
      accept,
      issueCount: issues.length,
      blockCount: issues.filter((i) => i.severity === 'block').length,
      droppedFormatNoise: droppedBlock + droppedWarn + droppedInfo,
      verifiedFieldsCount: verifiedFields.size,
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
