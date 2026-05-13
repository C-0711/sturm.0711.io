/**
 * elster-v5.1/phase4-entity-disambig — Layer 2 Disambiguation.
 *
 * Sturm-v3-Architektur Layer 2: nach dem großen Phase-3-Extract gibt es
 * pflichtige eCodes die immer noch null sind, oder bei denen der Wert
 * mehrdeutig im Dokument auftaucht (z.B. Adresse: Steuerpflichtiger vs
 * Arbeitgeber vs Bank). Hier wird PRO Pflichtfeld ein kleiner, fokussierter
 * vLLM-Call mit strict-JSON-Schema gemacht (~80-200 Tokens Output).
 *
 * Vorgehen:
 *   1. Aus phase3_per_anlage alle still_missing PFLICHT-eCodes sammeln
 *   2. Pro eCode: 5 OCR-Zeilen-Kandidaten via simple keyword overlap finden
 *      (full quantum cascade als Upgrade-Path; MVP nutzt Text-Heuristik)
 *   3. Mini-Prompt an Gemma-4: "1-aus-5-Picker mit Reasoning"
 *   4. Wenn confidence ≥ threshold → in den Phase-3-Output mergen
 *
 * Output-Shape: identisch zu Phase3LlmFillOutput → phase5-merge unverändert.
 */
import { defineStage } from '../../../core/stage.ts';
import {
  type AnlagenFelderListe,
  type AnlagenFeld,
} from '../../../lib/elster-catalog.ts';
import type { Phase1AnlageResult } from './phase1-regex.ts';
import type { Phase3AnlageResult, Phase3LlmHit, Phase3LlmFillOutput } from './phase3-llm-fill.ts';
import type { ChatProvider } from '../../../lib/llm-chat.ts';

export interface Phase4DisambigInput {
  text: string;
  phase1_per_anlage: Record<string, Phase1AnlageResult>;
  phase3_per_anlage: Record<string, Phase3AnlageResult>;
  felder_per_anlage: Record<string, AnlagenFelderListe>;
}

