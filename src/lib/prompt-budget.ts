/**
 * Dynamisches Prompt-Budget für Schema-guarded LLM-Calls.
 *
 * Statt hardcoded `slice(0, 18000)` oder `slice(0, 5000)` bestimmen wir
 * den verfügbaren Source-Char-Cap aus:
 *
 *   sourceMaxChars = max( minSourceChars,
 *                         safetyMargin * (modelContextTokens
 *                                         - schemaTokens
 *                                         - outputTokens
 *                                         - overheadTokens)
 *                         * charsPerToken )
 *
 * Defaults entsprechen der Beobachtung:
 *   • safetyMargin = 0.8     — 20% Puffer (KV-Cache, tokenizer-overhead, etc.)
 *   • charsPerToken = 3.5    — Deutsch ist dichter als Englisch (~4),
 *                              technisches Vokabular drückt es runter
 *
 * Der überhead deckt unsere Standard-Layer-1-Prompt-Struktur ab:
 *   • Steuerrechtlicher Rahmen (Einkunftsarten)            ~150 Tokens
 *   • Kandidaten-eCodes (Top-50, grouped by Anlage)       ~1000 Tokens
 *   • Disambiguations-Hinweise                            ~200 Tokens
 *   • KPI-Hints + Headline + System-Boilerplate           ~250 Tokens
 *   = ~1600 Tokens — wir runden auf 2000 als Default-Overhead.
 */

export interface PromptBudgetInputs {
  /** Context-Window des Ziel-Modells in Tokens. */
  modelContextTokens: number;
  /** Optional: das strict json_schema, das mit gesendet wird.
   *  Wir tokenisieren es grob über JSON.stringify().length / charsPerToken. */
  schema?: unknown;
  /** max_tokens für die Modell-Antwort. */
  maxOutputTokens: number;
  /** Tokens, die der Rest des Prompts (Headline, Rahmen, Kandidaten, …)
   *  schon verbraucht. Default 2000 für unseren Layer-1-Stack. */
  overheadTokens?: number;
  /** Sicherheitsmarge (0..1). Default 0.8. */
  safetyMargin?: number;
  /** Tokenisierungs-Rate Chars/Token. Default 3.5 für Deutsch. */
  charsPerToken?: number;
  /** Absolutes Minimum für Source — wir kappen niemals unter diesen Wert.
   *  Default 1000 (LLM bekommt sonst zu wenig Kontext, lieber Error werfen). */
  minSourceChars?: number;
}

export interface PromptBudget {
  /** Wie viele Zeichen Source-Text wir maximal an den Prompt anhängen dürfen. */
  sourceMaxChars: number;
  /** Wie viele Tokens grob für Source übrig sind. */
  sourceBudgetTokens: number;
  /** Tokens-Aufschlüsselung für Observability/Debug. */
  breakdown: {
    modelContextTokens: number;
    schemaTokens: number;
    outputTokens: number;
    overheadTokens: number;
    safetyTokens: number;
    sourceBudgetTokens: number;
  };
}

/** Pro-Modell Context-Window in Tokens. Kein Anspruch auf Vollständigkeit;
 *  unbekannte Modelle → conservative 32K. */
const MODEL_CONTEXT_TOKENS: Record<string, number> = {
  // vLLM Gemma-4 family. Deployment auf H200V ist aktuell mit
  // --max-model-len=32768 gestartet (siehe `curl :11435/v1/models`).
  // Wenn der Container später mit 128k re-deployed wird → hier hochziehen.
  'gemma4-mm': 32_768,
  'google/gemma-4-31b-it': 32_768,
  'gemma4-embed': 8_192,
  // Mistral cloud
  'mistral-large-latest': 128_000,
  'mistral-large-2': 128_000,
  'mistral-small-latest': 32_000,
  // Ollama lokal
  'gemma4:31b-128k': 128_000,
  'gemma4:31b': 32_000,
  'gemma4:e4b': 8_192,
  'gemma3:27b': 8_192,
  'qwen3:32b': 32_000,
  'gpt-oss:120b': 32_000,
  // LightOn / Paddle (kleine Modelle)
  'lighton-ocr': 8_192,
  'paddleocr-vl': 4_096,
};

/** Schlägt die Context-Token für ein Modell nach. Fallback 32K. */
export function contextTokensFor(model: string): number {
  return MODEL_CONTEXT_TOKENS[model] ?? 32_000;
}

const DEFAULT_OVERHEAD_TOKENS = 2_000;
const DEFAULT_SAFETY = 0.8;
const DEFAULT_CHARS_PER_TOKEN = 3.5;
const DEFAULT_MIN_SOURCE_CHARS = 1_000;

/**
 * Berechnet das Source-Char-Budget. Garantiert ≥ minSourceChars; wirft
 * niemals (auch nicht bei pathologisch kleinem Context-Window — du kriegst
 * dann mindestens das Minimum und musst selbst entscheiden ob das reicht).
 */
