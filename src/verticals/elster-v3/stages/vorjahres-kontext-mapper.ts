/**
 * @deprecated 2026-05-18 — hardcoded eCode-Mapper-Logik wird ersetzt durch die
 *   Container-deklarative PROJECTION_RULES in
 *   src/verticals/elster/lib/deterministic-rules.ts. Wird in PHASE 3
 *   vollständig entfernt zusammen mit dem Konsumenten-Refactor
 *   (vorjahres-kontext-extract ruft applyProjections() + leitet CaseContext
 *   aus dem resulting layer.codes ab). Bis dahin bleibt die Datei nur weil
 *   vorjahres-kontext-extract.ts noch importiert.
 *
 * Original-Doku (zum Verständnis):
 * Mapper: Vorjahres-Erklärung (nested JSON aus einkommensteuererklaerung_vorjahr.json)
 * → CaseContext (siehe src/server/applications.ts). Hardcoded Pfad→eCode.
 */
import type { CaseContext } from '../../../server/applications.ts';

type NestedVorjahr = {
  hauptvordruck?: {
    steuerjahr?: number;
    veranlagungsart?: string;
    person_a?: { familienname?: string; vorname?: string; idnr?: string };
    person_b?: { familienname?: string; vorname?: string; idnr?: string };
  };
  anlage_sa?: Record<string, unknown>;
  anlage_n?: {
    person?: 'a' | 'b';
    arbeitslohn?: Record<string, unknown>;
    pendlerpauschale?: {
      ziel_plz?: string; ziel_ort?: string; ziel_strasse?: string;
      arbeitstage?: number; entfernung_km?: number; verkehrsmittel?: string;
      entfernungspauschale_eur?: number;
    };
    arbeitsmittel?: { summe?: number; einzelposten?: Array<{ bezeichnung: string; betrag: number }> };
    weitere_werbungskosten?: Array<{ bezeichnung: string; betrag: number; kategorie?: string }>;
  };
  anlage_kap_person_a?: Record<string, unknown>;
  anlage_kap_person_b?: Record<string, unknown>;
  anlage_vor?: Record<string, unknown>;
  anlage_av?: Record<string, unknown>;
  anlage_kind?: { kinder?: Array<Record<string, unknown>> };
  anlage_v?: { objekte?: Array<Record<string, unknown>> };
  anlage_r?: { renten?: Array<Record<string, unknown>> };
  anlage_agb?: Record<string, unknown>;
};

/**
 * Berechnet die Entfernungspauschale nach §9 Abs.1 Nr.4 EStG (2023 Stand):
 *   km × tage × satz.
 * Standardsatz 0,30 €/km für die ersten 20 km, danach 0,38 € (2022-2026
 * Sonderregelung). Hier vereinfacht mit single rate — für die genaue
 * BMF-Berechnung läuft später ohnehin bmfRechnerComputeStage.
 */
export function computePendlerpauschaleEUR(km: number, tage: number, satz = 0.3): number {
  if (!Number.isFinite(km) || !Number.isFinite(tage) || km <= 0 || tage <= 0) return 0;
  return Math.round(km * tage * satz);
}

/** Pro-Anlage-Mapping welche eCodes "befüllt" als angemeldet gelten, wenn
 *  bestimmte Felder im nested-JSON gesetzt sind. Quelle der eCode-Wahrheit
 *  ist nested-to-ecode-mapper.ts + nested_schemas/*.json descriptions. */
const ECODE_MAP_HAUPTVORDRUCK: Record<string, string> = {
  // path-in-nested → eCode
  'person_a.familienname': 'E0100201',
  'person_a.vorname': 'E0100301',
  'person_a.idnr': 'E0100081',
  'person_a.geburtsdatum': 'E0100702',
  'person_a.religion': 'E0100402',
  'person_a.beruf': 'E0100802',
  'person_b.familienname': 'E0101201',
  'person_b.vorname': 'E0101301',
  'person_b.idnr': 'E0101081',
  'person_b.geburtsdatum': 'E0101702',
  'person_b.religion': 'E0100502',
  'adresse.strasse': 'E0101701',
  'adresse.hausnummer': 'E0101801',
  'adresse.plz': 'E0102001',
  'adresse.ort': 'E0102101',
  'bankverbindung.iban': 'E0102301',
  'bankverbindung.bic': 'E0102401',
};

