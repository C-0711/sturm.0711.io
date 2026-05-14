/**
 * elster-v5/phase3-llm-fill — LLM-Lücken-Füller mit Dynamic Schema.
 *
 * Bekommt von Phase 1:
 *   - regex_hits: Felder die schon 100% deterministisch extrahiert sind
 *   - missing_ecodes: Felder die der LLM finden soll
 *
 * Pro Anlage:
 *   1. **Dynamic Schema**: strict-json-schema enthält NUR die missing_ecodes
 *      → vLLM-Constrained-Decoding muss winziges Vokabular generieren statt
 *      die ganze Anlage. Erheblich kleiner = schneller.
 *   2. **Layout-Anchor-Injection**: die schon extrahierten regex_hits werden
 *      als "Räumliche Anker" in den Prompt geschrieben — der LLM kann sich
 *      damit in der OCR-Tabelle orientieren ("Aha, Zeile 5 ist Bruttoarbeitslohn
 *      mit 6355990 cents, dann muss Zeile 8 hier oben sein").
 *   3. **vLLM Gemma-4 Streaming**: Token-Level Events per `phase3_field` —
 *      User sieht Lücken live geschlossen.
 *
 * Output-Shape spiegelt phase1: per_anlage mit llm_hits map.
 */
import { defineStage } from '../../../core/stage.ts';
import { chatJson, type ChatProvider } from '../../../lib/llm-chat.ts';
import {
  loadContainerBrief,
  paragraphFuer,
  type AnlagenFelderListe,
  type AnlagenFeld,
} from '../../../lib/elster-catalog.ts';
import {
  computePromptBudget,
  contextTokensFor,
  assertFitsInBudget,
  PromptBudgetExceededError,
} from '../../../lib/prompt-budget.ts';
import type { Phase1AnlageResult, Phase1RegexHit } from './phase1-regex.ts';

// ─────────────────────────────────────────────────────────────────────────
// Streaming vLLM helper — kopiert von container-extract.ts (dieselbe Logik)
// ─────────────────────────────────────────────────────────────────────────

const STREAMING_FIELD_RX = /"(E\d+)"\s*:\s*("(?:[^"\\]|\\.)*"|null)(?=\s*[,}])/g;

/** Defensiv: vor dem Senden an vLLM alle Format-Constraints aus dem Schema
 *  entfernen die den FSM/Outlines-Compiler in eine Combinatorial Explosion
 *  treiben könnten (`pattern`, `format`, `minimum`/`maximum`). Wir validieren
 *  die ELSTER-Formate selbst in Phase 1 + Phase 5; das LLM braucht nur Typen. */
function stripUnsafeSchemaConstraints(schema: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = JSON.parse(JSON.stringify(schema));
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    const obj = node as Record<string, unknown>;
    delete obj.pattern;
    delete obj.format;
    delete obj.minimum;
    delete obj.maximum;
    delete obj.exclusiveMinimum;
    delete obj.exclusiveMaximum;
    delete obj.multipleOf;
    if (typeof obj.type === 'string' && obj.type === 'string' && obj.maxLength === undefined) {
      obj.maxLength = 200;
    }
    for (const v of Object.values(obj)) walk(v);
  };
  walk(clone);
  return clone;
}

