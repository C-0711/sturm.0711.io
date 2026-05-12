/**
 * auto-source-split — splits an OCR text into chunks when it exceeds the
 * prompt-budget for the target model.
 *
 * Strategy (in priority order):
 *   1. **Page-split via markdown headers** — wenn der Text Markdown-`#`
 *      Header pro Seite hat (typischer OCR-Output) splitten wir auf den
 *      Page-Boundaries. Header-Text wird als `titel` mitgenommen.
 *   2. **Pages-array** — wenn der Caller `pages: [{index, markdown}]`
 *      durchreicht, splitten wir auf den Page-Boundaries direkt.
 *   3. **Paragraph fallback** — sonst splitten wir auf `\n\n` und packen
 *      Paragraphen bis das chunk-Budget voll ist.
 *
 * Output: `{ shouldFanout, chunks[], passthroughText, budget }`
 *   • `shouldFanout=false` → der Caller benutzt `passthroughText` (Original,
 *     ggf. bereits truncated auf budget.sourceMaxChars).
 *   • `shouldFanout=true`  → der Caller iteriert über `chunks[]` (jedes
 *     unterhalb des Budgets) z.B. via `compare/fanout`.
 *
 * Diese Stage entscheidet NICHT selbst, was als nächstes passiert — das
 * ist Workflow-Konfiguration. Sie produziert nur die Datenstruktur, die
 * den Fanout ermöglicht.
 */
import { defineStage } from '../core/stage.ts';
import {
  computePromptBudget,
  contextTokensFor,
  splitToFitBudget,
  shouldFanoutBySource,
  type PromptBudget,
} from '../lib/prompt-budget.ts';

export interface AutoSourceSplitInput {
  /** OCR-Volltext. */
  text: string;
  /** Optional: original OCR pages (mit index + markdown), wenn vorhanden
   *  splitten wir auf den Page-Boundaries. */
  pages?: Array<{ index: number; markdown: string }>;
  /** Modellname für das Budget-Lookup (z.B. "gemma4-mm"). */
  model?: string;
  /** Optional: das JSON-Schema das mit gesendet wird (schrumpft das Budget). */
  schema?: unknown;
}

export interface AutoSourceSplitConfig {
  /** Override des modellbasierten Context-Lookups. */
  modelContextTokens?: number;
  /** max_tokens für die downstream Antwort. Default 2000. */
  maxOutputTokens?: number;
  /** Overhead für Prompt-Boilerplate (kandidaten, rahmen, headline). Default 2000. */
  overheadTokens?: number;
  /** chars/token. Default 3.5 (Deutsch). */
  charsPerToken?: number;
  /** Safety-Marge. Default 0.8. */
  safetyMargin?: number;
  /** Min-Source-Chars Floor. Default 1000. */
  minSourceChars?: number;
  /** Schwelle für Fanout. text > budget × factor → split. Default 1.5. */
  fanoutFactor?: number;
}

export interface AutoSourceChunk {
  id: string;          // "chunk-0", "chunk-1", ...
  text: string;
  /** Geschätzte Tokens; nur grob (chars / charsPerToken). */
  estTokens: number;
  /** Erster Header / Titel falls erkennbar (z.B. erstes `# ...`). */
  titel?: string;
  /** Welche Page-Indizes diesem Chunk zugeordnet sind (wenn pages[] vorhanden). */
  pageIndizes?: number[];
}

export interface AutoSourceSplitOutput {
  /** True wenn der Caller fanouten sollte (text > budget × fanoutFactor). */
  shouldFanout: boolean;
  /** Chunks für den Fanout-Fall. Im Passthrough-Fall: ein einzelner Chunk
   *  mit dem unveränderten Originaltext (KEINE Truncation per Policy). */
  chunks: AutoSourceChunk[];
  /** Passthrough — unverändert, NIEMALS truncated. */
  passthroughText: string;
  /** Originallänge in chars. */
  originalChars: number;
  /** Gewählte Strategy. */
  strategy: 'passthrough' | 'page-header' | 'pages-array' | 'paragraph';
  /** Budget-Berechnung für Observability. */
  budget: PromptBudget;
}

// ─────────────────────────────────────────────────────────────────────────
// Header-basierter Split (markdown-style)
// ─────────────────────────────────────────────────────────────────────────

