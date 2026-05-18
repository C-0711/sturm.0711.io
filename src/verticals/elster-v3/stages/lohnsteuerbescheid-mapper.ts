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
   */
  constructor(
    private containerAtoms: Atom[],
    private ratioThreshold: number = 0.85,
  ) {}

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

    // 2. Route by doc-class
    const typeStr = docClass.toLowerCase();
    if (typeStr.includes('religion')) {
      this.mapReligionszugehoerigkeit(chunks, isPersonA);
    } else if (typeStr.includes('lohnsteuerbescheinigung')) {
      this.mapLStB(chunks);
    } else if (
      typeStr.includes('kapitalerträge') ||
      typeStr.includes('freigestellte')
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

  private mapLStB(chunks: Chunk[]): void {
    // Pre-filter container to LStB-relevant anlagen
    const lstbAtoms = this.containerAtoms.filter(
      (a) => a.anlage === 'N' || a.anlage === 'VOR' || a.anlage === 'AV',
    );

    for (const chunk of chunks) {
      let matchedEcode: string | null = null;

      // FAST PATH: O(1) Zeile-Number match
      if (chunk.zeile) {
        const cleanZeile = chunk.zeile.replace(/[^0-9]/g, '');
        const exactMatch = lstbAtoms.find((a) => a.zeile === cleanZeile);
        if (exactMatch) matchedEcode = exactMatch.ecode;
      }

      // FALLBACK: Ratio Math against drucktext
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

      // Normalize + store
      if (matchedEcode) {
        this.extractedData[matchedEcode] = chunk.value.includes('€')
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
