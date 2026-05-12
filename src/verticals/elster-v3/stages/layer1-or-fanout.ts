/**
 * elster-v3/layer1-or-fanout — Wrapper, der layer1-extract entweder direkt
 * oder über chunks (compare/fanout-Stil) ausführt, abhängig vom Source-Volumen.
 *
 * Verhalten:
 *   • text ≤ Budget  → ein single layer1-extract Call mit dem Originaltext.
 *   • text > Budget  → splitToFitBudget()-basierte Aufteilung in N chunks,
 *     pro chunk ein layer1-extract Call, Output-JSONs werden gemerged.
 *
 * Merge-Semantik (no-loss):
 *   • Arrays     → konkateniert (typischer Fall: mehrere Belege in einem Bundle,
 *                  jede chunk liefert eigene donations[] / income_streams[]).
 *   • Objekte    → key-für-key gemerged; bei nested-Objekten rekursiv.
 *   • Skalare    → first-non-empty wins (chunks decken oft die gleichen
 *                  Stammdaten ab; wir nehmen den frühesten gefüllten Wert).
 *   • Konflikte  → werden in `mergeKonflikte[]` aufgezeichnet (path, werte
 *                  pro chunk) — der Caller kann eskalieren oder loggen.
 *
 * Kein Runner-Eingriff: alle Stage-Aufrufe laufen sequenziell innerhalb dieses
 * Wrappers via getStage('elster-v3/layer1-extract').run(). Die ChunkResults
 * werden im artifact-store unter `layer1_per_chunk/<id>.json` archiviert.
 */
import { defineStage } from '../../../core/stage.ts';
import { getStage } from '../../../core/registry.ts';
import {
  computePromptBudget,
  contextTokensFor,
  splitToFitBudget,
  shouldFanoutBySource,
} from '../../../lib/prompt-budget.ts';
import type {
  Layer1Input,
  Layer1Output,
  Layer1Config,
} from './layer1-extract.ts';

export interface Layer1OrFanoutInput extends Layer1Input {
  /**
   * Optional: original OCR-Pages für deterministisches Page-Splitting.
   * Wenn vorhanden, splittet der Wrapper auf Page-Boundaries statt auf
   * Header/Paragraph.
   */
  pages?: Array<{ index: number; markdown: string }>;
  /** Optional: das nested JSON-Schema (für genaueres Budget). Wenn nicht
   *  gegeben, laden wir es selber wie layer1-extract es tut. */
  schemaSize?: unknown;
}

export interface Layer1OrFanoutConfig extends Layer1Config {
  /** Maximal-Anzahl chunks. Schutz gegen pathologisch lange OCRs.
   *  Default 32 — sehr viel mehr als realistische BMF-Bundles. */
  maxChunks?: number;
  /** Wenn false: Errors einer chunk-Stage stoppen den Wrapper.
   *  Wenn true: chunk-Fehler werden geloggt + verworfen, andere chunks
   *  laufen weiter. Default true (robust). */
  continueOnChunkError?: boolean;
}

export interface ChunkErgebnis {
  chunkId: string;
  ok: boolean;
  ms: number;
  /** Layer-1-Output bei Erfolg, null bei Fehler. */
  output: Layer1Output | null;
  error?: string;
}

export interface MergeKonflikt {
  /** Dotted path im merged nested-JSON. */
  path: string;
  /** Welche chunks welchen Wert geliefert haben. */
  werte: Array<{ chunkId: string; value: unknown }>;
}

