/**
 * Datentyp-aware value normalization — bidirectional.
 *
 * The container labels each field with a `datentyp` (currency, date, iban,
 * idnr, …). This module renders both representations of any leaf value so
 * downstream stages (Span-Linker, Cross-Validator) can find it in either form.
 *
 * Examples:
 *   currency: 69291.8 ↔ ["69291,80", "69.291,80", "69.291,80 €", "69291.80"]
 *   date-de:  "2024-01-01" ↔ ["01.01.2024", "1.1.2024"]
 *   iban:     "DE085735103001050569 49" ↔ "DE08573510300105056949" (normalized form for checksum)
 */

/** Render a numeric value (or string-of-number) in the canonical German money form. */
export function toGermanCurrency(value: unknown): string | null {
  const n = toNumber(value);
  if (n === null) return null;
  // German format: thousands sep ".", decimal sep ",", always two decimals.
  const fixed = n.toFixed(2);
  const [intPart, decPart] = fixed.split('.');
  const withThousands = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${withThousands},${decPart}`;
}

/** Parse a (possibly German-formatted) string into a number. */
export function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  // Strip currency symbols / whitespace
  const cleaned = value.replace(/[€$£\s]/g, '');
  // Decide format: presence of a comma + dot → German (dot = thousands, comma = decimal)
  if (cleaned.includes(',')) {
    const lastComma = cleaned.lastIndexOf(',');
    const lastDot = cleaned.lastIndexOf('.');
    if (lastDot < lastComma) {
      const us = cleaned.replace(/\./g, '').replace(',', '.');
      const n = Number(us);
      return isFinite(n) ? n : null;
    }
  }
  const n = Number(cleaned);
  return isFinite(n) ? n : null;
}

/** All searchable forms of a value for the given datentyp. Always returns the raw string too. */
export function searchVariants(value: unknown, datentyp: string | undefined): string[] {
  const raw = value == null ? '' : String(value);
  if (!raw) return [];
  const out = new Set<string>([raw]);
  switch (datentyp) {
    case 'currency':
    case 'GeldBetrag':
    case 'geldbetrag': {
      const n = toNumber(value);
      if (n !== null) {
        const de = toGermanCurrency(n);
        if (de) {
          out.add(de);
          out.add(de + ' €');
          out.add(de + ' EUR');
        }
        out.add(n.toFixed(2));         // 69291.80
        out.add(String(Math.round(n))); // 69292 (rounded — for "no-cent" fields)
        // Without thousands separator
        const noThou = de?.replace(/\./g, '');
        if (noThou) out.add(noThou);
        // German integer with thousands but no comma (for "ohne Cent"-Felder)
        const intDe = String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
        out.add(intDe);
      }
      break;
    }
    case 'date':
    case 'date-iso':
    case 'date-de':
    case 'Datum': {
      // Accept "2024-01-01" or "01.01.2024"; emit both.
      const iso = parseToIso(raw);
      if (iso) {
        const [y, m, d] = iso.split('-');
        out.add(iso);
        out.add(`${parseInt(d, 10)}.${parseInt(m, 10)}.${y}`);  // "1.1.2024"
        out.add(`${d}.${m}.${y}`);                              // "01.01.2024"
      }
      break;
    }
    case 'iban':
    case 'IBAN': {
      // Compact (no whitespace) is the canonical form; also try grouped-4 form.
      const compact = raw.replace(/\s+/g, '').toUpperCase();
      out.add(compact);
      // 4-digit groups: DE08 5735 1030 0105 0569 49
      const grouped = compact.match(/.{1,4}/g)?.join(' ');
      if (grouped) out.add(grouped);
      break;
    }
    case 'idnr':
    case 'identifikationsnummer':
    case 'Identifikationsnummer': {
      const compact = raw.replace(/\s+/g, '');
      out.add(compact);
      // Common rendering: 4-3-4 grouping
      const m = compact.match(/^(\d{4})(\d{3})(\d{4})$/);
      if (m) out.add(`${m[1]} ${m[2]} ${m[3]}`);
      break;
    }
    case 'string':
    default: {
      // No type-specific variant beyond the raw value.
      const trimmed = raw.trim();
      if (trimmed !== raw) out.add(trimmed);
      break;
    }
  }
  return Array.from(out).filter((v) => v.length > 0);
}

function parseToIso(s: string): string | null {
  // ISO already?
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // German "dd.MM.yyyy" or "d.M.yyyy"
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}
