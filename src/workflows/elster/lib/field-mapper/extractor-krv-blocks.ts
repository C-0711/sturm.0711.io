/**
 * extractor-krv-blocks — Block-aware Parser für VaSt_KRV.
 *
 * Hintergrund:
 * Beitragsbescheinigungen privater KV-Anbieter (Debeka, AXA, …) sind als
 * "Beitragsdaten"-Blöcke strukturiert. Pro Block gibt es einen
 *
 *   Beitragsart                              <wickelt sich über bis zu 3 Zeilen>
 *   Beitragstragung                          …
 *   Einwilligung zur Übermittlung …          ja
 *   Beginn des Zeitraums …                   01.2024
 *   Ende des Zeitraums …                     12.2024
 *   Währung …                                EUR
 *   Höhe der geleisteten/erstatteten …       1.781,98
 *
 * Der Standard-Extractor sieht in jedem Block nur "Beitragsart" als Label
 * und übergeht die wrap-around-Wert-Zeilen — entsprechend matched das
 * Schema nichts. Dieser Block-Parser ist VaSt_KRV-spezifisch:
 *
 *   1. Text in Blöcke schneiden (Trennzeichen: "Beitragsdaten" Header).
 *   2. Pro Block die Beitragsart als KLASSIFIKATOR aufsammeln (multi-line
 *      Wert wird zusammengefügt).
 *   3. Die "Höhe der …"-Zeile als BETRAG abgreifen.
 *   4. Klassifikator → (eCode, kontextSubpath, valueType) mappen.
 *
 * Verwendung:
 *   const blocks = extractKrvBeitragsdatenBlocks(rawText);
 *   for (const b of blocks) {
 *     if (!b.eCode) continue; // unbekannte Beitragsart
 *     // emit MappedField(b.eCode, b.kontextSubpath, b.hoehe, …)
 *   }
 *
 * Anti-Goals:
 *   - Keine LLM-/Embedding-Klassifikation: das Match passiert per
 *     substring-Heuristik (deterministisch).
 *   - Keine Currency-Berechnung der Wahlleistungs-Differenz (Gesamt−Basis)
 *     — die wird im aggregate-Schritt oder über separate Felder modelliert.
 */

export interface KrvBlock {
  /** Klassifikator-Text aus dem "Beitragsart"-Feld (zusammengefügt aus
   *  ggf. mehreren Zeilen). */
  beitragsart: string;
  /** Roh-Betrag aus "Höhe der geleisteten/erstatteten Beiträge/Zuschüsse". */
  hoehe: string;
  /** Optional: TT.MM.JJJJ oder MM.JJJJ aus "Beginn des Zeitraums". */
  beginn?: string;
  /** Optional: TT.MM.JJJJ oder MM.JJJJ aus "Ende des Zeitraums". */
  ende?: string;
  /** Mapped E-Code falls Klassifikator erkannt; sonst undefined. */
  eCode?: string;
  /** Kontext-Pfad im XSD (z.B. 'Beitr_p_KV_PV_Inl'). */
  kontextSubpath?: string;
  /** Beschriftung im VaSt-PDF, identisch zu schemas.ts/pdfLabel. */
  pdfLabel?: string;
  /** Hinweis falls der Klassifikator NICHT zu einem E-Code gemappt wurde. */
  warning?: string;
}

/**
 * Klassifikator-Patterns für die Debeka-/AXA-/typischen privKV-
 * Beitragsarten. Reihenfolge ist relevant — wir matchen die SPEZIFISCHSTE
 * Regel zuerst, damit "Gesamtbeitrag zur Krankenversicherung
 * (Basisleistungen und Wahlleistungen)" nicht zufällig auf die
 * Basisleistungen-Regel fällt.
 */
interface Classifier {
  /** Wenn alle Sub-Strings im (lowercased) Beitragsart-Text drin sind,
   *  matched diese Regel. */
  contains: string[];
  /** Wenn IRGENDEINES dieser Sub-Strings im Text drin ist, matched die
   *  Regel NICHT (Negative-Filter — z.B. "wahlleistungen" disqualifiziert
   *  die "nur Basisabsicherung"-Regel). */
  not?: string[];
  eCode: string;
  kontextSubpath: string;
  pdfLabel: string;
}

const CLASSIFIERS: ReadonlyArray<Classifier> = [
  // (1) Gesamtbeitrag KV = Basis + Wahlleistungen — muss VOR den
  //     Basis-only-Regeln stehen
  {
    contains: ['gesamtbeitrag', 'krankenversicherung', 'wahlleistung'],
    eCode: 'E2003502',
    kontextSubpath: 'Beitr_p_KV_PV_Inl/WL_Zvers',
    pdfLabel: 'Gesamtbeitrag zur Krankenversicherung (Basisleistungen und Wahlleistungen)',
  },
  // (2) Gesamtbeitrag PV — Pflegepflicht + freiwillige Zusatz-PV
  {
    contains: ['gesamtbeitrag', 'pflegeversicherung', 'zusatzpflegeversicherung'],
    // Im VOR-Schema gibt es kein separates E-Code-Feld für „Gesamt-PV";
    // die Wahlleistungs-Differenz (Gesamt − Basis) fließt in E2003502
    // (gleicher Container wie Wahlleistungs-KV). Wir lassen eCode hier
    // bewusst leer — der aggregate-Schritt oder ein separater Schritt
    // im mapBeleg berechnet die Differenz und addiert sie zu E2003502.
    eCode: '',
    kontextSubpath: 'Beitr_p_KV_PV_Inl/WL_Zvers',
    pdfLabel: 'Gesamtbeitrag zur Pflegeversicherung',
  },
  // (3) Basis-KV ohne Krankengeldanspruch + ohne Zusatzbeitrag —
  //     darf nicht "wahlleistung" oder "gesamt" enthalten
  {
    contains: ['geleistete beiträge', 'krankenversicherung', 'basisleistung'],
    not: ['wahlleistung', 'gesamt'],
    eCode: 'E2003104',
    kontextSubpath: 'Beitr_p_KV_PV_Inl',
    pdfLabel: 'Geleistete Beiträge zur Krankenversicherung (ohne Krankengeldanspruch) ohne Zusatzbeitrag für Basisleistungen',
  },
  // (4) PV-Pflicht (soziale oder private Pflegepflichtversicherung)
  {
    contains: ['pflegepflichtversicherung'],
    not: ['gesamt', 'wahlleistung', 'zusatz'],
    eCode: 'E2003202',
    kontextSubpath: 'Beitr_p_KV_PV_Inl',
    pdfLabel: 'Geleistete Beiträge zur sozialen oder privaten Pflegepflichtversicherung',
  },
];

