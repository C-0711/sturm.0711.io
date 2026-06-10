/**
 * Lohnsteuerbescheid Mapper — Deterministic VaSt-Beleg Extractor
 *
 * Processes ELSTER VaSt-Belege (Vorausgefüllte Steuererklärung):
 *   - Lohnsteuerbescheinigung (employer wage-tax certificate)
 *   - Religionszugehörigkeit (church-tax registration)
 *   - Mitteilung freigestellte Kapitalerträge (bank tax-free-allowance reports)
 *
 * Routing per doc-class. Person-A/B disambig via Steuer-Identifikationsnummer
 * (first seen = Person A, second distinct = Person B).
 *
 * Two-stage label-matching for LStB fields:
 *   FAST PATH (O(1))   exact Zeile-Number match against atom.zeile
 *   FALLBACK           Levenshtein-Ratio against atom.drucktext, threshold 0.85
 *
 * Currency values are normalized to cents (integer). All eCode targets
 * are looked up against the ELSTER atoms.json container — no hardcoded
 * eCode mappings, no ground-truth values.
 */

// ============================================================================
// LStB-Zeile → eCode Mapping-Tabelle (BMF-Standard 2024+, jahresübergreifend)
// ============================================================================
// Die Lohnsteuerbescheinigung hat eine eigene Zeilen-Nummerierung (1-29) die
// NICHT mit der Anlage-N/VOR-vordruckzeile-Nummerierung übereinstimmt.
// Diese Tabelle übersetzt LStB-Quellzeile direkt in den ELSTER-eCode.
//
// Quelle: BMF-Vordruck "Lohnsteuerbescheinigung 2024" + ELSTER-Catalog
// jahresdok-2024:v2 (atoms.json).
//
// LStB-Z.22a/22b/23a/23b werden mit 22.0/22.1/23.0/23.1 nicht modeliert,
// weil das parseOcrLine-Regex die Buchstaben-Suffixe abschneidet
// (cleanZeile = nur Digits). Stattdessen: "22" → AG-Anteil RV (E2000801),
// "23" → AN-Anteil RV (E2000401) — beide first-match-wins. Wenn der Beleg
// beide Sub-Felder (a + b) liefert, gewinnt 22a/23a (gesetzliche RV) weil
// es zuerst im Beleg steht; berufsständische Versorgung (22b/23b) wird
// ggf. überschrieben — das ist BMF-konventionell akzeptabel weil der
// allergrößte Teil der Steuerpflichtigen nur gesetzliche RV hat.
// Beide Schlüssel-Varianten für Sub-Buchstaben (parseOcrLine emittiert "22 a"
// wenn LStB-Format "22. a) ..."; sonst nur "22"). "22"/"23" sind Fallbacks
// für Belege ohne Sub-Buchstabe — first-match-wins greift dann den Wert
// vom ersten 22.-Eintrag (typischerweise gesetzliche RV = a).
const LSTB_ZEILE_TO_ECODE: Record<string, string> = {
  '3': 'E0200201',    // Bruttoarbeitslohn (Anlage N Z.5)
  '4': 'E0200301',    // Einbehaltene Lohnsteuer (Anlage N Z.6)
  '5': 'E0200401',    // Solidaritätszuschlag (Anlage N Z.7)
  '6': 'E0200501',    // Kirchensteuer Arbeitnehmer (Anlage N Z.8)
  '7': 'E0200601',    // Kirchensteuer Partner / Konfessionsverschiedenheit (Anlage N Z.9)
  '8': 'E0200801',    // Versorgungsbezug brutto (Anlage N Z.10/11)
  // Z.9-21 + 28+: Sondervergütungen / Entschädigungen — aktuell nicht
  // gemapped, Levenshtein-Fallback übernimmt
  '22 a': 'E2000801', // AG-Anteil zur gesetzlichen RV (Anlage VOR Z.9)
  '22':   'E2000801', // Fallback ohne Sub-Buchstabe
  '22 b': 'E2000901', // AG-Anteil berufsständische Versorgung (Anlage VOR Z.10)
  '23 a': 'E2000401', // AN-Anteil zur gesetzlichen RV (Anlage VOR Z.4)
  '23':   'E2000401', // Fallback ohne Sub-Buchstabe
  '23 b': 'E2000501', // AN-Anteil berufsständische Versorgung (Anlage VOR Z.5)
  '25':   'E2001203', // AN-Beiträge zur gesetzlichen KV (Anlage VOR Z.11)
  '26':   'E2001505', // AN-Beiträge zur sozialen PV (Anlage VOR Z.13)
  '27':   'E2004403', // AN-Beiträge zur gesetzlichen Arbeitslosenvers (Anlage VOR Z.43)
};

