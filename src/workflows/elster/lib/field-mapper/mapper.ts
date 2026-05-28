/**
 * field-mapper — Hauptlogik
 *
 * Orchestriert die 7 Schritte:
 *   1. Beleg-Typ klassifizieren (per Titel-Patterns)  [bzw. übernommen aus Input]
 *   2. Schema laden
 *   3. Label→Wert aus OCR-Text extrahieren
 *   4. pro Schema-Feld: Label-Match
 *   5. Wert normalisieren
 *   6. Kontext-Branching auflösen (z.B. RBM bAV vs. gesetzlich)
 *   7. MappingResult bauen
 */
import { extractLabelValues, getAll, normalizeLabel } from './extractor.ts';
import { extractKrvBeitragsdatenBlocks } from './extractor-krv-blocks.ts';
import type { KrvBlock } from './extractor-krv-blocks.ts';
import { extractLstbByZeilennummer } from './extractor-lstb-zeilen.ts';
import { normalize } from './normalizer.ts';
import { getSchema, ALL_SCHEMAS } from './schemas.ts';
import type {
  BelegInput,
  BelegSchema,
  BelegTyp,
  FieldMapping,
  MappedField,
  MappingResult,
} from './types.ts';

/** Erkennt Beleg-Typ allein aus dem Titel (für Belege ohne vorgelagerten Klassifikator). */
export function detectBelegTyp(rawText: string): BelegTyp {
  const head = rawText.slice(0, 800);
  for (const schema of Object.values(ALL_SCHEMAS)) {
    for (const pat of schema.titlePatterns) {
      if (pat.test(head)) return schema.belegTyp;
    }
  }
  return 'Unbekannt';
}

// ─── RBM bAV-Routing (Fix 3) ─────────────────────────────────────────────
// Schema map RBM-Felder per Default in Leibr_gesetzl/Einz (gesetzliche Rente).
// Bei bAV/Pensionskasse zeigt die Rechtsgrundlage auf "sonstige Verträge" —
// dann wandern die Felder in Leibr_sonst/Einz. ABER: die E-Codes ändern sich
// strukturell, weil der Catalog für Leibr_sonst andere E-Codes nutzt.
// Felder ohne bAV-Pendant (z.B. Rentenanpassung E1800606 — die gibt es nur
// für gesetzliche Renten) werden mit `null` markiert und im Mapper verworfen.
const RBM_GESETZL_TO_SONST_ECODE: Record<string, string | null> = {
  E1800301: 'E1803102', // Rentenbetrag
  E1800501: 'E1803202', // Beginn der Rente
  E1800606: null,        // Rentenanpassung — gibt es bei bAV nicht
};

/** Branch-Logik für mehrdeutige Beleg-Inhalte (z.B. RBM gesetzlich vs. bAV). */
function resolveContextBranch(
  belegTyp: BelegTyp,
  rawText: string,
  field: FieldMapping,
): {
  kontextSubpath: string | undefined;
  eCode?: string;
  drop?: boolean;
  warning?: string;
} {
  if (belegTyp === 'VaSt_RBM' && field.kontextSubpath?.startsWith('Leibr_gesetzl')) {
    // Rechtsgrundlage entscheidet
    const t = rawText.toLowerCase();
    const isBav =
      /betrieblich.{0,40}altersversorgung/.test(t) ||
      /pensionskasse/.test(t) ||
      /altersvorsorgevertrag/.test(t) ||
      /sonstig.{0,20}vertr[aä]g/.test(t);
    if (isBav) {
      const replacement = RBM_GESETZL_TO_SONST_ECODE[field.eCode];
      if (replacement === undefined) {
        // E-Code, der nicht im Routing-Table steht, bleibt unverändert
        // (z.B. KV-Zuschuss E2003402 in /VOR — kein R-Kontext).
        return {
          kontextSubpath: field.kontextSubpath.replace('Leibr_gesetzl', 'Leibr_sonst'),
          warning: `RBM-bAV: E-Code ${field.eCode} ohne Routing-Eintrag — kontextSubpath gewechselt, eCode behalten`,
        };
      }
      if (replacement === null) {
        return {
          kontextSubpath: field.kontextSubpath,
          drop: true,
          warning: `RBM-bAV: ${field.eCode} (${field.pdfLabel}) hat kein bAV-Pendant — verworfen`,
        };
      }
      return {
        kontextSubpath: field.kontextSubpath.replace('Leibr_gesetzl', 'Leibr_sonst'),
        eCode: replacement,
        warning: `RBM-bAV: ${field.eCode}@Leibr_gesetzl → ${replacement}@Leibr_sonst`,
      };
    }
  }
  return { kontextSubpath: field.kontextSubpath };
}

