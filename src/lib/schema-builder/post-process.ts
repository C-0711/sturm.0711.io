/**
 * Post-OCR coercion driven by `ocrBinding`. Läuft gegen
 * `JSON.parse(response.document_annotation)`, um getypte STURM-Artefakte zu
 * erzeugen — z.B. "1.234,56" → 1234.56, "☑" → true.
 *
 * Schemavalidierung passiert in `mistral-ocr/codec.ts#validateAgainstSchema`;
 * dies hier ist der semantische Coercion-Layer.
 */

import type { BuilderField, OcrBinding } from './types.ts';

export function coerce(value: unknown, binding: OcrBinding): unknown {
  switch (binding.type) {
    case 'checkbox': {
      const truthy = binding.truthySymbols ?? ['☑', '☒', '✔', '✓', 'X', 'x', 'true', 'ja', 'Ja', 'JA'];
      const falsy = binding.falsySymbols ?? ['☐', '□', 'false', 'nein', 'Nein', 'NEIN'];
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') {
        const t = value.trim();
        if (truthy.includes(t)) return true;
        if (falsy.includes(t)) return false;
      }
      return null;
    }
    case 'amount': {
      if (typeof value === 'number') return value;
      if (typeof value !== 'string') return null;
      if (binding.locale === 'de-DE') {
        // German notation: "1.234,56" → 1234.56
        const cleaned = value.replace(/\./g, '').replace(',', '.').replace(/[^\d.\-]/g, '');
        const n = parseFloat(cleaned);
        return Number.isFinite(n) ? n : null;
      }
      const n = parseFloat(value.replace(/[^\d.\-]/g, ''));
      return Number.isFinite(n) ? n : null;
    }
    case 'iban': {
      if (typeof value !== 'string') return null;
      const stripped = value.replace(/\s+/g, '').toUpperCase();
      if (!/^[A-Z]{2}\d{2}[A-Z0-9]{1,30}$/.test(stripped)) return null;
      // Country-specific length check (DE = 22 chars).
      if (binding.country === 'DE' && stripped.length !== 22) return null;
      return stripped;
    }
    case 'tax_id': {
      // Germany: 11 digits with mod-11 checksum (Steuer-ID, not Steuernummer).
      if (typeof value !== 'string') return null;
      const stripped = value.replace(/\s+/g, '');
      if (!/^\d{11}$/.test(stripped)) return null;
      return validateGermanTaxIdChecksum(stripped) ? stripped : null;
    }
    case 'elster_anlage':
      return typeof value === 'string' ? value.toUpperCase() : null;
  }
}

export function coerceTree(
  parsed: Record<string, unknown>,
  fields: BuilderField[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = parsed[f.name];
    if (raw === undefined) continue;
    if (f.kind === 'object' && f.children && raw && typeof raw === 'object' && !Array.isArray(raw)) {
      out[f.name] = coerceTree(raw as Record<string, unknown>, f.children);
    } else if (f.ocrBinding) {
      out[f.name] = coerce(raw, f.ocrBinding);
    } else {
      out[f.name] = raw;
    }
  }
  return out;
}

/**
 * Bundeszentralamt für Steuern, Steuer-IDNr Checksumme (ISO 7064 mod-11,10
 * variant — implementiert nach offiziellem Berechnungsverfahren).
 */
function validateGermanTaxIdChecksum(id: string): boolean {
  if (id.length !== 11) return false;
  let product = 10;
  for (let i = 0; i < 10; i++) {
    let sum = (Number(id[i]) + product) % 10;
    if (sum === 0) sum = 10;
    product = (sum * 2) % 11;
  }
  let check = 11 - product;
  if (check === 10) check = 0;
  return check === Number(id[10]);
}