const ECODE_MAP_SA: Record<string, string> = {
  'kirchensteuer_gezahlt': 'E0701401',
  'kirchensteuer_erstattet': 'E0701501',
  'spenden_steuerbegunstigte_zwecke': 'E0701801',
  'mitgliedsbeitrage_politische_parteien': 'E0702101',
  'mitgliedsbeitrage_vereine': 'E0702301',
};

const ECODE_MAP_N: Record<string, string> = {
  'arbeitslohn.bruttoarbeitslohn': 'E0200201',
  'arbeitslohn.lohnsteuer': 'E0200301',
  'arbeitslohn.solidaritaetszuschlag': 'E0200401',
  'arbeitslohn.kirchensteuer_arbeitnehmer': 'E0200501',
  'arbeitslohn.kirchensteuer_partner': 'E0200601',
  'arbeitslohn.steuerklasse': 'E0200002',
  'pendlerpauschale.ziel_plz': 'E0203203',
  'pendlerpauschale.ziel_ort': 'E0203204',
  'pendlerpauschale.ziel_strasse': 'E0203205',
  'pendlerpauschale.arbeitstage': 'E0203301',
  'pendlerpauschale.entfernung_km': 'E0203401',
  'pendlerpauschale.entfernungspauschale_eur': 'E0203504',
  'arbeitsmittel.summe': 'E0204301',
};

const ECODE_MAP_KAP: Record<string, string> = {
  'antrag_guenstigerpruefung': 'E2300401',
  'kapitalertraege_brutto': 'E2300701',
  'kapitalertragsteuer': 'E2304301',
  'solidaritaetszuschlag_kap': 'E2304401',
  'kirchensteuer_kap': 'E2304501',
};

const ECODE_MAP_VOR: Record<string, string> = {
  'rv_arbeitnehmer': 'E2000401',
  'rv_arbeitgeber': 'E2000801',
  'berufsstaendisch_arbeitnehmer': 'E2000501',
  'kv_arbeitnehmer': 'E2001203',
  'pv_arbeitnehmer': 'E2001505',
  'av_arbeitnehmer': 'E2004403',
};

function getByPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object' && part in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, obj);
}

function isFilled(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'boolean') return true;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as Record<string, unknown>).length > 0;
  return false;
}

function collectFilledECodes(block: unknown, map: Record<string, string>): string[] {
  if (!block || typeof block !== 'object') return [];
  const out: string[] = [];
  for (const [path, eCode] of Object.entries(map)) {
    if (isFilled(getByPath(block, path))) out.push(eCode);
  }
  return out;
}

function mapVeranlagungsart(v: string | undefined): CaseContext['veranlagungsart'] {
  if (!v) return undefined;
  const s = v.toLowerCase();
  if (s.startsWith('zusammen') || s === 'verwitwet_splitting') return 'zusammenveranlagung';
  if (s.startsWith('einzel') || s === 'getrennt') return 'einzelveranlagung';
  if (s === 'ledig') return 'ledig';
  return undefined;
}

function ableitenMissingBelege(expected_anlagen: string[], vorjahr: number | undefined): string[] {
  const folgejahr = vorjahr ? vorjahr + 1 : undefined;
  const suffix = folgejahr ? ` ${folgejahr}` : '';
  const out: string[] = [];
  if (expected_anlagen.includes('N')) out.push(`Lohnsteuerbescheinigung${suffix}`);
  if (expected_anlagen.includes('KAP')) out.push(`Bank-Steuerbescheinigung${suffix}`);
  if (expected_anlagen.includes('VOR')) out.push(`KV/PV-Bescheinigung${suffix}`);
  if (expected_anlagen.includes('SA')) out.push(`Spendenquittungen${suffix}`);
  if (expected_anlagen.includes('AV')) out.push(`Riester-Bescheinigung (§10a EStG)${suffix}`);
  if (expected_anlagen.includes('Kind')) out.push(`Kinderbetreuungskosten-Rechnungen${suffix}`);
  if (expected_anlagen.includes('V')) out.push(`Mietvertrag + Nebenkosten-Abrechnungen${suffix}`);
  if (expected_anlagen.includes('R')) out.push(`Rentenbezugsmitteilung${suffix}`);
  return out;
}

