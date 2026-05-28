/**
 * field-mapper — Beleg-Schemas
 *
 * Pro Beleg-Typ ein Schema: Titel-Erkennung + Felder-Liste mit E-Code-Mapping.
 * Quelle der E-Code-Zuordnung: VaSt-PDF-Layouts (Stricker + Haubrich-Koch
 * Test-Korpus) und Jahresdokumentation_10_2024 (offiziell). Sollten neue
 * Beleg-Versionen mit anderen Labels auftauchen, bitte als Alias eintragen.
 */
import type { BelegSchema } from './types.ts';

// ─── Hilfe: gemeinsame Identitäts-Felder die in jedem VaSt-Beleg vorkommen ─
const IDENT_FIELDS_A = {
  ident: { pdfLabel: 'Identifikationsnummer', anlage: 'ESt1A', eCode: 'E0100081', valueType: 'idnr' as const },
  vorname: { pdfLabel: 'Vorname', anlage: 'ESt1A', eCode: 'E0100301', valueType: 'string' as const },
  name: { pdfLabel: 'Name', anlage: 'ESt1A', eCode: 'E0100201', valueType: 'string' as const, pdfLabelAliases: ['Nachname'] },
};
const IDENT_FIELDS_B = {
  ident: { pdfLabel: 'Identifikationsnummer', anlage: 'ESt1A', eCode: 'E0100082', valueType: 'idnr' as const },
  vorname: { pdfLabel: 'Vorname', anlage: 'ESt1A', eCode: 'E0100801', valueType: 'string' as const },
  name: { pdfLabel: 'Name', anlage: 'ESt1A', eCode: 'E0100901', valueType: 'string' as const, pdfLabelAliases: ['Nachname'] },
};