async function vllmStreamExtract(
  prompt: string,
  opts: {
    vllmUrl?: string;
    model: string;
    temperature: number;
    maxTokens: number;
    jsonSchema: { name: string; schema: Record<string, unknown>; strict: boolean };
    signal?: AbortSignal;
    timeoutMs?: number;
  },
  onField: (e: { eCode: string; value: string | null }) => void,
): Promise<Record<string, string | null>> {
  const baseUrl = opts.vllmUrl ?? 'http://localhost:11435';
  const safeSchema = stripUnsafeSchemaConstraints(opts.jsonSchema.schema);
  const body = {
    model: opts.model,
    temperature: opts.temperature,
    max_tokens: opts.maxTokens,
    messages: [{ role: 'user', content: prompt }],
    stream: true,
    response_format: {
      type: 'json_schema',
      json_schema: { name: opts.jsonSchema.name, schema: safeSchema, strict: opts.jsonSchema.strict },
    },
  };
  // Per-Request Timeout: wenn vLLM hängt (FSM-Compile-Stall, KV-Cache-OOM, …)
  // brechen wir ab statt forever-loop. Caller-signal bleibt zusätzlich gültig.
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`vLLM timeout after ${timeoutMs}ms`)), timeoutMs);
  const onParentAbort = () => ac.abort(opts.signal?.reason);
  opts.signal?.addEventListener('abort', onParentAbort, { once: true });
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onParentAbort);
    throw err;
  }
  if (!res.ok) {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onParentAbort);
    throw new Error(`vLLM stream ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  if (!res.body) {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onParentAbort);
    throw new Error('vLLM stream: no body');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let accumulated = '';
  const seen = new Set<string>();
  try {
    while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const line = chunk.trim();
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
        const delta = parsed.choices?.[0]?.delta?.content;
        if (typeof delta !== 'string' || delta.length === 0) continue;
        accumulated += delta;
        STREAMING_FIELD_RX.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = STREAMING_FIELD_RX.exec(accumulated)) !== null) {
          const eCode = m[1];
          if (seen.has(eCode)) continue;
          seen.add(eCode);
          let val: string | null;
          if (m[2] === 'null') val = null;
          else {
            try { val = JSON.parse(m[2]) as string; } catch { continue; }
          }
          onField({ eCode, value: val });
        }
      } catch { /* malformed SSE chunk */ }
    }
    }
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onParentAbort);
  }
  const stripped = accumulated.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(stripped.slice(start, end + 1)) as Record<string, string | null>; }
    catch { return {}; }
  }
  return {};
}

// ─────────────────────────────────────────────────────────────────────────
// I/O Types
// ─────────────────────────────────────────────────────────────────────────

export interface Phase3LlmFillInput {
  /** OCR-Volltext. */
  text: string;
  /** Output von Phase 1 — pro Anlage regex_hits + missing_ecodes. */
  phase1_per_anlage: Record<string, Phase1AnlageResult>;
  /** Output von felder-katalog — für die Atom-Metadata der missing_ecodes. */
  felder_per_anlage: Record<string, AnlagenFelderListe>;
}

export interface Phase3LlmHit {
  eCode: string;
  value: string;
  origin: 'LLM_FSM';
  /** §EStG-Kontext-Path aus dem Container. */
  kontextPath: string | null;
  anlage: string;
  drucktext: string;
  vordruckzeile: string;
  datentyp: 'string' | 'date' | 'currency';
}

export interface Phase3AnlageResult {
  anlage: string;
  /** Per eCode: alle vom LLM gefüllten Werte. */
  llm_hits: Record<string, Phase3LlmHit>;
  /** eCodes für die der LLM null geliefert hat. */
  still_missing: string[];
  /** Wie viele eCodes Phase 1 schon ausgefüllt hatte (für Audit). */
  prefilled_count: number;
  missing_at_start: number;
  durationMs: number;
  error?: string;
}

export interface Phase3LlmFillOutput {
  per_anlage: Record<string, Phase3AnlageResult>;
  totalFilled: number;
  ms: number;
}

export interface Phase3LlmFillConfig {
  provider?: ChatProvider;
  vllmUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  concurrency?: number;
  stream?: boolean;
  /** Per-Anlage Hard-Timeout in ms. Bricht den vLLM-Call ab statt forever
   *  zu hängen wenn FSM-Compile stallt oder KV-Cache OOM geht. Default 60_000. */
  perAnlageTimeoutMs?: number;
  /** v5.1-Modus: type-aware Schema (currency→number, date→ISO-string,
   *  enum-Felder→enum). Default false (=v5-kompatibel). */
  typedSchema?: boolean;
}

const DEFAULT_MODEL_BY_PROVIDER: Record<ChatProvider, string> = {
  vllm: 'gemma4-mm',
  mistral: 'mistral-large-latest',
  ollama: 'gemma4:31b-128k',
  anthropic: 'claude-haiku-4-5',
};

// ─────────────────────────────────────────────────────────────────────────
// Prompt-Bau
// ─────────────────────────────────────────────────────────────────────────

/** Bekannte ELSTER-Enum-Felder (BMF-kategorial). Wenn ein eCode hier auftaucht
 *  → strict enum statt freier String. Werte sind die ERiC-Schlüssel. */
const ENUM_FOR_ECODE: Record<string, string[]> = {
  // Religionszugehörigkeit (Stpfl./Ehegatte, ganzjährig + monatlich)
  E0100402: ['ev', 'rk', 'ak', 'ak2', 'is', 'jd', 'fr', 'fa', '--'],
};
// Religion ist über mehrere monatliche eCodes verteilt (E0100410..E0100421
// + Ehegatten-Pendants). Hier compact als Prefix-Map abgebildet.
const RELIGION_PREFIXES = ['E010041', 'E010042', 'E010043', 'E010044'];
function enumForECode(eCode: string): string[] | null {
  if (eCode in ENUM_FOR_ECODE) return ENUM_FOR_ECODE[eCode];
  for (const p of RELIGION_PREFIXES) {
    if (eCode.startsWith(p) && eCode.length === 8) {
      // Monats-Religion: gleiche Codes wie ganzjährig
      return ENUM_FOR_ECODE.E0100402;
    }
  }
  return null;
}

function buildDynamicSchema(
  anlage: string,
  felder: AnlagenFeld[],
  opts: { typed: boolean } = { typed: false },
): { name: string; schema: Record<string, unknown> } {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const f of felder) {
    if (opts.typed) {
      properties[f.eCode] = buildTypedProperty(f);
    } else {
      properties[f.eCode] = {
        type: ['string', 'null'],
        description: `${f.drucktext.slice(0, 100)} (Z${f.vordruckzeile}, ${f.datentyp}${f.pflicht ? ', PFLICHT' : ''})`,
      };
    }
    required.push(f.eCode);
  }
  return {
    name: `phase3_fill_${anlage.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
    schema: {
      type: 'object',
      additionalProperties: false,
      required,
      properties,
    },
  };
}