export interface Phase4DisambigConfig {
  provider?: ChatProvider;
  vllmUrl?: string;
  model?: string;
  temperature?: number;
  /** Confidence-Threshold: nur Werte mit conf ≥ X werden übernommen. Default 0.7. */
  confidenceThreshold?: number;
  /** Anzahl Kandidaten die Gemma vorgesetzt bekommt. Default 5. */
  topK?: number;
  /** Concurrency-Cap für Mini-Calls. Default 5 (kleine Prompts, prefix-cache friendly). */
  concurrency?: number;
  perCallTimeoutMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Kandidaten-Suche (Keyword-Overlap, Quantum-Cascade-Stub)
// ─────────────────────────────────────────────────────────────────────────

interface Candidate {
  idx: number;
  line: string;
  score: number;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9äöüß ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

function findCandidates(text: string, drucktext: string, topK: number): Candidate[] {
  const lines = text.split(/\r?\n/);
  const queryToks = new Set(tokenize(drucktext));
  if (queryToks.size === 0) return [];
  const scored: Candidate[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length < 3 || line.length > 250) continue;
    const lineToks = new Set(tokenize(line));
    let overlap = 0;
    for (const t of queryToks) if (lineToks.has(t)) overlap++;
    if (overlap === 0) continue;
    const score = overlap / queryToks.size;
    scored.push({ idx: i, line, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

// ─────────────────────────────────────────────────────────────────────────
// vLLM Mini-Call
// ─────────────────────────────────────────────────────────────────────────

interface DisambigAnswer {
  value: string | number | null;
  source_idx: number | null;
  confidence: number;
  reasoning: string;
}

async function disambigCall(
  feld: AnlagenFeld,
  anlage: string,
  candidates: Candidate[],
  cfg: Required<Pick<Phase4DisambigConfig, 'vllmUrl' | 'model' | 'temperature' | 'perCallTimeoutMs'>>,
  signal?: AbortSignal,
): Promise<DisambigAnswer | null> {
  const isCurrency = feld.datentyp === 'currency';
  const valueSchema: Record<string, unknown> = isCurrency
    ? { type: ['number', 'null'] }
    : feld.datentyp === 'date'
    ? { type: ['string', 'null'], maxLength: 10 }
    : { type: ['string', 'null'], maxLength: feld.maxLaenge ?? 200 };

  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['value', 'source_idx', 'confidence', 'reasoning'],
    properties: {
      value: valueSchema,
      source_idx: { type: ['integer', 'null'], minimum: 0, maximum: Math.max(0, candidates.length - 1) },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reasoning: { type: 'string', maxLength: 280 },
    },
  };

  const candidatesBlock = candidates
    .map((c, i) => `  [${i}] score=${c.score.toFixed(2)}  "${c.line.slice(0, 180)}"`)
    .join('\n');

  const prompt = [
    `# Disambiguierung für ELSTER eCode ${feld.eCode}`,
    `Drucktext: ${feld.drucktext}`,
    `Datentyp: ${feld.datentyp}${feld.maxLaenge ? `, maxLen=${feld.maxLaenge}` : ''}`,
    `Anlage: ${anlage}, Vordruckzeile: ${feld.vordruckzeile ?? '-'}`,
    `Einkunftsart: ${feld.einkunftsart ?? '-'}`,
    '',
    '# OCR-Kandidaten (nach Keyword-Overlap):',
    candidatesBlock || '  (keine Kandidaten gefunden)',
    '',
    '# Aufgabe',
    '- Wähle GENAU EINEN Kandidaten ODER null wenn unsicher.',
    '- Extrahiere NUR den Wert für dieses Feld (keine Labels, keine Einheiten).',
    isCurrency ? '- Currency: liefere die Zahl (FSM coercet automatisch).' : '',
    feld.datentyp === 'date' ? '- Date: ISO YYYY-MM-DD.' : '',
    '- Wenn der Kandidat semantisch nicht passt (z.B. Arbeitgeber-Adresse statt Steuerpflichtiger-Adresse) → null.',
    '- confidence < 0.6 wenn du raten müsstest.',
  ].filter(Boolean).join('\n');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('disambig timeout')), cfg.perCallTimeoutMs);
  const onParentAbort = () => ac.abort(signal?.reason);
  signal?.addEventListener('abort', onParentAbort, { once: true });
  try {
    const res = await fetch(`${cfg.vllmUrl}/v1/chat/completions`, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        temperature: cfg.temperature,
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
        response_format: {
          type: 'json_schema',
          json_schema: { name: `disambig_${feld.eCode}`, schema, strict: true },
        },
      }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = j.choices?.[0]?.message?.content ?? '';
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    return JSON.parse(raw.slice(start, end + 1)) as DisambigAnswer;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onParentAbort);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Stage
// ─────────────────────────────────────────────────────────────────────────

export const phase4EntityDisambigStage = defineStage<
  Phase4DisambigInput,
  Phase3LlmFillOutput,
  Phase4DisambigConfig
>({
  id: 'elster-v5_1/phase4-entity-disambig',
  name: 'Phase 4 — Layer 2 Entity Disambiguierung',
  description:
    'Pro PFLICHT-eCode der nach Phase 3 noch null ist: Keyword-Kandidatensuche im ' +
    'OCR-Text + Mini-vLLM-Call mit strict-JSON-Schema (1-aus-K Picker mit ' +
    'Confidence-Threshold). Output-Shape kompatibel zu Phase 3 → phase5-merge ' +
    'unverändert.',
  hints: {
    inputs: 'text, phase1_per_anlage, phase3_per_anlage, felder_per_anlage',
    outputs: 'per_anlage (gemerged), totalFilled, ms',
    inputPorts: [
      { name: 'text', type: 'text' },
      { name: 'phase1_per_anlage', type: 'json' },
      { name: 'phase3_per_anlage', type: 'json' },
      { name: 'felder_per_anlage', type: 'json' },
    ],
    outputPorts: [{ name: 'per_anlage', type: 'json' }],
  },

  async run(input, ctx) {
    const t0 = Date.now();
    const cfg = ctx.config ?? {};
    const provider: ChatProvider = cfg.provider ?? 'vllm';
    const vllmUrl = cfg.vllmUrl ?? 'http://localhost:11435';
    const model = cfg.model ?? 'gemma4-mm';
    const temperature = cfg.temperature ?? 0;
    const confT = cfg.confidenceThreshold ?? 0.7;
    const topK = cfg.topK ?? 5;
    const concurrency = Math.max(1, cfg.concurrency ?? 5);
    const perCallTimeoutMs = cfg.perCallTimeoutMs ?? 20_000;

    if (provider !== 'vllm') {
      ctx.logger.warn('phase4-entity-disambig: provider≠vllm — Mini-Disambig im aktuellen MVP nur über vLLM');
    }

    const phase3 = input.phase3_per_anlage ?? {};
    const felderMap = input.felder_per_anlage ?? {};
    const results: Record<string, Phase3AnlageResult> = {};
    let totalFilled = 0;

    // Zu disambiguierende Felder sammeln: PFLICHT + still_missing
    type Task = { anlage: string; feld: AnlagenFeld; candidates: Candidate[] };
    const tasks: Task[] = [];
    for (const [anlage, p3] of Object.entries(phase3)) {
      results[anlage] = { ...p3, llm_hits: { ...p3.llm_hits } };
      const liste = felderMap[anlage];
      if (!liste) continue;
      const felderByECode = new Map(liste.felder.map((f) => [f.eCode, f]));
      for (const eCode of p3.still_missing) {
        const feld = felderByECode.get(eCode);
        if (!feld || !feld.pflicht) continue;
        const candidates = findCandidates(input.text, feld.drucktext, topK);
        if (candidates.length === 0) continue;
        tasks.push({ anlage, feld, candidates });
      }
    }
    ctx.emit('phase4_start', { tasks: tasks.length, concurrency, model });

    const queue = [...tasks];
    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const task = queue.shift();
        if (!task) return;
        const ans = await disambigCall(
          task.feld,
          task.anlage,
          task.candidates,
          { vllmUrl, model, temperature, perCallTimeoutMs },
          ctx.signal,
        );
        if (!ans || ans.value === null || ans.confidence < confT) {
          ctx.emit('phase4_field_skip', {
            anlage: task.anlage,
            eCode: task.feld.eCode,
            confidence: ans?.confidence ?? 0,
            reason: ans ? 'low-confidence' : 'no-answer',
          });
          continue;
        }
        const r = results[task.anlage];
        const hit: Phase3LlmHit = {
          eCode: task.feld.eCode,
          value: String(ans.value),
          origin: 'LLM_FSM',
          kontextPath: task.feld.einkunftsart,
          anlage: task.anlage,
          drucktext: task.feld.drucktext,
          vordruckzeile: task.feld.vordruckzeile,
          datentyp: task.feld.datentyp,
        };
        r.llm_hits[task.feld.eCode] = hit;
        r.still_missing = r.still_missing.filter((e) => e !== task.feld.eCode);
        totalFilled++;
        ctx.emit('phase4_field_fill', {
          anlage: task.anlage,
          eCode: task.feld.eCode,
          value: hit.value,
          confidence: ans.confidence,
          reasoning: ans.reasoning,
        });
      }
    };

    await Promise.all(Array.from({ length: concurrency }, worker));
    await ctx.artifacts.write('phase4_per_anlage.json', results);
    const ms = Date.now() - t0;
    ctx.emit('phase4_done', { totalFilled, ms, tasks: tasks.length });
    return { per_anlage: results, totalFilled, ms };
  },
});