// ─── VaSt_LStB ────────────────────────────────────────────────────────────
export const SCHEMA_VAST_LSTB: BelegSchema = {
  belegTyp: 'VaSt_LStB',
  titlePatterns: [
    /^\s*Lohnsteuerbescheinigung\s*$/m,
    /Lohnsteuerbescheinigung\s+\S/i,
  ],
  felder: [
    { ...IDENT_FIELDS_A.ident },
    { ...IDENT_FIELDS_A.vorname },
    { ...IDENT_FIELDS_A.name },

    { pdfLabel: 'Steuerklasse', anlage: 'N', eCode: 'E0200002', valueType: 'enum', kontextSubpath: 'ArbL/LStB_1_5_Sum' },
    { pdfLabel: 'Kirchensteuermerkmal (Konfession)', anlage: 'ESt1A', eCode: 'E0100402', valueType: 'enum' },

    { pdfLabel: 'Bruttoarbeitslohn', pdfLabelAliases: ['Bruttoarbeitslohn (ohne 9. und 10.)'],
      anlage: 'N', eCode: 'E0200201', valueType: 'int_euro', kontextSubpath: 'ArbL/LStB_1_5_Sum', required: true },
    { pdfLabel: 'einbehaltene Lohnsteuer', pdfLabelAliases: ['Einbehaltene Lohnsteuer (von 3.)', 'Lohnsteuer'],
      anlage: 'N', eCode: 'E0200301', valueType: 'decimal_eur_cent', kontextSubpath: 'ArbL/LStB_1_5_Sum', required: true },
    { pdfLabel: 'einbehaltener Solidaritätszuschlag', pdfLabelAliases: ['Solidaritätszuschlag', 'Einbehaltener Solidaritätszuschlag (von 3.)'],
      anlage: 'N', eCode: 'E0200401', valueType: 'decimal_eur_cent', kontextSubpath: 'ArbL/LStB_1_5_Sum' },
    { pdfLabel: 'einbehaltene Kirchensteuer des Arbeitnehmers', pdfLabelAliases: ['Einbehaltene Kirchensteuer des Arbeitnehmers (von 3.)'],
      anlage: 'N', eCode: 'E0200501', valueType: 'decimal_eur_cent', kontextSubpath: 'ArbL/LStB_1_5_Sum' },
    { pdfLabel: 'Einbehaltene Kirchensteuer des Partners (von 3.)', pdfLabelAliases: ['einbehaltene Kirchensteuer des Ehegatten / Lebenspartners'],
      anlage: 'N', eCode: 'E0200601', valueType: 'decimal_eur_cent', kontextSubpath: 'ArbL/LStB_1_5_Sum' },

    // Versorgungsbezüge (typisch bei Pension/LBV)
    //
    // Label-wrap-around: pdftotext bricht lange Labels in der VaSt-PDF
    // an Spaltengrenzen um. Strategy-1 im extractor sieht nur die erste
    // Zeile als Label-Key. Aliases enthalten die wrap-around-Varianten.
    { pdfLabel: 'steuerbegünstigte Versorgungsbezüge (im Bruttoarbeitslohn enthalten)',
      pdfLabelAliases: [
        'Steuerbegünstigte Versorgungsbezüge',
        'steuerbegünstigte Versorgungsbezüge (im Bruttoarbeitslohn',   // ← Wrap-around: "enthalten)" auf nächster Zeile
      ],
      anlage: 'N', eCode: 'E0200801', valueType: 'int_euro', kontextSubpath: 'ArbL/VBez/Einz' },
    { pdfLabel: 'maßgebendes Kalenderjahr des Versorgungsbeginns',
      anlage: 'N', eCode: 'E0201307', valueType: 'year_JJJJ', kontextSubpath: 'ArbL/VBez/Einz' },
    { pdfLabel: 'Bemessungsgrundlage für Versorgungsfreibetrag',
      anlage: 'N', eCode: 'E0200902', valueType: 'int_euro', kontextSubpath: 'ArbL/VBez/Einz' },
    { pdfLabel: 'bei unterjähriger Zahlung: erster Monat, für den Versorgungsbezug gezahlt wurde',
      pdfLabelAliases: [
        'bei unterjähriger Zahlung: erster Monat, für den',   // ← Wrap-around: "Versorgungsbezug gezahlt wurde" auf nächster Zeile
      ],
      anlage: 'N', eCode: 'E0201003', valueType: 'month_MM', kontextSubpath: 'ArbL/VBez/Einz' },
    { pdfLabel: 'bei unterjähriger Zahlung: letzter Monat, für den Versorgungsbezug gezahlt wurde',
      pdfLabelAliases: [
        'bei unterjähriger Zahlung: letzter Monat, für den',
      ],
      anlage: 'N', eCode: 'E0201203', valueType: 'month_MM', kontextSubpath: 'ArbL/VBez/Einz' },

    // Sterbegeld / Kapitalauszahlungen / Abfindungen (LStB Z.32)
    { pdfLabel: 'Sterbegeld, Kapitalauszahlungen / Abfindungen und Nachzahlungen von Versorgungsbezügen',
      pdfLabelAliases: [
        'einmalige Versorgungsbezüge (Sterbegeld,',                   // ← Wrap-around: Mehrzeilen-Label
        'einmalige Versorgungsbezüge',
      ],
      anlage: 'N', eCode: 'E0201205', valueType: 'int_euro', kontextSubpath: 'ArbL/VBez/Einz' },

    // LStB-Nr.19 (Entschädigung / nicht ermäßigt besteuert)
    { pdfLabel: 'Entschädigungen / Arbeitslohn für mehrere Kalenderjahre (in 3. enthalten)',
      pdfLabelAliases: [
        'Entschädigungen / Arbeitslohn für mehrere Jahre',
        'Entschädigungen / Arbeitslohn für mehrere Kalenderjahre (in 3.',  // ← Wrap-around: "enthalten)" auf nächster Zeile
      ],
      anlage: 'N', eCode: 'E0201806', valueType: 'int_euro', kontextSubpath: 'ArbL/Nicht_erm_best/Sum' },

    // Anlage VOR (Sozialvers-Beiträge laut LStB Nr.22-27)
    { pdfLabel: 'Arbeitgeberanteil / -zuschuss zur gesetzlichen Rentenversicherung',
      pdfLabelAliases: ['a) Arbeitgeberanteil / -zuschuss zur gesetzlichen Rentenversicherung'],
      anlage: 'VOR', eCode: 'E2000801', valueType: 'int_euro', kontextSubpath: 'AVor' },
    { pdfLabel: 'Arbeitnehmeranteil zur gesetzlichen Rentenversicherung',
      pdfLabelAliases: ['a) Arbeitnehmeranteil zur gesetzlichen Rentenversicherung'],
      anlage: 'VOR', eCode: 'E2000601', valueType: 'int_euro', kontextSubpath: 'AVor' },
    { pdfLabel: 'Arbeitnehmeranteil zu berufsständischen Versorgungseinrichtungen',
      pdfLabelAliases: ['b) Arbeitnehmeranteil zu berufsständischen Versorgungseinrichtungen'],
      anlage: 'VOR', eCode: 'E2000501', valueType: 'int_euro', kontextSubpath: 'AVor' },
    { pdfLabel: 'Arbeitnehmerbeiträge zur gesetzlichen Krankenversicherung',
      anlage: 'VOR', eCode: 'E2001203', valueType: 'int_euro', kontextSubpath: 'Beitr_g_KV_PV_Inl/AN' },
    { pdfLabel: 'Arbeitnehmerbeiträge zur sozialen Pflegeversicherung',
      anlage: 'VOR', eCode: 'E2001505', valueType: 'int_euro', kontextSubpath: 'Beitr_g_KV_PV_Inl/AN' },
    { pdfLabel: 'Arbeitnehmerbeiträge zur gesetzlichen Arbeitslosenversicherung',
      anlage: 'VOR', eCode: 'E2004403', valueType: 'int_euro', kontextSubpath: 'Weit_Sons_VorAW/Pers' },

    // Private KV/PV bei Beamten-LStB (Z.28)
    { pdfLabel: 'nachgewiesene Beiträge zur privaten Krankenversicherung und Pflege-Pflichtversicherung',
      pdfLabelAliases: [
        'Beiträge zur privaten Kranken- und Pflege-Pflichtversicherung oder Mindestvorsorgepauschale',
        'nachgewiesene Beiträge zur privaten Krankenversicherung',   // ← Wrap-around: "und Pflege-Pflichtversicherung" auf nächster Zeile
      ],
      anlage: 'VOR', eCode: 'E2003104', valueType: 'int_euro', kontextSubpath: 'Beitr_p_KV_PV_Inl',
      branchHint: 'Bei Beamten-LStB: priv. KV-Anteil. Achtung: kann mit separater VaSt_KRV überlappen — Quellen-Priorität klären.' },
  ],
};

