/**
 * Deutscher EUR-Number-Parser.
 *
 * Format-Annahmen aus echten ELSTER-Belegen:
 *   "1.781,98"       → 1781.98
 *   "772,68 EUR"     → 772.68
 *   "−2.960,00 €"    → -2960.00
 *   "2.238,60"       → 2238.60
 *   "456,62 EUR"     → 456.62
 *
 * Sicherheitsregeln (gegen False-Positives auf Identifikationsnummern):
 *   • Komma als Dezimaltrenner ist PFLICHT (verhindert dass IdNr "57438590613"
 *     als 57438590613.0 missinterpretiert wird).
 *   • Maximal 9 Vorkommastellen (BMF-Spec: GeldBetragOhneCent erlaubt 5 Vorkomma,
 *     mit Cent 7 — wir geben uns puffer fuer Cent-Faelle mit 9 Vorkomma).
 *   • Tausender-Punkt-Validierung: jeder Punkt muss von 3 Ziffern gefolgt sein,
 *     bevor Komma kommt. "1.78,12" ist ungueltig (kein Tausenderpunkt nach 2 Ziffern).
 *   • Reject: nackte Zahlen ohne Komma (das sind keine Geldbetraege im deutschen Format).
 */

const NEG_PREFIXES = new Set(['-', '−', '–', '—']);

/** Streng deutscher EUR-Pattern. */
const EUR_PATTERN = /([−–—-]?)\s*(\d{1,3}(?:\.\d{3})*|\d{1,9})\s*,\s*(\d{2})\s*(?:€|EUR\b)?/g;

export interface EurMatch {
  value: number;
  /** [start, endExclusive] in der originalen Section. */
  span: [number, number];
  /** Roher Match-String (z.B. "1.781,98 €"). */
  raw: string;
}

/**
 * Findet alle EUR-Werte in einem Section-Text — sortiert nach Position.
 */
export function findEurValues(text: string): EurMatch[] {
  const matches: EurMatch[] = [];
  // Reset state (regex has /g flag).
  EUR_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EUR_PATTERN.exec(text)) !== null) {
    const [full, signStr, intStr, decStr] = m;
    const intDigits = intStr.replace(/\./g, '');
    if (intDigits.length > 9) continue; // zu lang, vermutlich keine Geldsumme

    // Tausender-Punkt-Validierung: wenn Punkt vorhanden, muss jeder Punkt
    // genau 3 Ziffern folgen (bis zum Komma). Format wie "1.78,12" wird hier
    // technisch nicht gematched weil EUR_PATTERN \d{1,3}(\.\d{3})* erzwingt.
    if (intStr.includes('.')) {
      const segs = intStr.split('.');
      const lead = segs[0];
      const tail = segs.slice(1);
      if (lead.length < 1 || lead.length > 3) continue;
      if (tail.some((s) => s.length !== 3)) continue;
    }

    const sign = NEG_PREFIXES.has(signStr) ? -1 : 1;
    const value = sign * (parseInt(intDigits, 10) + parseInt(decStr, 10) / 100);
    matches.push({
      value,
      span: [m.index, m.index + full.length],
      raw: full.trim(),
    });
  }
  return matches;
}

/**
 * Convenience: erster EUR-Wert in einer Section, oder null.
 * Bevorzugt sind Werte die direkt nach einer Spalte/Wert-Indikator stehen
 * — aber wir machen das hier NICHT smart: Anforderung war "erster EUR".
 * Wenn das nicht reicht, eskaliert der Beleg in Tier-3.
 */
export function firstEurInSection(text: string): EurMatch | null {
  const all = findEurValues(text);
  return all.length > 0 ? all[0] : null;
}

/**
 * ELSTER-Rundungsregel:
 *   - Einnahmen (income)      → IMMER aufrunden (sogar 1781,01 → 1782)
 *   - Ausgaben (expense)      → IMMER abrunden (sogar 1781,99 → 1781)
 *   - Anrechnungen (tax-credit) → konservativ wie Einnahmen (aufrunden)
 *
 * Hintergrund: ELSTER `formatRegex` fuer GeldBeitraege ist `\d{1,5}` oder `\d{1,6}`
 * - Integer-only, kein Komma. Vor Submission wird die OCR-Cent-Genauigkeit
 * auf Euro reduziert. Wir runden so dass der Steuerpflichtige IMMER
 * mindestens den deklarierten Betrag zahlt (= Finanzamt wird nie unterzahlt).
 */
export type ElsterRole = 'income' | 'expense' | 'tax-credit';

export function roundForElster(value: number, role: ElsterRole): number {
  switch (role) {
    case 'income':
    case 'tax-credit':
      return Math.ceil(value);
    case 'expense':
      return Math.floor(value);
  }
}

/**
 * Einzelne EUR-String parsen (z.B. fuer Test-Eingaben). null wenn invalid.
 */
export function parseEurString(s: string): number | null {
  const trimmed = s.trim();
  const all = findEurValues(trimmed);
  if (all.length !== 1) return null;
  if (all[0].span[0] !== 0 || all[0].span[1] !== trimmed.length) {
    // String muss VOLLSTAENDIG ein EUR-Match sein, kein Pre/Postfix.
    return null;
  }
  return all[0].value;
}
