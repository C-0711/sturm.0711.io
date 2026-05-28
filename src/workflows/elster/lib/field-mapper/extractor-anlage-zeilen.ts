/**
 * extractor-anlage-zeilen — "Zeile X Anlage Y"-Referenz als Extraktions-Anker.
 *
 * ════════════════════════════════════════════════════════════════════════
 *  Bank-Steuerbescheinigungen drucken die ZIEL-Anlage-Zeile direkt im
 *  Beleg. Das amtliche Muster der Steuerbescheinigung (§ 45a EStG) schreibt
 *  vor, dass jeder Betrag mit seiner Anlage-KAP-Zeile referenziert wird:
 *
 *    "Höhe der Kapitalerträge ...           Zeile 7  Anlage KAP    11,25"
 *    "Kapitalertragsteuer                   Zeile 37 Anlage KAP     2,75"
 *    "Solidaritätszuschlag                  Zeile 38 Anlage KAP     0,15"
 *    "Kirchensteuer zur KapErtSt            Zeile 39 Anlage KAP     0,24"
 * ════════════════════════════════════════════════════════════════════════
 *
 * Das ist der ZWEITE im-Beleg-gedruckte Nummernkreis (neben der LStB-Nr):
 * die Vordruckzeile des Ziel-Formulars (catalog vw_zeile_to_code). Anders
 * als die beleg-eigene LStB-Nr ist das die Ziel-Adresse — aber die Bank
 * druckt sie als Service direkt in den Beleg, also ist sie ein
 * employer-/wording-unabhängiger Anker.
 *
 * Warum als Anker:
 *   Verschiedene Banken formulieren "Höhe der Kapitalerträge" leicht
 *   anders, aber ALLE drucken "Zeile 7 Anlage KAP" — amtliche
 *   Muster-Pflicht. Die Zeilen-Referenz ist also stabiler als das Label.
 *
 * Quelle der Tabelle: catalog vw_zeile_to_code (Anlage KAP), verifiziert
 * gegen eine echte Westerwald-Bank-Steuerbescheinigung (Stricker 2024).
 */
import { normalize } from './normalizer.ts';
import type { MappedField, Person, ValueType } from './types.ts';

interface AnlageZeileSpec {
  eCode: string;
  anlage: string;
  kontextSubpath: string;
  valueType: ValueType;
  label: string;
}

/**
 * "<ANLAGE>:<Zeile>" → Feld-Spec. Aktuell Anlage KAP (Bank-
 * Steuerbescheinigung Muster I). Pro Zeile der PRIMÄRE E-Code (erste
 * Instanz; Person-B / Zweitkonto-Varianten via Label/Aggregation).
 */