/** Typed-Mode Property-Builder. Lässt vLLMs FSM die Type-Coercion machen:
 *   • currency → number|null  (FSM zwingt "30.707,00" → 30707)
 *   • date     → string|null, maxLength 10 (ISO YYYY-MM-DD via description)
 *   • enum     → enum-Schlüssel (Religion, Familienstand, …)
 *   • string   → string|null, maxLength aus atom.maxLaenge
 */
function buildTypedProperty(f: AnlagenFeld): Record<string, unknown> {
  const desc = `${f.drucktext.slice(0, 100)} (Z${f.vordruckzeile}${f.pflicht ? ', PFLICHT' : ''})`;
  switch (f.datentyp) {
    case 'currency':
      return { type: ['number', 'null'], description: `${desc} — Betrag in EUR als Zahl (FSM coercet "1.234,56" → 1234.56)` };
    case 'date':
      return { type: ['string', 'null'], maxLength: 10, description: `${desc} — ISO-Datum YYYY-MM-DD` };
    case 'string':
    default: {
      const enumVals = enumForECode(f.eCode);
      if (enumVals) {
        return {
          type: ['string', 'null'],
          enum: [...enumVals, null],
          description: `${desc} — kategorial`,
        };
      }
      return {
        type: ['string', 'null'],
        maxLength: f.maxLaenge ?? 200,
        description: desc,
      };
    }
  }
}

