/**
 * Mapping BMF-kontextPath (interne Einkunftsart-Codes) → §EStG-Klartext.
 *
 * Beispiele aus canonical_layer[eCode].kontextPath:
 *   "ArbL"                 → §19 EStG Einkünfte aus nichtselbständiger Arbeit
 *   "KapErt_inl_StAbz"     → §20 EStG Kapitalvermögen (inländisch, mit StAbz)
 *   "AVor"                 → §10a EStG Altersvorsorgeaufwendungen
 *   "Beitr_g_KV_PV_Inl"    → §10 Abs. 1 Nr. 3 EStG KV-/PV-Beiträge
 *   "KiSt"                 → §10 Abs. 1 Nr. 4 EStG Kirchensteuer
 *   "Allg"                 → ESt1A — Allgemeine Stammdaten
 *
 * Benutzt von src/ui/abrechnung.html zur Anzeige von §-Citations pro Wert.
 */

export interface EstgCitation {
  /** Kurzform für UI-Pills (z.B. "§19 EStG"). */
  short: string;
  /** Voller Klartext für Tooltip / Druckansicht. */
  full: string;
  /** Anlage-Code im ELSTER-Formular (z.B. "N", "KAP"). */
  anlage?: string;
}

/** Direkt-Mapping kontextPath → §-Citation. */
const KONTEXT_PATH_TO_CITATION: Record<string, EstgCitation> = {
  // Lohn/Anlage N
  'ArbL':                 { short: '§19 EStG',           full: '§19 EStG — Einkünfte aus nichtselbständiger Arbeit', anlage: 'N' },
  'ArbL_LStB':            { short: '§19 EStG',           full: '§19 EStG i.V.m. §41b — Lohnsteuerbescheinigung',     anlage: 'N' },
  'ArbL_LStB_1_5_Sum':    { short: '§19 EStG',           full: '§19 EStG — Brutto-Arbeitslohn lt. LStB Z.5',          anlage: 'N' },
  'Wege':                 { short: '§9 Abs. 1 Nr. 4 EStG', full: '§9 Abs. 1 Nr. 4 EStG — Entfernungspauschale',       anlage: 'N' },
  'Werbe':                { short: '§9 EStG',            full: '§9 EStG — Werbungskosten',                            anlage: 'N' },

  // Kapitalerträge / Anlage KAP
  'KapErt':               { short: '§20 EStG',           full: '§20 EStG — Einkünfte aus Kapitalvermögen',           anlage: 'KAP' },
  'KapErt_inl_StAbz':     { short: '§20 EStG',           full: '§20 EStG — Inländische Kapitalerträge mit Steuerabzug', anlage: 'KAP' },
  'KapErt_inl_oStAbz':    { short: '§20 EStG',           full: '§20 EStG — Inländische Kapitalerträge ohne Steuerabzug', anlage: 'KAP' },
  'KapErt_Ausl':          { short: '§20 EStG',           full: '§20 EStG — Ausländische Kapitalerträge',              anlage: 'KAP' },
  'Ant':                  { short: '§32d EStG',          full: '§32d EStG — Antrag Günstigerprüfung / Veranlagungswahl', anlage: 'KAP' },
  'Fam_Stift_P15_AStG':   { short: '§15 AStG',           full: '§15 AStG — Familienstiftungen',                       anlage: 'KAP' },

  // Vorsorgeaufwendungen / Anlage VOR
  'AVor':                 { short: '§10a EStG',          full: '§10a EStG — Altersvorsorgeaufwendungen',              anlage: 'VOR' },
  'Beitr_g_KV_PV_Inl':    { short: '§10 Abs. 1 Nr. 3 EStG', full: '§10 Abs. 1 Nr. 3 EStG — Kranken-/Pflegeversicherungsbeiträge inländisch', anlage: 'VOR' },
  'Beitr_BasisRente':     { short: '§10 Abs. 1 Nr. 2 EStG', full: '§10 Abs. 1 Nr. 2 EStG — Beiträge zur Basisversorgung', anlage: 'VOR' },
  'Beitr_AL_Vers':        { short: '§10 Abs. 1 Nr. 3a EStG', full: '§10 Abs. 1 Nr. 3a EStG — Arbeitslosenversicherungsbeiträge', anlage: 'VOR' },

  // Sonderausgaben / Anlage SA
  'KiSt':                 { short: '§10 Abs. 1 Nr. 4 EStG', full: '§10 Abs. 1 Nr. 4 EStG — Kirchensteuer (Sonderausgabe)', anlage: 'SA' },
  'Sonderausg':           { short: '§10 EStG',           full: '§10 EStG — Sonderausgaben',                           anlage: 'SA' },
  'SpendeMitglied':       { short: '§10b EStG',          full: '§10b EStG — Spenden und Mitgliedsbeiträge',           anlage: 'SA' },

  // Außergewöhnliche Belastungen
  'AgB':                  { short: '§33 EStG',           full: '§33 EStG — Außergewöhnliche Belastungen',             anlage: 'AgB' },
  'HA_35a':               { short: '§35a EStG',          full: '§35a EStG — Haushaltsnahe Beschäftigung/Dienstleistung', anlage: 'HA_35a' },

  // Stammdaten / Hauptvordruck ESt1A
  'Allg':                 { short: 'ESt1A',              full: 'ESt1A Hauptvordruck — Allgemeine Stammdaten',         anlage: 'ESt1A' },
  'Art_Erkl':             { short: '§25 EStG',           full: '§25 EStG — Art der Steuererklärung',                  anlage: 'ESt1A' },
  'Bankverb':             { short: '§37 AO',             full: '§37 AO — Bankverbindung für Erstattungen',            anlage: 'ESt1A' },
  'Veranl':               { short: '§26 EStG',           full: '§26 EStG — Wahl der Veranlagungsart bei Ehegatten',   anlage: 'ESt1A' },

  // Anlage R / Renten
  'Rente_gRV':            { short: '§22 Nr. 1 EStG',     full: '§22 Nr. 1 Satz 3 EStG — Leibrenten aus gesetzlicher Rentenversicherung', anlage: 'R' },
  'Rente_pPriv':          { short: '§22 Nr. 5 EStG',     full: '§22 Nr. 5 EStG — Private/betriebliche Altersvorsorge', anlage: 'R' },

  // Anlage V / Vermietung
  'Vermiet':              { short: '§21 EStG',           full: '§21 EStG — Einkünfte aus Vermietung und Verpachtung', anlage: 'V' },

  // Anlage G / Gewerbe + Anlage S / Selbständig
  'GewerbeBetrieb':       { short: '§15 EStG',           full: '§15 EStG — Einkünfte aus Gewerbebetrieb',             anlage: 'G' },
  'Selbst':               { short: '§18 EStG',           full: '§18 EStG — Einkünfte aus selbständiger Arbeit',       anlage: 'S' },

  // Kinder
  'Kind':                 { short: '§32 EStG',           full: '§32 EStG — Berücksichtigung von Kindern',             anlage: 'Kind' },
};