// ─── LStB Steuerklasse-6 Routing (Fix 2) ─────────────────────────────────
// Schema map alle Anlage-N-Felder per Default in LStB_1_5_Sum-Container.
// Wenn der Beleg aber Steuerklasse 6 ausweist, müssen Brutto/LSt/Soli/KiSt
// in den LStB_6_Sum-Container umgeschrieben werden (E-Code-Suffix .1 → .3).
// Steuerklasse-Feld selbst entfällt für StKl 6 (im Catalog gibt es kein
// E0200002-Pendant unter LStB_6_Sum — die Steuerklasse ist implizit durch
// den Container-Pfad).
const LSTB_15_TO_6_ECODE: Record<string, string> = {
  E0200201: 'E0200203', // Bruttoarbeitslohn
  E0200301: 'E0200303', // Lohnsteuer
  E0200401: 'E0200403', // Solidaritätszuschlag
  E0200501: 'E0200503', // KiSt Arbeitnehmer
  E0200601: 'E0200603', // KiSt Partner (Konfessionsverschiedenheit)
};

function postProcessLstbSteuerklasse6(
  felder: MappedField[],
  warnings: string[],
): MappedField[] {
  const stklField = felder.find((f) => f.eCode === 'E0200002');
  if (!stklField || stklField.wert !== '6') {
    return felder;
  }
  warnings.push('LStB Steuerklasse 6 erkannt — alle Anlage-N-Felder → LStB_6_Sum gerouted');
  return felder
    .filter((f) => f.eCode !== 'E0200002') // Steuerklasse-Marker für StKl 6 entfällt
    .map((f) => {
      if (f.anlage !== 'N') return f;
      if (!f.kontextSubpath?.startsWith('ArbL/LStB_1_5_Sum')) return f;
      const newECode = LSTB_15_TO_6_ECODE[f.eCode];
      if (!newECode) return f; // z.B. Versorgungsbezüge-Felder bleiben
      return {
        ...f,
        eCode: newECode,
        kontextSubpath: f.kontextSubpath.replace('LStB_1_5_Sum', 'LStB_6_Sum'),
        warnings: [
          ...(f.warnings ?? []),
          `StKl-6-Routing: ${f.eCode}@LStB_1_5_Sum → ${newECode}@LStB_6_Sum`,
        ],
      };
    });
}

// ─── ESt1A Person-B-Routing (Fix 5) ─────────────────────────────────────
// Schema-FieldMappings sind primär für Person A formuliert (E0100081 IdNr,
// E0100402 Religion, E0100201 Name, E0100301 Vorname — alle im
// /ESt1A/Allg/A Subtree). Für Person B hat ELSTER eigene E-Codes im
// /ESt1A/Allg/B Subtree. Bei einem MappedField mit person='B' und einem
// ESt1A-Person-A-eCode wird der eCode auf die B-Variante remapped, und
// der kontextSubpath-Lookup im XML-Builder findet automatisch /Allg/B.
const ESTLA_A_TO_B_ECODE: Record<string, string> = {
  E0100081: 'E0100082', // Identifikationsnummer
  E0100301: 'E0100801', // Vorname
  E0100201: 'E0100901', // Name
  E0100401: 'E0101001', // Geburtsdatum
  E0100402: 'E0101002', // Religion
};