// ─── VaSt_RBM (Rentenbezugsmitteilung) ────────────────────────────────────
export const SCHEMA_VAST_RBM: BelegSchema = {
  belegTyp: 'VaSt_RBM',
  titlePatterns: [/^\s*Rentenbezugsmitteilung/im],
  felder: [
    { ...IDENT_FIELDS_A.ident },
    { ...IDENT_FIELDS_A.vorname },
    { ...IDENT_FIELDS_A.name },

    // Branch via Rechtsgrundlage: 'gesetzlich' → Leibr_gesetzl; 'bAV' / 'Pensionskasse' → Leibr_sons
    // Hinweis: Anlage R legt Renten als ganz-Euro ab (int_euro), NICHT decimal —
    // ELSTER-XSD-Typ ist GanzzahlOhneFuehrNull (verifiziert via validate-schemas-against-db).
    { pdfLabel: 'Renten-/Leistungsbetrag',
      anlage: 'R', eCode: 'E1800301', valueType: 'int_euro',
      kontextSubpath: 'Leibr_gesetzl/Einz', required: true,
      branchHint: 'kontextSubpath in mapper.ts überschreiben falls Rechtsgrundlage "bAV" / "betriebliche Altersversorgung" / "Pensionskasse" enthält → Leibr_sons/Einz' },
    { pdfLabel: 'Rentenanpassungsbetrag',
      pdfLabelAliases: ['Rentenanpassungsbetrag bei gesetzlichen Renten'],
      anlage: 'R', eCode: 'E1800606', valueType: 'int_euro', kontextSubpath: 'Leibr_gesetzl/Einz' },
    { pdfLabel: 'Beginn der Rente/Leistung',
      anlage: 'R', eCode: 'E1800501', valueType: 'date_TTMMJJJJ', kontextSubpath: 'Leibr_gesetzl/Einz', required: true },

    // KV-Zuschuss von dritter Seite (Rentenversicherer).
    // Default-Branch: privat krankenversichert → E2003402 in /VOR/Beitr_p_KV_PV_Inl.
    // Für gesetzlich KV-versicherte Person muss mapper.ts dies auf E2002402 in
    // /VOR/Beitr_g_KV_PV_Inl/And_Pers umrouten (siehe branchHint).
    { pdfLabel: 'Höhe der geleisteten/erstatteten Beiträge/Zuschüsse zur Kranken-/Pflegeversicherung',
      anlage: 'VOR', eCode: 'E2003402', valueType: 'int_euro', kontextSubpath: 'Beitr_p_KV_PV_Inl',
      branchHint: 'Wenn Rentner GESETZLICH krankenversichert ist (statt privat) → eCode E2002402, kontextSubpath Beitr_g_KV_PV_Inl/And_Pers. Default ist privat-KV (Beamten-Pensionäre).' },
  ],
};

