/**
 * src/schemas/v1/types — kanonische v1-Vertrags-Typen, faithful zu den
 * JSON-Schemas in diesem Verzeichnis (Quelle: 0711-services/schemas/v1,
 * via engine-bundle 2026-06-10; identisch zum sturm-gateway/contract auf polar).
 *
 * Nicht hier ändern, ohne die Schemas (und das Gateway) mitzuziehen —
 * Breaking Changes laufen als v2 (siehe SCHEMAS-README.md).
 */

/** Ein ELSTER-Wert (Geld/Zahl/Bool/Text/Datum) oder leer. */
export type ElsterWert = number | string | boolean | null;

/** e_code → Wert. Person B trägt `__B`-Suffix im `engineInput`. */
export type ElsterWerte = Record<string, ElsterWert>;

/** position.schema.json */
export interface Position {
  bezeichnung: string;
  anlage: string | null;
  zeile: string | null;
  wert: ElsterWert;
  e_code: string | null;
  elster_kennziffer: string | null;
  kennzahl: string[];
  datentyp: string;
  aufgeloest?: string;
  resolver_score?: number;
  unsicher?: boolean;
  wert_code?: string;
  person_key: string | null;
  quelle_beleg_id: string | null;
}

/** beleg.schema.json */
export interface Beleg {
  beleg_id: string;
  dateiname: string | null;
  sha256: string | null;
  dokument_typ: string;
  aussteller: string | null;
  person_key: string;
  kalenderjahr: number | null;
  status?: string;
  positionen?: Position[];
  verarbeitung?: { engine?: string; ms?: number; erstellt?: string };
}

/** person.schema.json — Stammdaten (zeitlich konstant) */
export interface Person {
  rolle: string;
  person_key: string;
  idnr: string | null;
  name: string | null;
  vorname?: string | null;
  nachname?: string | null;
  geburtsdatum?: string | null;
  beruf?: string | null;
  anschrift_abweichend?: Record<string, unknown> | null;
}

/** profil.schema.json */
export interface Profil {
  haushalt: {
    veranlagung?: string;
    verheiratet?: boolean;
    verheiratet_seit?: string | null;
    verwitwet_seit?: string | null;
    finanzamt?: string | null;
    steuernummer?: string | null;
    bundesland?: string | null;
    adresse?: unknown;
    iban?: string | null;
    bic?: string | null;
  };
  personen: Person[];
  religion?: { person_a?: string | null; person_b?: string | null };
  metadaten?: Record<string, unknown>;
}

/** jahresperson.schema.json — Person-Jahres-Schnitt */
export interface JahresPerson {
  person_key: string;
  rolle?: string;
  idnr?: string | null;
  name?: string | null;
  anlagen?: string[];
  belege?: string[];
  elsterWerte: ElsterWerte;
}

/** Engine-Input für bmf-api POST :12015/api/rechnen. */
export interface EngineInput {
  steuerjahr: number;
  elsterWerte: ElsterWerte;
}

/** jahresblock.schema.json — pro Veranlagungsjahr */
export interface Jahresblock {
  veranlagung?: string;
  personen: JahresPerson[];
  engineInput: EngineInput;
}

/** vergleichzeile.schema.json — Multi-Jahr-Vergleich.
 *  (Instanzen tragen zusätzlich dynamische Jahres-Keys `"2023"`/`"2024"`: number —
 *   im JSON-Schema als patternProperties `^(19|20|21)\d{2}$` modelliert.) */
export interface VergleichZeile {
  e_code: string;
  label: string;
  anlage: string | null;
  zeile: string | null;
  delta: number;
  status: string;
}

export interface FehlenderBeleg {
  beleg: string;
  fehlt_in: string;
  vorhanden_in: string;
}

/** Endwerte aus bmf-api. */
export interface Endwerte {
  zve?: number;
  einkommensteuer?: number;
  solidaritaetszuschlag?: number;
  kirchensteuer?: number;
  erstattung?: number;
  nachzahlung?: number;
  [k: string]: number | undefined;
}

/** rechenergebnis.schema.json — Output von bmf-api POST /api/rechnen */
export interface RechenErgebnis {
  steuerjahr: number;
  engine?: string;
  berechnet_am?: string;
  endwerte: Endwerte;
  module_count?: number;
  formeln_gesamt?: number;
  fehler_gesamt?: number;
  module?: Array<Record<string, unknown>>;
}

/** mastercase.schema.json — Output-Snapshot eines Producers (z.B. beleg-api). */
export interface MasterCase {
  schema: string;
  fall: string;
  erzeugt?: string;
  jahre: Record<string, Jahresblock>;
  vergleich?: VergleichZeile[];
  fehlende_belege?: FehlenderBeleg[];
  _datei?: string;
  _quelle?: string;
}

/** fall.schema.json — die fachliche Klammer (Profil + Jahre + Belege). */
export interface Fall {
  schema: string;
  fall_id: string;
  erzeugt?: string;
  aktualisiert?: string;
  tenant?: string;
  profil: Profil;
  jahre: Record<string, Jahresblock>;
  belege?: Beleg[];
  vergleich?: VergleichZeile[];
  fehlende_belege?: FehlenderBeleg[];
  rechen_ergebnis?: Record<string, RechenErgebnis>;
}

/** Schema-Tags zur Laufzeit-Disambiguierung (Regel 5). */
export const SCHEMA_TAG_FALL = 'fall/v1' as const;
export const SCHEMA_TAG_MASTERCASE = 'mastercase/v1' as const;