function postProcessEstlaPersonB(
  felder: MappedField[],
  warnings: string[],
): MappedField[] {
  return felder.map((f) => {
    if (f.person !== 'B' || f.anlage !== 'ESt1A') return f;
    const newECode = ESTLA_A_TO_B_ECODE[f.eCode];
    if (!newECode) return f;
    warnings.push(
      `ESt1A Person-B-Routing: ${f.eCode} → ${newECode} (${f.pdfLabel})`,
    );
    return {
      ...f,
      eCode: newECode,
      warnings: [
        ...(f.warnings ?? []),
        `Person-B-Remap: ${f.eCode}@/ESt1A/Allg/A → ${newECode}@/ESt1A/Allg/B`,
      ],
    };
  });
}

// ─── KRV Wahlleistungs-Differential (Fix 4) ───────────────────────────────
// E2003502 nimmt im Catalog die "Über die Basisabsicherung hinausgehenden"
// Beiträge — sprich Wahlleistungs-Anteil. Der Beleg liefert aber den
// Gesamtbeitrag (inkl. Basis). Wir rechnen:
//   E2003502 = (Gesamt-KV − Basis-KV) + max(0, Gesamt-PV − Basis-PV)
//
// Wenn nur Gesamt-KV ohne Gesamt-PV vorhanden: nur erster Summand.
// Wenn weder Gesamt-KV noch Gesamt-PV: E2003502 entfällt.
function parseEuroLocal(s: string): number {
  const m = (s ?? '').replace(/\s|€|EUR/gi, '').match(/^(-?)([\d.]+)(?:,(\d{1,2}))?$/);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  const intPart = Number(m[2].replace(/\./g, ''));
  const cents = m[3] ? Number(m[3].padEnd(2, '0').substring(0, 2)) / 100 : 0;
  return sign * (intPart + cents);
}

function postProcessKrvWahlleistung(
  felder: MappedField[],
  blocks: KrvBlock[],
  person: 'A' | 'B',
  warnings: string[],
): MappedField[] {
  // Klassifiziere Blocks per pdfLabel-Substring.
  const findBlock = (sub: string): KrvBlock | undefined =>
    blocks.find((b) => (b.pdfLabel ?? '').toLowerCase().includes(sub.toLowerCase()));

  const basisKv = findBlock('Geleistete Beiträge zur Krankenversicherung');
  const basisPv = findBlock('Pflegepflichtversicherung');
  const gesamtKv = findBlock('Gesamtbeitrag zur Krankenversicherung');
  const gesamtPv = findBlock('Gesamtbeitrag zur Pflegeversicherung');

  if (!gesamtKv && !gesamtPv) {
    return felder; // nichts zu rechnen
  }

  const kvDiff =
    gesamtKv && basisKv ? Math.max(0, parseEuroLocal(gesamtKv.hoehe) - parseEuroLocal(basisKv.hoehe)) : 0;
  const pvDiff =
    gesamtPv && basisPv ? Math.max(0, parseEuroLocal(gesamtPv.hoehe) - parseEuroLocal(basisPv.hoehe)) : 0;
  const wahlleistung = kvDiff + pvDiff;

  // Entferne ein eventuell vom Schema gemapptes E2003502 (das wäre der
  // Gesamtbeitrag, nicht das Differential — also strukturell falsch).
  const cleaned = felder.filter((f) => f.eCode !== 'E2003502');

  if (wahlleistung <= 0) {
    warnings.push('KRV: Wahlleistungs-Anteil = 0 — E2003502 nicht emittiert.');
    return cleaned;
  }

  const wert = String(Math.round(wahlleistung));
  warnings.push(
    `KRV Wahlleistungs-Differential: E2003502 = ${wert} ` +
    `((Gesamt-KV ${gesamtKv?.hoehe ?? '∅'} − Basis-KV ${basisKv?.hoehe ?? '∅'}) + ` +
    `(Gesamt-PV ${gesamtPv?.hoehe ?? '∅'} − Basis-PV ${basisPv?.hoehe ?? '∅'}))`,
  );
  cleaned.push({
    eCode: 'E2003502',
    anlage: 'VOR',
    kontextSubpath: 'Beitr_p_KV_PV_Inl/WL_Zvers',
    wert,
    rawValue: `${gesamtKv?.hoehe ?? ''} − ${basisKv?.hoehe ?? ''} + ${gesamtPv?.hoehe ?? ''} − ${basisPv?.hoehe ?? ''}`,
    person,
    pdfLabel: 'Wahlleistungs-/Zusatzversicherungs-Beiträge (KV + freiwillige PV)',
    valueType: 'int_euro',
    method: 'schema',
    confidence: 0.9,
    warnings: ['Computed: Wahlleistungs-Differential aus 4 Beitragsdaten-Blöcken.'],
  });
  return cleaned;
}

