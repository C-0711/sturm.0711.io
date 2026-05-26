/**
 * field-mapper — Label-Wert-Extraktion aus OCR-Text
 *
 * VaSt-Belege haben sehr konsistentes Layout: pro Zeile entweder
 *   "Feldname     Wert"  (Tabellenform)
 * oder
 *   "Feldname\nWert"     (vertikal gestapelt)
 *
 * Diese Extraktion ist deterministisch — kein LLM. Sie produziert ein
 * Label→Wert-Dictionary, das anschließend gegen das BelegSchema gematcht
 * wird.
 */

/** Normalisiert ein Label für robusten Vergleich (Case + Whitespace + Umlaute). */
export function normalizeLabel(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .replace(/[„"”']/g, '')
    .trim();
}

/** Trennzeichen, das in VaSt-PDFs zwischen Label und Wert vorkommt. */
const LABEL_VALUE_SEP_RE = /^([^\d\n][^\n]+?)\s{2,}([\d\S].*)$/;

/**
 * Zerlegt OCR-Output in ein Label→Wert-Dictionary.
 *
 * Strategien (in Reihenfolge):
 *   1. Eine Zeile = "Label  Wert" (≥2 Leerzeichen als Separator)
 *   2. Zwei aufeinanderfolgende Zeilen = "Label\nWert" wenn die zweite Zeile
 *      typisch numerisch / kurzes Datum / Enum-Wert ist
 *   3. Mehrfach-Vorkommen werden als Array zurückgegeben (z.B. mehrere
 *      Beitragsdaten-Blöcke in VaSt_KRV)
 */
/**
 * Strippt LStB-Zeilen-Nummerierung-Präfixe wie "3.     " oder " 22. a) ".
 * In ELSTER-Sammel-VAST-PDFs sind die LStB-Felder mit ihrer
 * Vordruck-Zeilen-Nummer + ggf. Sub-Punkt versehen:
 *   "3.     Bruttoarbeitslohn..."     → "Bruttoarbeitslohn..."
 *   "22.    a) Arbeitgeberanteil..."  → "a) Arbeitgeberanteil..."
 * Damit greift LABEL_VALUE_SEP_RE (das ein nicht-Ziffer-Erstzeichen
 * erwartet) wieder.
 */
const LINE_PREFIX_RE = /^\s*\d{1,3}\.\s+/;
function stripLinePrefix(line: string): string {
  return line.replace(LINE_PREFIX_RE, '');
}

export function extractLabelValues(rawText: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    // LStB-Vordruckzeilen-Präfix wie "3.     " → entfernen, damit Strategy 1
    // matched. Wir behalten rawLine für die "Strategie 2"-Heuristik.
    const line = stripLinePrefix(rawLine);

    // Strategie 1: "Label  Wert" auf einer Zeile (≥2 Leerzeichen Trenner)
    const m1 = line.match(LABEL_VALUE_SEP_RE);
    if (m1) {
      const label = m1[1].trim();
      const wert = m1[2].trim();
      // skip header-/footer-Zeilen
      if (!isHeaderFooter(label) && !isHeaderFooter(wert)) {
        push(result, label, wert);
        continue;
      }
    }

    // Strategie 2: aktueller line = Label, nächster line = Wert.
    // Wichtig: nächste Zeile darf nicht SELBST ein "Label  Wert"-Paar sein,
    // sonst frisst Strategy 2 fälschlich strukturierte Folge-Zeilen.
    if (
      i + 1 < lines.length &&
      looksLikeLabel(line) &&
      !LABEL_VALUE_SEP_RE.test(lines[i + 1]) &&
      looksLikeValue(lines[i + 1])
    ) {
      push(result, line, lines[i + 1].trim());
      i += 1;
      continue;
    }
  }

  return result;
}

function push(d: Record<string, string[]>, label: string, value: string): void {
  const key = normalizeLabel(label);
  if (!d[key]) d[key] = [];
  d[key].push(value);
}

const HEADER_FOOTER_RE =
  /^(Transferticket|Abfragedatum|Veranlagungszeitraum|Seite\s+\d|Identifikationsnummer:\s+\d|Bitte beachten Sie|Es handelt sich)/i;

function isHeaderFooter(s: string): boolean {
  return HEADER_FOOTER_RE.test(s.trim());
}

function looksLikeLabel(s: string): boolean {
  const t = s.trim();
  if (t.length < 3 || t.length > 200) return false;
  if (/^[\d.,\s€%-]+$/.test(t)) return false;          // pure Zahl
  if (/^\d{1,2}\.\d{1,2}\.\d{2,4}$/.test(t)) return false; // Datum
  if (HEADER_FOOTER_RE.test(t)) return false;
  // muss mit Buchstabe beginnen
  return /^[A-ZÄÖÜa-zäöü]/.test(t);
}

function looksLikeValue(s: string): boolean {
  const t = s.trim();
  if (t.length === 0 || t.length > 120) return false;
  // typische Werttypen
  return (
    /^-?\d[\d.,]*$/.test(t) ||                          // Zahl (auch mit Tausender-/Komma)
    /^\d{1,2}\.\d{1,2}\.\d{2,4}$/.test(t) ||           // Datum
    /^\d{1,2}\.\d{2,4}$/.test(t) ||                    // MM.JJJJ
    /^\d{4}$/.test(t) ||                                // Jahr
    /^\d{2}$/.test(t) ||                                // Monat
    /^[A-Z]{2}\d{2}\s?\d{4}.+/.test(t) ||              // IBAN
    /^\d{2}\s?\d{3}\s?\d{3}\s?\d{3}$/.test(t) ||       // IdNr mit Spaces
    /^(Evangelisch|R[oö]misch[- ]?katholisch|EUR|Ja|Nein|X|[0-9])$/i.test(t) ||
    /^[A-ZÄÖÜa-zäöü][^:]{1,80}$/.test(t)               // kurzer Text als Wert (Name, Bank)
  );
}

/** Convenience: liefert den ERSTEN Wert für ein Label (oder null). */
export function getFirst(d: Record<string, string[]>, label: string): string | null {
  const key = normalizeLabel(label);
  const arr = d[key];
  return arr && arr.length > 0 ? arr[0] : null;
}

/** Convenience: liefert ALLE Werte für ein Label (für Mehrfach-Blöcke). */
export function getAll(d: Record<string, string[]>, label: string): string[] {
  const key = normalizeLabel(label);
  return d[key] ?? [];
}
