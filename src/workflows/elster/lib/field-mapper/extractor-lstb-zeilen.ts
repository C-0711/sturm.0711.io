/**
 * extractor-lstb-zeilen — LStB-Vordruckzeilen-Nummer als Extraktions-Anker.
 *
 * ════════════════════════════════════════════════════════════════════════
 *  Die Nummern am Zeilenanfang einer Lohnsteuerbescheinigung HABEN einen
 *  Sinn: sie sind die offiziellen Zeilen-Nummern des BMF-Musters für den
 *  Ausdruck der elektronischen Lohnsteuerbescheinigung. Sie sind
 *  employer-unabhängig, layout-unabhängig und über die Jahre stabil.
 * ════════════════════════════════════════════════════════════════════════
 *
 * Beispiel (Sammel-VaSt, Stricker):
 *   "3.  Bruttoarbeitslohn (ohne 9. und 10.)        69.291,80 €"
 *   "4.  Einbehaltene Lohnsteuer (von 3.)            7.532,00 €"   ← "(von 3.)"
 *   "19. Entschädigungen ... (in 3. enthalten)         300,00 €"   ← "(in 3.)"
 *
 * Die Labels referenzieren sich GEGENSEITIG über die Nummern ("von 3.",
 * "in 3. enthalten") — Beweis dass die Nummer die semantische ID ist,
 * nicht das (variable) Label-Wording.
 *
 * Warum als eigene Matching-Ebene:
 *   Label-Matching (mapper.ts) ist primär — schnell, deckt die ELSTER-
 *   standardisierten Labels + Aliase. ABER: neue Arbeitgeber-Exporte
 *   können bisher ungesehene Label-Wordings haben. Die Zeilen-Nummer ist
 *   die EINE Konstante die ELSTER garantiert. Deshalb läuft diese Ebene
 *   als Gap-Filler NACH dem Label-Matching: alles was das Label verpasst
 *   hat, aber eine erkannte LStB-Nr trägt, wird hier gerettet.
 *
 * Quelle der Nr→E-Code-Tabelle:
 *   • Quer-referenzierte Felder (9,10,15,17,19,22b,24a/b,25,26,27,29-32):
 *     catalog MV elster.vw_lstb_nr_to_code (drucktext "laut Nr. X").
 *   • Kern-Felder (3,4,5,6,7,8,22a,23a,23b): offizielles LStB-Muster,
 *     direkt verifiziert gegen die nummerierten VaSt-Belege (Stricker).
 *
 * NUR EINDEUTIGE Nr→E-Code-Mappings sind hier. Mehrdeutige (Nr 9/30/31/32
 * = Versorgungsbezug 1 vs 2, Nr 31 erster vs letzter Monat) bleiben dem
 * Label-Matching überlassen, weil die Nummer allein nicht disambiguiert.
 */
import { normalize } from './normalizer.ts';
import type { MappedField, Person, ValueType } from './types.ts';

interface ZeileFieldSpec {
  eCode: string;
  anlage: string;
  kontextSubpath: string;
  valueType: ValueType;
  label: string; // Klartext für pdfLabel / Debug
}

/**
 * LStB-Zeilen-Nummer (inkl. Sub-Buchstabe wie "22a") → Feld-Spec.
 * Schlüssel ohne Punkt, Sub-Buchstabe kleingeschrieben angehängt.
 */
