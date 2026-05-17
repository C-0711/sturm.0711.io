/**
 * Centralized German-locale number parser for canonical_layer entries.
 *
 * Background: canonical_layer values arrive from OCR/LLM as locale strings
 * ("1.781,98 EUR", "6.011", "772,68"). Downstream consumers (BMF tax
 * calculation, ground-truth comparators, sum checks) need JS numbers. We
 * keep the raw `value` for audit, the wire-formatted `normalized` (Integer-
 * Cents for currency, "DD.MM.YYYY" for date) for ERiC, AND now a
 * `normalizedNumber` (`number`) as the single source of arithmetic truth.
 *
 * The Stricker case (commit 791bec2) showed why this matters: German
 * thousand-grouped integers without decimals ("6.011" = sechstausendelf)
 * were re-interpreted as 6.011 (six-point-zero-one-one), a factor-1000
 * underflow that propagated into the BMF Vorsorgeaufwendungen calculation.
 *
 * The heuristic prefers German interpretation but falls back to English
 * for inputs that are unambiguous (e.g. "1234.56" — only one dot, ≥4
 * digits-only-around-the-dot → English decimal).
 */

/**
 * Parse a (possibly German-formatted) money/number string into a JS number.
 *
 * Examples:
 *   "1.781,98 EUR"     → 1781.98
 *   "1.781,98"         → 1781.98
 *   "1781,98 €"        → 1781.98
 *   "1781.98"          → 1781.98   (English fallback)
 *   "1781"             → 1781
 *   "-1.234,50"        → -1234.5
 *   "6.011"            → 6011      (German thousand-group integer — WISO Stricker)
 *   ""                 → null
 *   "Nicht zutreffend" → null
 *   42                 → 42        (number passthrough)
 *
 * Returns null for empty, non-numeric, or non-string/number inputs.
 */
export function parseGermanMoney(s: string | number | null | undefined): number | null {
  if (s === null || s === undefined) return null;
  if (typeof s === 'number') return Number.isFinite(s) ? s : null;
  if (typeof s !== 'string') return null;

  // Strip currency symbols (EUR, €, $) and whitespace. Leave digits, separators, sign.
  const stripped = s.replace(/EUR/gi, '').replace(/[€$\s]/g, '').trim();
  if (stripped === '') return null;

  // Sign handling (keep separate so the body-only patterns are simpler).
  const sign = stripped.startsWith('-') ? '-' : (stripped.startsWith('+') ? '+' : '');
  const body = sign ? stripped.slice(1) : stripped;
  if (body === '') return null;

  // Reject if no digit at all.
  if (!/\d/.test(body)) return null;

  const lastDot = body.lastIndexOf('.');
  const lastComma = body.lastIndexOf(',');

  let normalized: string;

  if (lastComma >= 0 && lastDot >= 0) {
    // Both separators. The LAST one wins as the decimal.
    if (lastComma > lastDot) {
      // German: "1.234,56" — dots are thousands, comma is decimal.
      normalized = body.replace(/\./g, '').replace(',', '.');
    } else {
      // English-with-thousands: "1,234.56" — commas are thousands, dot is decimal.
      normalized = body.replace(/,/g, '');
    }
  } else if (lastComma >= 0) {
    // Only comma: German decimal. "1234,56" → "1234.56", "1,5" → "1.5".
    normalized = body.replace(',', '.');
  } else if (lastDot >= 0) {
    // Only dot — ambiguous. Heuristic:
    //   (a) Pattern like "6.011" or "1.234" or "12.345.678" — every dot-group
    //       after the first is EXACTLY 3 digits AND has no other digits-
    //       after-dot pattern → German thousand-grouped integer.
    //   (b) Otherwise English decimal ("1234.5", "0.5", "1781.98").
    //
    // Note: "1.234" is the classic ambiguity. We prefer German thousands
    // ("1234") because that is the WISO/ELSTER convention; OCR rarely emits
    // English "1.234" for a real fractional amount in a German tax doc.
    if (/^\d{1,3}(?:\.\d{3})+$/.test(body)) {
      normalized = body.replace(/\./g, '');
    } else {
      // Single dot with non-thousand-grouping → treat as English decimal.
      normalized = body;
    }
  } else {
    // No separator — plain integer string.
    normalized = body;
  }

  const n = Number(sign + normalized);
  return Number.isFinite(n) ? n : null;
}