// ─── VaSt_KRV (Beitragsbescheinigung Krankenversicherung) ─────────────────
export const SCHEMA_VAST_KRV: BelegSchema = {
  belegTyp: 'VaSt_KRV',
  titlePatterns: [/Beitragsbescheinigung\s+Kranken-\s*\/?Pflegeversicherung/i],
  felder: [
    { ...IDENT_FIELDS_A.ident },

    // KV-Beiträge — pro Beitragsdaten-Block (multipliziert in mapper.ts)
    { pdfLabel: 'Geleistete Beiträge zur Krankenversicherung (ohne Krankengeldanspruch) ohne Zusatzbeitrag für Basisleistungen',
      pdfLabelAliases: ['KV-Basis ohne Krankengeld'],
      anlage: 'VOR', eCode: 'E2003104', valueType: 'int_euro', kontextSubpath: 'Beitr_p_KV_PV_Inl', required: true },
    { pdfLabel: 'Geleistete Beiträge zur sozialen oder privaten Pflegepflichtversicherung',
      pdfLabelAliases: ['Pflegepflichtversicherung'],
      anlage: 'VOR', eCode: 'E2003202', valueType: 'int_euro', kontextSubpath: 'Beitr_p_KV_PV_Inl' },
    { pdfLabel: 'Gesamtbeitrag zur Krankenversicherung (Basisleistungen und Wahlleistungen)',
      anlage: 'VOR', eCode: 'E2003502', valueType: 'int_euro', kontextSubpath: 'Beitr_p_KV_PV_Inl/WL_Zvers',
      branchHint: 'Berechnung im mapper: Wahlleistungs-Anteil = Gesamt − Basis. Hier wird die ganze Summe abgelegt; mapper kann differenzieren. /WL_Zvers = Wahlleistungs-Zusatzversicherungs-Container im XSD.' },
  ],
};

// ─── VaSt_FSA (Freistellungsauftrag) ──────────────────────────────────────
export const SCHEMA_VAST_FSA: BelegSchema = {
  belegTyp: 'VaSt_FSA',
  titlePatterns: [
    /Kapitalerträge\s+mit\s+Freistellungsauftrag/i,
    /Mitteilung\s+über\s+freigestellte\s+Kapitalertr[aä]ge/i,
  ],
  felder: [
    { ...IDENT_FIELDS_A.ident },

    // freigestellter Betrag — aggregiert in mapper über alle FSA-Belege
    { pdfLabel: 'Betrag',
      pdfLabelAliases: ['Freigestellte Kapitalerträge: Betrag'],
      anlage: 'KAP', eCode: 'E1901402', valueType: 'int_euro', kontextSubpath: 'Sp_PB',
      branchHint: 'Mapper summiert über alle FSA-Belege EINER Person.' },
  ],
};

