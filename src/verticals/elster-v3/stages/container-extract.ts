/**
 * elster-v4/container-extract — vLLM Gemma-4 strict-json-schema Extraktion
 * pro Anlage. EIN Call pro Anlage; sequenziell.
 *
 * Architektur (siehe plan): klassifizierung (regex) → felder-katalog →
 * **container-extract** → funnel → validator.
 *
 * Pro Anlage:
 *   1. Lade CONTAINER_BRIEF.md (atom-schema, konventionen — wird IM PROMPT
 *      als allererster Block geladen).
 *   2. Sammele Einkunftsarten aus den Atom-kontextPaths + §EStG-Klartextzitate.
 *   3. Generiere strict JSON-Schema dynamisch:
 *        - properties: { [eCode]: { type:["string","null"], description, pattern } }
 *        - additionalProperties: false  (Gemma darf KEINE eigenen eCodes erfinden)
 *        - required: alle eCodes (Modell muss jeden expliziten Wert oder null setzen)
 *   4. vLLM Gemma-4-Call (response_format=json_schema strict).
 *   5. Output-Shape identisch zu elster/extraktion → funnel-stage unverändert.
 *
 * No-Truncate-Policy: assertFitsInBudget() vor jedem Call; OCR + Brief +
 * Felderliste + Schema müssen ins Budget passen. Bei Übergröße wirft
 * PromptBudgetExceededError mit Hinweis auf auto-source-split.
 */
import { defineStage } from '../../../core/stage.ts';
import { chatJson, type ChatProvider } from '../../../lib/llm-chat.ts';

// ─────────────────────────────────────────────────────────────────────────
// Streaming vLLM helper — extracts per-field events as tokens arrive
// ─────────────────────────────────────────────────────────────────────────
//
// vLLM serves an OpenAI-compatible SSE stream when `stream: true`. Mit
// strict json_schema mode bleibt der akkumulierte Output JSON-valide
// (FSM-constrained decoding) → wir können während dem Streaming mit einem
// Regex die fertigen `"eCode": "..."` Paare detektieren und live emitten.
//
// Pattern: `"(E\d+)"\s*:\s*("(?:[^"\\]|\\.)*"|null)(?=\s*[,}])`
//   — ein eCode-Key, dann ein vollständig terminierter String-Value oder null,
//     gefolgt von Komma oder closing brace (= Wert ist garantiert komplett).

const STREAMING_FIELD_RX = /"(E\d+)"\s*:\s*("(?:[^"\\]|\\.)*"|null)(?=\s*[,}])/g;

interface StreamFieldEvent {
  eCode: string;
  value: string | null;
}