/** Hauptfunktion: ein Beleg → strukturierte Felder mit E-Codes. */
export function mapBeleg(input: BelegInput): MappingResult {
  let { belegTyp, person, rawText } = input;
  const warnings: string[] = [];

  if (belegTyp === 'Unbekannt') {
    const detected = detectBelegTyp(rawText);
    if (detected !== 'Unbekannt') {
      belegTyp = detected;
      warnings.push(`Beleg-Typ aus Titel erkannt: ${detected}`);
    }
  }

  const schema = getSchema(belegTyp);
  if (!schema) {
    return {
      belegTyp,
      person,
      felder: [],
      missingExpected: [],
      unmatched: [],
      warnings: [...warnings, `Kein Schema für Beleg-Typ ${belegTyp} verfügbar.`],
    };
  }

  const dict = extractLabelValues(rawText);

  // ─── Fix 4 (Hildburg Debeka): KRV-Block-Extractor ────────────────────
  // VaSt_KRV-Belege strukturieren ihre Daten in Beitragsdaten-Blöcken
  // (klassifizierende "Beitragsart"-Zeile + separater "Höhe"-Wert). Der
  // generische Extractor sieht nur Labels, nicht die wrap-around-Werte.
  // Wir injizieren block-extrahierte (label, hoehe)-Paare ins dict —
  // danach matcht das Schema-Driven-Matching ganz normal.
  let krvBlocks: KrvBlock[] = [];
  if (belegTyp === 'VaSt_KRV') {
    krvBlocks = extractKrvBeitragsdatenBlocks(rawText);
    for (const b of krvBlocks) {
      if (b.warning) {
        warnings.push(b.warning);
        continue;
      }
      if (!b.pdfLabel) continue;
      const key = normalizeLabel(b.pdfLabel);
      // Override: Block-Wert ist autoritativ (der generic-Extractor liefert
      // bei wrap-around-Werten nur Teilstücke oder gar nichts).
      dict[key] = [b.hoehe];
    }
  }

  const seenLabels = new Set<string>();
  const out: MappedField[] = [];
  const missingExpected: string[] = [];

  for (const field of schema.felder) {
    const candidates = [field.pdfLabel, ...(field.pdfLabelAliases ?? [])];
    let raw: string | null = null;
    let matchedLabel = field.pdfLabel;

    for (const label of candidates) {
      const key = normalizeLabel(label);
      seenLabels.add(key);
      const values = dict[key] ?? [];
      if (values.length > 0) {
        raw = values[0]; // erster Treffer; Mehrfach-Blöcke via repeatField unten
        matchedLabel = label;
        break;
      }
    }

    if (raw === null) {
      if (field.required) missingExpected.push(field.pdfLabel);
      continue;
    }

    const norm = normalize(raw, field.valueType);
    const branch = resolveContextBranch(belegTyp, rawText, field);
    if (branch.drop) {
      if (branch.warning) warnings.push(branch.warning);
      continue;
    }
    const fieldWarnings = [...norm.warnings];
    if (branch.warning) fieldWarnings.push(branch.warning);

    out.push({
      eCode: branch.eCode ?? field.eCode,
      anlage: field.anlage,
      kontextSubpath: branch.kontextSubpath,
      wert: norm.wert,
      rawValue: raw,
      person,
      pdfLabel: matchedLabel,
      valueType: field.valueType,
      method: 'schema',
      confidence: matchedLabel === field.pdfLabel ? 1.0 : 0.85,
      warnings: fieldWarnings.length > 0 ? fieldWarnings : undefined,
    });
  }

  // ─── LStB-Zeilennummer-Anker (3. Matching-Ebene) ─────────────────────
  // Die Vordruckzeilen-Nummer der Lohnsteuerbescheinigung (3=Brutto,
  // 4=LSt, ...) ist der employer-/layout-unabhängige Anker zu den
  // E-Codes. Gap-Filler: füllt Felder die das Label-Matching verpasst
  // hat (unbekannte Label-Wordings), via der stabilen Nummer. Läuft nur
  // für VaSt_LStB. Label-Match (confidence 1.0) gewinnt bei Konflikt —
  // wir fügen nur E-Codes hinzu die noch nicht in out[] stehen.
  if (belegTyp === 'VaSt_LStB') {
    const alreadyEmitted = new Set(out.map((f) => f.eCode));
    const zeilenHits = extractLstbByZeilennummer(rawText, person);
    for (const hit of zeilenHits) {
      if (alreadyEmitted.has(hit.field.eCode)) continue;
      out.push(hit.field);
      alreadyEmitted.add(hit.field.eCode);
      warnings.push(`LStB-Nr-Anker rettete ${hit.field.eCode} (Zeile ${hit.zeile}) — Label-Match hatte verpasst`);
    }
  }

  // Unmatched: Labels im Beleg, die NICHT vom Schema abgedeckt sind
  const unmatched: Array<{ label: string; value: string }> = [];
  for (const [normKey, values] of Object.entries(dict)) {
    if (seenLabels.has(normKey)) continue;
    if (values.length > 0) unmatched.push({ label: normKey, value: values[0] });
  }

  // Fix 2 (Live-Lauf Hildburg): LStB Steuerklasse-6-Routing
  let felderFinal = belegTyp === 'VaSt_LStB'
    ? postProcessLstbSteuerklasse6(out, warnings)
    : out;

  // Fix 5 (Live-Lauf Stricker): ESt1A Person-B-Code-Routing.
  // Wenn der Beleg für Person B gilt UND ESt1A-Identitäts-Felder enthält,
  // werden die E-Codes auf die Person-B-Slots im /ESt1A/Allg/B remappt.
  if (person === 'B') {
    felderFinal = postProcessEstlaPersonB(felderFinal, warnings);
  }

  // Fix 4 (Live-Lauf Hildburg): KRV Wahlleistungs-Differential.
  // Im Schema landet E2003502 anfangs als Gesamtbeitrag-KV (1781+456 = 2238).
  // ELSTER will dort aber NUR die Wahlleistungs-Differenz Gesamt − Basis.
  // Mit den krvBlocks haben wir auch den Gesamtbeitrag-PV — der trägt
  // ebenfalls zur E2003502-Summe bei wenn freiwillige Zusatz-PV bezahlt
  // wird.
  if (belegTyp === 'VaSt_KRV' && krvBlocks.length > 0) {
    felderFinal = postProcessKrvWahlleistung(felderFinal, krvBlocks, person, warnings);
  }

  return {
    belegTyp,
    person,
    felder: felderFinal,
    missingExpected,
    unmatched,
    warnings,
  };
}