export function computePromptBudget(opts: PromptBudgetInputs): PromptBudget {
  const safety = opts.safetyMargin ?? DEFAULT_SAFETY;
  const cpt = opts.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  const overheadTokens = opts.overheadTokens ?? DEFAULT_OVERHEAD_TOKENS;
  const minSourceChars = opts.minSourceChars ?? DEFAULT_MIN_SOURCE_CHARS;

  // Schema-Größe konservativ: JSON-stringify-Länge / 3.5 (Tokenizer-Schätzung).
  // 0 wenn kein Schema (Mistral mode mit json_object statt json_schema).
  const schemaChars = opts.schema ? JSON.stringify(opts.schema).length : 0;
  const schemaTokens = Math.ceil(schemaChars / cpt);

  // Bruttobudget vor Safety-Cut.
  const grossSourceTokens =
    opts.modelContextTokens - schemaTokens - opts.maxOutputTokens - overheadTokens;
  // Safety reserviert (1 - safety) der Brutto-Source-Tokens als Puffer.
  const sourceBudgetTokens = Math.floor(grossSourceTokens * safety);
  const safetyTokens = grossSourceTokens - sourceBudgetTokens;

  const computedChars = Math.floor(sourceBudgetTokens * cpt);
  const sourceMaxChars = Math.max(minSourceChars, computedChars);

  return {
    sourceMaxChars,
    sourceBudgetTokens: Math.max(
      Math.ceil(minSourceChars / cpt),
      sourceBudgetTokens,
    ),
    breakdown: {
      modelContextTokens: opts.modelContextTokens,
      schemaTokens,
      outputTokens: opts.maxOutputTokens,
      overheadTokens,
      safetyTokens,
      sourceBudgetTokens,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// No-Truncate-Policy
// ─────────────────────────────────────────────────────────────────────────
//
// Es gibt KEINE Truncation-Funktion. Wenn ein Source-Text das Budget sprengt
// MUSS er gesplittet werden (z.B. via auto-source-split → compare/fanout).
// Silent truncation würde Informationen verlieren — das ist verboten.
//
// API:
//   assertFitsInBudget(text, budget)   → throws PromptBudgetExceededError wenn zu groß
//   splitToFitBudget(text, budget)     → garantiert: jeder Chunk passt, kein Inhalt verloren
//   shouldFanoutBySource(len, budget)  → boolean-Check für Routing-Decisions

export class PromptBudgetExceededError extends Error {
  constructor(
    msg: string,
    public readonly textLen: number,
    public readonly budgetChars: number,
  ) {
    super(msg);
    this.name = 'PromptBudgetExceededError';
  }
}

/**
 * Wirft wenn `text` nicht in das `budget` passt. KEIN silent truncate.
 * Caller muss vorher auto-source-split fahren oder via splitToFitBudget chunken.
 */
export function assertFitsInBudget(text: string, budget: PromptBudget): void {
  if (text.length > budget.sourceMaxChars) {
    throw new PromptBudgetExceededError(
      `Source text (${text.length} chars) überschreitet Budget (${budget.sourceMaxChars}). ` +
      `Truncation ist per Policy verboten — splitte den Source via auto-source-split (chunks[]) ` +
      `und führe N parallele Calls via compare/fanout aus, oder benutze splitToFitBudget() inline.`,
      text.length,
      budget.sourceMaxChars,
    );
  }
}

/**
 * Splittet `text` in Chunks, von denen JEDER unter `budget.sourceMaxChars`
 * liegt. Niemals truncated — wenn ein einzelner Paragraph größer als das
 * Budget wäre, wird er an einer harten Char-Grenze geteilt, aber kein
 * Inhalt geht verloren.
 *
 * Strategie:
 *   1. Markdown-Header `^# ...` als bevorzugte Boundary (typisches OCR-Output).
 *   2. Paragraph-Boundaries (`\n\n`) als Fallback.
 *   3. Char-Boundary als letzter Ausweg (sehr lange Paragraphen).
 *
 * Output ist immer ein non-empty Array, auch für leeren Input (ein Chunk mit "").
 */
export function splitToFitBudget(
  text: string,
  budget: PromptBudget,
): string[] {
  const cap = budget.sourceMaxChars;
  if (text.length === 0) return [''];
  if (text.length <= cap) return [text];

  // Pass 1: Header-basiert, falls Markdown-Header vorhanden.
  if (/^#\s+/m.test(text)) {
    const sections = splitByHeaderInternal(text);
    const out: string[] = [];
    for (const sec of sections) {
      if (sec.length <= cap) out.push(sec);
      else out.push(...splitByParagraphInternal(sec, cap));
    }
    return out;
  }

  // Pass 2: Paragraph-basiert.
  return splitByParagraphInternal(text, cap);
}

function splitByHeaderInternal(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const sections: string[][] = [];
  let curr: string[] = [];
  for (const line of lines) {
    if (/^#\s+/.test(line)) {
      if (curr.length > 0) sections.push(curr);
      curr = [line];
    } else {
      curr.push(line);
    }
  }
  if (curr.length > 0) sections.push(curr);
  return sections.map((s) => s.join('\n'));
}

function splitByParagraphInternal(text: string, cap: number): string[] {
  const paras = text.split(/\n{2,}/);
  const out: string[] = [];
  let cur = '';
  for (const p of paras) {
    const next = cur.length === 0 ? p : `${cur}\n\n${p}`;
    if (next.length > cap) {
      if (cur.length > 0) out.push(cur);
      // Wenn der einzelne Paragraph selbst > cap → hard-cut entlang chars,
      // aber niemals verlieren: alle Stücke kommen raus.
      if (p.length > cap) {
        for (let i = 0; i < p.length; i += cap) {
          out.push(p.slice(i, i + cap));
        }
        cur = '';
      } else {
        cur = p;
      }
    } else {
      cur = next;
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * Boolean-Check: "passt der Text ins Budget?". Wird von Routing-Entscheidungen
 * benutzt (z.B. auto-source-split): true ⇒ Single-Call ist sicher, false ⇒ fanout.
 * Mit fanoutFactor < 1.0 kann man früher fanouten (zur Sicherheit); Default 1.0
 * heißt: jedes Übergrößen-Char triggert fanout (kein Toleranzpolster).
 */
export function shouldFanoutBySource(
  textLen: number,
  budget: PromptBudget,
  fanoutFactor = 1.0,
): boolean {
  return textLen > budget.sourceMaxChars * fanoutFactor;
}