export function nestedToVorjahresKontext(
  nested: NestedVorjahr,
  jahr: number,
): CaseContext {
  const hv = nested.hauptvordruck ?? {};
  const expected_anlagen: string[] = [];
  const expected_ecodes_by_anlage: Record<string, string[]> = {};
  const daueranschnitte: CaseContext['daueranschnitte'] = [];

  // ── ESt1A Hauptvordruck ist immer da (required im Schema) ──────────
  expected_anlagen.push('ESt1A');
  const ecodesESt1A = collectFilledECodes(hv, ECODE_MAP_HAUPTVORDRUCK);
  if (ecodesESt1A.length > 0) expected_ecodes_by_anlage['ESt1A'] = ecodesESt1A;

  // ── Anlage SA ──────────────────────────────────────────────────────
  if (nested.anlage_sa && Object.keys(nested.anlage_sa).length > 0) {
    expected_anlagen.push('SA');
    const ecodes = collectFilledECodes(nested.anlage_sa, ECODE_MAP_SA);
    if (ecodes.length > 0) expected_ecodes_by_anlage['SA'] = ecodes;
  }

  // ── Anlage N (Lohn + Werbungskosten) ───────────────────────────────
  if (nested.anlage_n && Object.keys(nested.anlage_n).length > 0) {
    expected_anlagen.push('N');
    const ecodes = collectFilledECodes(nested.anlage_n, ECODE_MAP_N);
    if (ecodes.length > 0) expected_ecodes_by_anlage['N'] = ecodes;

    // Daueranschnitt: Pendlerpauschale
    const pp = nested.anlage_n.pendlerpauschale;
    if (pp && Number.isFinite(pp.entfernung_km) && Number.isFinite(pp.arbeitstage)) {
      const km = Number(pp.entfernung_km);
      const tage = Number(pp.arbeitstage);
      const wert = pp.entfernungspauschale_eur ?? computePendlerpauschaleEUR(km, tage);
      daueranschnitte.push({
        eCode: 'E0203301',
        label: `Entfernungspauschale ${km} km × ${tage} Tage = ${wert} €` +
          (pp.ziel_ort ? ` (Ziel: ${pp.ziel_ort})` : ''),
        wert,
        einheit: '€',
        quelle: 'vorjahr_anlage_n_pendlerpauschale',
        status: 'vorgeschlagen',
      });
    }

    // Daueranschnitt: Arbeitsmittel-Pauschale
    if (nested.anlage_n.arbeitsmittel?.summe && nested.anlage_n.arbeitsmittel.summe > 0) {
      daueranschnitte.push({
        eCode: 'E0204301',
        label: `Arbeitsmittel-Pauschale ${nested.anlage_n.arbeitsmittel.summe} €`,
        wert: nested.anlage_n.arbeitsmittel.summe,
        einheit: '€',
        quelle: 'vorjahr_anlage_n_arbeitsmittel',
        status: 'vorgeschlagen',
      });
    }

    // Daueranschnitt: weitere Werbungskosten (Kontoführung, Berufsverband, Rechtsschutz…)
    for (const wk of nested.anlage_n.weitere_werbungskosten ?? []) {
      if (!wk.betrag || wk.betrag <= 0) continue;
      daueranschnitte.push({
        eCode: 'E0204801',
        label: `${wk.bezeichnung}: ${wk.betrag} €`,
        wert: wk.betrag,
        einheit: '€',
        quelle: `vorjahr_anlage_n_werbungskosten:${wk.kategorie ?? 'sonstiges'}`,
        status: 'vorgeschlagen',
      });
    }
  }

  // ── Anlage KAP Person A + B ────────────────────────────────────────
  if (nested.anlage_kap_person_a && Object.keys(nested.anlage_kap_person_a).length > 0) {
    if (!expected_anlagen.includes('KAP')) expected_anlagen.push('KAP');
    const ecodes = collectFilledECodes(nested.anlage_kap_person_a, ECODE_MAP_KAP);
    if (ecodes.length > 0) expected_ecodes_by_anlage['KAP'] = ecodes;
  }
  if (nested.anlage_kap_person_b && Object.keys(nested.anlage_kap_person_b).length > 0) {
    if (!expected_anlagen.includes('KAP')) expected_anlagen.push('KAP');
    const ecodes = collectFilledECodes(nested.anlage_kap_person_b, ECODE_MAP_KAP);
    const merged = new Set([...(expected_ecodes_by_anlage['KAP'] ?? []), ...ecodes]);
    if (merged.size > 0) expected_ecodes_by_anlage['KAP'] = [...merged];
  }

  // ── Anlage VOR ─────────────────────────────────────────────────────
  if (nested.anlage_vor && Object.keys(nested.anlage_vor).length > 0) {
    expected_anlagen.push('VOR');
    const ecodes = collectFilledECodes(nested.anlage_vor, ECODE_MAP_VOR);
    if (ecodes.length > 0) expected_ecodes_by_anlage['VOR'] = ecodes;

    // Daueranschnitte: KV/PV/RV — wert wird vom User in 2024 aus neuer
    // KV/PV-Bescheinigung übernommen, aber wir signalisieren die Erwartung.
    const vor = nested.anlage_vor as Record<string, number | undefined>;
    if (vor.kv_arbeitnehmer && vor.kv_arbeitnehmer > 0) {
      daueranschnitte.push({
        eCode: 'E2001203',
        label: `KV-Beitrag AN (Vorjahr): ${vor.kv_arbeitnehmer} €`,
        wert: vor.kv_arbeitnehmer,
        einheit: '€',
        quelle: 'vorjahr_anlage_vor_kv',
        status: 'vorgeschlagen',
      });
    }
  }

  // ── Anlage AV (Riester) ────────────────────────────────────────────
  if (nested.anlage_av && Object.keys(nested.anlage_av).length > 0) {
    expected_anlagen.push('AV');
  }

  // ── Anlage Kind ────────────────────────────────────────────────────
  let anzahl_kinder: number | undefined;
  if (nested.anlage_kind?.kinder && nested.anlage_kind.kinder.length > 0) {
    expected_anlagen.push('Kind');
    anzahl_kinder = nested.anlage_kind.kinder.length;
  }

  // ── Anlage V (Vermietung) ──────────────────────────────────────────
  if (nested.anlage_v?.objekte && nested.anlage_v.objekte.length > 0) {
    expected_anlagen.push('V');
  }

  // ── Anlage R (Renten) ──────────────────────────────────────────────
  if (nested.anlage_r?.renten && nested.anlage_r.renten.length > 0) {
    expected_anlagen.push('R');
  }

  // ── Anlage AGB ─────────────────────────────────────────────────────
  if (nested.anlage_agb && Object.keys(nested.anlage_agb).length > 0) {
    expected_anlagen.push('AgB');
  }

  // Person-A/B-Identitäten extrahieren — wird von v5_4-Mappern als hartes
  // Seed für Person-A/B-Disambig genutzt (idnr ist ground-truth-Match).
  const pa = hv.person_a;
  const pb = hv.person_b;
  const person_a = pa && (pa.idnr || pa.familienname || pa.vorname)
    ? { idnr: pa.idnr, familienname: pa.familienname, vorname: pa.vorname }
    : undefined;
  const person_b = pb && (pb.idnr || pb.familienname || pb.vorname)
    ? { idnr: pb.idnr, familienname: pb.familienname, vorname: pb.vorname }
    : undefined;

  return {
    source: 'vorjahr',
    setAt: new Date().toISOString(),
    vorjahr: jahr,
    expected_anlagen,
    expected_ecodes_by_anlage,
    veranlagungsart: mapVeranlagungsart(hv.veranlagungsart),
    anzahl_kinder,
    daueranschnitte,
    missing_belege_erwartet: ableitenMissingBelege(expected_anlagen, jahr),
    person_a,
    person_b,
  };
}