const ANLAGE_ZEILE_TO_FIELD: Record<string, AnlageZeileSpec> = {
  // Kapitalerträge mit inl. Steuerabzug (Betr_lt_StBesch)
  'KAP:7': { eCode: 'E1900701', anlage: 'KAP', kontextSubpath: 'KapErt_inl_StAbz/Betr_lt_StBesch', valueType: 'int_euro', label: 'Höhe der Kapitalerträge (KAP Z.7)' },
  'KAP:8': { eCode: 'E1900901', anlage: 'KAP', kontextSubpath: 'KapErt_inl_StAbz/Betr_lt_StBesch', valueType: 'int_euro', label: 'Gewinne Aktienveräußerung (KAP Z.8)' },
  'KAP:11': { eCode: 'E1901101', anlage: 'KAP', kontextSubpath: 'KapErt_inl_StAbz/Betr_lt_StBesch', valueType: 'int_euro', label: 'Ersatzbemessungsgrundlage (KAP Z.11)' },
  'KAP:12': { eCode: 'E1901201', anlage: 'KAP', kontextSubpath: 'KapErt_inl_StAbz/Betr_lt_StBesch', valueType: 'int_euro', label: 'Nicht ausgeglichene Verluste (KAP Z.12)' },
  'KAP:13': { eCode: 'E1901301', anlage: 'KAP', kontextSubpath: 'KapErt_inl_StAbz/Betr_lt_StBesch', valueType: 'int_euro', label: 'Verluste Aktienveräußerung (KAP Z.13)' },
  // Sparer-Pauschbetrag
  'KAP:16': { eCode: 'E1901401', anlage: 'KAP', kontextSubpath: 'Sp_PB', valueType: 'int_euro', label: 'Sparer-Pauschbetrag (KAP Z.16)' },
  'KAP:17': { eCode: 'E1901402', anlage: 'KAP', kontextSubpath: 'Sp_PB', valueType: 'int_euro', label: 'Sparer-Pauschbetrag (KAP Z.17)' },
  // Kapitalerträge ohne inl. Steuerabzug
  'KAP:18': { eCode: 'E1901501', anlage: 'KAP', kontextSubpath: 'KapErt_kein_inl_StAbz', valueType: 'int_euro', label: 'Inländische Kapitalerträge ohne StAbz (KAP Z.18)' },
  'KAP:19': { eCode: 'E1901702', anlage: 'KAP', kontextSubpath: 'KapErt_kein_inl_StAbz', valueType: 'int_euro', label: 'Ausländische Kapitalerträge (KAP Z.19)' },
  // Steuerabzugsbeträge
  'KAP:37': { eCode: 'E1904701', anlage: 'KAP', kontextSubpath: 'St_Abz_Betr_Inl_u_Inv_Ert', valueType: 'decimal_eur_cent', label: 'Kapitalertragsteuer (KAP Z.37)' },
  'KAP:38': { eCode: 'E1904901', anlage: 'KAP', kontextSubpath: 'St_Abz_Betr_Inl_u_Inv_Ert', valueType: 'decimal_eur_cent', label: 'Solidaritätszuschlag (KAP Z.38)' },
  'KAP:39': { eCode: 'E1904801', anlage: 'KAP', kontextSubpath: 'St_Abz_Betr_Inl_u_Inv_Ert', valueType: 'decimal_eur_cent', label: 'Kirchensteuer zur KapErtSt (KAP Z.39)' },
  'KAP:40': { eCode: 'E1905001', anlage: 'KAP', kontextSubpath: 'St_Abz_Betr_Inl_u_Inv_Ert', valueType: 'decimal_eur_cent', label: 'Angerechnete ausländische Steuern (KAP Z.40)' },
  'KAP:41': { eCode: 'E1905101', anlage: 'KAP', kontextSubpath: 'St_Abz_Betr_Inl_u_Inv_Ert', valueType: 'decimal_eur_cent', label: 'Anrechenbare ausländische Steuern (KAP Z.41)' },
};

export interface AnlageZeileHit {
  ref: string;            // "KAP:7"
  field: MappedField;
}

/**
 * Scannt rawText nach "Zeile <N> Anlage <X>"-Referenzen und dem Betrag
 * auf derselben Zeile. Reihenfolge der Tokens variiert je Bank:
 *   "... Zeile 7 Anlage KAP    11,25"   (Ref vor Wert)
 *   "Anlage KAP Zeile 7 ...    11,25"   (Anlage vor Zeile)
 * Beide Formen werden erkannt.
 */
export function extractByAnlageZeile(rawText: string, person: Person): AnlageZeileHit[] {
  const hits: AnlageZeileHit[] = [];
  const seen = new Set<string>();
  const lines = rawText.split(/\r?\n/);

  // Erkennt "Zeile N Anlage X" ODER "Anlage X Zeile N" irgendwo in der Zeile.
  const refRe = /(?:Zeile\s+(\d{1,3}[a-z]?)\s+Anlage\s+([A-Za-zÄÖÜ_]+))|(?:Anlage\s+([A-Za-zÄÖÜ_]+)\s+Zeile\s+(\d{1,3}[a-z]?))/i;
  // Betrag = letztes Zahl-Token der Zeile (mit optionalem €).
  const valueRe = /(-?\d[\d.]*(?:,\d{1,2})?)\s*€?\s*$/;

  for (const line of lines) {
    const rm = line.match(refRe);
    if (!rm) continue;
    const zeile = rm[1] ?? rm[4];
    const anlage = (rm[2] ?? rm[3] ?? '').toUpperCase();
    if (!zeile || !anlage) continue;
    const key = `${anlage}:${zeile}`;
    const spec = ANLAGE_ZEILE_TO_FIELD[key];
    if (!spec) continue;
    if (seen.has(key)) continue;

    const vm = line.match(valueRe);
    if (!vm) continue;
    const rawValue = vm[1];
    // Plausi: der Wert darf nicht die Zeilen-/Anlagen-Nummer selbst sein.
    if (rawValue === zeile) continue;

    seen.add(key);
    const norm = normalize(rawValue, spec.valueType);
    hits.push({
      ref: key,
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
        confidence: 0.9,
        warnings: [
          `Anlage-Zeile-Anker: ${key} → ${spec.eCode}`,
          ...(norm.warnings ?? []),
        ],
      },
    });
  }
  return hits;
}
