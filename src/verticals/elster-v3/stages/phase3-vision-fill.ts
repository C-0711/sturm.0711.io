/**
 * elster-v6/phase3-vision-fill — gemma4-mm vision drop-in replacement for
 * phase3LlmFill (text-only).
 *
 * Contract: SAME input/output shape as phase3LlmFill (Phase3LlmFillInput
 * extended with `filePath`; Phase3LlmFillOutput unchanged). Downstream
 * phases 4-7 see the same per_anlage map with llm_hits keyed by eCode.
 *
 * Internally:
 *   1. Render the PDF to PNG pages via `lib/pdf-render` (sha256-cached).
 *   2. Batch pages into groups of up to 4 (Gemma-4 vLLM limit).
 *   3. Build ONE field-map (text table + JSON schema) covering all
 *      missing eCodes across all anlagen — we do not know which page
 *      carries which anlage.
 *   4. Run batches in parallel through `lib/vllm-vision` with the field
 *      map as text instructions and the JSON-schema constrained decoding.
 *   5. Merge per-eCode results (last non-null wins across batches).
 *   6. WISO-placeholder post-pass (configurable).
 *   7. Restructure flat eCode map → per-anlage Phase3AnlageResult.
 *
 * Falls back to `phase3LlmFillStage` (text-only) when:
 *   • PDF render fails (e.g. pdftoppm missing).
 *   • ALL vision batches fail.
 *   • vLLM baseUrl cannot be resolved from the extraction-llm handle.
 *
 * Origin tag for vision hits is currently `'LLM_FSM'` — phase5Merge treats
 * it correctly without extension. Promoting to a dedicated `'LLM_VISION'`
 * origin is a follow-up (would require phase5-merge trust-score updates).
 */
import { defineStage } from '../../../core/stage.ts';
import type { LlmHandle } from '../../../core/tools/handles.ts';
import { renderPdfToPng } from '../../../lib/pdf-render.ts';
import {
  callVllmVision,
  VllmVisionError,
  type VllmVisionOptions,
  type VllmVisionResult,
} from '../../../lib/vllm-vision.ts';
import { buildFieldMap } from '../../../lib/field-map-builder.ts';
import {
  phase3LlmFillStage,
  type Phase3LlmFillInput,
  type Phase3LlmFillOutput,
  type Phase3AnlageResult,
  type Phase3LlmHit,
  type Phase3LlmFillConfig,
} from './phase3-llm-fill.ts';
import type { StageContext } from '../../../core/types.ts';

// Re-export the load-bearing types so importers can rely on a single
// module for the v6 vision-fill contract.
export type {
  Phase3LlmFillOutput,
  Phase3AnlageResult,
  Phase3LlmHit,
} from './phase3-llm-fill.ts';

// ─────────────────────────────────────────────────────────────────────────
// I/O
// ─────────────────────────────────────────────────────────────────────────

export interface Phase3VisionFillInput extends Phase3LlmFillInput {
  /** Absolute path to the input PDF (or image). Required to render pages
   *  for the vision call. v6 workflows wire this from `${input.filePath}`. */
  filePath: string;
}