export interface Layer1OrFanoutOutput {
  /** Das (ggf. gemergete) nested JSON — identische Shape wie layer1-extract. */
  nested: unknown;
  /** Schema-Name aus dem ersten erfolgreichen chunk. */
  schemaName: string;
  /** Wie viele chunks tatsächlich gefanned wurden (1 wenn passthrough). */
  chunkCount: number;
  /** Per-chunk Detail-Ergebnisse für Audit/Debug. */
  chunkErgebnisse: ChunkErgebnis[];
  /** Skalare Konflikte beim Merge. Leer bei single-chunk oder voller Übereinstimmung. */
  mergeKonflikte: MergeKonflikt[];
  /** Gesamtdauer in ms. */
  ms: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Merge-Logik
// ─────────────────────────────────────────────────────────────────────────

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function isEmptyScalar(v: unknown): boolean {
  return v === null || v === undefined || v === '' ||
    (typeof v === 'number' && Number.isNaN(v));
}

/**
 * Mergt nested JSONs der chunks (in chunk-order) in eine einzige Struktur.
 * Konflikte: skalare Werte die zwischen chunks divergieren werden im
 * `konflikte[]` Array aufgezeichnet (path + alle gesehenen Werte).
 */
function mergeChunkOutputs(
  perChunk: Array<{ chunkId: string; nested: unknown }>,
): { merged: unknown; konflikte: MergeKonflikt[] } {
  if (perChunk.length === 0) return { merged: null, konflikte: [] };
  if (perChunk.length === 1) return { merged: perChunk[0].nested, konflikte: [] };

  const konflikte: MergeKonflikt[] = [];

  const mergeNode = (
    nodes: Array<{ chunkId: string; value: unknown }>,
    path: string,
  ): unknown => {
    const live = nodes.filter((n) => !isEmptyScalar(n.value));
    if (live.length === 0) return null;

    // Array-Fall: konkateniere alle, in chunk-order.
    const allArr = live.every((n) => Array.isArray(n.value));
    if (allArr) {
      const out: unknown[] = [];
      for (const n of live) for (const item of (n.value as unknown[])) out.push(item);
      return out;
    }
    // Wenn mindestens einer Array UND mindestens einer non-Array: konflikt.
    const someArr = live.some((n) => Array.isArray(n.value));
    if (someArr) {
      konflikte.push({
        path,
        werte: live.map((n) => ({ chunkId: n.chunkId, value: n.value })),
      });
      // Default: nimm das Array (additiv ist sicherer als skalar-overwrite).
      return live.find((n) => Array.isArray(n.value))!.value;
    }

    // Object-Fall: rekursiv key-für-key mergen.
    const allObj = live.every((n) => isPlainObject(n.value));
    if (allObj) {
      const keys = new Set<string>();
      for (const n of live) for (const k of Object.keys(n.value as object)) keys.add(k);
      const out: Record<string, unknown> = {};
      for (const k of keys) {
        out[k] = mergeNode(
          live.map((n) => ({
            chunkId: n.chunkId,
            value: (n.value as Record<string, unknown>)[k],
          })),
          path === '' ? k : `${path}.${k}`,
        );
      }
      return out;
    }

    // Skalar: first-non-empty wins. Wenn divergent → Konflikt.
    const distinct = new Map<string, string>();
    for (const n of live) {
      const sig = JSON.stringify(n.value);
      if (!distinct.has(sig)) distinct.set(sig, n.chunkId);
    }
    if (distinct.size > 1) {
      konflikte.push({
        path,
        werte: live.map((n) => ({ chunkId: n.chunkId, value: n.value })),
      });
    }
    return live[0].value;
  };

  const merged = mergeNode(
    perChunk.map((p) => ({ chunkId: p.chunkId, value: p.nested })),
    '',
  );
  return { merged, konflikte };
}

// ─────────────────────────────────────────────────────────────────────────
// Stage
// ─────────────────────────────────────────────────────────────────────────

export const layer1OrFanoutStage = defineStage<
  Layer1OrFanoutInput,
  Layer1OrFanoutOutput,
  Layer1OrFanoutConfig
>({
  id: 'elster-v3/layer1-or-fanout',
  name: 'Layer-1 — adaptiver Single-Call oder Multi-Chunk-Fanout',
  description:
    'Wrapper um elster-v3/layer1-extract: bei Source ≤ Modell-Budget single call; sonst Chunk-Fanout (page → header → paragraph → char) + No-Loss-Merge der nested JSONs (Arrays concat, Objekte rekursiv, Skalare first-non-empty mit Konflikt-Recording). Niemals truncated.',
  hints: {
    inputs: 'text, dokumenttyp_id (+ optional kpis, kandidatenECodes, einkunftsarten, anlagen, pages, schemaSize)',
    outputs: 'nested (merged), schemaName, chunkCount, chunkErgebnisse[], mergeKonflikte[], ms',
    configExample: JSON.stringify({
      provider: 'vllm',
      model: 'gemma4-mm',
      temperature: 0,
      maxTokens: 2000,
      maxChunks: 32,
      continueOnChunkError: true,
    }, null, 2),
    inputPorts: [
      { name: 'text', type: 'text' },
      { name: 'dokumenttyp_id', type: 'string' },
      { name: 'kandidatenECodes', type: 'candidates' },
      { name: 'einkunftsarten', type: 'json' },
      { name: 'anlagen', type: 'json' },
      { name: 'pages', type: 'pages' },
    ],
    outputPorts: [
      { name: 'nested', type: 'nested-json' },
      { name: 'chunkErgebnisse', type: 'json' },
      { name: 'mergeKonflikte', type: 'json' },
    ],
  },

  async run(input, ctx) {
    const t0 = Date.now();
    const cfg = ctx.config ?? {};
    const maxChunks = cfg.maxChunks ?? 32;
    const continueOnChunkError = cfg.continueOnChunkError ?? true;

    const layer1 = getStage('elster-v3/layer1-extract');
    if (!layer1) throw new Error('layer1-or-fanout: elster-v3/layer1-extract not registered');

    // Budget für die Routing-Decision. Verwendet die gleiche Logik wie
    // layer1-extract.run() intern — wenn wir nicht splitten, wirft das die
    // Single-Call-Variante. Wenn wir splitten, garantiert splitToFitBudget
    // dass jeder chunk passt.
    const provider = cfg.provider ?? 'vllm';
    const defaultModel = provider === 'mistral' ? 'mistral-large-latest'
      : provider === 'ollama' ? 'gemma4:31b-128k' : 'gemma4-mm';
    const modelName = cfg.model ?? defaultModel;
    const budget = computePromptBudget({
      modelContextTokens: contextTokensFor(modelName),
      schema: input.schemaSize,
      maxOutputTokens: cfg.maxTokens ?? 2000,
      overheadTokens: 2000,
    });
    const needsFanout = shouldFanoutBySource(input.text.length, budget);

    let chunks: Array<{ id: string; text: string }>;
    if (!needsFanout) {
      chunks = [{ id: 'chunk-0', text: input.text }];
    } else {
      // Bevorzuge pages[] wenn vorhanden — sonst splitToFitBudget über text.
      let pieces: string[];
      if (input.pages && input.pages.length > 1) {
        pieces = [];
        let buf: string[] = [];
        let bufLen = 0;
        for (const p of input.pages) {
          if (bufLen + p.markdown.length + 2 > budget.sourceMaxChars && buf.length > 0) {
            pieces.push(buf.join('\n\n'));
            buf = [];
            bufLen = 0;
          }
          if (p.markdown.length > budget.sourceMaxChars) {
            if (buf.length > 0) { pieces.push(buf.join('\n\n')); buf = []; bufLen = 0; }
            pieces.push(...splitToFitBudget(p.markdown, budget));
          } else {
            buf.push(p.markdown);
            bufLen += p.markdown.length + 2;
          }
        }
        if (buf.length > 0) pieces.push(buf.join('\n\n'));
      } else {
        pieces = splitToFitBudget(input.text, budget);
      }
      if (pieces.length > maxChunks) {
        throw new Error(
          `layer1-or-fanout: source produziert ${pieces.length} chunks > maxChunks=${maxChunks}. ` +
          `Erhöhe maxChunks in config oder verwende eine upstream page-split stage.`,
        );
      }
      chunks = pieces.map((text, i) => ({ id: `chunk-${i}`, text }));
    }

    ctx.emit('layer1_fanout_plan', {
      chunkCount: chunks.length,
      needsFanout,
      budget: budget.breakdown,
    });

    // Sequenzielle Ausführung — Gemma-4 vLLM hat seinen eigenen
    // batch-Scheduler; mehrere parallele Inferenzen kommen sowieso über die
    // compare/fanout-Schicht (Gemma + Mistral consensus). Sequenziell hier
    // hält den Wrapper deterministisch und einfach.
    const chunkErgebnisse: ChunkErgebnis[] = [];
    for (const c of chunks) {
      const tChunk = Date.now();
      try {
        const out = (await layer1.run(
          {
            ...input,
            text: c.text,
          } as unknown as Layer1Input,
          {
            ...ctx,
            stageId: `${ctx.stageId}.${c.id}`,
            config: cfg,
          },
        )) as Layer1Output;
        chunkErgebnisse.push({
          chunkId: c.id,
          ok: true,
          ms: Date.now() - tChunk,
          output: out,
        });
        await ctx.artifacts.write(`layer1_per_chunk/${c.id}.json`, out);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        chunkErgebnisse.push({
          chunkId: c.id,
          ok: false,
          ms: Date.now() - tChunk,
          output: null,
          error: msg,
        });
        ctx.emit('layer1_chunk_error', { chunkId: c.id, error: msg });
        if (!continueOnChunkError) throw err;
      }
    }

    const successful = chunkErgebnisse.filter((c) => c.ok && c.output !== null);
    if (successful.length === 0) {
      throw new Error(
        `layer1-or-fanout: alle ${chunks.length} chunks failed. Letzter Fehler: ${chunkErgebnisse[chunkErgebnisse.length - 1]?.error}`,
      );
    }

    const { merged, konflikte } = mergeChunkOutputs(
      successful.map((c) => ({ chunkId: c.chunkId, nested: c.output!.nested })),
    );

    ctx.emit('layer1_fanout_merged', {
      chunkCount: chunks.length,
      successful: successful.length,
      konflikte: konflikte.length,
    });

    return {
      nested: merged,
      schemaName: successful[0].output!.schemaName,
      chunkCount: chunks.length,
      chunkErgebnisse,
      mergeKonflikte: konflikte,
      ms: Date.now() - t0,
    };
  },
});
