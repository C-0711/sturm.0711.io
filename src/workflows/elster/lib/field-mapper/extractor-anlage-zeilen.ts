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
 * Scannt rawText nach "Zeile <N> Anlage <X>"-Referenzen und dem Betrag.
 * Reihenfolge der Tokens variiert je Bank:
 *   "... Zeile 7 Anlage KAP    11,25"   (Ref vor Wert, gleiche Zeile)
 *   "Anlage KAP Zeile 7 ...    11,25"   (Anlage vor Zeile, gleiche Zeile)
 * Beide Formen werden erkannt.
 *
 * OCR-Layout-Fallback: In gescannten Belegen steht der Betrag oft NICHT auf
 * der Ref-Zeile, sondern 1–3 Zeilen DARÜBER (der Wert lebt in der rechten
 * EUR/CT-Spalte auf Höhe des Labels, die "Zeile N Anlage KAP"-Annotation
 * ist eine eigene Zeile darunter):
 *     Höhe der Kapitalerträge
 *     nach Berücksichtigung ...        11,25   ← Wert (rechte Spalte)
 *     (ohne Kapitalerträge ...)
 *                       Zeile 7 Anlage KAP     ← Ref, kein Wert
 * Wenn die Ref-Zeile keinen Wert trägt, wird der nächste Money-Decimal-Wert
 * in den bis zu 3 nicht-leeren Zeilen darüber als Betrag genommen (jede
 * Wert-Zeile nur einmal — `consumed`).
 */
export function extractByAnlageZeile(rawText: string, person: Person): AnlageZeileHit[] {
  const hits: AnlageZeileHit[] = [];
  const seen = new Set<string>();
  const lines = rawText.split(/\r?\n/);

  // Erkennt "Zeile N Anlage X" ODER "Anlage X Zeile N" irgendwo in der Zeile.
  // `\s*` (statt `\s+`) an den Zahl-Grenzen: die Foto-OCR klebt die Tokens oft
  // zusammen („Zeile 38Anlage KAP", „Zeile39 Anlage KAP") → sonst fällt die
  // betroffene Zeile (typisch SolZ Z.38 / KiSt Z.39) komplett aus.
  const refRe = /(?:Zeile\s*(\d{1,3}[a-z]?)\s*Anlage\s+([A-Za-zÄÖÜ_]+))|(?:Anlage\s+([A-Za-zÄÖÜ_]+)\s+Zeile\s*(\d{1,3}[a-z]?))/i;
  // Betrag = letztes Zahl-Token der Zeile (mit optionalem €).
  const valueRe = /(-?\d[\d.]*(?:,\d{1,2})?)\s*€?\s*$/;
  // Strikterer Money-Decimal (mit Komma-Nachkommastellen) für den
  // Look-Back — verhindert dass PLZ/Jahr/Kundennr. als Wert gegriffen wird.
  const moneyRe = /(-?\d[\d.]*,\d{1,2})\s*€?\s*$/;
  const consumed = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const rm = line.match(refRe);
    if (!rm) continue;
    const zeile = rm[1] ?? rm[4];
    const anlage = (rm[2] ?? rm[3] ?? '').toUpperCase();
    if (!zeile || !anlage) continue;
    const key = `${anlage}:${zeile}`;
    const spec = ANLAGE_ZEILE_TO_FIELD[key];
    if (!spec) continue;
    if (seen.has(key)) continue;

    let rawValue: string | null = null;
    let valueLineIdx = i;
    // (a) Wert auf der Ref-Zeile selbst.
    const vm = line.match(valueRe);
    if (vm && vm[1] !== zeile) {
      rawValue = vm[1];
    } else {
      // (b) OCR-Fallback: Money-Decimal in bis zu 3 nicht-leeren Zeilen darüber.
      // STOP an einer anderen "Anlage KAP"-Ref-Zeile — sonst greift der
      // Look-Back über die Feld-Grenze in den Wert des Nachbar-Felds (z.B.
      // Sparkasse-Layout: Werte UNTER der Ref → die KapSt-Ref würde sonst
      // den Kapitalerträge-Betrag des Feldes darüber greifen).
      let tested = 0;
      for (let idx = i - 1; idx >= 0 && tested < 3; idx--) {
        if (lines[idx].trim() === '') continue; // Leerzeilen überspringen (zählen nicht)
        if (/Anlage\s+[A-ZÄÖÜ]{2,}/i.test(lines[idx])) break; // Feld-Grenze erreicht
        tested++;
        if (consumed.has(idx)) continue;
        const bm = lines[idx].match(moneyRe);
        if (bm) { rawValue = bm[1]; valueLineIdx = idx; break; }
      }
    }
    if (rawValue === null) continue;
    if (rawValue === zeile) continue;

    seen.add(key);
    consumed.add(valueLineIdx);
    const norm = normalize(rawValue, spec.valueType);
    const dist = i - valueLineIdx;
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
        confidence: dist === 0 ? 0.9 : 0.8, // Look-Back-Wert minimal unsicherer
        warnings: [
          `Anlage-Zeile-Anker: ${key} → ${spec.eCode}` +
            (dist > 0 ? ` (Wert ${dist} Zeile(n) über Ref — OCR-Spaltenlayout)` : ''),
          ...(norm.warnings ?? []),
        ],
      },
    });
  }
  return hits;
}

