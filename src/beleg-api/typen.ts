/**
 * Beleg-API — gemeinsame Typen (ELSTER-Steuerbelege).
 *
 * Pro Datei-Lauf entsteht ein `BelegResult` (eine JSON pro Datei), abgelegt im
 * Fall-Ordner. Sind alle Belege eines Falls durch, aggregiert der Master-Case
 * (`MasterCase`) Personen/Jahre/elsterWerte + Vergleich + fehlende Belege.
 *
 * Kette: BelegResult → dokumente[] → positionen[]; jede Position trägt
 *        bezeichnung · anlage/zeile · wert · e_code · kennzahl · datentyp.
 */
import type { Datentyp } from './datentyp.ts';

/** Eingangsart, abgeleitet aus Datei-Endung / Inhalt. */
export type Quellart = 'pdf' | 'bild' | 'text';

/** Verarbeitungsmodus im Beleg-Result. */
export type Modus = 'text-pdf' | 'scan-pdf' | 'bild' | 'text';

// ─── Position — der Kern (eine ELSTER-Wert-Zeile) ─────────────────────────

export interface Position {
  bezeichnung: string;                 // wie im Beleg gelesen (Kurator)
  anlage: string | null;               // aufgelöst (Katalog), z. B. "Anlage KAP"
  zeile: string | null;                // z. B. "Zeile 7"
  wert: number | string | boolean | null; // typgerecht (datentyp-coerced)
  e_code: string | null;               // ELSTER-Code (SSoT)
  kennzahl: string[];                  // [Person A, Person B] o. ä.
  datentyp: Datentyp;
  elster_kennziffer: string | null;    // "Anlage KAP Zeile 7 · Kz 210/410"
  aufgeloest: 'zeile' | 'label';       // wie der e_code gefunden wurde
  resolver_score?: number;             // nur bei "label"
  unsicher: boolean;
  wert_code?: string;                  // Enum-Code (z. B. Religion), falls Enum
  // Herkunft (im flachen Spiegel angereichert):
  dokument_typ?: string;
  aussteller?: string | null;
  quelle?: string;
  // Person/Rolle (für Master-Case-Gruppierung):
  person?: string | null;
  rolle?: 'A' | 'B';
}

// ─── Dokument (1 Datei kann mehrere enthalten) ────────────────────────────

export interface Dokument {
  dokument_typ: string;
  aussteller: string | null;
  person: string | null;
  kalenderjahr: number | null;
  finanzamt: string | null;
  rolle?: 'A' | 'B';
  positionen: Position[];
}

// ─── KPI ──────────────────────────────────────────────────────────────────

export interface Kpi {
  anzahl_werte: number;
  mit_kennziffer: number;
  unsicher: number;
  tokens_pro_sek?: number;
  total_ms: number;
  warnung: boolean;
}

// ─── Beleg-Result (ein Dokument-Lauf) ─────────────────────────────────────

export interface BelegResult {
  schema: 'beleg-result/v1';
  dateiname: string;
  status: 'ok' | 'fehler' | 'leer';
  modus: Modus;
  fall: string;
  id: string;
  sha256: string;
  dokumente: Dokument[];
  positionen: Position[];              // flacher Spiegel ALLER Positionen
  kpi: Kpi;
  markdownDatei: string;
  verarbeitung: {
    engine: 'Kurator';
    ms: number;
    usage?: { input?: number; output?: number };
    erstellt: string;
    /** true → Kurator-Ergebnis kam aus dem Cache (kein erneuter Opus-Call). */
    ausCache?: boolean;
  };
}

// ─── Roh-Ausgabe des Kurators (vor Katalog-Auflösung) ─────────────────────

export interface KuratorPositionRoh {
  bezeichnung: string;
  anlage?: string | null;
  zeile?: string | null;
  kennzahl?: string | null;
  wert?: string | null;
  person?: string | null;
  rolle?: 'A' | 'B' | null;
}
export interface KuratorDokumentRoh {
  dokument_typ?: string;
  aussteller?: string | null;
  person?: string | null;
  kalenderjahr?: number | null;
  finanzamt?: string | null;
  rolle?: 'A' | 'B' | null;
  positionen?: KuratorPositionRoh[];
}
export interface KuratorRoh {
  markdown: string;
  dokumente: KuratorDokumentRoh[];
  warnung?: boolean;
  usage?: { input?: number; output?: number };
  ms: number;
}

// ─── Master-Case ──────────────────────────────────────────────────────────

export interface MasterPerson {
  rolle: 'A' | 'B';
  person_key: string;
  idnr: string | null;
  name: string | null;
  anlagen: string[];
  belege: string[];
  elsterWerte: Record<string, number | string | boolean | null>;
}
export interface MasterJahr {
  veranlagung: 'einzel' | 'zusammen';
  personen: MasterPerson[];
  /** Abgeleiteter Engine-Input (Stufe 4) für POST :12015/api/rechnen. */
  engineInput: {
    steuerjahr: number;
    elsterWerte: Record<string, number | string | boolean | null>;
  };
}
export interface VergleichZeile {
  e_code: string;
  label: string;
  anlage: string | null;
  zeile: string | null;
  delta: number;
  status: 'geändert' | 'neu' | 'entfallen' | 'gleich';
  // dynamische Jahr-Keys, z. B. "2023": 71047.0, "2024": 6565.26
  [jahr: `${number}`]: number | string | null;
}
export interface FehlenderBeleg {
  beleg: string;
  fehlt_in: string;
  vorhanden_in: string;
}
export interface MasterCase {
  fall: string;
  erzeugt: string;
  jahre: Record<string, MasterJahr>;
  vergleich: VergleichZeile[];
  fehlende_belege: FehlenderBeleg[];
  _datei: string;
}

// ─── Job + Fehler ──────────────────────────────────────────────────────────

/** Ein Verarbeitungs-Job, vom Wächter oder HTTP-Intake erzeugt. */
export interface BelegJob {
  /** Pfad der geclaimten Datei im verarbeitung/-Ordner. */
  claimPfad: string;
  /** Ursprünglicher Dateiname (für Output-Benennung + Result). */
  originalname: string;
  /** Fall-Zuordnung (Unterordner-Name oder Default). */
  fall: string;
}

/** Strukturierter Verarbeitungsfehler (landet als `<id>.fehler.json`). */
export class BelegFehler extends Error {
  constructor(
    public code:
      | 'nicht_unterstuetzt'
      | 'zu_gross'
      | 'leer'
      | 'kurator_fehler'
      | 'unbekannt',
    message: string,
  ) {
    super(message);
    this.name = 'BelegFehler';
  }
}