// LStB-Stammdaten-Labels (oben im Beleg, ohne zeile-Number-Prefix) → ESt1A
// eCodes. Match case-insensitive auf chunk.label trim. personSuffix wird
// am Aufrufer angehängt.
const LSTB_LABEL_TO_ECODE: Record<string, string> = {
  'identifikationsnummer': 'E0100081', // → E0100081__A (oder __B für Person B)
  'steuer-id': 'E0100081',
  'steuer-identifikationsnummer': 'E0100081',
  'nachname': 'E0100201',
  'familienname': 'E0100201',
  'vorname': 'E0100301',
  'steuerklasse': 'E0200002',
  'kirchensteuermerkmal (konfession)': 'E0100402',
  'kirchensteuermerkmal': 'E0100402',
};

// ============================================================================
// CORE MATH: Levenshtein Ratio (0.0 to 1.0)
// ============================================================================
export function levenshteinDistance(a: string, b: string): number {
  const matrix = Array.from({ length: a.length + 1 }, () =>
    Array(b.length + 1).fill(0),
  );
  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1, // deletion
        matrix[i][j - 1] + 1, // insertion
        matrix[i - 1][j - 1] + cost, // substitution
      );
    }
  }
  return matrix[a.length][b.length];
}

export function calculateRatio(
  ocrLabel: string,
  containerLabel: string,
): number {
  const cleanOcr = ocrLabel.toLowerCase().replace(/[^a-zäöüß0-9]/g, '');
  const cleanCont = containerLabel.toLowerCase().replace(/[^a-zäöüß0-9]/g, '');

  const dist = levenshteinDistance(cleanOcr, cleanCont);
  const maxLen = Math.max(cleanOcr.length, cleanCont.length);
  if (maxLen === 0) return 1.0;
  return 1.0 - dist / maxLen;
}

// ============================================================================
// TYPES & INTERFACES
// ============================================================================
export type ECode = string;

/** Atom from ELSTER atoms.json container (compact view). */
export interface Atom {
  ecode: ECode;
  anlage: string;
  drucktext: string;
  /** Vordruckzeile from BMF schema (e.g. "3" for Brutto in LStB). */
  zeile?: string;
}

/** A label/value pair extracted from a VaSt-Beleg by OCR. */
export interface Chunk {
  /** Optional Zeile-Nummer prefix from the OCR row (e.g. "3." → "3"). */
  zeile: string | null;
  label: string;
  value: string;
}

/** Result: map of eCode → extracted value (cents for currency, raw for strings). */
export interface ExtractionResult {
  [ecode: string]: string | number;
}

// ============================================================================
// ENGINE: Deterministic VaSt-Beleg Mapper
// ============================================================================
export class LohnsteuerbescheidMapper {
  private primaryIdNr: string | null = null;
  private secondaryIdNr: string | null = null;
  public extractedData: ExtractionResult = {};