/**
 * Erträgnisaufstellung-Summe-Extraktor — für Bank-Belege OHNE inline
 * "Zeile N Anlage KAP"-Referenzen, dafür mit einer Summen-Zeile in einer
 * Tabelle. Volksbank/Raiffeisen-Format (Stricker 2024, Maria, Volksbank
 * Gebhardshain):
 *     Summe zur vorstehenden Tabelle ...   Anlage KAP
 *     Höhe der Kapitalerträge (z. B. Zinsen, Dividenden, Investmenterträge)
 *     319,35   7                                ← Wert + Zeilen-Nr-Spalte
 *
 * Greift NUR die Summen-Zeile (Anker = "Höhe der Kapitalerträge"-Phrase, die
 * im Tabellen-Kopf nicht vollständig vorkommt), NICHT die Einzelzeilen → kein
 * Doppelzählen. Der Wert darf auf der Label-Zeile oder bis zu 2 nicht-leere
 * Zeilen darunter stehen; der Money-Decimal wird auch dann erkannt, wenn ein
 * bloßer Zeilen-Nr-Integer (z. B. "7") dahinter steht.
 *
 * Läuft als Fallback NUR wenn der Zeile-Anker kein E1900701 fand (Caller-
 * Verantwortung), damit es sich mit dem Standard-Pfad nicht überlagert.
 */
export function extractKapErtraegnisSumme(rawText: string, person: Person): AnlageZeileHit[] {
  const lines = rawText.split(/\r?\n/);
  const moneyAnywhere = /(-?\d[\d.]*,\d{1,2})/; // Money-Decimal irgendwo in der Zeile
  const spec = ANLAGE_ZEILE_TO_FIELD['KAP:7']; // Höhe der Kapitalerträge → E1900701
  // Anker in Prioritätsreihenfolge. Volksbank-/Raiffeisen-Erträgnisaufstellungen
  // tragen die maßgebliche Gesamtsumme NICHT als „Höhe der Kapitalerträge Zeile 7
  // Anlage KAP <Wert>" (das zerlegt OCR über die Tabellen-Spaltenköpfe, Umlaute
  // weg), sondern auf der Zeile „Ermittelt aus der Summe der steuerpflichtigen
  // Einzelerträge … <Summe>" (Wert INLINE) bzw. unter „Summe zur vorstehenden
  // Tabelle". Anker 1 greift auf das distinktive „steuerpflichtigen Einzelerträge"
  // (überspringt das OCR-anfällige „Summe/Surmme"); Anker 3 ist der Alt-Label-Pfad.
  const anchors: RegExp[] = [
    /steuerpflichtigen\s+Einzelertr[äa]ge/i,   // Wert auf derselben Zeile
    /Summe\s+zur\s+vorstehenden\s+Tabelle/i,   // Wert 1–2 Zeilen darunter
    /H[öo]he\s+der\s+Kapitalertr[äa]ge/i,      // klassischer Label-Anker
  ];

  for (const anchor of anchors) {
    for (let i = 0; i < lines.length; i++) {
      if (!anchor.test(lines[i])) continue;
      // Wert: erst auf der Anker-Zeile, sonst in den nächsten 3 nicht-leeren Zeilen.
      let raw: string | null = null;
      const sm = lines[i].match(moneyAnywhere);
      if (sm) {
        raw = sm[1];
      } else {
        let tested = 0;
        for (let j = i + 1; j < lines.length && tested < 3; j++) {
          if (lines[j].trim() === '') continue;
          tested++;
          const m = lines[j].match(moneyAnywhere);
          if (m) { raw = m[1]; break; }
        }
      }
      if (!raw) continue;
      const norm = normalize(raw, spec.valueType);
      return [{
        ref: 'KAP:7(Summe)',
        field: {
          eCode: spec.eCode,
          anlage: spec.anlage,
          kontextSubpath: spec.kontextSubpath,
          wert: norm.wert,
          rawValue: raw,
          person,
          pdfLabel: 'Höhe der Kapitalerträge (Erträgnis-Summe)',
          valueType: spec.valueType,
          method: 'schema',
          confidence: 0.8,
          warnings: [`Erträgnisaufstellung-Summe → ${spec.eCode}`, ...(norm.warnings ?? [])],
        },
      }];
    }
  }
  return [];
}
