/**
 * The 7-stage cascade for ELSTER. Each stage is a small pure function from
 * (kpi, catalog) to a Match (or null). The generic cascade-runtime in
 * src/lib/cascade-runtime.ts walks them in order until one wins.
 *
 * Stage ordering matters — higher-precision deterministic stages run first
 * so the LLM fallback is only invoked when nothing else matched.
 */
import type { CascadeConfig, CascadeStage, Match, KPI } from '../../../lib/cascade-runtime.ts';
import {
  loadCatalog,
  norm,
  type ElsterCatalog,
  type ElsterFieldEntry,
} from './elster-katalog.ts';
import { coerceValue } from './validation.ts';
import { chatJson } from '../../../lib/llm-chat.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Stage 1: Bezeichnung exact (post-normalization)
// ─────────────────────────────────────────────────────────────────────────────

const stageBezeichnungExact: CascadeStage<ElsterCatalog> = {
  id: 'bezeichnung-exact',
  minConfidence: 0.95,
  match(kpi, catalog) {
    const k = norm(kpi.key);
    if (!k) return null;
    const candidates = catalog.bezeichnungIndex.get(k) ?? [];
    if (candidates.length === 0) {
      const dt = catalog.drucktextIndex.get(k);
      if (!dt) return null;
      return matchFromCandidates(dt, kpi, catalog, 'drucktext-exact', 0.97);
    }
    return matchFromCandidates(candidates, kpi, catalog, 'bezeichnung-exact', 0.98);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Stage 2: Bezeichnung fuzzy (token containment, low-bar)
// ─────────────────────────────────────────────────────────────────────────────

const stageBezeichnungFuzzy: CascadeStage<ElsterCatalog> = {
  id: 'bezeichnung-fuzzy',
  minConfidence: 0.75,
  match(kpi, catalog) {
    const tokens = norm(kpi.key).split(' ').filter((t) => t.length >= 4);
    if (tokens.length === 0) return null;
    const scoped = scopeByAnlagen(catalog, kpi.recommendedAnlagen);
    let best: { code: string; score: number; field: ElsterFieldEntry } | null = null;
    for (const f of scoped) {
      const target = norm(f.bezeichnung) + ' ' + norm(f.drucktext);
      let hits = 0;
      for (const t of tokens) if (target.includes(t)) hits++;
      const score = hits / tokens.length;
      if (score >= 0.75 && (!best || score > best.score)) {
        best = { code: f.eCode, score, field: f };
      }
    }
    if (!best) return null;
    return {
      code: best.code,
      value: coerceValue(kpi.value, best.field.datentyp),
      confidence: 0.75 + (best.score - 0.75) * 0.2, // 0.75..0.80 mapped to 0.75..0.80
      reasoning: `${Math.round(best.score * 100)}% token-overlap with "${best.field.bezeichnung.slice(0, 40)}"`,
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Stage 3: Synonyme aus konzept_zuordnung.searchKeywords (postgres export)
// ─────────────────────────────────────────────────────────────────────────────

const stageSemantikSchlagworte: CascadeStage<ElsterCatalog> = {
  id: 'semantik-schlagworte',
  minConfidence: 0.85,
  match(kpi, catalog) {
    const k = norm(kpi.key);
    if (!k) return null;
    const cands = catalog.conceptIndex.get(k);
    if (!cands || cands.length === 0) return null;
    return matchFromCandidates(cands, kpi, catalog, 'concept-keyword', 0.88);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Stage 4: Format regex against catalog field's formatRegex (value validation
// to disambiguate when multiple bezeichnung-share-the-same-name candidates
// exist, e.g. "Bruttoarbeitslohn" appears in E0200201..E0200204)
// ─────────────────────────────────────────────────────────────────────────────

const stageRegex: CascadeStage<ElsterCatalog> = {
  id: 'format-regex',
  minConfidence: 0.80,
  match(kpi, catalog) {
    if (typeof kpi.value !== 'string' && typeof kpi.value !== 'number') return null;
    const valStr = String(kpi.value);
    const k = norm(kpi.key);
    if (!k) return null;
    const candidates = catalog.bezeichnungIndex.get(k) ?? [];
    for (const code of candidates) {
      const f = catalog.byCode.get(code);
      if (!f?.formatRegex) continue;
      try {
        const re = new RegExp(f.formatRegex);
        if (re.test(valStr)) {
          return {
            code: f.eCode,
            value: coerceValue(kpi.value, f.datentyp),
            confidence: 0.85,
            reasoning: `value matches formatRegex of ${f.eCode}`,
          };
        }
      } catch {
        // bad regex in catalog — skip silently
      }
    }
    return null;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Stage 5: BMF-Slug (bmf_elster_zuordnung) — for WISO/Buhl-compatible slug aliases
// ─────────────────────────────────────────────────────────────────────────────

const stageBmfSlug: CascadeStage<ElsterCatalog> = {
  id: 'bmf-slug',
  minConfidence: 0.90,
  match(kpi, catalog) {
    const k = norm(kpi.key);
    if (!k) return null;
    const code = catalog.bmfSlugIndex.get(k);
    if (!code) return null;
    const f = catalog.byCode.get(code);
    if (!f) return null;
    return {
      code,
      value: coerceValue(kpi.value, f.datentyp),
      confidence: 0.92,
      reasoning: `bmf-slug "${kpi.key}" → ${code}`,
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Stage 6: LLM fallback — only if all deterministic stages declined
// ─────────────────────────────────────────────────────────────────────────────

const stageLlm: CascadeStage<ElsterCatalog> = {
  id: 'llm-fallback',
  minConfidence: 0.60,
  async: true,
  async match(kpi, catalog) {
    const scoped = scopeByAnlagen(catalog, kpi.recommendedAnlagen).slice(0, 200);
    if (scoped.length === 0) return null;
    const fieldList = scoped.map((f) =>
      `${f.eCode} | ${f.bezeichnung} | ${f.datentyp}`,
    ).join('\n');
    const prompt = [
      'Du bekommst einen frei extrahierten KPI aus einem deutschen Steuer-Beleg',
      'und eine Liste von ELSTER-Feldern. Bestimme den am besten passenden eCode.',
      `KPI-Label: "${kpi.key}"`,
      `KPI-Wert:  "${String(kpi.value).slice(0, 200)}"`,
      kpi.docType ? `Dokumenttyp: ${kpi.docType}` : '',
      kpi.recommendedAnlagen?.length
        ? `Empfohlene Anlagen: ${kpi.recommendedAnlagen.join(', ')}`
        : '',
      '',
      'Antworte ausschließlich mit JSON: {"eCode":"E0123456","confidence":0.7,"reason":"..."}',
      'Wenn keiner passt: {"eCode":null,"confidence":0,"reason":"…"}',
      '',
      '--- Felder ---',
      fieldList,
    ].filter(Boolean).join('\n');
    try {
      const { parsed } = await chatJson<{ eCode?: string; confidence?: number; reason?: string }>(
        prompt,
      );
      if (!parsed.eCode || !catalog.byCode.has(parsed.eCode)) return null;
      const f = catalog.byCode.get(parsed.eCode)!;
      return {
        code: parsed.eCode,
        value: coerceValue(kpi.value, f.datentyp),
        confidence: Math.max(0.6, Math.min(0.85, parsed.confidence ?? 0.65)),
        reasoning: `llm: ${parsed.reason ?? 'no-reason'}`,
      };
    } catch {
      return null;
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function matchFromCandidates(
  candidates: string[],
  kpi: KPI,
  catalog: ElsterCatalog,
  source: string,
  baseConfidence: number,
): Match | null {
  if (candidates.length === 0) return null;
  const scoped = filterByAnlagen(candidates, catalog, kpi.recommendedAnlagen);
  const winner = scoped[0] ?? candidates[0];
  const f = catalog.byCode.get(winner);
  if (!f) return null;
  // If multiple candidates remain, modest confidence penalty
  const ambiguityPenalty = Math.max(0, scoped.length - 1) * 0.02;
  return {
    code: winner,
    value: coerceValue(kpi.value, f.datentyp),
    confidence: Math.max(0.7, baseConfidence - ambiguityPenalty),
    reasoning: `${source} (${scoped.length} candidate${scoped.length !== 1 ? 's' : ''})`,
  };
}

function scopeByAnlagen(
  catalog: ElsterCatalog,
  recommendedAnlagen: string[] | undefined,
): ElsterFieldEntry[] {
  if (!recommendedAnlagen || recommendedAnlagen.length === 0) {
    return [...catalog.byCode.values()];
  }
  const scoped: ElsterFieldEntry[] = [];
  for (const a of recommendedAnlagen) {
    const bucket = catalog.feldKatalog.anlagen[a];
    if (bucket) scoped.push(...bucket.codes);
  }
  return scoped;
}

function filterByAnlagen(
  candidates: string[],
  catalog: ElsterCatalog,
  recommendedAnlagen: string[] | undefined,
): string[] {
  if (!recommendedAnlagen || recommendedAnlagen.length === 0) return candidates;
  const allowed = new Set<string>();
  for (const a of recommendedAnlagen) {
    const bucket = catalog.feldKatalog.anlagen[a];
    if (!bucket) continue;
    for (const f of bucket.codes) allowed.add(f.eCode);
  }
  const filtered = candidates.filter((c) => allowed.has(c));
  return filtered.length > 0 ? filtered : candidates;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: the assembled config
// ─────────────────────────────────────────────────────────────────────────────

export async function getElsterCascadeConfig(): Promise<CascadeConfig<ElsterCatalog>> {
  const catalog = await loadCatalog();
  return {
    schemaId: 'elster',
    version: catalog.feldKatalog.catalogVersion,
    stages: [
      stageBezeichnungExact,
      stageBezeichnungFuzzy,
      stageSemantikSchlagworte,
      stageRegex,
      stageBmfSlug,
      stageLlm,
    ],
  };
}

export const ELSTER_CASCADE_STAGES = [
  'bezeichnung-exact',
  'bezeichnung-fuzzy',
  'semantik-schlagworte',
  'format-regex',
  'bmf-slug',
  'llm-fallback',
] as const;