// E-Codes, die LEGITIMATE per-Beleg-Werte tragen (verschiedene Renten haben
// unterschiedliche Versorgungsbeginn-Jahre; verschiedene LStBs haben separate
// Bemessungsgrundlagen-Versorgungsfreibetrag). Bei diesen wird NICHT
// aggregiert/Konflikt-flagged — sondern jedes Vorkommen bleibt eigenständig
// (lfd_nr wird gesetzt, damit XML-Generator später Einzelangaben rendern kann).
const PER_BELEG_NICHT_AGGREGIEREN: ReadonlySet<string> = new Set([
  'E0201307', // maßgebendes Kalenderjahr des Versorgungsbeginns
  'E0201003', // unterjähriger Versorgungsbezug: erster Monat
  'E0201203', // unterjähriger Versorgungsbezug: letzter Monat
  // (Steuerklasse E0200002 wird durch Fix 2 strukturell entfernt für StKl 6
  //  — daher hier nicht nötig.)
]);

/**
 * Aggregiert mehrere MappingResults zu einem Fall (z.B. 5 Bank-Belege für
 * Stricker → 1 KAP-Block mit Summen). Aggregation per
 * (anlage, kontextSubpath, eCode, person).
 *
 * Drei Fälle:
 *   1. Numerische Typen (int_euro/decimal_eur_cent) → Summe.
 *   2. PER_BELEG_NICHT_AGGREGIEREN-Felder → jedes Vorkommen mit eigener
 *      lfd_nr behalten, keine Konsolidierung.
 *   3. Sonstige nicht-numerische → erstes Vorkommen, Konflikt-Warning wenn
 *      verschiedene Werte.
 */