export interface Phase3VisionFillConfig {
  /** vLLM image-input limit per call (Gemma-4 supports up to 4). Default 4. */
  pagesPerCall?: number;
  /** Parallel vLLM calls — keep low to avoid saturating vLLM. Default 2. */
  callConcurrency?: number;
  /** Post-pass: drop {drucktext='Bezeichnung', value='456'}-style WISO
   *  placeholder patterns. Default true. */
  rejectWisoPlaceholders?: boolean;
  /** On render-fail or all-batches-fail: fall back to phase3LlmFill
   *  (text-only). Default true. */
  fallbackToV5?: boolean;
  /** Per-call max_tokens. Default 2500. */
  maxTokensPerCall?: number;
  /** Per-call timeout (ms). Default 60_000. */
  perCallTimeoutMs?: number;
  /** Render dpi. Default 200 (proven in v6 spike). */
  renderDpi?: number;
  /** Cap on field-map total fields per call (prompt budget safety).
   *  Default 80. */
  maxFieldsPerCall?: number;
  /** Schema name used in jsonSchema.name. Default 'elster_v6_extract'. */
  schemaName?: string;
  /** Test seam: override the vision-call implementation. Default
   *  `callVllmVision`. */
  visionCaller?: (opts: VllmVisionOptions) => Promise<VllmVisionResult>;
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function chunkArray<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/** Concurrency-limited Promise.all. Preserves index alignment with `items`. */
async function pMapBounded<TIn, TOut>(
  items: TIn[],
  limit: number,
  worker: (item: TIn, idx: number) => Promise<TOut>,
): Promise<TOut[]> {
  const results: TOut[] = new Array(items.length);
  let cursor = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: n }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

interface FlatHit {
  eCode: string;
  value: string;
  /** Which batch produced this value (for cross-page consistency audit). */
  batchIdx: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Stage
// ─────────────────────────────────────────────────────────────────────────

export const phase3VisionFillStage = defineStage<
  Phase3VisionFillInput,
  Phase3LlmFillOutput,
  Phase3VisionFillConfig
>({
  id: 'elster-v6/phase3-vision-fill',
  name: 'Phase 3 — Vision LLM-Fill (gemma4-mm)',
  description:
    'Vision-aware drop-in for phase3-llm-fill. Renders PDF pages, batches ' +
    'into 4-page gemma4-mm vision calls with field-map prompts, parses ' +
    'per-anlage hits. Falls back to phase3-llm-fill on render-fail or ' +
    'all-batches-fail.',
  hints: {
    inputs:
      'filePath (PDF/image), text, phase1_per_anlage (Phase 1 result), ' +
      'felder_per_anlage (Atom-Metadata)',
    outputs:
      'per_anlage map mit llm_hits + still_missing pro Anlage, ' +
      'totalFilled, ms (kompatibel zu phase3-llm-fill)',
    configExample: JSON.stringify(
      {
        pagesPerCall: 4,
        callConcurrency: 2,
        rejectWisoPlaceholders: true,
        fallbackToV5: true,
        maxTokensPerCall: 2500,
        perCallTimeoutMs: 60_000,
        renderDpi: 200,
        maxFieldsPerCall: 80,
      },
      null,
      2,
    ),
    llm: { providers: ['vllm'], default: 'vllm' },
    acceptsContainers: ['elster-catalog'],
    inputPorts: [
      { name: 'filePath', type: 'text' },
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
    const tStart = Date.now();
    const cfg = ctx.config ?? {};
    // Cap of 4 is the vLLM --limit-mm-per-prompt {image: 4} runtime limit.
    // Going higher would cause vLLM to reject the request. To fit more pages
    // per call, either restart vLLM with a higher cap, or accept the batch.
    const pagesPerCall = Math.max(1, Math.min(4, cfg.pagesPerCall ?? 4));
    const callConcurrency = Math.max(1, cfg.callConcurrency ?? 2);
    const rejectWiso = cfg.rejectWisoPlaceholders ?? true;
    const fallbackToV5 = cfg.fallbackToV5 ?? true;
    const maxTokensPerCall = cfg.maxTokensPerCall ?? 2500;
    const perCallTimeoutMs = cfg.perCallTimeoutMs ?? 60_000;
    const renderDpi = cfg.renderDpi ?? 200;
    const maxFieldsPerCall = cfg.maxFieldsPerCall ?? 80;
    const schemaName = cfg.schemaName ?? 'elster_v6_extract';
    const visionCaller = cfg.visionCaller ?? callVllmVision;

    const phase1 = input.phase1_per_anlage ?? {};
    const felderMap = input.felder_per_anlage ?? {};
    const anlagen = Object.keys(phase1);
    if (anlagen.length === 0) {
      return { per_anlage: {}, totalFilled: 0, ms: Date.now() - tStart };
    }

    // Resolve vLLM URL from the bound extraction-llm handle (same path
    // phase3-llm-fill uses). If we can't get a baseUrl, fall back.
    let llm: LlmHandle | null = null;
    let vllmUrl: string | undefined;
    let modelName = 'gemma4-mm';
    // The fallback stage expects its own config type; ctx is structurally
    // compatible (we only access ctx.tools / artifacts / emit / signal /
    // logger / etc., never `ctx.config`'s vision-specific keys from inside
    // the text-only path). Cast once and reuse.
    const fallbackCtx = ctx as unknown as StageContext<Phase3LlmFillConfig>;
    try {
      llm = ctx.tools.getByRole<LlmHandle>('extraction-llm');
      vllmUrl = llm.meta.baseUrl;
      modelName = llm.meta.model;
    } catch (err) {
      ctx.emit('vision_fallback_triggered', {
        reason: 'no-extraction-llm-handle',
        error: (err as Error).message,
      });
      if (fallbackToV5) return phase3LlmFillStage.run(input, fallbackCtx);
      throw err;
    }
    if (!vllmUrl) {
      ctx.emit('vision_fallback_triggered', { reason: 'no-baseurl' });
      if (fallbackToV5) return phase3LlmFillStage.run(input, fallbackCtx);
      throw new Error('phase3VisionFill: extraction-llm handle has no baseUrl');
    }

    ctx.emit('phase3_vision_start', {
      anlagen: anlagen.length,
      model: modelName,
      pagesPerCall,
      callConcurrency,
    });

    // ── 1. Render PDF ──────────────────────────────────────────────────
    let pngPaths: string[];
    let sha256 = '';
    let cached = false;
    let renderMs = 0;
    try {
      const r = await renderPdfToPng(input.filePath, { dpi: renderDpi });
      pngPaths = r.pngPaths;
      sha256 = r.sha256;
      cached = r.cached;
      renderMs = r.renderMs;
    } catch (err) {
      ctx.emit('vision_fallback_triggered', {
        reason: 'render-failed',
        error: (err as Error).message,
      });
      if (fallbackToV5) return phase3LlmFillStage.run(input, fallbackCtx);
      throw err;
    }
    ctx.emit('vision_rendered', {
      pageCount: pngPaths.length,
      sha256,
      cached,
      renderMs,
    });

    // ── 2. Build field map for STILL-MISSING + SUSPICIOUS fields ───────
    // phase1Regex already filled ~30-50% of the catalog deterministically.
    // Asking vision about clean hits wastes prompt budget — they'd be
    // skipped at the cross-validation step anyway (regex wins in phase5).
    // BUT phase1Regex also produces SUSPICIOUS hits: WISO-placeholder
    // values (repeat_suspicious=true) or fallback hits without zeile-anchor
    // (zeile_anchored=false). Those poison canonical_layer (e.g. VOR shows
    // "456 / 456" instead of "4.703 / 1.243"). We re-ask vision about
    // those so it can correct or NULL them.
    const missingFelderMap: typeof felderMap = {};
    let suspiciousReAskCount = 0;
    for (const anlage of anlagen) {
      const result = phase1[anlage];
      if (!result) continue;
      const askSet = new Set<string>(result.missing_ecodes ?? []);
      for (const [eCode, hit] of Object.entries(result.regex_hits ?? {})) {
        const isSuspicious =
          hit.repeat_suspicious === true || hit.zeile_anchored === false;
        if (isSuspicious) {
          askSet.add(eCode);
          suspiciousReAskCount++;
        }
      }
      const fullList = felderMap[anlage];
      if (!fullList) continue;
      missingFelderMap[anlage] = {
        anlage: fullList.anlage,
        felder: fullList.felder.filter((f) => askSet.has(f.eCode)),
      };
    }
    ctx.emit('vision_field_set', {
      missingFromPhase1: Object.values(phase1).reduce(
        (s, r) => s + (r.missing_ecodes?.length ?? 0),
        0,
      ),
      suspiciousReAsked: suspiciousReAskCount,
    });
    const fieldMap = buildFieldMap({
      perAnlage: missingFelderMap,
      schemaName,
      maxFields: maxFieldsPerCall,
    });

    if (fieldMap.fields.length === 0) {
      ctx.emit('phase3_vision_done', {
        reason: 'no-fields',
        anlagen: anlagen.length,
      });
      // No fields to extract — return empty per_anlage so downstream
      // stages still see the expected shape.
      const per_anlage: Record<string, Phase3AnlageResult> = {};
      for (const anlage of anlagen) {
        per_anlage[anlage] = {
          anlage,
          llm_hits: {},
          still_missing: phase1[anlage].missing_ecodes,
          prefilled_count: Object.keys(phase1[anlage].regex_hits).length,
          missing_at_start: phase1[anlage].missing_ecodes.length,
          durationMs: 0,
        };
      }
      return { per_anlage, totalFilled: 0, ms: Date.now() - tStart };
    }

    // ── 3. Build text instruction PREFIX (OCR-text snippet built per batch
    //       below so the prompt only contains the OCR for the pages the
    //       batch is actually seeing). ─────────────────────────────────────
    const fullOcrText = typeof input.text === 'string' ? input.text : '';
    const instructionsPrefix = [
      'Du extrahierst ELSTER-Felder aus PDF-Seiten einer Steuererklaerung.',
      'Du siehst die Seiten als Bilder. Zusaetzlich folgt der OCR-Text',
      'der GENAU DIESER Seiten als Cross-Reference fuer schwer lesbare Zahlen.',
      '',
      'Regeln:',
      '- Werte EXAKT wie auf dem Bild (deutsches Format z.B. "63.559,90",',
      '  Datum DD.MM.YYYY, Text wortgenau).',
      '- Wenn ein Feld auf den gezeigten Seiten nicht erkennbar ist: NULL.',
      '- WISO-Test-Platzhalter (Bezeichnung+Betrag beide "456" wiederholt)',
      '  → NULL setzen.',
      '- Person B (Ehefrau) hat eigene Anlagen — Werte stehen NICHT in',
      "  Person A's Anlage.",
      '- VERSUCHE moeglichst viele Felder zu fuellen, nicht nur die',
      '  offensichtlichen — verlasse dich auf BILD + OCR-TEXT zusammen.',
    ].join('\n');
    const instructionsSuffix = [
      fieldMap.mapText,
      '',
      'Antworte mit JSON-Objekt nach Schema — keine Erklaerung.',
      'Fuelle so viele eCodes wie moeglich; NULL nur bei echter Unsicherheit.',
    ].join('\n');

    // Slice the full OCR text into one chunk per PDF page by character offset.
    // We don't have true page boundaries from OCR, so we approximate by
    // equal slicing across pngPaths.length pages. Each batch then concats
    // only the slices for its own pages.
    const pageCount = pngPaths.length || 1;
    const pageOcrChunks: string[] = [];
    if (fullOcrText.length > 0) {
      const sliceLen = Math.ceil(fullOcrText.length / pageCount);
      for (let i = 0; i < pageCount; i++) {
        pageOcrChunks.push(fullOcrText.slice(i * sliceLen, (i + 1) * sliceLen));
      }
    }

    // ── 4. Batch pages and call vision ─────────────────────────────────
    const batches = chunkArray(pngPaths, pagesPerCall);
    ctx.emit('vision_batches', { count: batches.length, pagesPerCall });

    interface BatchOutcome {
      idx: number;
      parsed: Record<string, string | null>;
      error: Error | null;
      wallclockMs: number;
      promptTokens: number;
      completionTokens: number;
    }

    const outcomes: BatchOutcome[] = await pMapBounded(
      batches,
      callConcurrency,
      async (pngs, idx) => {
        // Build per-batch OCR slice: take the OCR chunks that correspond
        // to the page indices in THIS batch (idx*pagesPerCall .. +pngs.length).
        const startPage = idx * pagesPerCall;
        const batchOcr = pageOcrChunks
          .slice(startPage, startPage + pngs.length)
          .join('\n--- Seitenwechsel ---\n');
        const batchInstructions = [
          instructionsPrefix,
          '',
          '=== OCR-TEXT NUR der Seiten in diesem Batch ===',
          batchOcr,
          '=== ENDE OCR-TEXT ===',
          '',
          instructionsSuffix,
        ].join('\n');
        try {
          const r = await visionCaller({
            vllmUrl,
            model: modelName,
            imagePaths: pngs,
            textInstructions: batchInstructions,
            jsonSchema: fieldMap.jsonSchema,
            maxTokens: maxTokensPerCall,
            timeoutMs: perCallTimeoutMs,
            signal: ctx.signal,
          });
          const parsed = (r.parsed ?? {}) as Record<string, string | null>;
          const fieldsFound = Object.entries(parsed).filter(
            ([, v]) => v !== null && v !== undefined && String(v).trim() !== '',
          ).length;
          ctx.emit('vision_batch_done', {
            idx,
            pages: pngs.length,
            ms: r.wallclockMs,
            prompt_tokens: r.promptTokens,
            completion_tokens: r.completionTokens,
            fieldsFound,
            fieldMapSize: fieldMap.fields.length,
          });
          // Persist raw vision response per batch for offline diagnosis.
          // Without this we can't tell whether the model wrote 5 fields and
          // stopped, wrote 500 fields all-NULL, or hit a token cap.
          await ctx.artifacts.write(
            `phase3_vision_raw/batch-${idx}.json`,
            {
              idx,
              pages: pngs.length,
              promptTokens: r.promptTokens,
              completionTokens: r.completionTokens,
              wallclockMs: r.wallclockMs,
              fieldsAskedFor: fieldMap.fields.length,
              fieldsAnswered: fieldsFound,
              parsed,
            },
          );
          return {
            idx,
            parsed,
            error: null,
            wallclockMs: r.wallclockMs,
            promptTokens: r.promptTokens,
            completionTokens: r.completionTokens,
          } satisfies BatchOutcome;
        } catch (err) {
          const e = err as Error;
          ctx.emit('vision_batch_failed', {
            idx,
            error: e.message,
            stage: err instanceof VllmVisionError ? err.stage : undefined,
          });
          return {
            idx,
            parsed: {},
            error: e,
            wallclockMs: 0,
            promptTokens: 0,
            completionTokens: 0,
          } satisfies BatchOutcome;
        }
      },
    );

    const failures = outcomes.filter((o) => o.error !== null);

    // ── 5. Fallback if ALL batches failed ──────────────────────────────
    if (failures.length === batches.length) {
      if (fallbackToV5) {
        ctx.emit('vision_fallback_triggered', {
          reason: 'all-batches-failed',
          failures: failures.length,
          firstError: failures[0]?.error?.message,
        });
        return phase3LlmFillStage.run(input, fallbackCtx);
      }
      throw new Error(
        `phase3VisionFill: all ${batches.length} batches failed — ` +
          (failures[0]?.error?.message ?? 'unknown error'),
      );
    }

    // ── 6. Merge per-eCode: last non-null wins. Track origin batch for
    //      cross-page consistency notes (audit only — value selection is
    //      last-write-wins to favour later/more-detailed pages). ───────
    const merged = new Map<string, FlatHit>();
    for (const o of outcomes) {
      if (o.error) continue;
      for (const [eCode, v] of Object.entries(o.parsed)) {
        if (v === null || v === undefined) continue;
        const valStr = String(v).trim();
        if (valStr === '' || valStr.toLowerCase() === 'null') continue;
        const prev = merged.get(eCode);
        if (prev && prev.value !== valStr) {
          ctx.emit('vision_value_conflict', {
            eCode,
            previous: prev.value,
            previousBatch: prev.batchIdx,
            next: valStr,
            nextBatch: o.idx,
          });
        }
        merged.set(eCode, { eCode, value: valStr, batchIdx: o.idx });
      }
    }

    // ── 7. WISO-placeholder post-pass ──────────────────────────────────
    // Drop any value that exactly equals its drucktext (WISO repeat
    // artifact) OR appears for the same drucktext on ≥3 distinct anlagen
    // — same pattern as phase1-regex's repeat_suspicious post-pass.
    if (rejectWiso) {
      // Build eCode → AnlagenFeld lookup for quick drucktext access.
      const eCodeToFeld = new Map<
        string,
        { drucktext: string; anlage: string }
      >();
      for (const [anlage, liste] of Object.entries(felderMap)) {
        for (const f of liste?.felder ?? []) {
          if (!eCodeToFeld.has(f.eCode)) {
            eCodeToFeld.set(f.eCode, {
              drucktext: f.drucktext ?? '',
              anlage,
            });
          }
        }
      }
      // 7a. drop where value === drucktext (or trimmed value equals it)
      let droppedSelfEqual = 0;
      for (const [eCode, hit] of merged) {
        const feld = eCodeToFeld.get(eCode);
        if (!feld) continue;
        const druckTrim = feld.drucktext.trim();
        if (druckTrim && hit.value.trim() === druckTrim) {
          merged.delete(eCode);
          droppedSelfEqual++;
        }
      }
      // 7b. drop repeated (value, drucktext) seen on ≥3 anlagen
      const buckets = new Map<string, string[]>(); // key → eCodes
      for (const [eCode, hit] of merged) {
        const feld = eCodeToFeld.get(eCode);
        if (!feld) continue;
        const key = `${hit.value} ${feld.drucktext.trim()}`;
        let arr = buckets.get(key);
        if (!arr) {
          arr = [];
          buckets.set(key, arr);
        }
        arr.push(eCode);
      }
      let droppedRepeat = 0;
      for (const eCodes of buckets.values()) {
        if (eCodes.length < 3) continue;
        // Distinct anlagen check
        const anlagensSeen = new Set<string>();
        for (const ec of eCodes) {
          const feld = eCodeToFeld.get(ec);
          if (feld) anlagensSeen.add(feld.anlage);
        }
        if (anlagensSeen.size < 2) continue;
        for (const ec of eCodes) {
          merged.delete(ec);
          droppedRepeat++;
        }
      }
      if (droppedSelfEqual > 0 || droppedRepeat > 0) {
        ctx.emit('vision_wiso_rejected', {
          droppedSelfEqual,
          droppedRepeat,
        });
      }
    }

    // ── 8. Regex cross-check (audit only — never override regex) ───────
    for (const [anlage, ar] of Object.entries(phase1)) {
      for (const [eCode, rh] of Object.entries(ar.regex_hits)) {
        const v = merged.get(eCode);
        if (!v) continue;
        if (String(rh.value).trim() !== v.value.trim()) {
          ctx.emit('vision_regex_diff', {
            anlage,
            eCode,
            regex: String(rh.value),
            vision: v.value,
          });
        }
      }
    }

    // ── 9. Restructure flat merged map → per-anlage Phase3AnlageResult
    // Mirror phase3-llm-fill's contract exactly: only fill llm_hits for
    // eCodes that phase1 did NOT already cover; collect missing pflicht
    // fields into still_missing. Origin tagged 'LLM_FSM' so phase5Merge
    // treats vision values with medium trust (same as text-LLM).
    const per_anlage: Record<string, Phase3AnlageResult> = {};
    let totalFilled = 0;
    for (const anlage of anlagen) {
      const tA = Date.now();
      const phase1Result = phase1[anlage];
      const regexHits = phase1Result.regex_hits;
      const liste = felderMap[anlage];
      const anlageFelder = liste?.felder ?? [];
      const llm_hits: Record<string, Phase3LlmHit> = {};
      const still_missing: string[] = [];

      for (const f of anlageFelder) {
        // Regex priority — but ONLY when the regex hit is clean. If phase1
        // flagged it suspicious (WISO-Platzhalter or zeile-anchor failed),
        // the vision answer wins (mirrors phase5-merge precedence). Without
        // this, asking vision about VOR Zeile 11 → 4.703 was wasted because
        // the restructure step would drop it in favour of regex's "456".
        const existing = regexHits[f.eCode];
        if (existing) {
          const existingSuspect =
            existing.repeat_suspicious === true ||
            existing.zeile_anchored === false;
          if (!existingSuspect) continue;
        }
        const m = merged.get(f.eCode);
        if (m) {
          llm_hits[f.eCode] = {
            eCode: f.eCode,
            value: m.value,
            origin: 'LLM_FSM',
            kontextPath: f.einkunftsart,
            anlage,
            drucktext: f.drucktext,
            vordruckzeile: f.vordruckzeile,
            datentyp: f.datentyp,
          };
        } else if (f.pflicht) {
          still_missing.push(f.eCode);
        }
      }

      per_anlage[anlage] = {
        anlage,
        llm_hits,
        still_missing,
        prefilled_count: Object.keys(regexHits).length,
        missing_at_start: phase1Result.missing_ecodes.length,
        durationMs: Date.now() - tA,
      };
      totalFilled += Object.keys(llm_hits).length;

      await ctx.artifacts.write(
        `phase3_vision_per_anlage/${anlage}.json`,
        per_anlage[anlage],
      );
    }

    ctx.emit('phase3_vision_done', {
      anlagen: anlagen.length,
      totalFilled,
      visionBatches: batches.length,
      visionFailures: failures.length,
      renderMs,
      ms: Date.now() - tStart,
    });

    return {
      per_anlage,
      totalFilled,
      ms: Date.now() - tStart,
    };
  },
});