async function chatJsonVllmStreaming(
  prompt: string,
  opts: {
    vllmUrl?: string;
    model: string;
    temperature: number;
    maxTokens: number;
    jsonSchema: { name: string; schema: Record<string, unknown>; strict: boolean };
    signal?: AbortSignal;
  },
  onField: (e: StreamFieldEvent) => void,
): Promise<{ parsed: Record<string, string | null>; raw: string }> {
  const baseUrl = opts.vllmUrl ?? 'http://localhost:11435';
  const body = {
    model: opts.model,
    temperature: opts.temperature,
    max_tokens: opts.maxTokens,
    messages: [{ role: 'user', content: prompt }],
    stream: true,
    response_format: {
      type: 'json_schema',
      json_schema: opts.jsonSchema,
    },
  };
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    signal: opts.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`vLLM stream ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.body) throw new Error('vLLM stream: no body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let accumulated = '';
  const seenECodes = new Set<string>();

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
        const parsed = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const delta = parsed.choices?.[0]?.delta?.content;
        if (typeof delta !== 'string' || delta.length === 0) continue;
        accumulated += delta;
        // Re-scan the accumulated buffer for newly-completed eCode pairs.
        // STREAMING_FIELD_RX is global; we reset lastIndex each scan.
        STREAMING_FIELD_RX.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = STREAMING_FIELD_RX.exec(accumulated)) !== null) {
          const eCode = m[1];
          if (seenECodes.has(eCode)) continue;
          seenECodes.add(eCode);
          let value: string | null;
          if (m[2] === 'null') value = null;
          else {
            try { value = JSON.parse(m[2]) as string; }
            catch { continue; } // unparseable — skip, will retry on next scan
          }
          onField({ eCode, value });
        }
      } catch {
        // Malformed SSE chunk — skip silently
      }
    }
  }

  // Final-Parse: vollständige akkumulierte Antwort.
  const stripped = accumulated.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  let finalParsed: Record<string, string | null> = {};
  if (start >= 0 && end > start) {
    try {
      finalParsed = JSON.parse(stripped.slice(start, end + 1)) as Record<string, string | null>;
    } catch {
      // accumulated war nicht vollständig — wir liefern was wir an Events gesendet haben
    }
  }
  return { parsed: finalParsed, raw: accumulated };
}
import {
  loadContainerBrief,
  paragraphFuer,
  disambiguationHinweiseFuer,
  type AnlagenFelderListe,
  type AnlagenFeld,
} from '../../../lib/elster-catalog.ts';
import {
  computePromptBudget,
  contextTokensFor,
  assertFitsInBudget,
  PromptBudgetExceededError,
} from '../../../lib/prompt-budget.ts';
import type { CatalogHandle } from '../../../core/tools/handles.ts';

export interface ContainerExtractInput {
  /** OCR-Volltext (von mistral-ocr). */
  text: string;
  /** Anlagen-Felder-Listen aus elster-v4/felder-katalog. */
  per_anlage: Record<string, AnlagenFelderListe>;
  /** Optional: Doc-Class-Hint für Disambiguation (Single-Doc-Belege haben
   *  eindeutiges dokumenttyp_id; Multi-Doc-Bundles lassen das leer). */
  dokumenttyp_id?: string;
}

export interface AnlageExtractResult {
  anlage: string;
  /** Wie viele Atome im Input-Schema waren. */
  fieldCount: number;
  /** Wie viele dieser Atome einen Wert ≠ null bekommen haben. */
  filled: number;
  /** Map eCode → Wert (oder null wenn LLM keinen Wert finden konnte). */
  values: Record<string, string | null>;
  durationMs: number;
  error?: string;
  /** §EStG-Einkunftsarten die in dieser Anlage vorkommen (BMF-Prefixes). */
  einkunftsarten: string[];
}

export interface ContainerExtractOutput {
  per_anlage: Record<string, AnlageExtractResult>;
  totalFilled: number;
  ms: number;
}

export interface ContainerExtractConfig {
  provider?: ChatProvider;
  vllmUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Anlagen mit mehr als so vielen Atomen werden upfront ausgeschlossen
   *  und im Result mit error vermerkt — sehr selten in der Praxis
   *  (kein BMF-Anlage hat > 250 Atome). Default 250. */
  maxFelderProAnlage?: number;
  /** Token-level Streaming (nur vLLM-Provider): emittiert
   *  `container_extract_field`-Events sobald jeder eCode-Wert fertig generiert
   *  ist, statt auf den ganzen Response zu warten. UI kann Felder live
   *  anzeigen. Default true für vLLM, ignoriert für andere Provider. */
  stream?: boolean;
  /** Wie viele Anlagen parallel extrahiert werden. vLLM mit Continuous
   *  Batching kann mehrere Requests effizient auf dem GPU batchen, solange
   *  --max-num-seqs nicht überschritten wird. Default 3 (konservativ); auf
   *  H200V Gemma-4-mm TP=2 sind 5-7 unproblematisch. Setze auf 1 für
   *  rein sequenzielle Verarbeitung (deterministische Log-Reihenfolge). */
  concurrency?: number;
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

function einkunftsartenFromFelder(felder: AnlagenFeld[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of felder) {
    if (f.einkunftsart && !seen.has(f.einkunftsart)) {
      seen.add(f.einkunftsart);
      out.push(f.einkunftsart);
    }
  }
  return out;
}

async function buildEinkunftsartenZitate(prefixes: string[]): Promise<string> {
  if (prefixes.length === 0) return '';
  const lines: string[] = ['§EStG-Rahmen für diese Anlage:'];
  for (const p of prefixes) {
    const zitat = await paragraphFuer(p);
    lines.push(`  • ${p.padEnd(24)} ${zitat}`);
  }
  return lines.join('\n');
}

function formatFelderListe(felder: AnlagenFeld[]): string {
  const lines: string[] = [];
  for (const f of felder) {
    const tags: string[] = [];
    if (f.vordruckzeile) tags.push(`Z${f.vordruckzeile}`);
    tags.push(f.datentyp);
    if (f.pflicht) tags.push('PFLICHT');
    const tag = `[${tags.join(' ')}]`;
    lines.push(`  ${f.eCode} ${tag}  ${f.drucktext.slice(0, 100)}`);
  }
  return lines.join('\n');
}

/** Generiert das strict JSON-Schema dynamisch aus der Felder-Liste der Anlage. */
function buildSchema(anlage: string, felder: AnlagenFeld[]): { name: string; schema: Record<string, unknown> } {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const f of felder) {
    const desc = [
      f.drucktext.slice(0, 100),
      `(Z${f.vordruckzeile}, ${f.datentyp}${f.pflicht ? ', PFLICHT' : ''})`,
    ].join(' ');
    properties[f.eCode] = {
      type: ['string', 'null'],
      description: desc,
    };
    required.push(f.eCode);
  }
  return {
    name: `extract_${anlage.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
    schema: {
      type: 'object',
      additionalProperties: false,
      required,
      properties,
    },
  };
}

