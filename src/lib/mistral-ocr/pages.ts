/**
 * Page-range string ↔ integer array.
 *
 * Display convention (UI, playground): 1-indexed, "1-4,8" → pages 1,2,3,4,8.
 * Wire convention (Mistral API): 0-indexed array, [0,1,2,3,7].
 *
 * KEEP this conversion in one place; it is the single off-by-one that bites.
 */

const RANGE_RE = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/;

export function pageRangeStringToArray(input: string | null | undefined): number[] {
  if (!input) return [];
  const out = new Set<number>();
  for (const part of input.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const m = RANGE_RE.exec(trimmed);
    if (!m) throw new Error(`Invalid page range token: "${trimmed}"`);
    const start = Number(m[1]);
    const end = m[2] !== undefined ? Number(m[2]) : start;
    if (start < 1) throw new Error(`Page numbers are 1-indexed in display, got "${trimmed}"`);
    if (end < start) throw new Error(`Range end before start: "${trimmed}"`);
    for (let i = start; i <= end; i++) out.add(i - 1); // → 0-indexed
  }
  return Array.from(out).sort((a, b) => a - b);
}

export function arrayToPageRangeString(pages: number[] | null | undefined): string {
  if (!pages || pages.length === 0) return '';
  const sorted = Array.from(new Set(pages)).sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const cur = sorted[i];
    if (cur !== prev + 1) {
      parts.push(start === prev ? `${start + 1}` : `${start + 1}-${prev + 1}`);
      start = cur;
    }
    prev = cur;
  }
  return parts.join(',');
}