const LSTB_ZEILE_TO_FIELD: Record<string, ZeileFieldSpec> = {
  // ── Kern: Arbeitslohn + Abzüge (LStB_1_5_Sum) ──────────────────────
  '3': { eCode: 'E0200201', anlage: 'N', kontextSubpath: 'ArbL/LStB_1_5_Sum', valueType: 'int_euro', label: 'Bruttoarbeitslohn (Nr. 3 LStB)' },
  '4': { eCode: 'E0200301', anlage: 'N', kontextSubpath: 'ArbL/LStB_1_5_Sum', valueType: 'decimal_eur_cent', label: 'Einbehaltene Lohnsteuer (Nr. 4 LStB)' },
  '5': { eCode: 'E0200401', anlage: 'N', kontextSubpath: 'ArbL/LStB_1_5_Sum', valueType: 'decimal_eur_cent', label: 'Solidaritätszuschlag (Nr. 5 LStB)' },
  '6': { eCode: 'E0200501', anlage: 'N', kontextSubpath: 'ArbL/LStB_1_5_Sum', valueType: 'decimal_eur_cent', label: 'Kirchensteuer Arbeitnehmer (Nr. 6 LStB)' },
  '7': { eCode: 'E0200601', anlage: 'N', kontextSubpath: 'ArbL/LStB_1_5_Sum', valueType: 'decimal_eur_cent', label: 'Kirchensteuer Partner (Nr. 7 LStB)' },

  // ── Versorgungsbezüge (VBez/Einz) ──────────────────────────────────
  '8': { eCode: 'E0200801', anlage: 'N', kontextSubpath: 'ArbL/VBez/Einz', valueType: 'int_euro', label: 'Steuerbegünstigte Versorgungsbezüge (Nr. 8 LStB)' },
  '29': { eCode: 'E0200902', anlage: 'N', kontextSubpath: 'ArbL/VBez/Einz', valueType: 'int_euro', label: 'Bemessungsgrundlage Versorgungsfreibetrag (Nr. 29 LStB)' },
  // Nr 30/31/32 mehrdeutig (Versorgungsbezug 1/2, erster/letzter Monat)
  // → bewusst NICHT hier, Label-Matching disambiguiert.

  // ── Entschädigung / mehrjährig (Nicht_erm_best) ────────────────────
  '19': { eCode: 'E0201806', anlage: 'N', kontextSubpath: 'ArbL/Nicht_erm_best/Sum', valueType: 'int_euro', label: 'Entschädigungen mehrere Jahre (Nr. 19 LStB)' },

  // ── Sozialversicherung → Anlage VOR ────────────────────────────────
  // Nr 22 a/b: Arbeitgeberanteil RV. a (gesetzlich) + b (berufsständisch)
  // werden im Catalog in E2000801 zusammengefasst. Wir ankern nur 22a
  // (b ist selten ≠ 0 und würde dieselbe E-Code doppelt belegen).
  '22a': { eCode: 'E2000801', anlage: 'VOR', kontextSubpath: 'AVor', valueType: 'int_euro', label: 'AG-Anteil gesetzl. RV (Nr. 22a LStB)' },
  // Nr 23 a/b: Arbeitnehmeranteil RV — getrennte E-Codes.
  '23a': { eCode: 'E2000601', anlage: 'VOR', kontextSubpath: 'AVor', valueType: 'int_euro', label: 'AN-Anteil gesetzl. RV (Nr. 23a LStB)' },
  '23b': { eCode: 'E2000501', anlage: 'VOR', kontextSubpath: 'AVor', valueType: 'int_euro', label: 'AN-Anteil berufsständisch (Nr. 23b LStB)' },
  // Nr 24 a/b: steuerfreie AG-Zuschüsse KV (gesetzlich / privat)
  '24a': { eCode: 'E2003705', anlage: 'VOR', kontextSubpath: 'Stfr_AG_Zusch', valueType: 'int_euro', label: 'AG-Zuschuss gesetzl. KV (Nr. 24a LStB)' },
  '24b': { eCode: 'E2003807', anlage: 'VOR', kontextSubpath: 'Stfr_AG_Zusch', valueType: 'int_euro', label: 'AG-Zuschuss priv. KV (Nr. 24b LStB)' },
  // Nr 25/26/27: AN-Beiträge KV / PV / ALV
  '25': { eCode: 'E2001203', anlage: 'VOR', kontextSubpath: 'Beitr_g_KV_PV_Inl/AN', valueType: 'int_euro', label: 'AN-Beiträge KV (Nr. 25 LStB)' },
  '26': { eCode: 'E2001505', anlage: 'VOR', kontextSubpath: 'Beitr_g_KV_PV_Inl/AN', valueType: 'int_euro', label: 'AN-Beiträge PV (Nr. 26 LStB)' },
  '27': { eCode: 'E2004403', anlage: 'VOR', kontextSubpath: 'Weit_Sons_VorAW/Pers', valueType: 'int_euro', label: 'AN-Beiträge ALV (Nr. 27 LStB)' },
};

export interface LstbZeileHit {
  zeile: string;          // "3", "22a", ...
  field: MappedField;
}

/**
 * Scannt rawText nach LStB-Zeilen der Form "<nr>. [<sub>)] <label>  <wert>"
 * und emittiert pro erkannter Nummer einen MappedField.
 *
 * Nur Zeilen mit Nummer im LSTB_ZEILE_TO_FIELD-Table werden berücksichtigt;
 * alles andere ignoriert (Label-Matching deckt's ab oder es ist Meta).
 */
export function extractLstbByZeilennummer(rawText: string, person: Person): LstbZeileHit[] {
  const hits: LstbZeileHit[] = [];
  const seen = new Set<string>(); // Nr-Keys schon gesehen (erstes Vorkommen gewinnt)
  const lines = rawText.split(/\r?\n/);

  for (const line of lines) {
    // "  3.     Bruttoarbeitslohn ...        69.291,80 €"
    // "  22.    a) Arbeitgeberanteil ...      6.544,01 €"
    const m = line.match(/^\s*(\d{1,3})\.\s+(.+?)\s{2,}(\S.*?)\s*$/);
    if (!m) continue;
    const nr = m[1];
    let rest = m[2];
    const rawValue = m[3];

    // optionaler Sub-Buchstabe "a)" / "b)"
    let key = nr;
    const subM = rest.match(/^([a-z])\)\s+/);
    if (subM) key = nr + subM[1];

    const spec = LSTB_ZEILE_TO_FIELD[key];
    if (!spec) continue;
    if (seen.has(key)) continue;
    seen.add(key);

    // Wert muss numerisch aussehen (sonst ist's keine Betrags-/Datums-Zeile)
    if (!/[\d]/.test(rawValue)) continue;

    const norm = normalize(rawValue, spec.valueType);
    hits.push({
      zeile: key,
      field: {
        eCode: spec.eCode,
        anlage: spec.anlage,
        kontextSubpath: spec.kontextSubpath,
        wert: norm.wert,
        rawValue,
        person,
        pdfLabel: spec.label,
        valueType: spec.valueType,
        method: 'schema',
        confidence: 0.9, // hoch, aber unter Label-exact (1.0) — Label gewinnt bei Konflikt
        warnings: [
          `LStB-Zeilennummer-Anker: Nr. ${key} → ${spec.eCode}`,
          ...(norm.warnings ?? []),
        ],
      },
    });
  }
  return hits;
}
