/**
 * Span-Linker — maps every extracted leaf value back to its location in the
 * source text. Produces an audit trail: each value gets a sibling `_span` key
 * with `{page, charStart, charEnd, snippet}`.
 *
 * Algorithm (deterministic, no LLM):
 *   1. Flatten the extraction into (path, value) pairs.
 *   2. For each pair, fuzzy-find the value in the source text:
 *      - Normalize both sides (strip currency symbols, collapse whitespace,
 *        lowercase if `caseSensitive=false`).
 *      - Exact match first; fall back to per-token windowed match with
 *        Jaccard >= fuzziness threshold.
 *   3. When pages[] is provided, identify which page covers the match by
 *      tracking cumulative char offsets across pages.
 *
 * Coverage metric: ratio of leaves where a span was found. Unmappable values
 * (typically derived/computed, like sums) are reported separately.
 */
import { defineStage } from '../../core/stage.ts';
import { searchVariants } from '../../lib/quality/datentyp-normalize.ts';

export interface SpanLinkerInput {
  extracted: unknown;
  /** Either the concatenated source text … */
  source?: string;
  /** … or the per-page array (page index → markdown) for page-resolution. */
  pages?: Array<{ index: number; markdown: string }>;
  /**
   * Optional per-leaf metadata from container-field-mapper. When provided, the
   * linker uses `datentyp` to generate format-aware search variants — turns
   * `69291.8` into ALSO searching for `"69.291,80"`, `"69.291,80 €"`, etc.
   * Boosts coverage on numeric/currency/date fields from ~0.6 to >0.95.
   */
  field_meta?: Record<string, { datentyp?: string } | null>;
}

export interface Span {
  page: number;       // -1 if unknown
  charStart: number;
  charEnd: number;
  snippet: string;    // ±40 chars around the match
}

export interface SpanLinkerOutput {
  /** Object cloned from `extracted`, augmented with `_span` siblings for each leaf. */
  extracted_with_spans: unknown;
  /** Dotted paths of leaves we could NOT locate in source. */
  unmappable: string[];
  /** Matched / total. */
  coverage: number;
  ms: number;
}

export interface SpanLinkerConfig {
  caseSensitive?: boolean;
  /** 0..1 — minimum Jaccard for fuzzy match. Default 0.85. */
  fuzziness?: number;
  /** Include ±40-char snippet in each span. Default true. */
  includeSnippet?: boolean;
  /** Skip keys with these names (already meta — e.g. _span, _validation). */
  skipKeys?: string[];
}

// ── Normalization helpers ───────────────────────────────────────────────────
function normalizeValue(v: string, caseSensitive: boolean): string {
  let s = v
    .replace(/[€$£]/g, '')   // currency
    .replace(/\s+/g, ' ')   // collapse whitespace
    .trim();
  if (!caseSensitive) s = s.toLowerCase();
  return s;
}
function normalizeSource(text: string, caseSensitive: boolean): string {
  let s = text.replace(/\s+/g, ' ');
  if (!caseSensitive) s = s.toLowerCase();
  return s;
}

// ── Fuzzy search ────────────────────────────────────────────────────────────
function jaccard(a: string, b: string): number {
  // Simple char-trigram Jaccard — robust to typos, OK for short numeric values too.
  const tri = (s: string) => {
    const set = new Set<string>();
    if (s.length < 3) { set.add(s); return set; }
    for (let i = 0; i <= s.length - 3; i++) set.add(s.slice(i, i + 3));
    return set;
  };
  const A = tri(a), B = tri(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

function findExactOrFuzzy(needle: string, haystack: string, fuzziness: number): { start: number; end: number } | null {
  if (!needle) return null;
  // 1. Exact substring (cheap and most common path)
  const ix = haystack.indexOf(needle);
  if (ix >= 0) return { start: ix, end: ix + needle.length };
  // 2. Fuzzy windowed scan — only for needles >= 4 chars (avoid junk matches)
  if (needle.length < 4) return null;
  const windowLen = needle.length;
  const step = Math.max(1, Math.floor(windowLen / 4));
  let best: { start: number; score: number } | null = null;
  for (let i = 0; i <= haystack.length - windowLen; i += step) {
    const slice = haystack.slice(i, i + windowLen);
    const sc = jaccard(slice, needle);
    if (!best || sc > best.score) best = { start: i, score: sc };
  }
  if (best && best.score >= fuzziness) {
    return { start: best.start, end: best.start + windowLen };
  }
  return null;
}

// ── Page resolution ─────────────────────────────────────────────────────────
function buildPageMap(pages?: Array<{ index: number; markdown: string }>): { cum: number[]; pageOf: (pos: number) => number } {
  if (!pages || pages.length === 0) {
    return { cum: [], pageOf: () => -1 };
  }
  // Sources are concatenated with '\n\n' in our convention; mirror that offset math.
  const SEP = '\n\n';
  const cum: number[] = [];
  let acc = 0;
  for (const p of pages) {
    cum.push(acc);
    acc += (p.markdown || '').length + SEP.length;
  }
  return {
    cum,
    pageOf: (pos: number) => {
      // Binary search for the page whose start <= pos
      let lo = 0, hi = cum.length - 1, ans = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] <= pos) { ans = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      return pages[ans]?.index ?? ans;
    },
  };
}

// ── Tree walker: deep-clone with `_span` siblings ───────────────────────────
type Walker = (path: string, value: unknown) => Span | null;

function annotate(node: unknown, prefix: string, skip: Set<string>, find: Walker, found: { ok: number; total: number; unmappable: string[] }): unknown {
  if (node == null) return node;
  if (Array.isArray(node)) {
    return node.map((v, i) => annotate(v, `${prefix}[${i}]`, skip, find, found));
  }
  if (typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      // Skip all annotation keys (convention: prefix _). Covers
      // _span_*, _validation, _resolution, _ecode_*, _meta_*, _span_<name>.
      // Existing meta keys are passed through unchanged.
      if (k.startsWith('_') || skip.has(k)) { out[k] = v; continue; }
      const childPath = prefix ? `${prefix}.${k}` : k;
      const annotated = annotate(v, childPath, skip, find, found);
      out[k] = annotated;
      // Add _span sibling for leaf values (string/number/boolean).
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        const strVal = String(v);
        if (strVal.length === 0) continue; // empty values aren't span-able
        found.total += 1;
        // Pass raw v (not strVal) so datentyp-aware variants work on the typed value.
        const span = find(childPath, v);
        if (span) {
          out[`_span_${k}`] = span;
          found.ok += 1;
        } else {
          found.unmappable.push(childPath);
        }
      }
    }
    return out;
  }
  return node;
}