const HEADER_RX = /^#\s+(.+?)\s*$/m;

function splitByHeader(text: string, budgetChars: number): AutoSourceChunk[] {
  // Splitten am `^# ` Header. Sammelt Section pro Header. Falls eine Section
  // selbst über dem Budget liegt → rekursiv per Paragraph weiterzerlegen.
  const lines = text.split(/\r?\n/);
  const sections: Array<{ titel: string | null; lines: string[] }> = [];
  let curr: { titel: string | null; lines: string[] } = { titel: null, lines: [] };
  for (const line of lines) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (curr.lines.length > 0 || curr.titel !== null) sections.push(curr);
      curr = { titel: m[1].trim(), lines: [line] };
    } else {
      curr.lines.push(line);
    }
  }
  if (curr.lines.length > 0 || curr.titel !== null) sections.push(curr);

  const chunks: AutoSourceChunk[] = [];
  let idx = 0;
  for (const sec of sections) {
    const sectionText = sec.lines.join('\n');
    if (sectionText.length <= budgetChars) {
      chunks.push({
        id: `chunk-${idx++}`,
        text: sectionText,
        estTokens: Math.ceil(sectionText.length / 3.5),
        titel: sec.titel ?? undefined,
      });
    } else {
      // Section is itself oversized → paragraph-split innerhalb
      for (const p of splitByParagraph(sectionText, budgetChars)) {
        chunks.push({
          id: `chunk-${idx++}`,
          text: p,
          estTokens: Math.ceil(p.length / 3.5),
          titel: sec.titel ?? undefined,
        });
      }
    }
  }
  return chunks;
}

function splitByPages(
  pages: Array<{ index: number; markdown: string }>,
  budgetChars: number,
): AutoSourceChunk[] {
  // Kombiniert aufeinanderfolgende Pages bis das Budget erreicht ist; wenn
  // eine einzelne Page das Budget sprengt → Paragraph-Split innerhalb.
  const chunks: AutoSourceChunk[] = [];
  let idx = 0;
  let buf: string[] = [];
  let bufPages: number[] = [];
  let bufLen = 0;
  const flush = () => {
    if (buf.length === 0) return;
    const text = buf.join('\n\n');
    chunks.push({
      id: `chunk-${idx++}`,
      text,
      estTokens: Math.ceil(text.length / 3.5),
      pageIndizes: [...bufPages],
    });
    buf = [];
    bufPages = [];
    bufLen = 0;
  };
  for (const p of pages) {
    if (p.markdown.length > budgetChars) {
      flush();
      for (const pp of splitByParagraph(p.markdown, budgetChars)) {
        chunks.push({
          id: `chunk-${idx++}`,
          text: pp,
          estTokens: Math.ceil(pp.length / 3.5),
          pageIndizes: [p.index],
        });
      }
      continue;
    }
    if (bufLen + p.markdown.length + 2 > budgetChars) flush();
    buf.push(p.markdown);
    bufPages.push(p.index);
    bufLen += p.markdown.length + 2;
  }
  flush();
  return chunks;
}