export function aggregate(results: MappingResult[]): MappedField[] {
  const buckets = new Map<string, MappedField[]>();

  for (const r of results) {
    for (const f of r.felder) {
      const key = `${f.anlage}|${f.kontextSubpath ?? ''}|${f.eCode}|${f.person}`;
      const arr = buckets.get(key) ?? [];
      arr.push(f);
      buckets.set(key, arr);
    }
  }

  const merged: MappedField[] = [];
  for (const [key, fields] of buckets.entries()) {
    if (fields.length === 1) {
      merged.push(fields[0]);
      continue;
    }
    const first = fields[0];

    // (2) per-Beleg-Felder: alle Vorkommen behalten, lfd_nr indizieren
    if (PER_BELEG_NICHT_AGGREGIEREN.has(first.eCode)) {
      for (let idx = 0; idx < fields.length; idx++) {
        merged.push({
          ...fields[idx],
          warnings: [
            ...(fields[idx].warnings ?? []),
            `Per-Beleg-Wert ${idx + 1}/${fields.length} (kein Aggregat)`,
          ],
        });
      }
      continue;
    }

    // (1) numerische Summe
    if (first.valueType === 'int_euro' || first.valueType === 'decimal_eur_cent') {
      const sum = fields.reduce((acc, f) => acc + parseEuro(f.wert), 0);
      const wert =
        first.valueType === 'int_euro' ? String(Math.round(sum)) : formatEuroCent(sum);
      merged.push({
        ...first,
        wert,
        rawValue: fields.map((f) => f.rawValue).join(' + '),
        confidence: Math.min(...fields.map((f) => f.confidence)),
        warnings: [`Aggregat aus ${fields.length} Belegen`],
      });
      continue;
    }

    // (3) sonstige nicht-numerische: erstes Vorkommen + Konflikt-Warning
    const distinct = new Set(fields.map((f) => f.wert));
    merged.push({
      ...first,
      warnings:
        distinct.size > 1
          ? [`Konflikt: ${fields.length} Belege liefern unterschiedliche Werte: ${[...distinct].join(' | ')}`]
          : undefined,
    });
  }
  return merged;
}

function parseEuro(s: string): number {
  // erwartet ELSTER-Format: "1234" oder "1234,56"
  const m = s.match(/^(-?)([0-9]+)(?:,(\d{1,2}))?$/);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  const int = Number(m[2]);
  const cents = m[3] ? Number(m[3].padEnd(2, '0').substring(0, 2)) / 100 : 0;
  return sign * (int + cents);
}

function formatEuroCent(n: number): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const int = Math.floor(abs);
  const cents = Math.round((abs - int) * 100);
  return `${sign}${int},${String(cents).padStart(2, '0')}`;
}
