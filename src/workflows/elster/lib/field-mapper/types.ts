/**
 * field-mapper — Typen
 *
 * Datenstrukturen für die deterministische Beleg→E-Code-Abbildung. Quellen
 * dieser Mapping-Regeln sind die VaSt-PDF-Layouts und die Jahresdokumentation
 * (siehe scripts/elster-catalog-db/). Werte werden gegen den Katalog (DB oder
 * JSON) validiert.
 */

export type BelegTyp =
  | 'VaSt_LStB'                  // Lohnsteuerbescheinigung
  | 'VaSt_RBM'                   // Rentenbezugsmitteilung
  | 'VaSt_KRV'                   // Beitragsbescheinigung KV/PV
  | 'VaSt_RIE'                   // Riester-Bescheinigung
  | 'VaSt_RUE'                   // Basisrenten-Bescheinigung (Rürup)
  | 'VaSt_LErsL'                 // Lohnersatzleistungen
  | 'VaSt_VWL'                   // Vermögenswirksame Leistungen
  | 'VaSt_GDB'                   // Grad der Behinderung
  | 'VaSt_FSA'                   // Freistellungsauftrag (KapErt)
  | 'VaSt_Pers'                  // Stammdaten
  | 'VaSt_Religion'              // Religionszugehörigkeit
  | 'Steuerbescheinigung_Bank'   // Bank-Jahres-Steuerbescheinigung
  | 'Einkommensteuererklaerung'  // ganze ausgefüllte ELSTER-Erklärung (Druck, multi-Anlage)
  | 'Unbekannt';

export type Person = 'A' | 'B';

export type ValueType =
  | 'string'
  | 'int_euro'             // ganze € — z.B. Bruttoarbeitslohn (Anlage N)
  | 'decimal_eur_cent'     // € mit 2 NK — z.B. Lohnsteuer
  | 'idnr'                 // 11-stellig
  | 'date_TTMMJJJJ'        // 24.11.1935
  | 'year_JJJJ'            // 1995
  | 'month_MM'             // 01..12
  | 'enum'                 // Lookup gegen Katalog-Enumeration
  | 'bool_ja1';            // "X" / "Ja" → "1"

/**
 * Mapping-Regel für ein einzelnes Feld in einem Beleg-Typ.
 *
 * Beispiel: in VaSt_LStB steht "Bruttoarbeitslohn" → Anlage N, E0200201,
 * Wert ist int_euro (gerundet).
 */
export interface FieldMapping {
  /** Exaktes Label wie im PDF gedruckt (primärer Match-Key). */
  pdfLabel: string;
  /** Akzeptierte Schreibweisen / Varianten. */
  pdfLabelAliases?: string[];
  /** Ziel-Anlage (ESt1A, N, R, KAP, VOR, …). */
  anlage: string;
  /** Ziel-Element im XSD. */
  eCode: string;
  /** Werttyp für Normalisierung. */
  valueType: ValueType;
  /** Optionale Kontext-Pfad-Verfeinerung (z.B. 'VBez/Einz' wenn Versorgungs­bezug). */
  kontextSubpath?: string;
  /** Wenn der Beleg dieses Feld liefert, muss es belegt sein. */
  required?: boolean;
  /** Hinweis für mehrdeutige Belege (z.B. bAV vs. gesetzliche Rente). */
  branchHint?: string;
}

export interface BelegSchema {
  belegTyp: BelegTyp;
  /** Regex-Patterns die den Beleg-Typ am Titel erkennen. */
  titlePatterns: RegExp[];
  /** Felder mit deterministischem Mapping. */
  felder: FieldMapping[];
}

export interface BelegInput {
  /** Vom Klassifikator gesetzt; 'Unbekannt' wenn unklar (dann Best-Effort). */
  belegTyp: BelegTyp;
  /** Welcher Person der Beleg gehört. */
  person: Person;
  /** Raw OCR-Output (Mistral / Claude-Vision / pdftotext). */
  rawText: string;
  /** Optionale Provenance. */
  source?: {
    pdfPath?: string;
    pageStart?: number;
    pageEnd?: number;
    sha256?: string;
  };
}

export interface MappedField {
  eCode: string;
  anlage: string;
  kontextSubpath?: string;
  /** Normalisierter, XML-ready Wert (deutsches Komma für Dezimalzahlen). */
  wert: string;
  /** Original-Wert wie aus dem PDF gelesen. */
  rawValue: string;
  person: Person;
  pdfLabel: string;
  valueType: ValueType;
  /** 'schema' = aus BelegSchema, 'manual' = User-Eingabe. */
  method: 'schema' | 'manual';
  /** 0..1, basierend auf Match-Sicherheit. */
  confidence: number;
  warnings?: string[];
}

export interface MappingResult {
  belegTyp: BelegTyp;
  person: Person;
  felder: MappedField[];
  /** PDF-Labels die im Schema vorgesehen waren, aber im rawText nicht
   *  gefunden wurden (für HiTL-Routing). */
  missingExpected: string[];
  /** PDF-Labels die im rawText auftauchen aber im Schema unbekannt sind. */
  unmatched: Array<{ label: string; value: string }>;
  warnings: string[];
}