interface PromptBundle {
  prompt: string;
  schema: ReturnType<typeof buildSchema>;
  einkunftsarten: string[];
}

async function buildPrompt(
  anlage: string,
  felder: AnlagenFeld[],
  text: string,
  brief: string,
  dokumenttypId: string | undefined,
): Promise<PromptBundle> {
  const einkunftsarten = einkunftsartenFromFelder(felder);
  const rahmen = await buildEinkunftsartenZitate(einkunftsarten);
  const disambiguation = dokumenttypId
    ? await disambiguationHinweiseFuer(dokumenttypId)
    : [];
  const schema = buildSchema(anlage, felder);

  const promptParts: string[] = [
    '=== CONTAINER-BRIEF (zuerst lesen) ===',
    brief,
    '=== ENDE BRIEF ===',
    '',
    `# Aufgabe: Felder-Extraktion für Anlage ${anlage}`,
    '',
  ];
  if (rahmen.length > 0) {
    promptParts.push(rahmen, '');
  }
  if (disambiguation.length > 0) {
    promptParts.push('Klassifikations-Hinweise:', ...disambiguation, '');
  }
  promptParts.push(
    `# Felder dieser Anlage (${felder.length} eCodes — alle aus atoms.json):`,
    formatFelderListe(felder),
    '',
    '# Regeln:',
    '- Für JEDEN eCode oben: setze den Wert wenn du ihn im OCR-Text findest, sonst NULL.',
    '- Currency-Werte in deutscher Notation belassen (z.B. "1.234,56"); Normalisierung erfolgt downstream.',
    '- Date-Werte im Originalformat des Belegs.',
    '- String-Werte trimmen, sonst unverändert.',
    '- KEINE eCodes erfinden — nur die oben aufgelisteten Felder kommen im Output vor.',
    '- Pflicht-Felder unbedingt prüfen wenn der Beleg dieser Anlage tatsächlich enthält.',
    '',
    '# OCR-Volltext:',
    text,
  );
  return { prompt: promptParts.join('\n'), schema, einkunftsarten };
}

// ─────────────────────────────────────────────────────────────────────────
// Stage
// ─────────────────────────────────────────────────────────────────────────

export const containerExtractStage = defineStage<
  ContainerExtractInput,
  ContainerExtractOutput,
  ContainerExtractConfig
