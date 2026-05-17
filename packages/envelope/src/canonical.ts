/**
 * RFC 8785 JSON Canonicalization Scheme (JCS) — minimal implementation.
 *
 * Deterministic serialization is the foundation of every signature in this
 * package: two services on different machines must produce the same bytes for
 * the same logical value, regardless of insertion order or string formatting.
 *
 * Covers what the 0711 platform needs (objects, arrays, strings, numbers,
 * booleans, null). Does NOT cover the full RFC 8785 number-canonicalization
 * (no NaN/Infinity, no E-notation handling beyond what JSON.stringify does).
 * Adequate for signed JSON payloads we control; replace if we ever need to
 * canonicalize untrusted floating-point.
 */

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k]))
      .join(',') +
    '}'
  );
}
