import { chatJson } from '../../elster/lib/mistral-chat.ts';
import type { Dokumenttyp } from './typen-katalog.ts';

export type Konfidenz = 'regex-stark' | 'regex-schwach' | 'llm' | 'unbekannt';

export interface ClassificationResult {
  typ_id: string | null;
  label: string | null;
  anlagen: string[];
  ecodeHintsProAnlage: Record<string, string[]>;
  konfidenz: Konfidenz;
  regex_scores: Record<string, number>;
  llm_vote: string | null;
  used_llm: boolean;
  ms: number;
}

export interface ClassifyOptions {
  model?: string;
  regexStrongThreshold?: number;
  regexDominanceFactor?: number;
  useLlmFallback?: boolean;
  temperature?: number;
  signal?: AbortSignal;
  onLlmVote?: (typ_id: string | null) => void;
}

function scoreRegex(text: string, typen: Dokumenttyp[]): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const typ of typen) {
    let count = 0;
    for (const src of typ.patterns) {
      const re = new RegExp(src, 'gi');
      const m = text.match(re);
      if (m) count += m.length;
    }
    if (count > 0) scores[typ.id] = count;
  }
  return scores;
}

function rank(scores: Record<string, number>): { id: string; score: number }[] {
  return Object.entries(scores)
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

function mergeHints(typen: Dokumenttyp[]): Record<string, string[]> {
  const merged = new Map<string, Set<string>>();
  for (const typ of typen) {
    for (const [anlage, hints] of Object.entries(typ.ecodeHintsProAnlage ?? {})) {
      if (!merged.has(anlage)) merged.set(anlage, new Set());
      const bucket = merged.get(anlage)!;
      for (const hint of hints ?? []) bucket.add(hint);
    }
  }
  return Object.fromEntries([...merged.entries()].map(([anlage, hints]) => [anlage, [...hints]]));
}

function detectMixedBundle(
  ranked: { id: string; score: number }[],
  typen: Dokumenttyp[],
  strongThreshold: number,
): ClassificationResult | null {
  const strong = ranked
    .filter((entry) => entry.score >= strongThreshold)
    .map((entry) => ({ entry, typ: typen.find((t) => t.id === entry.id) ?? null }))
    .filter((entry): entry is { entry: { id: string; score: number }; typ: Dokumenttyp } => !!entry.typ);

  if (strong.length < 2) return null;

  const totalScore = strong.reduce((sum, item) => sum + item.entry.score, 0);
  const topShare = totalScore > 0 ? strong[0].entry.score / totalScore : 1;
  const distinctAnlagen = new Set(strong.flatMap((item) => item.typ.anlagen ?? []));
  if (distinctAnlagen.size < 2 || topShare > 0.7) return null;

  const topTypes = strong.slice(0, 3).map((item) => item.typ);
  const label = 'Gemischtes Belegbündel: ' + topTypes.map((typ) => typ.label).join(' + ');
  return {
    typ_id: 'mixed_tax_bundle',
    label,
    anlagen: [...distinctAnlagen],
    ecodeHintsProAnlage: mergeHints(topTypes),
    konfidenz: 'regex-schwach',
    regex_scores: Object.fromEntries(strong.map((item) => [item.entry.id, item.entry.score])),
    llm_vote: null,
    used_llm: false,
    ms: 0,
  };
}

async function llmPick(
  text: string,
  typen: Dokumenttyp[],
  model: string,
  temperature: number,
  signal?: AbortSignal,
): Promise<string | null> {
  const liste = typen.map((t) => `- ${t.id}: ${t.label}`).join('\n');
  const prompt = [
    'Du bekommst den OCR-Text eines einzelnen Belegs für eine private Einkommensteuererklärung.',
    'Welcher der folgenden Dokumenttypen passt am besten? Wenn keiner passt, antworte mit null.',
    '',
    liste,
    '',
    'Antworte ausschließlich als JSON: {"typ_id": "<id aus der Liste oder null>"}.',
    '',
    '--- Dokument ---',
    text.slice(0, 20_000),
  ].join('\n');

  const { parsed } = await chatJson<{ typ_id?: string | null }>(prompt, {
    model,
    temperature,
    signal,
  });
  const ids = new Set(typen.map((t) => t.id));
  const pick = parsed.typ_id;
  return typeof pick === 'string' && ids.has(pick) ? pick : null;
}

/**
 * Klassifiziert einen Einzelbeleg gegen den Typen-Katalog.
 * Regex-first, LLM-Fallback bei schwachem/mehrdeutigem Regex-Ergebnis.
 */
export async function classifyText(
  text: string,
  typen: Dokumenttyp[],
  opts: ClassifyOptions = {},
): Promise<ClassificationResult> {
  const t0 = Date.now();
  const strongThreshold = opts.regexStrongThreshold ?? 2;
  const dominance = opts.regexDominanceFactor ?? 2;
  const useLlm = opts.useLlmFallback ?? true;
  const model = opts.model ?? 'mistral-small-latest';
  const temperature = opts.temperature ?? 0;

  const scores = scoreRegex(text, typen);
  const ranked = rank(scores);

  const mixed = detectMixedBundle(ranked, typen, strongThreshold);
  if (mixed) {
    return {
      ...mixed,
      ms: Date.now() - t0,
    };
  }

  const top = ranked[0];
  const second = ranked[1];
  const regexStark =
    !!top &&
    top.score >= strongThreshold &&
    (!second || top.score >= dominance * second.score);

  let pickId: string | null = regexStark ? top.id : null;
  let konfidenz: Konfidenz = regexStark
    ? 'regex-stark'
    : top
    ? 'regex-schwach'
    : 'unbekannt';
  let llmVote: string | null = null;
  let usedLlm = false;

  if (!regexStark && useLlm) {
    try {
      llmVote = await llmPick(text, typen, model, temperature, opts.signal);
      usedLlm = true;
      opts.onLlmVote?.(llmVote);
      if (llmVote) {
        pickId = llmVote;
        konfidenz = 'llm';
      }
    } catch {
      // LLM fehlgeschlagen — Regex-Ergebnis behalten
    }
  }

  const pick = pickId ? typen.find((t) => t.id === pickId) ?? null : null;
  return {
    typ_id: pick?.id ?? null,
    label: pick?.label ?? null,
    anlagen: pick?.anlagen ?? [],
    ecodeHintsProAnlage: pick?.ecodeHintsProAnlage ?? {},
    konfidenz,
    regex_scores: scores,
    llm_vote: llmVote,
    used_llm: usedLlm,
    ms: Date.now() - t0,
  };
}
