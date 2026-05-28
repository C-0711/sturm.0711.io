/**
 * field-mapper — Wert-Normalisierung
 *
 * Wandelt rohe PDF-Werte ("30.707,00 €", "57 438 590 613", "Evangelisch")
 * in ELSTER-XML-konforme Form um. ELSTER nutzt deutsches Komma als
 * Dezimaltrennzeichen — Punkt führt zu Plausi-Fehler.
 */
import type { ValueType } from './types.ts';

/**
 * Religion → ELSTER-Religionsschlüssel (Enum_Religionsschluessel_ab_VZ_2014_3).
 *
 * Schlüssel sind 2-stellige Codes wie in der XSD spezifiziert
 * (`xs:enumeration value="02"` für Evangelisch, etc.). Quelle: direkter
 * Auszug aus E10-2024.xsd / Enum_Religionsschluessel_ab_VZ_2014_3_BaseCType.
 */
const RELIGION_MAP: Record<string, string> = {
  // 11 = nicht kirchensteuerpflichtig (konfessionslos)
  'keine': '11',
  'konfessionslos': '11',
  'nicht kirchensteuerpflichtig': '11',
  '--': '11',
  // 02 = Evangelisch (alle Landeskirchen)
  'evangelisch': '02',
  'evangelische kirche': '02',
  'evangelische kirche im rheinland': '02',
  'evangelisch-lutherisch': '02',
  // 03 = Römisch-katholisch
  'römisch-katholisch': '03',
  'romisch-katholisch': '03',
  'roemisch-katholisch': '03',
  'katholisch': '03',
  'bistum trier': '03',
  // 05 = Evangelisch-reformiert
  'evangelisch-reformiert': '05',
  // 04 = Altkatholisch
  'altkatholisch': '04',
  'alt-katholisch': '04',
  // 25 = Israelitische Religionsgemeinschaft Baden
  // 19 = Jüdische Gemeinden im Landesverband Hessen
  // (Detail-Schlüsselung pro Bundesland nicht aus dem Beleg ableitbar —
  //  Wert 19 als Default für „jüdisch/israelitisch" wäre fragwürdig.
  //  Lieber leer lassen + Warning, damit User korrigieren kann.)
  // 10 = Sonstige
  'sonstige': '10',
};

/**
 * OCR-Korrektur: das deutsche Dezimal-Komma als Punkt fehlgelesen.
 *   "6.720.00" → "6.720,00"   "5.06" → "5,06"   "0.00" → "0,00"
 * Greift NUR wenn kein Komma vorhanden ist UND das Muster „…\.dd" am Ende
 * steht (optional mit Tausender-Punkten davor). Reine Tausender ohne
 * Nachkommastellen ("63.559", "1.234") bleiben unverändert.
 */
function ocrFixGermanDecimal(s: string): string {
  if (s.includes(',')) return s;
  if (/^-?\d{1,3}(?:\.\d{3})*\.\d{2}$/.test(s)) {
    const i = s.lastIndexOf('.');
    return s.slice(0, i) + ',' + s.slice(i + 1);
  }
  return s;
}

export interface NormalizeOptions {
  /** Strikter Modus: throws bei unbekannten Werten. Default: false (gibt rawValue zurück + warning). */
  strict?: boolean;
}

export interface NormalizeResult {
  wert: string;
  warnings: string[];
}