function classify(beitragsart: string): Classifier | null {
  const t = beitragsart.toLowerCase().replace(/\s+/g, ' ').trim();
  for (const c of CLASSIFIERS) {
    if (c.contains.every((s) => t.includes(s))) {
      if (c.not && c.not.some((s) => t.includes(s))) continue;
      return c;
    }
  }
  return null;
}

/** Erkennt ob eine Zeile ein neues "Feld" startet (Label am Zeilenanfang). */
function isFieldStart(line: string): boolean {
  if (line.length === 0) return false;
  // Beginnt mit Buchstabe (Label) — nicht mit Whitespace (Wert-Continuation).
  return /^[A-Za-zÄÖÜäöüß]/.test(line);
}

/**
 * Extrahiert den Wert nach einer fixen Label-Phrase, ggf. multi-line.
 *
 * Strategie: labelKey ist nur ein Prefix-Marker (z.B. "Höhe der geleisteten"
 * matched "Höhe der geleisteten/erstatteten Beiträge/Zuschüsse"). Der Wert
 * beginnt nach dem ERSTEN `\s{2,}`-Block in der Zeile — NICHT direkt nach
 * dem labelKey.
 */
function readFieldValue(
  lines: string[],
  startIdx: number,
  labelKey: string,
): { value: string; nextIdx: number } | null {
  const startLine = lines[startIdx];
  if (!startLine.toLowerCase().startsWith(labelKey.toLowerCase())) return null;
  // Wert beginnt nach dem ersten Doppel-Whitespace-Block in der Zeile.
  const sepMatch = startLine.match(/^(.+?)\s{2,}(\S.*)$/);
  const collected: string[] = [];
  if (sepMatch) {
    collected.push(sepMatch[2].trim());
  }
  // Continuation: alle nachfolgenden Zeilen, die mit Whitespace beginnen
  // (also kein neues Feld starten) ODER vollständig leer sind, falls noch
  // kein Wert-Token gesammelt wurde.
  let i = startIdx + 1;
  while (i < lines.length) {
    const l = lines[i];
    if (l.length === 0) { i += 1; continue; }
    if (isFieldStart(l)) break;
    collected.push(l.trim());
    i += 1;
  }
  return { value: collected.join(' ').replace(/\s+/g, ' ').trim(), nextIdx: i };
}

export function extractKrvBeitragsdatenBlocks(rawText: string): KrvBlock[] {
  const lines = rawText.split(/\r?\n/).map((l) => l.replace(/\s+$/, ''));
  // 1. Block-Grenzen: jede Zeile die nur "Beitragsdaten" enthält.
  const blockStarts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^Beitragsdaten\s*$/.test(lines[i].trim())) blockStarts.push(i);
  }
  if (blockStarts.length === 0) return [];

  // 2. Pro Block parsen
  const blocks: KrvBlock[] = [];
  for (let b = 0; b < blockStarts.length; b++) {
    const start = blockStarts[b] + 1;
    const end = b + 1 < blockStarts.length ? blockStarts[b + 1] : lines.length;
    const blockLines = lines.slice(start, end);
    let beitragsart = '';
    let hoehe = '';
    let beginn: string | undefined;
    let ende: string | undefined;

    for (let i = 0; i < blockLines.length; i++) {
      // Beitragsart (multi-line)
      const r1 = readFieldValue(blockLines, i, 'Beitragsart');
      if (r1 && !beitragsart) {
        beitragsart = r1.value;
        i = r1.nextIdx - 1;
        continue;
      }
      // Höhe (typisch single-line)
      const r2 = readFieldValue(blockLines, i, 'Höhe der geleisteten');
      if (r2 && !hoehe) {
        hoehe = r2.value;
        i = r2.nextIdx - 1;
        continue;
      }
      // Beginn / Ende (single-line, MM.JJJJ)
      const r3 = readFieldValue(blockLines, i, 'Beginn des Zeitraums');
      if (r3 && !beginn) {
        beginn = r3.value;
        i = r3.nextIdx - 1;
        continue;
      }
      const r4 = readFieldValue(blockLines, i, 'Ende des Zeitraums');
      if (r4 && !ende) {
        ende = r4.value;
        i = r4.nextIdx - 1;
        continue;
      }
    }

    if (!beitragsart || !hoehe) continue; // unvollständiger Block

    const c = classify(beitragsart);
    if (c) {
      blocks.push({
        beitragsart,
        hoehe,
        beginn,
        ende,
        eCode: c.eCode || undefined,
        kontextSubpath: c.kontextSubpath,
        pdfLabel: c.pdfLabel,
      });
    } else {
      blocks.push({
        beitragsart,
        hoehe,
        beginn,
        ende,
        warning: `Beitragsart nicht klassifiziert: "${beitragsart.slice(0, 80)}"`,
      });
    }
  }
  return blocks;
}