/** Look up citation by kontextPath. Fällt auf eine generische Citation
 *  zurück wenn der Code unbekannt ist, statt undefined. */
export function citationFor(kontextPath: string | null | undefined, anlage?: string): EstgCitation {
  if (!kontextPath) {
    return { short: anlage ?? 'BMF', full: anlage ? `Anlage ${anlage}` : 'BMF-Kontext nicht angegeben', anlage };
  }
  const direct = KONTEXT_PATH_TO_CITATION[kontextPath];
  if (direct) return direct;
  // Fallback: Mapping nach Anlage allein (besser als gar nichts)
  const byAnlage: Record<string, EstgCitation> = {
    'N':     { short: '§19 EStG', full: '§19 EStG — Einkünfte aus nichtselbständiger Arbeit', anlage: 'N' },
    'KAP':   { short: '§20 EStG', full: '§20 EStG — Einkünfte aus Kapitalvermögen', anlage: 'KAP' },
    'VOR':   { short: '§10 EStG', full: '§10 Abs. 1 Nr. 2-3a EStG — Vorsorgeaufwendungen', anlage: 'VOR' },
    'SA':    { short: '§10 EStG', full: '§10 EStG — Sonderausgaben', anlage: 'SA' },
    'AV':    { short: '§10a EStG', full: '§10a EStG — Altersvorsorgezulage', anlage: 'AV' },
    'ESt1A': { short: 'ESt1A', full: 'Hauptvordruck ESt1A', anlage: 'ESt1A' },
    'R':     { short: '§22 EStG', full: '§22 EStG — Sonstige Einkünfte (Renten)', anlage: 'R' },
    'V':     { short: '§21 EStG', full: '§21 EStG — Vermietung und Verpachtung', anlage: 'V' },
  };
  if (anlage && byAnlage[anlage]) {
    return { ...byAnlage[anlage], full: `${byAnlage[anlage].full} (kontextPath: ${kontextPath})` };
  }
  return { short: anlage ?? 'BMF', full: `kontextPath ${kontextPath}${anlage ? ` · Anlage ${anlage}` : ''}` };
}

/** §-Referenzen für die Rechenschritte (1-9) der BMF Lane-1. */
export const RECHENSCHRITT_CITATIONS = [
  { schritt: 1, paragraph: '§2 Abs. 1 EStG',       title: 'Summe der Einkünfte' },
  { schritt: 2, paragraph: '§9 EStG',              title: 'Abzug Werbungskosten' },
  { schritt: 3, paragraph: '§10 Abs. 1 Nr. 2-3a EStG', title: 'Abzug Vorsorgeaufwendungen' },
  { schritt: 4, paragraph: '§10 / §10c EStG',      title: 'Abzug Sonderausgaben' },
  { schritt: 5, paragraph: '§2 Abs. 5 EStG',       title: 'Zu versteuerndes Einkommen' },
  { schritt: 6, paragraph: '§32a EStG',            title: 'Einkommensteuer (Tarif)' },
  { schritt: 7, paragraph: '§3 SolZG',             title: 'Solidaritätszuschlag' },
  { schritt: 8, paragraph: '§36 Abs. 2 EStG',      title: 'Anrechnung Vorauszahlungen' },
  { schritt: 9, paragraph: '§36 Abs. 4 EStG',      title: 'Festsetzung und Erstattung/Nachzahlung' },
] as const;