/** Hauptfunktion: roh → XML-tauglich. */
export function normalize(rawValue: string, type: ValueType, opts: NormalizeOptions = {}): NormalizeResult {
  const trimmed = (rawValue ?? '').trim();
  if (trimmed === '') return { wert: '', warnings: [] };
  const warnings: string[] = [];

  switch (type) {
    case 'string':
      return { wert: trimmed, warnings };

    case 'idnr': {
      const digits = trimmed.replace(/\s+/g, '');
      if (!/^\d{11}$/.test(digits)) {
        warnings.push(`idnr: erwarte 11 Ziffern, bekam "${trimmed}"`);
        if (opts.strict) throw new Error(warnings[0]);
      }
      return { wert: digits, warnings };
    }

    case 'int_euro': {
      // "30.707,00 €" / "30.707,00" / "30707" → "30707"
      let s = ocrFixGermanDecimal(trimmed.replace(/\s|€|EUR/gi, ''));
      // Komma + 2 Dezimalstellen abschneiden (ELSTER rundet kaufmännisch)
      const m = s.match(/^(-?)([\d.]+)(?:,(\d{1,2}))?$/);
      if (!m) {
        warnings.push(`int_euro: konnte "${trimmed}" nicht parsen`);
        return { wert: trimmed, warnings };
      }
      const sign = m[1];
      const intPart = m[2].replace(/\./g, ''); // Tausender-Punkte weg
      const cents = m[3] ?? '00';
      // kaufmännisch runden
      const rounded = Math.round(Number(intPart + '.' + cents.padEnd(2, '0')));
      return { wert: sign + String(rounded), warnings };
    }

    case 'decimal_eur_cent': {
      // "2.960,00 €" → "2960,00"
      let s = ocrFixGermanDecimal(trimmed.replace(/\s|€|EUR/gi, ''));
      const m = s.match(/^(-?)([\d.]+)(?:,(\d{1,2}))?$/);
      if (!m) {
        warnings.push(`decimal_eur_cent: konnte "${trimmed}" nicht parsen`);
        return { wert: trimmed, warnings };
      }
      const sign = m[1];
      const intPart = m[2].replace(/\./g, '');
      const cents = (m[3] ?? '00').padEnd(2, '0').substring(0, 2);
      return { wert: `${sign}${intPart},${cents}`, warnings };
    }

    case 'date_TTMMJJJJ': {
      // "24.11.1935" → behalten; "1935-11-24" → konvertieren
      if (/^\d{2}\.\d{2}\.\d{4}$/.test(trimmed)) return { wert: trimmed, warnings };
      const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (iso) return { wert: `${iso[3]}.${iso[2]}.${iso[1]}`, warnings };
      warnings.push(`date_TTMMJJJJ: konnte "${trimmed}" nicht parsen`);
      return { wert: trimmed, warnings };
    }

    case 'year_JJJJ': {
      const m = trimmed.match(/\b(19\d{2}|20\d{2})\b/);
      if (m) return { wert: m[1], warnings };
      warnings.push(`year_JJJJ: kein 4-stelliges Jahr in "${trimmed}"`);
      return { wert: trimmed, warnings };
    }

    case 'month_MM': {
      const m = trimmed.match(/^(\d{1,2})$/);
      if (m) return { wert: m[1].padStart(2, '0'), warnings };
      warnings.push(`month_MM: erwarte 1-12, bekam "${trimmed}"`);
      return { wert: trimmed, warnings };
    }

    case 'bool_ja1': {
      const t = trimmed.toLowerCase();
      if (['x', 'ja', 'true', '1'].includes(t)) return { wert: '1', warnings };
      if (['', 'nein', 'false', '0'].includes(t)) return { wert: '', warnings };
      warnings.push(`bool_ja1: unklarer Boolean-Wert "${trimmed}"`);
      return { wert: '', warnings };
    }

    case 'enum': {
      // Aktuell nur Religion gemappt — weitere Enums per Katalog-Lookup
      // (z.B. Steuerklasse passt direkt: 1..6).
      const key = trimmed.toLowerCase().normalize('NFKC');
      if (RELIGION_MAP[key]) return { wert: RELIGION_MAP[key], warnings };
      if (/^[1-6]$/.test(trimmed)) return { wert: trimmed, warnings }; // Steuerklasse
      warnings.push(`enum: keine Mapping-Regel für "${trimmed}" (Katalog-Lookup erforderlich)`);
      return { wert: trimmed, warnings };
    }

    default:
      return { wert: trimmed, warnings };
  }
}
