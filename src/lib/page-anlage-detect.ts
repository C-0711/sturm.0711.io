/**
 * page-anlage-detect — split OCR text into pages and infer which ELSTER
 * anlage each page covers.
 *
 * Used by phase3-vision-fill (v6) to send focused per-anlage vision calls
 * with only the pages and fields relevant to that anlage. Matches the
 * pattern of the v6 spike that hit 42/44 fields on Stricker (~22 fields
 * per call, pages grouped by anlage).
 *
 * Pure: no I/O, no side effects.
 */

/** Split mistral-ocr concatenated markdown into per-page strings.
 *
 * Mistral OCR's joined output contains "Seite N von M" lines at each page
 * break. We split on the lookahead so the marker stays with the FOLLOWING
 * page (the one it labels).
 *
 * If no markers are found, returns the input as a single page. Caller can
 * decide whether that fallback is acceptable.
 */
export function splitOcrByPages(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return [''];
  const headerRx = /Seite (\d+) von \d+/;
  const parts = text.split(/(?=Seite \d+ von \d+)/);
  const cleaned = parts.map((p) => p.trim()).filter((p) => p.length > 0);
  if (cleaned.length === 0) return [text];

  // Bucket sections by the page NUMBER from their header. This handles two
  // common artifacts:
  //   1. Leading noise before the first "Seite 1 von M" marker (else page-0
  //      would be that noise → off-by-one indexing for all downstream).
  //   2. Mistral OCR emitting "Seite N von M" twice on the same page (header
  //      + content start) → multiple sections collapse into the same page.
  // Sections without a header are discarded (they belong to no page).
  const byPage = new Map<number, string[]>();
  let maxPage = -1;
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const m = trimmed.match(headerRx);
    if (!m) continue; // drop unheadered noise (e.g. before Seite 1)
    const pageIdx = parseInt(m[1], 10) - 1; // 1-based → 0-based
    if (pageIdx < 0) continue;
    const bucket = byPage.get(pageIdx) ?? [];
    bucket.push(trimmed);
    byPage.set(pageIdx, bucket);
    if (pageIdx > maxPage) maxPage = pageIdx;
  }
  if (maxPage < 0) return [text]; // no headers found → keep original behavior

  const out: string[] = [];
  for (let i = 0; i <= maxPage; i++) {
    const chunks = byPage.get(i) ?? [];
    out.push(chunks.join('\n\n'));
  }
  return out;
}

/** Anlage key → list of regex patterns that, if any match a page's text,
 *  indicate that anlage is present on the page.
 *
 *  Ordering matters when patterns could overlap (e.g. "Anlage KAP" matches
 *  inside "Anlage KAP-INV") — KAP_I is checked before KAP.
 */
const ANLAGE_MARKERS: Array<[string, RegExp[]]> = [
  // Stammdaten / cover
  ['ESt1A', [
    /Hauptvordruck\s*ESt\s*1\s*A/i,
    /Mantelbogen/i,
    /Steuererkl[äa]rung\s+(?:zur\s+)?Einkommensteuer/i,
  ]],
  // Order of these matters — more specific first
  ['KAP_I', [/Anlage\s+KAP[- ]?INV/i, /Investmenterträge/i]],
  ['KAP',   [/Anlage\s+KAP(?![- ]?INV)/i, /Einkünfte\s+aus\s+Kapitalvermögen/i]],
  ['N',     [/Anlage\s+N\b/i, /nichtselbständig/i, /Werbungskosten/i]],
  ['VOR',   [/Anlage\s+(?:Vorsorgeaufwand|VOR)\b/i, /Vorsorgeaufwendungen/i]],
  ['SA',    [/Anlage\s+S[AO]\b/i, /Sonderausgaben\s*(?:\(|:)/i]],
  ['AV',    [/Anlage\s+AV\b/i, /Altersvorsorgebeitr[äa]ge/i]],
  ['Kind',  [/Anlage\s+Kind\b/i]],
  ['G',     [/Anlage\s+G\b/i, /Gewerbebetrieb/i]],
  ['S',     [/Anlage\s+S\b/i, /selbständige\s+Arbeit/i]],
  ['L',     [/Anlage\s+L\b/i, /Land\-\s*und\s+Forstwirtschaft/i]],
  ['V',     [/Anlage\s+V\b/i, /Vermietung\s+und\s+Verpachtung/i]],
  ['R',     [/Anlage\s+R\b/i, /Renteneinkünfte/i]],
];

/** Detect which anlagen appear on each page.
 *
 *  Returns Map<anlage, sorted list of page indices (0-based)>.
 *  Pages with no markers are not assigned to any anlage. Callers should
 *  treat unassigned pages as "all anlagen possibly present" fallback.
 */
export function detectAnlagenPerPage(pageTexts: string[]): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (let i = 0; i < pageTexts.length; i++) {
    const text = pageTexts[i] ?? '';
    const matched = new Set<string>();
    for (const [anl, patterns] of ANLAGE_MARKERS) {
      if (matched.has(anl)) continue;
      for (const rx of patterns) {
        if (rx.test(text)) {
          matched.add(anl);
          break;
        }
      }
    }
    for (const anl of matched) {
      const arr = out[anl] ?? [];
      arr.push(i);
      out[anl] = arr;
    }
  }
  return out;
}

/** Extract ELSTER-Zeile numbers visible on a page.
 *
 *  Used by phase3-vision-fill's strict page-Zeile filter (no fallback):
 *  every field asked of vision must have its vordruckzeile detected as
 *  a row leader on the actual page text. Mirrors the spike invariant.
 *
 *  Matches:
 *    - explicit "Zeile 5", "Zeile 30" mentions
 *    - row leader "43 Arbeitnehmerbeiträge ..." (digit then label)
 *    - table cell  "| 48 Bezeichnung |" (markdown table)
 */
export function detectZeilenOnPage(pageText: string): Set<string> {
  const zeilen = new Set<string>();
  if (typeof pageText !== 'string' || pageText.length === 0) return zeilen;
  for (const m of pageText.matchAll(/Zeile\s+(\d{1,3})\b/gi)) zeilen.add(m[1]);
  for (const m of pageText.matchAll(/(?:^|\n|\|)\s*(\d{1,3})\s+[A-ZÄÖÜa-zäöü]/g)) {
    zeilen.add(m[1]);
  }
  return zeilen;
}

/** For one anlage, return the pages where it appears.
 *  Fallback strategy when no pages matched: return the first page only
 *  (anlage probably on the cover or an unrecognised header). The caller
 *  may also choose to fall back to all pages for full coverage.
 */
export function pagesForAnlage(
  anlage: string,
  perPage: Record<string, number[]>,
  totalPages: number,
  fallback: 'first-page' | 'all-pages' = 'all-pages',
): number[] {
  const found = perPage[anlage];
  if (found && found.length > 0) return found;
  if (fallback === 'first-page') return totalPages > 0 ? [0] : [];
  return Array.from({ length: totalPages }, (_, i) => i);
}