export const spanLinkerStage = defineStage<SpanLinkerInput, SpanLinkerOutput, SpanLinkerConfig>({
  id: 'extract/span-linker',
  name: 'Span-Linker — value→source mapping',
  description:
    'Mappt jeden extrahierten Leaf-Wert zurück auf seine Position im OCR-Quelltext ' +
    '(Seite, charStart/End, Snippet). Erzeugt audit-fähigen Trail von Wert → Quelle. ' +
    'Deterministisch, kein LLM-Call.',
  hints: {
    inputs: 'extracted (nested-json), source (text) ODER pages[{index,markdown}]',
    outputs: 'extracted_with_spans, unmappable[], coverage (0..1)',
    configExample: '{"caseSensitive": false, "fuzziness": 0.85, "includeSnippet": true}',
    inputPorts: [
      { name: 'extracted', type: 'nested-json' },
      { name: 'source', type: 'text', description: 'Concatenated OCR text — used if pages[] missing' },
      { name: 'pages', type: 'pages', description: 'Per-page array for page-resolution' },
      { name: 'field_meta', type: 'json', description: 'Per-leaf metadata (datentyp) from container-field-mapper for type-aware search variants' },
    ],
    outputPorts: [
      { name: 'extracted_with_spans', type: 'nested-json' },
      { name: 'unmappable', type: 'json', description: 'List of leaf paths not found' },
      { name: 'coverage', type: 'number', description: '0..1 ratio of mappable leaves' },
    ],
  },

  async run(input, ctx) {
    if (!input?.extracted) throw new Error('span-linker: input.extracted fehlt');
    const cfg = ctx.config ?? ({} as SpanLinkerConfig);
    const caseSensitive = cfg.caseSensitive === true;
    const fuzziness = cfg.fuzziness ?? 0.85;
    const includeSnippet = cfg.includeSnippet !== false;
    const skipKeys = new Set<string>([
      ...(cfg.skipKeys ?? []),
      '_span', '_validation', '_resolution', // already-decorated keys
    ]);

    const t0 = Date.now();
    const source = input.source ?? (input.pages?.map((p) => p.markdown).join('\n\n') ?? '');
    const normSource = normalizeSource(source, caseSensitive);
    const pageMap = buildPageMap(input.pages);

    const fieldMeta = input.field_meta ?? {};
    const find: Walker = (path: string, rawValue: unknown) => {
      // Container-aware: when we have datentyp metadata for this path, generate
      // type-aware search variants (e.g. for currency: "69291.8" → also "69.291,80",
      // "69.291,80 €"). Falls back to the plain stringified value otherwise.
      const datentyp = fieldMeta[path]?.datentyp;
      const variants = datentyp
        ? searchVariants(rawValue, datentyp)
        : [String(rawValue)];
      for (const v of variants) {
        const needle = normalizeValue(v, caseSensitive);
        const f = findExactOrFuzzy(needle, normSource, fuzziness);
        if (f) {
          const page = pageMap.pageOf(f.start);
          const snippet = includeSnippet
            ? source.slice(Math.max(0, f.start - 40), Math.min(source.length, f.end + 40))
            : '';
          return { page, charStart: f.start, charEnd: f.end, snippet };
        }
      }
      return null;
    };

    const found = { ok: 0, total: 0, unmappable: [] as string[] };
    const annotated = annotate(input.extracted, '', skipKeys, find, found);

    const coverage = found.total === 0 ? 1 : found.ok / found.total;
    const ms = Date.now() - t0;
    ctx.emit('span_linker_done', { ms, coverage, mapped: found.ok, total: found.total, unmappable: found.unmappable.length });

    return {
      extracted_with_spans: annotated,
      unmappable: found.unmappable,
      coverage,
      ms,
    };
  },
});