function formatHintsBlock(hits: Record<string, Phase1RegexHit>): string {
  const entries = Object.values(hits);
  if (entries.length === 0) return '';
  const lines: string[] = [
    '--- VORANALYSIERTE FORM-FIELD-HINTS (Phase 1 deterministisch erkannt) ---',
    '(Diese Felder sind bereits 100%ig zugeordnet. Nutze sie als Layout-Anker,',
    ' um dich in der OCR-Tabelle zu orientieren. NICHT erneut extrahieren.)',
    '',
  ];
  for (const h of entries) {
    lines.push(`  ${h.eCode} [Z${h.vordruckzeile} ${h.datentyp}]  ${h.drucktext} = ${h.value}`);
  }
  return lines.join('\n');
}

function formatMissingFieldsBlock(felder: AnlagenFeld[]): string {
  const lines: string[] = ['# Lückenfüller — diese Felder hast du zu extrahieren:'];
  for (const f of felder) {
    const tags = [
      f.vordruckzeile ? `Z${f.vordruckzeile}` : '',
      f.datentyp,
      f.pflicht ? 'PFLICHT' : '',
    ].filter(Boolean).join(' ');
    lines.push(`  ${f.eCode} [${tags}]  ${f.drucktext.slice(0, 100)}`);
  }
  return lines.join('\n');
}

async function formatEinkunftsartenZitate(felder: AnlagenFeld[]): Promise<string> {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const f of felder) {
    if (!f.einkunftsart || seen.has(f.einkunftsart)) continue;
    seen.add(f.einkunftsart);
    const zitat = await paragraphFuer(f.einkunftsart);
    lines.push(`  • ${f.einkunftsart.padEnd(24)} ${zitat}`);
  }
  if (lines.length === 0) return '';
  return '# §EStG-Rahmen für die noch fehlenden Felder:\n' + lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────
// Stage
// ─────────────────────────────────────────────────────────────────────────

