/**
 * Per-value validation + datentyp coercion.
 *
 * Used by the cascade to coerce free-form KPI values ("12.345,67 €") into
 * canonical-typed values (12345.67) and by the validator-stage to check
 * format-regex and basic constraints.
 */
import type { ElsterFieldEntry } from './elster-katalog.ts';
import type { CanonicalValue } from '../../../lib/canonical-layer.ts';

export type Datentyp = ElsterFieldEntry['datentyp'];

const RX_GERMAN_NUMBER = /^[+-]?\s*\d{1,3}(\.\d{3})*(,\d+)?$|^[+-]?\s*\d+(,\d+)?$/;
const RX_ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RX_GERMAN_DATE = /^(\d{1,2})[.](\d{1,2})[.](\d{2,4})$/;

export function coerceValue(raw: unknown, datentyp: Datentyp): CanonicalValue {
  if (raw === null || raw === undefined) return null;
  switch (datentyp) {
    case 'string':
      return typeof raw === 'string' ? raw : String(raw);
    case 'integer': {
      const n = parseGermanNumber(String(raw));
      if (n === null) return String(raw);
      return Math.round(n);
    }
    case 'currency': {
      const n = parseGermanNumber(String(raw));
      return n === null ? String(raw) : n;
    }
    case 'date':
      return parseDateToIso(String(raw)) ?? String(raw);
    case 'boolean':
      return parseBoolean(raw);
    default:
      return typeof raw === 'string' ? raw : String(raw);
  }
}

function parseGermanNumber(s: string): number | null {
  const trimmed = String(s).replace(/[€$\s]/g, '').trim();
  if (!trimmed) return null;
  if (!RX_GERMAN_NUMBER.test(trimmed)) {
    // Fall back to "treat as JS number"
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  // Strip thousands-dots, replace decimal comma with dot
  const normalized = trimmed.replace(/\./g, '').replace(',', '.');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function parseDateToIso(s: string): string | null {
  const t = s.trim();
  if (RX_ISO_DATE.test(t)) return t;
  const m = RX_GERMAN_DATE.exec(t);
  if (!m) return null;
  let year = parseInt(m[3], 10);
  if (year < 100) year += year < 50 ? 2000 : 1900;
  const month = m[2].padStart(2, '0');
  const day = m[1].padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseBoolean(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  const s = String(raw).trim().toLowerCase();
  if (['ja', 'yes', 'true', '1', 'x', 'angekreuzt', 'angegeben'].includes(s)) return true;
  if (['nein', 'no', 'false', '0', '', 'nicht angegeben'].includes(s)) return false;
  return Boolean(s);
}

// ─────────────────────────────────────────────────────────────────────────────
// Field-level validation against catalog metadata
// ─────────────────────────────────────────────────────────────────────────────

export interface ValidationResult {
  pass: boolean;
  errors: string[];
}

export function validateValue(
  value: CanonicalValue,
  field: ElsterFieldEntry,
): ValidationResult {
  const errors: string[] = [];
  if (value === null || value === undefined) {
    if (field.pflicht) errors.push(`${field.eCode}: Pflichtfeld leer`);
    return { pass: errors.length === 0, errors };
  }
  // Length checks for strings
  if (typeof value === 'string') {
    if (field.minLaenge !== null && value.length < field.minLaenge) {
      errors.push(`${field.eCode}: minLaenge ${field.minLaenge} verletzt (${value.length})`);
    }
    if (field.maxLaenge !== null && value.length > field.maxLaenge) {
      errors.push(`${field.eCode}: maxLaenge ${field.maxLaenge} verletzt (${value.length})`);
    }
    // Format-regex check (only if catalog supplied one)
    if (field.formatRegex) {
      try {
        const re = new RegExp(field.formatRegex);
        if (!re.test(value)) {
          errors.push(`${field.eCode}: formatRegex verletzt`);
        }
      } catch {
        // bad regex in catalog — ignore
      }
    }
  }
  return { pass: errors.length === 0, errors };
}
