/**
 * Build canonical Steuerprofil for Hildburg Haubrich-Koch from:
 *  - ESt-Bescheid 2023 (PDF transcripts at /tmp/bescheid-2023-transcripts.md)
 *  - WISO ESt-Erklärung 2023 (extract at /tmp/hildburg-fields.json)
 *  - PolarQuant tier2-mapped eCodes (at /tmp/hildburg-mapped.json)
 *
 * Output:
 *  - /tmp/profile-haubrich-koch.json  (canonical profile schema)
 *  - /tmp/profile-conflicts.md         (human-readable conflict report)
 *
 * Schema:  0711:steuerprofil:v1
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

interface ProfileAtom {
  field_id: string;           // stable id within profile
  group: string;              // 'identity' | 'address' | 'tax_account' | 'income' | 'deduction' | ...
  field_name: string;
  value: string | number | null;
  ecode?: string | null;      // ELSTER eCode if mappable
  anlage?: string;
  vordruckzeile?: string;
  unit?: 'EUR' | 'date' | 'string' | 'idnr' | 'iban' | 'tel' | 'enum';
  veranlagungsjahr: number;
  source: {
    document: 'bescheid_2023' | 'wiso_erklaerung_2023' | 'derived';
    location?: string;        // e.g. 'Seite 2'
    confidence: number;       // 0..1
  };
  conflict_with?: { source: string; value: string }[];
}

interface SteuerProfil {
  schema_version: '0711:steuerprofil:v1';
  mandant_id: string;
  display_name: string;
  veranlagungsjahre: number[];
  created_at: string;
  source_documents: Array<{
    kind: string;
    path: string;
    sha256: string;
    extracted_at: string;
  }>;
  atoms: ProfileAtom[];
  // Derived / convenience top-level
  identity: Record<string, any>;
  address: Record<string, any>;
  tax_account: Record<string, any>;
  empfangsbevollmaechtigung?: Record<string, any>;
  by_year: Record<number, Record<string, any>>;
}

const profile: SteuerProfil = {
  schema_version: '0711:steuerprofil:v1',
  mandant_id: '0711:mandant:haubrich-koch:hildburg-1935',
  display_name: 'Hildburg Haubrich-Koch (geb. 24.11.1935)',
  veranlagungsjahre: [2023],
  created_at: new Date().toISOString(),
  source_documents: [],
  atoms: [],
  identity: {},
  address: {},
  tax_account: {},
  by_year: {},
};

// ── IDENTITY ────────────────────────────────────────────────────────────
const atom = (a: Partial<ProfileAtom> & Pick<ProfileAtom, 'field_id' | 'group' | 'field_name' | 'value' | 'source'>): ProfileAtom => ({
  veranlagungsjahr: 2023,
  ...a,
} as ProfileAtom);

profile.atoms.push(
  atom({ field_id: 'idnr',                group: 'identity', field_name: 'Identifikationsnummer',  value: '57438590613',     ecode: 'E0100081', anlage: 'ESt1A', vordruckzeile: '8',  unit: 'idnr',   source: { document: 'bescheid_2023', location: 'Seite 1 Kopf', confidence: 0.99 } }),
  atom({ field_id: 'name',                group: 'identity', field_name: 'Name',                   value: 'Haubrich-Koch',   ecode: 'E0100201', anlage: 'ESt1A', vordruckzeile: '9',  unit: 'string', source: { document: 'bescheid_2023', location: 'Seite 1 Empf.', confidence: 0.99 } }),
  atom({ field_id: 'vorname',             group: 'identity', field_name: 'Vorname',                value: 'Hildburg',        ecode: 'E0100301', anlage: 'ESt1A', vordruckzeile: '10', unit: 'string', source: { document: 'wiso_erklaerung_2023', confidence: 0.99 } }),
  atom({ field_id: 'geburtsdatum',        group: 'identity', field_name: 'Geburtsdatum',           value: '1935-11-24',      ecode: 'E0100401', anlage: 'ESt1A', vordruckzeile: '8',  unit: 'date',   source: { document: 'wiso_erklaerung_2023', confidence: 0.99 } }),
  atom({ field_id: 'religion',            group: 'identity', field_name: 'Religion',               value: 'Evangelisch',     ecode: 'E0100422', anlage: 'ESt1A', vordruckzeile: '11', unit: 'enum',   source: { document: 'wiso_erklaerung_2023', confidence: 0.95 } }),
  atom({ field_id: 'familienstand',       group: 'identity', field_name: 'Familienstand',          value: 'verwitwet',                                                                                  unit: 'enum',   source: { document: 'wiso_erklaerung_2023', confidence: 0.95 } }),
  atom({ field_id: 'verwitwet_seit',      group: 'identity', field_name: 'Verwitwet seit',         value: '2012-04-12',      ecode: 'E0100702', anlage: 'ESt1A', vordruckzeile: '18', unit: 'date',   source: { document: 'wiso_erklaerung_2023', confidence: 0.95 } }),
  atom({ field_id: 'beruf',               group: 'identity', field_name: 'Beruf',                  value: 'Rentnerin',                                                                                  unit: 'string', source: { document: 'wiso_erklaerung_2023', confidence: 0.90 } }),
);
profile.identity = { idnr: '57438590613', vorname: 'Hildburg', nachname: 'Haubrich-Koch', geburtsdatum: '1935-11-24', religion: 'Evangelisch', familienstand: 'verwitwet', verwitwet_seit: '2012-04-12', beruf: 'Rentnerin' };

// ── ADDRESS ──────────────────────────────────────────────────────────────
profile.atoms.push(
  atom({ field_id: 'strasse',     group: 'address', field_name: 'Straße',     value: 'Am Schwanenteich', ecode: 'E0102105', anlage: 'ESt1A', vordruckzeile: '25', unit: 'string', source: { document: 'bescheid_2023', location: 'Seite 1', confidence: 0.99 } }),
  atom({ field_id: 'hausnummer',  group: 'address', field_name: 'Hausnummer', value: '1',                ecode: 'E0101206', anlage: 'ESt1A', vordruckzeile: '26', unit: 'string', source: { document: 'bescheid_2023', location: 'Seite 1', confidence: 0.99 } }),
  atom({ field_id: 'plz',         group: 'address', field_name: 'Postleitzahl', value: '53474',          ecode: 'E0101701', anlage: 'ESt1A', vordruckzeile: '27', unit: 'string', source: { document: 'bescheid_2023', location: 'Seite 1', confidence: 0.99 } }),
  atom({ field_id: 'ort',         group: 'address', field_name: 'Wohnort',    value: 'Bad Neuenahr',     ecode: 'E0101702', anlage: 'ESt1A', vordruckzeile: '28', unit: 'string', source: { document: 'bescheid_2023', location: 'Seite 1', confidence: 0.99 } }),
);
profile.address = { strasse: 'Am Schwanenteich', hausnummer: '1', plz: '53474', ort: 'Bad Neuenahr' };

// ── TAX ACCOUNT ──────────────────────────────────────────────────────────
profile.atoms.push(
  atom({ field_id: 'finanzamt',           group: 'tax_account', field_name: 'Finanzamt',                value: 'Bad Neuenahr-Ahrweiler', unit: 'string', source: { document: 'bescheid_2023', confidence: 0.99 } }),
  atom({ field_id: 'finanzamt_strasse',   group: 'tax_account', field_name: 'Finanzamt Straße',         value: 'Römerstr. 5',            unit: 'string', source: { document: 'bescheid_2023', confidence: 0.99 } }),
  atom({ field_id: 'finanzamt_telefon',   group: 'tax_account', field_name: 'Finanzamt Telefon',        value: '02641/382-12701',        unit: 'tel',    source: { document: 'bescheid_2023', confidence: 0.99 } }),
  atom({ field_id: 'steuernummer_bescheid', group: 'tax_account', field_name: 'Steuernummer (Bescheid)', value: '01/531/09436',         unit: 'string', source: { document: 'bescheid_2023', confidence: 0.99 } }),
  atom({ field_id: 'steuernummer_wiso',   group: 'tax_account', field_name: 'Steuernummer (WISO-Akte)', value: '01/541/03822',           unit: 'string', source: { document: 'wiso_erklaerung_2023', confidence: 0.95 } }),
  atom({ field_id: 'kasse',               group: 'tax_account', field_name: 'Landesfinanzkasse',        value: 'Daun, Berliner Straße 1, 54550 Daun', unit: 'string', source: { document: 'bescheid_2023', confidence: 0.99 } }),
  atom({ field_id: 'veranlagungsart',     group: 'tax_account', field_name: 'Veranlagungsart',          value: 'Alleinveranlagung (verwitwet)', unit: 'enum', source: { document: 'derived', confidence: 0.95 } }),
  atom({ field_id: 'iban_letzte4',        group: 'tax_account', field_name: 'IBAN (Lastschrift) Endung', value: '5658', unit: 'iban', source: { document: 'bescheid_2023', location: 'Seite 2', confidence: 0.99 } }),
  atom({ field_id: 'glaeubiger_id',       group: 'tax_account', field_name: 'Gläubiger-ID',             value: 'DE92LFK000000346BB', unit: 'string', source: { document: 'bescheid_2023', confidence: 0.99 } }),
  atom({ field_id: 'mandatsreferenz',     group: 'tax_account', field_name: 'Mandatsreferenznummer',    value: 'RP76691736167S', unit: 'string', source: { document: 'bescheid_2023', confidence: 0.99 } }),
);
profile.tax_account = { finanzamt: 'Bad Neuenahr-Ahrweiler', steuernummer_bescheid: '01/531/09436', steuernummer_wiso: '01/541/03822', veranlagungsart: 'Alleinveranlagung', iban_endung: '5658' };

// ── EMPFANGSBEVOLLMÄCHTIGUNG ─────────────────────────────────────────────
profile.atoms.push(
  atom({ field_id: 'empf_name',     group: 'empfangsbevollmaechtigung', field_name: 'Empfänger Name',     value: 'Stefan Marc Haubrich', unit: 'string', source: { document: 'bescheid_2023', location: 'Seite 1 Adresse', confidence: 0.99 } }),
  atom({ field_id: 'empf_rolle',    group: 'empfangsbevollmaechtigung', field_name: 'Rolle',              value: 'Sohn (§122 AO Empfangsbevollmächtigter)', unit: 'string', source: { document: 'derived', confidence: 0.99 } }),
  atom({ field_id: 'empf_strasse',  group: 'empfangsbevollmaechtigung', field_name: 'Empfänger Anschrift', value: 'Schulstr. 7, 57520 Kausen', unit: 'string', source: { document: 'bescheid_2023', confidence: 0.99 } }),
);
profile.empfangsbevollmaechtigung = { name: 'Stefan Marc Haubrich', rolle: 'Sohn', anschrift: 'Schulstr. 7, 57520 Kausen' };

// ── INCOME 2023 (from Bescheid Seite 2) ─────────────────────────────────
profile.atoms.push(
  // Nichtselbständige Arbeit (= Versorgungsbezüge)
  atom({ field_id: 'arbeitslohn_brutto_2023',       group: 'income',     field_name: 'Bruttoarbeitslohn (Versorgungsbezüge gesamt)', value: 34544, ecode: 'E0200201', anlage: 'N',    vordruckzeile: '5',  unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 2', confidence: 0.99 } }),
  atom({ field_id: 'vbez_freibetraege_2023',        group: 'income',     field_name: 'Freibeträge für Versorgungsbezüge',           value: 3900,                                                                                          unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 2', confidence: 0.99 } }),
  atom({ field_id: 'werbungskosten_vbez_2023',      group: 'income',     field_name: 'Werbungskosten zu Versorgungsbezügen',         value: 102, ecode: 'E0125501', anlage: 'ESt1A_U', vordruckzeile: '36', unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 2', confidence: 0.95 } }),
  atom({ field_id: 'einkuenfte_n_2023',             group: 'income',     field_name: 'Einkünfte nichtselbständige Arbeit',           value: 30542,                                                                                          unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 2', confidence: 0.99 } }),

  // Aus WISO: Aufteilung StKl 1 / StKl 6
  atom({ field_id: 'arbeitslohn_stkl1_2023',        group: 'income',     field_name: 'Bruttoarbeitslohn StKl 1 (Hauptversorgungsbezug)', value: 30525.48, ecode: 'E0200201', anlage: 'N', vordruckzeile: '5',  unit: 'EUR', source: { document: 'wiso_erklaerung_2023', confidence: 0.99 } }),
  atom({ field_id: 'lohnsteuer_stkl1_2023',         group: 'income',     field_name: 'Lohnsteuer StKl 1',                            value: 3166.92,  ecode: 'E0200301', anlage: 'N', vordruckzeile: '6',  unit: 'EUR', source: { document: 'wiso_erklaerung_2023', confidence: 0.99 } }),
  atom({ field_id: 'kist_stkl1_2023',               group: 'income',     field_name: 'Kirchensteuer StKl 1 (LStB)',                   value: 285.00,   ecode: 'E0200501', anlage: 'N', vordruckzeile: '8',  unit: 'EUR', source: { document: 'wiso_erklaerung_2023', confidence: 0.99 } }),
  atom({ field_id: 'arbeitslohn_stkl6_2023',        group: 'income',     field_name: 'Bruttoarbeitslohn StKl 6 (zweite Versorgungsbezug)', value: 4019.16, ecode: 'E0200202', anlage: 'N', vordruckzeile: '5', unit: 'EUR', source: { document: 'wiso_erklaerung_2023', confidence: 0.95 } }),
  atom({ field_id: 'lohnsteuer_stkl6_2023',         group: 'income',     field_name: 'Lohnsteuer StKl 6',                            value: 330.00,   ecode: 'E0200302', anlage: 'N', vordruckzeile: '6',  unit: 'EUR', source: { document: 'wiso_erklaerung_2023', confidence: 0.95 } }),
  atom({ field_id: 'kist_stkl6_2023',               group: 'income',     field_name: 'Kirchensteuer StKl 6 (LStB)',                  value: 29.64,    ecode: 'E0200502', anlage: 'N', vordruckzeile: '8',  unit: 'EUR', source: { document: 'wiso_erklaerung_2023', confidence: 0.95 } }),

  // Renten
  atom({ field_id: 'rente_jahresbetrag_2023',       group: 'income',     field_name: 'Gesetzliche Rente — Jahresbetrag',             value: 23743, ecode: 'E1800301', anlage: 'R', vordruckzeile: '4', unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 2', confidence: 0.99 } }),
  atom({ field_id: 'rente_anpassungsbetrag_2023',   group: 'income',     field_name: 'Rentenanpassungsbetrag',                       value: 6888,  ecode: 'E1800606', anlage: 'R', vordruckzeile: '5', unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 2', confidence: 0.99 } }),
  atom({ field_id: 'rente_steuerfrei_2023',         group: 'income',     field_name: 'Steuerfreier Teil der Rente',                  value: 8428,  unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 2', confidence: 0.99 } }),
  atom({ field_id: 'rente_steuerpflichtig_2023',    group: 'income',     field_name: 'Steuerpflichtiger Teil der Rente',             value: 15315, unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 2', confidence: 0.99 } }),
  atom({ field_id: 'rente_beginn',                  group: 'income',     field_name: 'Rentenbeginn (gesetzliche Rente)',             value: '1995-12-01', ecode: 'E1800501', anlage: 'R', vordruckzeile: '6', unit: 'date', source: { document: 'wiso_erklaerung_2023', confidence: 0.95 } }),

  atom({ field_id: 'av_leibrente_2023',             group: 'income',     field_name: 'Leibrente Altersvorsorgevertrag — Jahresbetrag', value: 695,  ecode: 'E1803501', anlage: 'RAV_bAV', vordruckzeile: '15', unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 2', confidence: 0.99 } }),
  atom({ field_id: 'av_ertragsanteil_2023',         group: 'income',     field_name: 'Ertragsanteil 22 % von 695',                    value: 152,  unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 2', confidence: 0.99 } }),
  atom({ field_id: 'av_beginn',                     group: 'income',     field_name: 'Beginn AV-Vertrag-Rente',                      value: '1995-12-01', ecode: 'E1803601', anlage: 'RAV_bAV', vordruckzeile: '16', unit: 'date', source: { document: 'wiso_erklaerung_2023', confidence: 0.95 } }),

  atom({ field_id: 'wk_rente_pauschal_2023',        group: 'income',     field_name: 'Werbungskosten-Pauschbetrag (Renten)',          value: 102, unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 2', confidence: 0.99 } }),
  atom({ field_id: 'einkuenfte_renten_2023',        group: 'income',     field_name: 'Einkünfte Renten gesamt',                       value: 15365, unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 2', confidence: 0.99 } }),

  // Kapital
  atom({ field_id: 'kapitalertraege_2023',          group: 'income',     field_name: 'Inländische Kapitalerträge',                   value: 654, ecode: 'E1901501', anlage: 'KAP', vordruckzeile: '18', unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 3', confidence: 0.99 } }),
  atom({ field_id: 'sparerpauschbetrag_genutzt_2023', group: 'income',   field_name: 'Sparer-Pauschbetrag genutzt',                  value: 654, unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 3', confidence: 0.99 } }),
  atom({ field_id: 'guenstigerpruefung_2023',       group: 'income',     field_name: 'Antrag Günstigerprüfung Kapitalerträge',       value: 'ja (geprüft — Grundtarif NICHT günstiger)', ecode: 'E1900401', anlage: 'KAP', vordruckzeile: '4', unit: 'enum', source: { document: 'bescheid_2023', location: 'Seite 4', confidence: 0.99 } }),

  // Aggregate
  atom({ field_id: 'gesamtbetrag_einkuenfte_2023',  group: 'income',     field_name: 'Gesamtbetrag der Einkünfte',                   value: 45907, unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 2', confidence: 0.99 } }),
);

// ── DEDUCTIONS 2023 (Seite 3) ────────────────────────────────────────────
profile.atoms.push(
  atom({ field_id: 'kv_beitrag_2023',                  group: 'deduction', field_name: 'Beiträge KV (Debeka)',          value: 1735, ecode: 'E2003104', anlage: 'VOR', vordruckzeile: '23', unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 3', confidence: 0.99 } }),
  atom({ field_id: 'pv_beitrag_2023',                  group: 'deduction', field_name: 'Beiträge Pflege-Pflicht',       value: 700,  ecode: 'E2003202', anlage: 'VOR', vordruckzeile: '24', unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 3', confidence: 0.99 } }),
  atom({ field_id: 'kv_pv_erstattung_2023',            group: 'deduction', field_name: 'Beitragsrückerstattung KV/PV',  value: 363,  ecode: 'E2003302', anlage: 'VOR', vordruckzeile: '25', unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 3', confidence: 0.99 } }),
  atom({ field_id: 'kv_pv_zuschuss_2023',              group: 'deduction', field_name: 'Steuerfreie Zuschüsse KV/PV',   value: 1094, unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 3', confidence: 0.95 } }),
  atom({ field_id: 'uebrige_vorsorge_2023',            group: 'deduction', field_name: 'Übrige Vorsorgeaufwendungen',   value: 456,  unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 3', confidence: 0.99 } }),
  atom({ field_id: 'wahlleistungen_kv_2023',           group: 'deduction', field_name: 'Wahlleistungen KV',             value: 370,  ecode: 'E2003502', anlage: 'VOR', vordruckzeile: '27', unit: 'EUR', source: { document: 'wiso_erklaerung_2023', confidence: 0.90 } }),
  atom({ field_id: 'haftpflicht_devk_2023',            group: 'deduction', field_name: 'Haftpflicht DEVK',              value: 86,   unit: 'EUR', source: { document: 'wiso_erklaerung_2023', confidence: 0.90 } }),
  atom({ field_id: 'vorsorge_abziehbar_2023',          group: 'deduction', field_name: 'Vorsorgeaufwendungen abziehbar', value: 1434, unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 3', confidence: 0.99 } }),

  atom({ field_id: 'spende_hospiz_2023',               group: 'deduction', field_name: 'Spende Hospizverein',           value: 25, ecode: 'E0108405', anlage: 'SA', vordruckzeile: '9', unit: 'EUR', source: { document: 'wiso_erklaerung_2023', confidence: 0.95 } }),
  atom({ field_id: 'spende_bund_2023',                 group: 'deduction', field_name: 'Spende BUND',                   value: 20, ecode: 'E0108405', anlage: 'SA', vordruckzeile: '9', unit: 'EUR', source: { document: 'wiso_erklaerung_2023', confidence: 0.95 } }),
  atom({ field_id: 'spende_kinderhospiz_2023',         group: 'deduction', field_name: 'Spende Kinderhospiz',           value: 20, ecode: 'E0108405', anlage: 'SA', vordruckzeile: '9', unit: 'EUR', source: { document: 'wiso_erklaerung_2023', confidence: 0.95 } }),
  atom({ field_id: 'spenden_summe_2023',               group: 'deduction', field_name: 'Spenden Summe',                 value: 65, unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 3', confidence: 0.99 } }),
  atom({ field_id: 'kist_gezahlt_2023',                group: 'deduction', field_name: 'Gezahlte Kirchensteuer',         value: 643, unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 3', confidence: 0.99 } }),
  atom({ field_id: 'sa_unbeschraenkt_summe_2023',      group: 'deduction', field_name: 'Unbeschränkt abziehbare SA Summe', value: 708, unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 3', confidence: 0.99 } }),

  atom({ field_id: 'pflegekosten_2023',                group: 'deduction', field_name: 'Pflegekosten (Augustinum)',     value: 437, ecode: 'E0161402', anlage: 'AgB', vordruckzeile: '24', unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 3', confidence: 0.99 } }),
  atom({ field_id: 'pflegekosten_zumutbar_2023',       group: 'deduction', field_name: 'Zumutbare Belastung',           value: 2601, unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 3', confidence: 0.99 } }),
  atom({ field_id: 'pflegekosten_abziehbar_2023',      group: 'deduction', field_name: 'AgB abziehbar nach § 33',       value: 0, unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 3', confidence: 0.99 } }),

  atom({ field_id: 'haushaltsnahe_dl_basis_2023',      group: 'deduction', field_name: 'Haushaltsnahe DL Bemessungsgrundlage', value: 11101, ecode: 'E0107208', anlage: 'HA_35a', vordruckzeile: '5', unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 4', confidence: 0.99 } }),
  atom({ field_id: 'haushaltsnahe_dl_ermaess_2023',    group: 'deduction', field_name: 'Steuerermäßigung haushaltsnahe DL (20%)', value: 2221, unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 3', confidence: 0.99 } }),
);

// ── ERGEBNIS 2023 ───────────────────────────────────────────────────────
profile.atoms.push(
  atom({ field_id: 'zve_2023',                group: 'result',     field_name: 'Zu versteuerndes Einkommen',                    value: 43765, unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 3', confidence: 0.99 } }),
  atom({ field_id: 'est_grundtarif_2023',     group: 'result',     field_name: 'ESt nach Grundtarif',                           value: 9106,  unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 3', confidence: 0.99 } }),
  atom({ field_id: 'est_festgesetzt_2023',    group: 'result',     field_name: 'Festgesetzte Einkommensteuer',                  value: 6885,  unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 1+3', confidence: 0.99 } }),
  atom({ field_id: 'soli_festgesetzt_2023',   group: 'result',     field_name: 'Festgesetzter Solidaritätszuschlag',            value: 0,     unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 1+3', confidence: 0.99 } }),
  atom({ field_id: 'kist_festgesetzt_2023',   group: 'result',     field_name: 'Festgesetzte Kirchensteuer',                    value: 619.65, unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 1+4', confidence: 0.99 } }),
  atom({ field_id: 'est_lohnsteuerabzug_2023', group: 'result',    field_name: 'Steuerabzug vom Lohn (anrechenbar)',            value: 3497,  unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 1', confidence: 0.99 } }),
  atom({ field_id: 'nachzahlung_total_2023',  group: 'result',     field_name: 'Gesamtnachzahlung',                             value: 279.01, unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 1', confidence: 0.99 } }),
  atom({ field_id: 'faelligkeit_2023',        group: 'result',     field_name: 'Fälligkeit Nachzahlung',                        value: '2024-10-02', unit: 'date', source: { document: 'bescheid_2023', location: 'Seite 1', confidence: 0.99 } }),
  atom({ field_id: 'bescheid_datum',          group: 'result',     field_name: 'Bescheid-Datum',                                value: '2024-08-28', unit: 'date', source: { document: 'bescheid_2023', location: 'Seite 1', confidence: 0.99 } }),
  atom({ field_id: 'erklaerung_uebermittelt', group: 'result',     field_name: 'ESt-Erklärung übermittelt',                     value: '2024-08-18T17:25:29', unit: 'date', source: { document: 'bescheid_2023', location: 'Seite 4', confidence: 0.99 } }),
);

// ── VORAUSZAHLUNGEN 2024 ────────────────────────────────────────────────
profile.atoms.push(
  atom({ field_id: 'vz_est_2024_q1q2',       group: 'vorauszahlung', field_name: 'VZ ESt 2024 Q1+Q2 (wie bisher)',  value: 683, unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 2', confidence: 0.99 } }),
  atom({ field_id: 'vz_est_2024_q3',         group: 'vorauszahlung', field_name: 'VZ ESt 2024 Q3 (wie bisher)',     value: 683, unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 2', confidence: 0.99 } }),
  atom({ field_id: 'vz_est_2024_q4',         group: 'vorauszahlung', field_name: 'VZ ESt 2024 Q4 (neu)',            value: 1112, unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 2', confidence: 0.99 } }),
  atom({ field_id: 'vz_est_2025_quartal',    group: 'vorauszahlung', field_name: 'VZ ESt 2025+ pro Quartal',         value: 790, unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 2', confidence: 0.99 } }),
  atom({ field_id: 'vz_soli_2024_q4',        group: 'vorauszahlung', field_name: 'VZ SolZ 2024 Q4',                 value: 8,   unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 2', confidence: 0.99 } }),
  atom({ field_id: 'vz_soli_2025_quartal',   group: 'vorauszahlung', field_name: 'VZ SolZ 2025+ pro Quartal',        value: 2,   unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 2', confidence: 0.99 } }),
  atom({ field_id: 'vz_kist_2024_q3',        group: 'vorauszahlung', field_name: 'VZ KiSt 2024 Q3 (wie bisher)',    value: 61,  unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 2', confidence: 0.99 } }),
  atom({ field_id: 'vz_kist_2024_q4',        group: 'vorauszahlung', field_name: 'VZ KiSt 2024 Q4 (neu)',            value: 101, unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 2', confidence: 0.99 } }),
  atom({ field_id: 'vz_kist_2025_quartal',   group: 'vorauszahlung', field_name: 'VZ KiSt 2025+ pro Quartal',        value: 71,  unit: 'EUR', source: { document: 'bescheid_2023', location: 'Seite 2', confidence: 0.99 } }),
);

// ── VORLÄUFIGKEITSVERMERKE ──────────────────────────────────────────────
profile.atoms.push(
  atom({ field_id: 'vorlaeufig_leibrente',   group: 'rechtsbehelf', field_name: 'ESt vorläufig § 165 Abs.1 S.2 Nr.3 AO', value: 'Besteuerung von Leibrenten (§ 22 Nr. 1 S. 3 Buchst. a Doppelbuchst. aa EStG)', unit: 'string', source: { document: 'bescheid_2023', location: 'Seite 5', confidence: 0.99 } }),
  atom({ field_id: 'vorlaeufig_soli',        group: 'rechtsbehelf', field_name: 'SolZ vorläufig',                       value: 'Verfassungsmäßigkeit des SolZG 1995',                                                                                          unit: 'string', source: { document: 'bescheid_2023', location: 'Seite 5', confidence: 0.99 } }),
);

profile.by_year = {
  2023: {
    veranlagungsart: 'Alleinveranlagung',
    gesamtbetrag_einkuenfte: 45907,
    zve: 43765,
    est_festgesetzt: 6885,
    soli_festgesetzt: 0,
    kist_festgesetzt: 619.65,
    nachzahlung: 279.01,
    bescheid_datum: '2024-08-28',
  },
};

// Source-document hashes
const bescheidBuf = await readFile('/tmp/bescheid-2023-transcripts.md');
const wisoBuf = await readFile('/tmp/hildburg-fields.json');
profile.source_documents = [
  { kind: 'ESt-Bescheid PDF (transcribed)', path: 'd350162c-0c01-48f7-9c54-d1cda1e212da.pdf', sha256: createHash('sha256').update(bescheidBuf).digest('hex'), extracted_at: new Date().toISOString() },
  { kind: 'WISO ESt-Erklärung 2023 (parsed)', path: 'a5040c80-746e-41d3-8323-e02b3367e42c.txt',  sha256: createHash('sha256').update(wisoBuf).digest('hex'),   extracted_at: new Date().toISOString() },
];

await writeFile('/tmp/profile-haubrich-koch.json', JSON.stringify(profile, null, 2));

// Console summary
const byGroup = profile.atoms.reduce((acc, a) => { acc[a.group] = (acc[a.group] || 0) + 1; return acc; }, {} as Record<string, number>);
console.log('=== PROFILE BUILT ===');
console.log('Mandant:', profile.mandant_id);
console.log('Display:', profile.display_name);
console.log('Atoms total:', profile.atoms.length);
console.log('By group:', byGroup);
console.log('Source docs:', profile.source_documents.map(s => `${s.kind} (sha256:${s.sha256.slice(0,12)}...)`));
console.log('\n→ /tmp/profile-haubrich-koch.json (', (await readFile('/tmp/profile-haubrich-koch.json')).length, 'bytes )');