// ─── VaSt_Pers (Stammdaten) ───────────────────────────────────────────────
export const SCHEMA_VAST_PERS: BelegSchema = {
  belegTyp: 'VaSt_Pers',
  titlePatterns: [/^\s*Stammdaten\s*$/im, /Stammdaten von/i],
  felder: [
    { ...IDENT_FIELDS_A.ident },
    { ...IDENT_FIELDS_A.vorname },
    { ...IDENT_FIELDS_A.name },
    { pdfLabel: 'Geburtsdatum', anlage: 'ESt1A', eCode: 'E0100401', valueType: 'date_TTMMJJJJ' },
    { pdfLabel: 'Strasse', pdfLabelAliases: ['Straße'], anlage: 'ESt1A', eCode: 'E0101104', valueType: 'string' },
    { pdfLabel: 'Hausnummer', anlage: 'ESt1A', eCode: 'E0101206', valueType: 'string' },
    { pdfLabel: 'Postleitzahl', anlage: 'ESt1A', eCode: 'E0100601', valueType: 'string' },
    { pdfLabel: 'Wohnort', anlage: 'ESt1A', eCode: 'E0100602', valueType: 'string' },
    { pdfLabel: 'Bankverbindung: IBAN', pdfLabelAliases: ['IBAN'],
      anlage: 'ESt1A', eCode: 'E0102102', valueType: 'string', kontextSubpath: 'Allg/BV' },
  ],
};

// ─── VaSt_Religion ────────────────────────────────────────────────────────
export const SCHEMA_VAST_RELIGION: BelegSchema = {
  belegTyp: 'VaSt_Religion',
  titlePatterns: [/^\s*Religionszugeh[oö]rigkeit\s*$/im],
  felder: [
    { ...IDENT_FIELDS_A.ident },
    { pdfLabel: 'Religion', anlage: 'ESt1A', eCode: 'E0100402', valueType: 'enum', required: true },
  ],
};

// ─── Steuerbescheinigung_Bank ─────────────────────────────────────────────
export const SCHEMA_STEUERBESCHEINIGUNG_BANK: BelegSchema = {
  belegTyp: 'Steuerbescheinigung_Bank',
  titlePatterns: [
    /^\s*Steuerbescheinigung\s*$/im,
    /Steuerbescheinigung\s+Bank/i,
    // Erträgnisaufstellung (Volksbank/Raiffeisen u.a.) ist eine
    // Steuerbescheinigung im Tabellen-Format — gleiche KAP-Felder, andere
    // Überschrift. Mit Kapitalerträge-Kontext, um Fehlklassifikation zu meiden.
    /Erträgnisaufstellung[\s\S]{0,120}Kapitalerträge/i,
  ],
  felder: [
    { pdfLabel: 'Höhe der Kapitalerträge', pdfLabelAliases: ['Kapitalerträge'],
      anlage: 'KAP', eCode: 'E1900701', valueType: 'int_euro', kontextSubpath: 'KapErt_inl_StAbz/Betr_lt_StBesch', required: true },
    { pdfLabel: 'Höhe des in Anspruch genommenen Sparer-Pauschbetrages',
      anlage: 'KAP', eCode: 'E1901402', valueType: 'int_euro', kontextSubpath: 'Sp_PB' },
    { pdfLabel: 'Kapitalertragsteuer',
      anlage: 'KAP', eCode: 'E1904701', valueType: 'decimal_eur_cent', kontextSubpath: 'St_Abz_Betr_Inl_u_Inv_Ert' },
    { pdfLabel: 'Solidaritätszuschlag',
      anlage: 'KAP', eCode: 'E1904901', valueType: 'decimal_eur_cent', kontextSubpath: 'St_Abz_Betr_Inl_u_Inv_Ert' },
    { pdfLabel: 'Kirchensteuer zur Kapitalertragsteuer',
      anlage: 'KAP', eCode: 'E1904801', valueType: 'decimal_eur_cent', kontextSubpath: 'St_Abz_Betr_Inl_u_Inv_Ert' },
  ],
};

// ─── Registry ─────────────────────────────────────────────────────────────
export const ALL_SCHEMAS: Record<string, BelegSchema> = {
  VaSt_LStB: SCHEMA_VAST_LSTB,
  VaSt_RBM: SCHEMA_VAST_RBM,
  VaSt_KRV: SCHEMA_VAST_KRV,
  VaSt_FSA: SCHEMA_VAST_FSA,
  VaSt_Pers: SCHEMA_VAST_PERS,
  VaSt_Religion: SCHEMA_VAST_RELIGION,
  Steuerbescheinigung_Bank: SCHEMA_STEUERBESCHEINIGUNG_BANK,
};

/** Liefert das Schema für einen Beleg-Typ oder null. */
export function getSchema(belegTyp: string): BelegSchema | null {
  return ALL_SCHEMAS[belegTyp] ?? null;
}
