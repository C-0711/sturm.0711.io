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

/** Deutsche Währung mit Cent — der Wert-Marker einer LStB-Betragszeile.
 *  Akzeptiert BEIDE Schreibweisen: mit Tausenderpunkt ("69.291,80",
 *  VaSt-Export) UND ohne ("51144,88", gedrucktes BMF-Muster). Reine
 *  Referenz-Nummern ("von 3.", "9. und 10.") haben kein „,dd" → nie als Wert.
 *  Die gruppierte Alternative steht zuerst, damit "1.427,16" voll matcht
 *  statt nur "427,16". */
const CURRENCY_RE = /\d{1,3}(?:\.\d{3})+,\d{2}|\d+,\d{2}/;
const firstCurrency = (s: string): string | undefined => (s.match(CURRENCY_RE) ?? [])[0];

interface ZeilenBlock {
  nr: number;
  text: string; // alles nach der Nummer bis zur nächsten Nummer (Zeilen zusammengeführt)
}

/**
 * Scannt rawText nach LStB-Vordruckzeilen und emittiert pro erkannter Nummer
 * einen MappedField.
 *
 * ROBUST gegen ZWEI Layouts (Memory [[pdf-render-families]]):
 *   • VaSt-Export (Sammel-Datenabholung): einspaltig, „3. Label … 69.291,80 €"
 *     — Nummer, Label und Wert auf EINER Zeile.
 *   • BMF-Muster „Ausdruck der elektronischen Lohnsteuerbescheinigung":
 *     ZWEISPALTIG. `pdftotext -layout` verschränkt linke (Name/Adresse/IdNr)
 *     und rechte (nummerierte Felder) Spalte → die Nummer steht NICHT am
 *     Zeilenanfang (Stray-Linksspalten-Text davor) und der Wert steht oft auf
 *     einer FOLGEZEILE (umbrochenes Label). Der alte Zeilen-Regex verfehlte
 *     so das wichtigste Feld (Nr. 3 Bruttoarbeitslohn) → zvE = 0.
 *
 * Lösung: sequenzieller Zeilennummern-Automat. Das Muster nummeriert 1..34 in
 * AUFSTEIGENDER Reihenfolge — wir akzeptieren ein „<n>."-Token nur als Anker,
 * wenn n die Sequenz fortsetzt (streng steigend, moderater Vorwärts-Gap für
 * unzugeordnete/abwesende Nummern). Das verwirft Rückwärts-Referenzen
 * („von 3."), Stray-Zahlen („141003", „15 %") und Sub-Wiederholungen. Pro
 * Anker wird der Block bis zur nächsten Nummer gesammelt; der Wert ist die
 * erste Währungszahl im Block (Sub a)/b) separat behandelt).
 */
export function extractLstbByZeilennummer(rawText: string, person: Person): LstbZeileHit[] {
  const lines = rawText.split(/\r?\n/);

  // ── Phase 1: Sequenzieller Automat → Blöcke ──
  // Ein „<n>."-Token ist nur dann ein FELD-Anker, wenn direkt ein Label folgt:
  // Großbuchstabe (Feldnamen sind großgeschrieben) ODER ein Sub-Marker „a)".
  // Das verwirft In-Label-Referenzen wie „… ohne 9. und 10.)" (klein „und" /
  // „)") und „von 3.  318,72" (Ziffer) — DIE Ursache, dass Nr. 4–8 sonst in
  // den Bruttolohn-Block (Nr. 3) gesaugt würden.
  const blocks: ZeilenBlock[] = [];
  const anchorRe = /(?:^|\s)(\d{1,2})\.(?=\s+(?:[A-ZÄÖÜ]|[a-c]\)))/g;
  const MAX_GAP = 15; // 8→19 (Gap 11) im Muster kommt vor
  let lastNr = 0;
  let open: ZeilenBlock | null = null;

  for (const line of lines) {
    let acceptNr = -1;
    let acceptEnd = -1;
    anchorRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = anchorRe.exec(line)) !== null) {
      const n = parseInt(m[1], 10);
      if (n > lastNr && n <= lastNr + MAX_GAP) {
        acceptNr = n;
        acceptEnd = m.index + m[0].length; // direkt hinter „<n>."
        break;
      }
    }
    if (acceptNr !== -1) {
      if (open) blocks.push(open);
      open = { nr: acceptNr, text: line.slice(acceptEnd) };
      lastNr = acceptNr;
    } else if (open) {
      open.text += ' ' + line.trim();
    }
  }
  if (open) blocks.push(open);

  // ── Phase 2: Blöcke → Felder über die Tabelle ──
  const hits: LstbZeileHit[] = [];
  const seen = new Set<string>();
  const emit = (key: string, rawValue: string | undefined): void => {
    const spec = LSTB_ZEILE_TO_FIELD[key];
    if (!spec || !rawValue || seen.has(key)) return;
    seen.add(key);
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
  };

  for (const b of blocks) {
    const nr = String(b.nr);
    const hasSub = LSTB_ZEILE_TO_FIELD[nr + 'a'] || LSTB_ZEILE_TO_FIELD[nr + 'b'];
    if (hasSub) {
      // a) = gesetzliche RV (primär, erste Währung); b) = berufsständisch/privat
      // (nach „b)"-Marker). Robust gegen Spalten-Verschränkung im Muster.
      const bIdx = b.text.indexOf('b)');
      const aRaw = firstCurrency(bIdx >= 0 ? b.text.slice(0, bIdx) : b.text);
      const bRaw = bIdx >= 0 ? firstCurrency(b.text.slice(bIdx)) : undefined;
      emit(nr + 'a', aRaw);
      emit(nr + 'b', bRaw);
    } else if (LSTB_ZEILE_TO_FIELD[nr]) {
      emit(nr, firstCurrency(b.text));
    }
  }
  return hits;
}
