/**
 * Citation-Finder: gegeben einen claimed value + OCR-Text → liefert die Position
 * im Text wo der Wert verifizierbar ist (oder null wenn uncitable).
 *
 * Pure compute. Reuse der Normalisierungs-Logik aus audit.ts (DE/ISO-Datum,
 * Currency, IBAN-Whitespace, multi-token names).
 *
 * Confidence-Levels:
 *   - 'verbatim'   : exakt-Match im OCR-Text
 *   - 'normalized' : Match nach Format-Normalisierung (Datum DE→ISO, Currency)
 *   - 'partial'    : ≥70% der alphanumerischen Zeichen auf einer Zeile gefunden
 *   - null         : nicht im OCR-Text → uncitable (potentielle Halluzination)
 */

export interface Citation {
  /** 1-basierte Seitennummer (oder undefined wenn pagesMarkdown nicht verfügbar). */
  page?: number;
  /** Char-Offset in pagesMarkdown[page-1] oder im flachen markdown. */
  charOffset: number;
  /** Länge des gefundenen Spans (in Zeichen). */
  length: number;
  /** Snippet drum herum, ~80 Zeichen, für UI-Anzeige. */
  evidence: string;
  /** Wie hart der Match ist. */
  confidence: 'verbatim' | 'normalized' | 'partial';
  /** Der tatsächlich gefundene Span (kann sich vom claimed value unterscheiden bei normalized/partial). */
  matchedText: string;
}

/** Normalisierung — gleiche Logik wie audit.ts:normalize(). */
function normalize(v: unknown): string {
  if (v == null) return '';
  let s = String(v).trim().toLowerCase();
  const de = s.match(/^(\d{2})\.(\d{2})\.((19|20)\d{2})$/);
  if (de) return `${de[3]}-${de[2]}-${de[1]}`;
  if (/(€|eur)/.test(s) || /^[\d.]+,\d{2}$/.test(s)) {
    s = s.replace(/€|eur/g, '').replace(/\s/g, '');
    if (/^-?[\d.]+,\d{2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  }
  return s.replace(/\s+/g, '');
}

/** Variantenerzeugung — gleiche Logik wie audit.ts:variants(). */
function variants(v: string): string[] {
  const out = new Set<string>([v.trim()]);
  const s = v.trim();
  const iso = s.match(/^((?:19|20)\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
  if (iso) out.add(`${iso[3]}.${iso[2]}.${iso[1]}`);
  const de = s.match(/^(0[1-9]|[12]\d|3[01])\.(0[1-9]|1[0-2])\.((?:19|20)\d{2})$/);
  if (de) out.add(`${de[3]}-${de[2]}-${de[1]}`);
  const numMatch = s.match(/^(-?[\d.]+,\d{2})\s*(€|EUR|eur)?$/);
  if (numMatch) {
    const num = numMatch[1];
    out.add(num);
    out.add(`${num} €`);
    out.add(`${num} EUR`);
    const noThou = num.replace(/\./g, '');
    out.add(noThou);
    out.add(`${noThou} €`);
    out.add(`${noThou} EUR`);
  }
  return [...out];
}

function snippetAround(text: string, idx: number, len: number, span = 80): string {
  const start = Math.max(0, idx - 30);
  const end = Math.min(text.length, idx + len + (span - 30));
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
}

/** Such einen Wert im flachen Markdown. Liefert {idx, len, matched, confidence} oder null. */
function findInFlat(value: string, markdown: string): { idx: number; len: number; matched: string; confidence: Citation['confidence'] } | null {
  if (!markdown || !value) return null;
  // 1. Verbatim-Variants
  for (const v of variants(value)) {
    const i = markdown.indexOf(v);
    if (i >= 0) return { idx: i, len: v.length, matched: v, confidence: v === value.trim() ? 'verbatim' : 'normalized' };
  }
  // 2. Normalized full scan (compact)
  const target = normalize(value);
  if (target) {
    const compactMd = markdown.replace(/\s+/g, '').toLowerCase();
    const compactTarget = target.replace(/\s+/g, '');
    const ci = compactMd.indexOf(compactTarget);
    if (ci >= 0) return { idx: Math.min(ci, markdown.length - 1), len: compactTarget.length, matched: compactTarget, confidence: 'normalized' };
  }
  // 3. Multi-token
  const tokens = value.trim().split(/\s+/).filter((t) => t.length >= 3);
  if (tokens.length >= 2) {
    const lc = markdown.toLowerCase();
    const positions = tokens.map((t) => lc.indexOf(t.toLowerCase()));
    if (positions.every((p) => p >= 0)) {
      const min = Math.min(...positions);
      const max = Math.max(...positions);
      if (max - min < 200) return { idx: min, len: max - min + 20, matched: markdown.slice(min, max + 20), confidence: 'normalized' };
    }
  }
  // 4. Partial line-stripped
  const stripped = (target || value).replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (stripped.length >= 6) {
    const lines = markdown.split(/\n/);
    let cumOffset = 0;
    for (const line of lines) {
      const lineStripped = line.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (lineStripped.includes(stripped)) {
        return { idx: cumOffset, len: Math.min(line.length, 200), matched: line.trim().slice(0, 200), confidence: 'partial' };
      }
      cumOffset += line.length + 1; // +1 for the newline
    }
  }
  return null;
}

/**
 * Find citation for a single claimed value.
 *
 * - Wenn pagesMarkdown vorhanden ist: per-page Suche → page wird gesetzt
 * - Sonst: fallback auf flat markdown ohne page
 */
export function findCitation(
  value: string,
  ctx: { markdown?: string; pagesMarkdown?: string[] },
): Citation | null {
  if (!value || !value.trim()) return null;
  // Per-page first if available
  if (ctx.pagesMarkdown && ctx.pagesMarkdown.length > 0) {
    for (let i = 0; i < ctx.pagesMarkdown.length; i++) {
      const page = ctx.pagesMarkdown[i];
      const r = findInFlat(value, page);
      if (r) {
        return {
          page: i + 1,
          charOffset: r.idx,
          length: r.len,
          evidence: snippetAround(page, r.idx, r.len),
          confidence: r.confidence,
          matchedText: r.matched,
        };
      }
    }
  }
  // Fallback to flat markdown
  if (ctx.markdown) {
    const r = findInFlat(value, ctx.markdown);
    if (r) {
      return {
        charOffset: r.idx,
        length: r.len,
        evidence: snippetAround(ctx.markdown, r.idx, r.len),
        confidence: r.confidence,
        matchedText: r.matched,
      };
    }
  }
  return null;
}

/** Batch-Convenience: alle Citations für eine KPI-Liste auf einmal. */
export function findAllCitations(
  kpis: Array<{ key: string; value: string }>,
  ctx: { markdown?: string; pagesMarkdown?: string[] },
): Array<{ key: string; citation: Citation | null }> {
  return kpis.map((k) => ({ key: k.key, citation: findCitation(k.value, ctx) }));
}

/** Coverage-Summary: wieviel % der KPIs sind zitierbar. */
export function citationCoverage(kpis: Array<{ citation?: Citation | null }>): {
  total: number; cited: number; verbatim: number; normalized: number; partial: number; uncitable: number;
} {
  let cited = 0, verbatim = 0, normalized = 0, partial = 0, uncitable = 0;
  for (const k of kpis) {
    if (k.citation) {
      cited++;
      if (k.citation.confidence === 'verbatim') verbatim++;
      else if (k.citation.confidence === 'normalized') normalized++;
      else partial++;
    } else uncitable++;
  }
  return { total: kpis.length, cited, verbatim, normalized, partial, uncitable };
}