>({
  id: 'elster-v4/container-extract',
  name: 'Container-Extract (vLLM Gemma-4 strict-json, sequenziell pro Anlage)',
  description:
    'Extrahiert pro erkannter Anlage die eCode-Werte aus dem OCR-Text via ' +
    'vLLM Gemma-4 mit dynamisch generiertem strict json_schema. Schema ' +
    'kommt aus atoms.json (single source of truth). Prompt lädt zuerst ' +
    'CONTAINER_BRIEF.md, dann §EStG-Rahmen aus paragraph_estg.json, dann ' +
    'die Felder-Liste, dann den vollen OCR-Text (niemals truncated). ' +
    'Output-Shape kompatibel mit elster/funnel.',
  hints: {
    inputs: 'text (OCR), per_anlage (von elster-v4/felder-katalog) · optional: dokumenttyp_id',
    outputs: 'per_anlage map (AnlageExtractResult pro Anlage), totalFilled, ms',
    configExample: JSON.stringify(
      { provider: 'vllm', model: 'gemma4-mm', temperature: 0, maxTokens: 2000, maxFelderProAnlage: 250 },
      null,
      2,
    ),
    llm: { providers: ['vllm', 'mistral'], default: 'vllm' },
    acceptsContainers: ['elster-catalog'],
    inputPorts: [
      { name: 'text', type: 'text' },
      { name: 'per_anlage', type: 'json' },
      { name: 'dokumenttyp_id', type: 'string' },
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
    const maxFelder = cfg.maxFelderProAnlage ?? 250;
    const temperature = cfg.temperature ?? 0;
    const maxTokens = cfg.maxTokens ?? 2000;
    const concurrency = Math.max(1, cfg.concurrency ?? 3);

    const perAnlage = input.per_anlage ?? {};
    const anlagen = Object.keys(perAnlage);
    const results: Record<string, AnlageExtractResult> = {};

    if (anlagen.length === 0) {
      return { per_anlage: {}, totalFilled: 0, ms: Date.now() - t0 };
    }

    // P7: Catalog-Handle für Container-Identität + zukünftige Brief-Quelle.
    // CONTAINER_BRIEF.md ist (noch) keine atoms/container/nested-Key, daher
    // bleibt loadContainerBrief() der Fallback-Pfad. Wenn das Catalog-Tool
    // gebunden ist, emitten wir die containerId im Start-Event für Audit.
    const cat = ctx.tools.has('elster-catalog')
      ? ctx.tools.get<CatalogHandle>('elster-catalog')
      : null;

    const containerBrief = await loadContainerBrief();
    let totalFilled = 0;
    ctx.emit('container_extract_start', {
      anlagen: anlagen.length,
      model: modelName,
      concurrency,
      containerId: cat?.meta.containerId,
    });

    // Worker-Pool: parallele Anlagen-Extraktion. vLLM mit Continuous Batching
    // batched effizient; bei concurrency=1 äquivalent zum sequenziellen Loop.
    const queue = [...anlagen];

    const processOne = async (anlage: string): Promise<void> => {
      const liste = perAnlage[anlage];
      const felder = (liste?.felder ?? []).filter((f) => /^E\d+$/.test(f.eCode));
      const t_a = Date.now();
      ctx.emit('container_extract_anlage_start', { anlage, fieldCount: felder.length });

      if (felder.length === 0) {
        results[anlage] = {
          anlage,
          fieldCount: 0,
          filled: 0,
          values: {},
          durationMs: Date.now() - t_a,
          einkunftsarten: [],
        };
        return;
      }
      if (felder.length > maxFelder) {
        results[anlage] = {
          anlage,
          fieldCount: felder.length,
          filled: 0,
          values: {},
          durationMs: Date.now() - t_a,
          error: `Anlage hat ${felder.length} Felder > maxFelderProAnlage=${maxFelder}; reduziere config oder schalte auto-source-split davor.`,
          einkunftsarten: [],
        };
        ctx.emit('container_extract_anlage_error', { anlage, reason: 'too_many_fields' });
        return;
      }

      let prompt!: PromptBundle;
      try {
        prompt = await buildPrompt(anlage, felder, input.text, containerBrief, input.dokumenttyp_id);
      } catch (err) {
        const msg = (err as Error).message;
        results[anlage] = {
          anlage,
          fieldCount: felder.length,
          filled: 0,
          values: {},
          durationMs: Date.now() - t_a,
          error: `buildPrompt failed: ${msg}`,
          einkunftsarten: [],
        };
        ctx.emit('container_extract_anlage_error', { anlage, reason: 'prompt_build', error: msg });
        return;
      }

      // No-Truncate: prüfe ob OCR-Text noch ins Budget passt nachdem
      // Brief + Felder-Liste + Schema reserviert wurden.
      const schemaCharLen = JSON.stringify(prompt.schema.schema).length;
      const promptOverheadChars =
        containerBrief.length +
        prompt.prompt.length -
        input.text.length; // Header + Felder + Schema-Beschreibung
      const budget = computePromptBudget({
        modelContextTokens: contextTokensFor(modelName),
        schema: prompt.schema.schema,
        maxOutputTokens: maxTokens,
        overheadTokens: Math.ceil((promptOverheadChars + schemaCharLen) / 3.5) + 500,
      });
      try {
        assertFitsInBudget(input.text, budget);
      } catch (err) {
        if (err instanceof PromptBudgetExceededError) {
          results[anlage] = {
            anlage,
            fieldCount: felder.length,
            filled: 0,
            values: {},
            durationMs: Date.now() - t_a,
            error:
              `OCR (${err.textLen} chars) > Budget (${err.budgetChars} chars) für Modell ${modelName}. ` +
              `Splitte den OCR-Text via auto-source-split (chunks[]) und rufe container-extract pro chunk separat auf.`,
            einkunftsarten: prompt.einkunftsarten,
          };
          ctx.emit('container_extract_anlage_error', {
            anlage,
            reason: 'budget',
            originalChars: err.textLen,
            budgetChars: err.budgetChars,
          });
          return;
        }
        throw err;
      }

      // LLM-Call — streaming wenn vLLM + stream=true (Default).
      try {
        let parsed: Record<string, string | null>;
        const wantStream = (cfg.stream ?? true) && provider === 'vllm';
        if (wantStream) {
          const r = await chatJsonVllmStreaming(
            prompt.prompt,
            {
              vllmUrl: cfg.vllmUrl,
              model: modelName,
              temperature,
              maxTokens,
              jsonSchema: { name: prompt.schema.name, schema: prompt.schema.schema, strict: true },
              signal: ctx.signal,
            },
            ({ eCode, value }) => {
              // Live-Event pro fertig generiertem Feld — UI kann es sofort anzeigen.
              ctx.emit('container_extract_field', { anlage, eCode, value });
            },
          );
          parsed = r.parsed;
        } else {
          const r = await chatJson<Record<string, string | null>>(prompt.prompt, {
            provider,
            model: modelName,
            vllmUrl: cfg.vllmUrl,
            temperature,
            maxTokens,
            jsonSchema: { name: prompt.schema.name, schema: prompt.schema.schema, strict: true },
            signal: ctx.signal,
          });
          parsed = r.parsed;
        }

        // Filtere auf die erwarteten eCodes (strict-mode garantiert das, aber defensive).
        const allowed = new Set(felder.map((f) => f.eCode));
        const values: Record<string, string | null> = {};
        let filled = 0;
        for (const f of felder) {
          // Stelle sicher, dass jeder eCode im Output vorkommt — auch wenn
          // strict-mode den Wert nicht liefert (sollte nicht passieren).
          if (!(f.eCode in (parsed ?? {}))) values[f.eCode] = null;
        }
        for (const [k, v] of Object.entries(parsed ?? {})) {
          if (!allowed.has(k)) continue;
          if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) {
            values[k] = null;
          } else {
            values[k] = String(v);
            filled++;
          }
        }
        const r: AnlageExtractResult = {
          anlage,
          fieldCount: felder.length,
          filled,
          values,
          durationMs: Date.now() - t_a,
          einkunftsarten: prompt.einkunftsarten,
        };
        results[anlage] = r;
        totalFilled += filled;
        await ctx.artifacts.write(`per_anlage/${anlage}.json`, r);
        // Streame die extrahierten Werte direkt im Event — UI kann sie
        // anzeigen sobald die Anlage durchläuft, statt auf stage_done zu
        // warten. Filtert null-Felder raus damit das Event kompakt bleibt.
        const filledValues: Record<string, string> = {};
        for (const [k, v] of Object.entries(values)) {
          if (v !== null) filledValues[k] = v;
        }
        ctx.emit('container_extract_anlage_done', {
          anlage,
          filled,
          fieldCount: felder.length,
          durationMs: r.durationMs,
          einkunftsarten: prompt.einkunftsarten,
          values: filledValues,
        });
      } catch (err) {
        const msg = (err as Error).message;
        results[anlage] = {
          anlage,
          fieldCount: felder.length,
          filled: 0,
          values: {},
          durationMs: Date.now() - t_a,
          error: msg,
          einkunftsarten: prompt.einkunftsarten,
        };
        ctx.logger.warn(`container-extract failed for ${anlage}`, { error: msg });
        ctx.emit('container_extract_anlage_error', { anlage, reason: 'llm', error: msg });
      }
    };  // end processOne

    // Spawn `concurrency` Worker, die parallel aus dem queue ziehen.
    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const anlage = queue.shift();
        if (!anlage) break;
        await processOne(anlage);
      }
    };
    const nWorkers = Math.min(concurrency, anlagen.length);
    await Promise.all(Array.from({ length: nWorkers }, () => worker()));

    ctx.emit('container_extract_done', { anlagen: anlagen.length, totalFilled, concurrency });
    return { per_anlage: results, totalFilled, ms: Date.now() - t0 };
  },
});