function splitByParagraph(text: string, budgetChars: number): string[] {
  const paras = text.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  const out: string[] = [];
  let cur = '';
  for (const p of paras) {
    if (cur.length === 0) {
      cur = p;
      continue;
    }
    if (cur.length + p.length + 2 > budgetChars) {
      out.push(cur);
      cur = p;
    } else {
      cur = `${cur}\n\n${p}`;
    }
  }
  if (cur.length > 0) out.push(cur);
  // Falls ein einzelner Paragraph > budget: harter char-cut (selten in OCR).
  return out.flatMap((p) =>
    p.length <= budgetChars
      ? [p]
      : Array.from({ length: Math.ceil(p.length / budgetChars) },
          (_, i) => p.slice(i * budgetChars, (i + 1) * budgetChars)),
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Stage
// ─────────────────────────────────────────────────────────────────────────

export const autoSourceSplitStage = defineStage<
  AutoSourceSplitInput,
  AutoSourceSplitOutput,
  AutoSourceSplitConfig
>({
  id: 'auto-source-split',
  name: 'Auto Source Split — adaptive page-fanout decision',
  description:
    'Berechnet das prompt-Budget für ein Ziel-Modell + Schema und entscheidet, ob der OCR-Volltext fanouted werden muss. Wenn ja: emittiert chunks[] (page-header, pages-array oder paragraph-fallback). Wenn nein: gibt passthroughText (ggf. truncated) zurück.',
  hints: {
    inputs: 'text · optional: pages, model, schema',
    outputs: 'shouldFanout, chunks[], passthroughText, passthroughTruncated, strategy, budget',
    configExample: JSON.stringify(
      { maxOutputTokens: 2000, overheadTokens: 2000, fanoutFactor: 1.5 },
      null,
      2,
    ),
    inputPorts: [
      { name: 'text', type: 'text' },
      { name: 'pages', type: 'pages', description: 'optional OCR pages array' },
      { name: 'model', type: 'string' },
      { name: 'schema', type: 'json' },
    ],
    outputPorts: [
      { name: 'shouldFanout', type: 'boolean' },
      { name: 'chunks', type: 'branches' },
      { name: 'passthroughText', type: 'text' },
    ],
  },

  async run(input, ctx) {
    const cfg = ctx.config ?? {};
    const model = input.model ?? 'gemma4-mm';
    const budget = computePromptBudget({
      modelContextTokens: cfg.modelContextTokens ?? contextTokensFor(model),
      schema: input.schema,
      maxOutputTokens: cfg.maxOutputTokens ?? 2_000,
      overheadTokens: cfg.overheadTokens ?? 2_000,
      safetyMargin: cfg.safetyMargin,
      charsPerToken: cfg.charsPerToken,
      minSourceChars: cfg.minSourceChars,
    });
    // No-Truncate-Policy: Default fanoutFactor = 1.0. Jedes Zeichen über dem
    // Budget triggert echtes Splitting; wir schneiden niemals ab.
    const fanoutFactor = cfg.fanoutFactor ?? 1.0;
    const text = typeof input.text === 'string' ? input.text : '';
    const originalChars = text.length;

    const fanout = shouldFanoutBySource(originalChars, budget, fanoutFactor);

    if (!fanout) {
      // Passthrough: Original unverändert, in einen Single-Chunk gepackt
      // damit Caller einheitlich über chunks[] iterieren können.
      ctx.emit('source_split_decision', {
        decision: 'passthrough',
        originalChars,
        budgetBreakdown: budget.breakdown,
      });
      return {
        shouldFanout: false,
        chunks: [{
          id: 'chunk-0',
          text,
          estTokens: Math.ceil(originalChars / 3.5),
        }],
        passthroughText: text,
        originalChars,
        strategy: 'passthrough',
        budget,
      };
    }

    let strategy: AutoSourceSplitOutput['strategy'] = 'paragraph';
    let chunks: AutoSourceChunk[] = [];
    if (input.pages && input.pages.length > 1) {
      chunks = splitByPages(input.pages, budget.sourceMaxChars);
      strategy = 'pages-array';
    } else if (HEADER_RX.test(text)) {
      chunks = splitByHeader(text, budget.sourceMaxChars);
      strategy = 'page-header';
    } else {
      // Fallback: lasse splitToFitBudget machen (paragraph-first, char-last) —
      // garantiert no-loss durch identische Logik wie die Library.
      const pieces = splitToFitBudget(text, budget);
      chunks = pieces.map((p, i) => ({
        id: `chunk-${i}`,
        text: p,
        estTokens: Math.ceil(p.length / 3.5),
      }));
    }

    // Invariante: ALLE chunks unter dem Budget, alle Inhalt erhalten.
    for (const c of chunks) {
      if (c.text.length > budget.sourceMaxChars) {
        throw new Error(
          `auto-source-split: chunk ${c.id} (${c.text.length} chars) verletzt budget (${budget.sourceMaxChars}). ` +
          `Bug im Splitter — splitToFitBudget garantiert no-overflow.`,
        );
      }
    }

    ctx.emit('source_split_decision', {
      decision: 'fanout',
      strategy,
      chunks: chunks.length,
      originalChars,
      budgetBreakdown: budget.breakdown,
    });

    return {
      shouldFanout: true,
      chunks,
      passthroughText: '', // im Fanout-Fall ungenutzt
      originalChars,
      strategy,
      budget,
    };
  },
});