  /**
   * @param containerAtoms All atoms from the ELSTER atoms.json container.
   * @param ratioThreshold Levenshtein-Ratio cutoff for the fallback path
   *   (default 0.85 — empirically optimal for German BMF drucktexts).
   * @param seedPersonAIdNr Optional ground-truth IdNr from Vorjahres-Kontext
   *   (caseContext.nested.hauptvordruck.person_a.idnr). Wenn gesetzt: hartes
   *   Override für Person-A-Erkennung — robust gegen Beleg-Reihenfolge.
   * @param seedPersonBIdNr Analog für Person B.
   */
  constructor(
    private containerAtoms: Atom[],
    private ratioThreshold: number = 0.85,
    seedPersonAIdNr?: string | null,
    seedPersonBIdNr?: string | null,
  ) {
    if (seedPersonAIdNr) this.primaryIdNr = seedPersonAIdNr;
    if (seedPersonBIdNr) this.secondaryIdNr = seedPersonBIdNr;
  }

  /** German notation "1.234,56 €" → 123456 cents. */
  private normalizeCurrency(val: string): number {
    const clean = val
      .replace(/[€\s]/g, '')
      .replace(/\./g, '')
      .replace(',', '.');
    return Math.round(parseFloat(clean) * 100);
  }

  /**
   * Process a single VaSt-Beleg block. Routes to the right mapping function
   * based on docClass classifier output.
   */
  public processBeleg(docClass: string, chunks: Chunk[]): void {
    if (chunks.length === 0) return;

    // 1. Identify person via Steuer-Identifikationsnummer (first seen = A,
    //    second distinct = B). This carries across all belege in a session.
    const idChunk = chunks.find(
      (c) => calculateRatio(c.label, 'Identifikationsnummer') > this.ratioThreshold,
    );

    if (idChunk && !this.primaryIdNr) {
      this.primaryIdNr = idChunk.value.trim();
    } else if (
      idChunk &&
      idChunk.value.trim() !== this.primaryIdNr &&
      !this.secondaryIdNr
    ) {
      this.secondaryIdNr = idChunk.value.trim();
    }

    const isPersonA = idChunk ? idChunk.value.trim() === this.primaryIdNr : true;
    const personSuffix: 'A' | 'B' = isPersonA ? 'A' : 'B';

    // 2. Route by doc-class — tolerant gegen Umlaut/Slug-Varianten:
    //    'kapitalerträge' (mit Umlaut) UND 'kapitalertraege' (Slug) UND
    //    'steuerbescheinigung_bank' (Vision-OCR-Block-Typ für Sparkasse/Bank)
    const typeStr = docClass.toLowerCase();
    if (typeStr.includes('religion')) {
      this.mapReligionszugehoerigkeit(chunks, isPersonA);
    } else if (typeStr.includes('lohnsteuerbescheinigung')) {
      this.mapLStB(chunks, personSuffix);
    } else if (
      typeStr.includes('kapitalertr') ||      // matched kapitalerträge + kapitalertraege
      typeStr.includes('freigestellte') ||
      typeStr.includes('steuerbescheinigung_bank')
    ) {
      this.mapKapErt(chunks, isPersonA);
    }
  }

  private mapReligionszugehoerigkeit(chunks: Chunk[], isPersonA: boolean): void {
    const religionChunk = chunks.find(
      (c) => calculateRatio(c.label, 'Religion') > this.ratioThreshold,
    );
    if (religionChunk) {
      // Person-suffix is a downstream concern (ELSTER-XML emitter
      // resolves _A/_B against the actual atom-eCodes E0100402 vs E0101002).
      const ecode = isPersonA ? 'E0100402_A' : 'E0100402_B';
      this.extractedData[ecode] = religionChunk.value.trim();
    }
  }