export const phase3LlmFillStage = defineStage<Phase3LlmFillInput, Phase3LlmFillOutput, Phase3LlmFillConfig>({
  id: 'elster-v5/phase3-llm-fill',
  name: 'Phase 3 — LLM-Lückenfüller mit Dynamic Schema + Layout-Hints',
  description:
    'Füllt die von Phase 1 gelassenen Lücken via vLLM Gemma-4 strict-json-schema. ' +
    'Dynamisches Schema enthält NUR die missing_ecodes (winziges Vokabular → schnell). ' +
    'Phase-1-regex_hits werden als räumliche Anker in den Prompt injiziert. ' +
    'Token-Level Streaming via SSE — pro Feld ein phase3_field-Event.',
  hints: {
    inputs: 'text, phase1_per_anlage (Phase 1 result), felder_per_anlage (Atom-Metadata)',
    outputs: 'per_anlage map mit llm_hits + still_missing pro Anlage, totalFilled, ms',
    configExample: JSON.stringify(
      { provider: 'vllm', model: 'gemma4-mm', temperature: 0, maxTokens: 2000, concurrency: 7, stream: true },
      null,
      2,
    ),
    llm: { providers: ['vllm', 'mistral'], default: 'vllm' },
    acceptsContainers: ['elster-catalog'],
    inputPorts: [
      { name: 'text', type: 'text' },
      { name: 'phase1_per_anlage', type: 'json' },
      { name: 'felder_per_anlage', type: 'json' },
    ],
    outputPorts: [
      { name: 'per_anlage', type: 'json' },
      { name: 'totalFilled', type: 'number' },
    ],
  },

  async run(input, ctx) {
    const t0 = Date.now();
    const cfg = ctx.config ?? {};
    const provider: ChatProvider = cfg.provider ?? 'vllm';
    const modelName = cfg.model ?? DEFAULT_MODEL_BY_PROVIDER[provider];
    const temperature = cfg.temperature ?? 0;
    const maxTokens = cfg.maxTokens ?? 2000;
    const concurrency = Math.max(1, cfg.concurrency ?? 3);
    const wantStream = (cfg.stream ?? true) && provider === 'vllm';
    const perAnlageTimeoutMs = cfg.perAnlageTimeoutMs ?? 60_000;
    const typedSchema = cfg.typedSchema ?? false;

    const phase1 = input.phase1_per_anlage ?? {};
    const felderMap = input.felder_per_anlage ?? {};
    const results: Record<string, Phase3AnlageResult> = {};
    const anlagen = Object.keys(phase1);
    if (anlagen.length === 0) {
      return { per_anlage: {}, totalFilled: 0, ms: Date.now() - t0 };
    }

    const brief = await loadContainerBrief();
    let totalFilled = 0;
    ctx.emit('phase3_start', { anlagen: anlagen.length, model: modelName, concurrency });

    const processOne = async (anlage: string): Promise<void> => {
      const phase1Result = phase1[anlage];
      const liste = felderMap[anlage];
      const tA = Date.now();
      ctx.emit('phase3_anlage_start', { anlage, missing: phase1Result.missing_ecodes.length });

      // Wenn nichts fehlt → skip LLM komplett.
      if (phase1Result.missing_ecodes.length === 0) {
        results[anlage] = {
          anlage,
          llm_hits: {},
          still_missing: [],
          prefilled_count: Object.keys(phase1Result.regex_hits).length,
          missing_at_start: 0,
          durationMs: Date.now() - tA,
        };
        ctx.emit('phase3_anlage_done', { anlage, filled: 0, still_missing: 0, skipped: true });
        return;
      }

      const missingEcodes = new Set(phase1Result.missing_ecodes);
      const missingFelder = (liste?.felder ?? []).filter((f) => missingEcodes.has(f.eCode));
      if (missingFelder.length === 0) {
        results[anlage] = {
          anlage,
          llm_hits: {},
          still_missing: phase1Result.missing_ecodes,
          prefilled_count: Object.keys(phase1Result.regex_hits).length,
          missing_at_start: phase1Result.missing_ecodes.length,
          durationMs: Date.now() - tA,
          error: 'no atom-metadata found for missing eCodes (felder-katalog mismatch)',
        };
        return;
      }

      const schema = buildDynamicSchema(anlage, missingFelder, { typed: typedSchema });
      const hintsBlock = formatHintsBlock(phase1Result.regex_hits);
      const missingBlock = formatMissingFieldsBlock(missingFelder);
      const zitate = await formatEinkunftsartenZitate(missingFelder);

      const prompt = [
        '=== CONTAINER-BRIEF (zuerst lesen) ===',
        brief,
        '=== ENDE BRIEF ===',
        '',
        `# Aufgabe: Lücken-Füller für Anlage ${anlage} (Phase 3 von 5)`,
        '',
        zitate,
        '',
        hintsBlock,
        '',
        missingBlock,
        '',
        '# Regeln:',
        '- Für JEDEN eCode oben: setze den Wert wenn du ihn im OCR findest, sonst NULL.',
        '- Currency-Werte in deutscher Notation belassen (z.B. "1.234,56"); Normalisierung downstream.',
        '- Date-Werte im Originalformat des Belegs.',
        '- KEINE eCodes erfinden — nur die oben aufgelisteten Felder im Output.',
        '- Die Hints oben sind schon korrekt — extrahiere sie NICHT nochmal.',
        '',
        '# OCR-Volltext:',
        input.text,
      ].join('\n');

      const overheadChars = brief.length + hintsBlock.length + missingBlock.length + zitate.length + 500;
      const budget = computePromptBudget({
        modelContextTokens: contextTokensFor(modelName),
        schema: schema.schema,
        maxOutputTokens: maxTokens,
        overheadTokens: Math.ceil(overheadChars / 3.5),
      });
      try {
        assertFitsInBudget(input.text, budget);
      } catch (err) {
        if (err instanceof PromptBudgetExceededError) {
          results[anlage] = {
            anlage,
            llm_hits: {},
            still_missing: phase1Result.missing_ecodes,
            prefilled_count: Object.keys(phase1Result.regex_hits).length,
            missing_at_start: phase1Result.missing_ecodes.length,
            durationMs: Date.now() - tA,
            error: `OCR (${err.textLen}) > Budget (${err.budgetChars}); auto-source-split davor schalten`,
          };
          ctx.emit('phase3_anlage_error', { anlage, reason: 'budget', textLen: err.textLen });
          return;
        }
        throw err;
      }

      try {
        let parsed: Record<string, string | null> = {};
        if (wantStream) {
          parsed = await vllmStreamExtract(
            prompt,
            {
              vllmUrl: cfg.vllmUrl,
              model: modelName,
              temperature,
              maxTokens,
              jsonSchema: { name: schema.name, schema: schema.schema, strict: true },
              signal: ctx.signal,
              timeoutMs: perAnlageTimeoutMs,
            },
            ({ eCode, value }) => ctx.emit('phase3_field', { anlage, eCode, value }),
          );
        } else {
          const r = await chatJson<Record<string, string | null>>(prompt, {
            provider,
            model: modelName,
            vllmUrl: cfg.vllmUrl,
            temperature,
            maxTokens,
            jsonSchema: { name: schema.name, schema: schema.schema, strict: true },
            signal: ctx.signal,
          });
          parsed = r.parsed as Record<string, string | null>;
        }

        const allowed = new Set(missingFelder.map((f) => f.eCode));
        const llm_hits: Record<string, Phase3LlmHit> = {};
        const still_missing: string[] = [];
        const felderByECode = new Map(missingFelder.map((f) => [f.eCode, f]));
        for (const eCode of missingFelder.map((f) => f.eCode)) {
          const v = parsed[eCode];
          if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) {
            still_missing.push(eCode);
            continue;
          }
          if (!allowed.has(eCode)) continue;
          const f = felderByECode.get(eCode)!;
          llm_hits[eCode] = {
            eCode,
            value: String(v),
            origin: 'LLM_FSM',
            kontextPath: f.einkunftsart,
            anlage,
            drucktext: f.drucktext,
            vordruckzeile: f.vordruckzeile,
            datentyp: f.datentyp,
          };
        }
        const r: Phase3AnlageResult = {
          anlage,
          llm_hits,
          still_missing,
          prefilled_count: Object.keys(phase1Result.regex_hits).length,
          missing_at_start: phase1Result.missing_ecodes.length,
          durationMs: Date.now() - tA,
        };
        results[anlage] = r;
        totalFilled += Object.keys(llm_hits).length;
        await ctx.artifacts.write(`phase3_per_anlage/${anlage}.json`, r);
        ctx.emit('phase3_anlage_done', {
          anlage,
          filled: Object.keys(llm_hits).length,
          still_missing: still_missing.length,
          durationMs: r.durationMs,
        });
      } catch (err) {
        const msg = (err as Error).message;
        results[anlage] = {
          anlage,
          llm_hits: {},
          still_missing: phase1Result.missing_ecodes,
          prefilled_count: Object.keys(phase1Result.regex_hits).length,
          missing_at_start: phase1Result.missing_ecodes.length,
          durationMs: Date.now() - tA,
          error: msg,
        };
        ctx.emit('phase3_anlage_error', { anlage, reason: 'llm', error: msg });
      }
    };

    const queue = [...anlagen];
    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const anlage = queue.shift();
        if (!anlage) break;
        await processOne(anlage);
      }
    };
    const nWorkers = Math.min(concurrency, anlagen.length);
    await Promise.all(Array.from({ length: nWorkers }, () => worker()));

    ctx.emit('phase3_done', { anlagen: anlagen.length, totalFilled });
    return { per_anlage: results, totalFilled, ms: Date.now() - t0 };
  },
});