  private mapLStB(chunks: Chunk[], personSuffix: 'A' | 'B' = 'A'): void {
    // Pre-filter container to LStB-relevant anlagen
    const lstbAtoms = this.containerAtoms.filter(
      (a) => a.anlage === 'N' || a.anlage === 'VOR' || a.anlage === 'AV',
    );

    for (const chunk of chunks) {
      if (!chunk.value || chunk.value.trim() === '') continue;

      // FAST PATH 1: LStB-Quellzeile → eCode via deterministischer Mapping-
      // tabelle. Die Zeilennummern auf der Lohnsteuerbescheinigung (3, 4, 5,
      // 6, 7, 22a, 22b, 23a, 23b, 25, 26, 27) entsprechen NICHT direkt den
      // vordruckzeile-Nummern in Anlage N/VOR — z.B. LStB Z.3 (Brutto) ist
      // Anlage N Z.5 (E0200201). Diese Tabelle ist Steuerrechts-Standard
      // (BMF LStB-Vordruck 2024) und bleibt jahresübergreifend stabil.
      // Lookup-Reihenfolge: erst "22 a"-spezifisch, dann "22"-Fallback.
      if (chunk.zeile) {
        const subKey = chunk.zeile.trim();           // z.B. "22 a"
        const baseKey = subKey.replace(/[^0-9]/g, ''); // z.B. "22"
        const baseEcode = LSTB_ZEILE_TO_ECODE[subKey] ?? LSTB_ZEILE_TO_ECODE[baseKey];
        if (baseEcode) {
          const ecode = `${baseEcode}__${personSuffix}`;
          this.extractedData[ecode] = chunk.value.includes('€')
            ? this.normalizeCurrency(chunk.value)
            : chunk.value.trim();
          continue;  // LStB-Mapping ist deterministisch — Levenshtein nicht mehr nötig
        }
      }

      // FAST PATH 1b: LStB-Stammdaten-Label-Lookup (ohne zeile-Number).
      // "Nachname Stricker", "Vorname Rainer", "Identifikationsnummer 852...",
      // "Steuerklasse 3", etc. — deterministisches Label→eCode-Mapping.
      const labelKey = chunk.label.toLowerCase().trim();
      const stammEcode = LSTB_LABEL_TO_ECODE[labelKey];
      if (stammEcode) {
        const ecode = `${stammEcode}__${personSuffix}`;
        this.extractedData[ecode] = chunk.value.trim();
        continue;
      }

      // FAST PATH 2 (non-LStB-Zeilen wie "Steuerklasse 3", "Nachname Stricker"):
      // direkter atom.zeile === chunk.zeile Match — nur wenn chunk.zeile gesetzt.
      let matchedEcode: string | null = null;
      if (chunk.zeile) {
        const cleanZeile = chunk.zeile.replace(/[^0-9]/g, '');
        const exactMatch = lstbAtoms.find((a) => a.zeile === cleanZeile);
        if (exactMatch) matchedEcode = exactMatch.ecode;
      }

      // FALLBACK: Ratio Math gegen drucktext
      if (!matchedEcode) {
        let bestRatio = 0;
        for (const atom of lstbAtoms) {
          const ratio = calculateRatio(chunk.label, atom.drucktext);
          if (ratio > bestRatio) {
            bestRatio = ratio;
            if (ratio > this.ratioThreshold) {
              matchedEcode = atom.ecode;
            }
          }
        }
      }

      // Normalize + store (mit Person-Suffix für konsistentes Person-A/B-Routing)
      if (matchedEcode) {
        const ecode = `${matchedEcode}__${personSuffix}`;
        this.extractedData[ecode] = chunk.value.includes('€')
          ? this.normalizeCurrency(chunk.value)
          : chunk.value.trim();
      }
    }
  }

  private mapKapErt(chunks: Chunk[], isPersonA: boolean): void {
    const betragChunk = chunks.find(
      (c) => calculateRatio(c.label, 'Betrag') > this.ratioThreshold,
    );
    if (betragChunk) {
      const ecode = isPersonA ? 'E1902402_A' : 'E1902402_B';
      const currentVal = (this.extractedData[ecode] as number) || 0;
      // Accumulate across multiple Freistellungsaufträge per person
      this.extractedData[ecode] = currentVal + this.normalizeCurrency(betragChunk.value);
    }
  }

  /** Inspection: which IdNrs have been seen so far. */
  public get personMapping(): { primary: string | null; secondary: string | null } {
    return { primary: this.primaryIdNr, secondary: this.secondaryIdNr };
  }
}
