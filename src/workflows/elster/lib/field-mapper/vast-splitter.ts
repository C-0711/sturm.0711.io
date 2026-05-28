/**
 * vast-splitter — Multi-Beleg-VAST-PDF in einzelne Beleg-Sections splitten.
 *
 * Hintergrund:
 * ELSTER liefert die "Vorausgefüllte Steuererklärung" (VaSt) wahlweise als
 * Einzel-PDFs pro Beleg ODER als ein gestapeltes Sammel-PDF mit allen
 * Belegen hintereinander. Im Sammel-PDF beginnt jede Section mit einem
 *
 *   Transferticket:              Steuer-Abruf
 *   Zuletzt abgerufen am:        DD.MM.YYYY HH:MM Uhr    …    Seite N
 *   Diese Bescheinigung wurde {übernommen|nicht übernommen}.
 *
 * gefolgt vom Beleg-Titel ("Religionszugehörigkeit", "Lohnsteuerbescheinigung
 * Verbandsgemeindewerke Abwasser", …) und den Daten.
 *
 * Anti-Goals:
 *   • Keine PDF-Page-Splitting; arbeiten auf pdftotext-Output.
 *   • Kein OCR; wenn pdftotext nichts liefert, ist's eh Lane-2-Sache.
 */

import { detectBelegTyp } from './mapper.ts';
import type { BelegTyp, Person } from './types.ts';
import type { HouseholdInfo, PersonInfo } from './triage.ts';

/** Eine Beleg-Section im Sammel-PDF. */
export interface VastSection {
  /** 0-based Position in der Section-Liste. */
  index: number;
  /** Rohtext dieser Section — beginnt mit "Transferticket:" oder
   *  am Anfang des PDF wenn der erste Beleg keinen Header hat. */
  text: string;
  /** Größe in chars (für triage minTextChars-check). */
  chars: number;
  /** "übernommen" vs "nicht übernommen" — kommt aus dem PDF selbst.
   *  Sections mit "nicht übernommen" sind oft die Religionen, die der
   *  User in ELSTER explizit nicht übernommen hat — die DATEN sind
   *  aber trotzdem korrekt und können extrahiert werden. */
  uebernommen: boolean;
  /** Aus dem Header: "Zuletzt abgerufen am: DD.MM.YYYY HH:MM Uhr".
   *  Optional; nur Anzeige-Zweck. */
  abrufdatum?: string;
}

const HEADER_RE = /^\s*Transferticket:\s*Steuer-Abruf\s*$/;
const UEBERNOMMEN_RE = /Diese Bescheinigung wurde\s+(nicht\s+)?übernommen\.?/i;
const ABRUF_RE = /Zuletzt abgerufen am:\s+([0-9.]+\s+[0-9:]+)/;

/**
 * Splittet einen pdftotext-Output in unabhängige Beleg-Sections.
 *
 * Algorithmus:
 *   1. Suche alle Zeilen-Indizes mit `Transferticket: Steuer-Abruf`
 *   2. Bei keinen Treffern → 1 Section (das ganze rawText)
 *   3. Bei N Treffern → N Sections, jede vom Header bis zum nächsten
 *      Header (oder Dateiende)
 *   4. Pro Section: extrahiere `uebernommen` und `abrufdatum` aus den
 *      ersten paar Zeilen
 */
export function splitVastText(rawText: string): VastSection[] {
  const lines = rawText.split(/\r?\n/);
  const headers: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (HEADER_RE.test(lines[i])) headers.push(i);
  }
  if (headers.length === 0) {
    // Single-Beleg-PDF — kein Sammel-Layout
    return [{
      index: 0,
      text: rawText,
      chars: rawText.length,
      uebernommen: true,
    }];
  }
  const sections: VastSection[] = [];
  for (let s = 0; s < headers.length; s++) {
    const start = headers[s];
    const end = s + 1 < headers.length ? headers[s + 1] : lines.length;
    const text = lines.slice(start, end).join('\n');
    const uebMatch = text.match(UEBERNOMMEN_RE);
    const uebernommen = uebMatch ? !uebMatch[1] : true;
    const abrMatch = text.match(ABRUF_RE);
    sections.push({
      index: s,
      text,
      chars: text.length,
      uebernommen,
      abrufdatum: abrMatch?.[1],
    });
  }
  return sections;
}

/**
 * Result of household-inference. Mehr Detail als nur HouseholdInfo —
 * zeigt welche IdNr in welchen Sections vorkommt + welche Belegtypen
 * sie touchen.
 */
export interface HouseholdResolution {
  household: HouseholdInfo;
  /** Pro IdNr: in welchen Section-Indices kam sie vor + welche
   *  BelegTypen-Hits. Zur Diagnose. */
  occurrences: Array<{
    idnr: string;
    sectionsCount: number;
    sectionIndices: number[];
    belegTypen: BelegTyp[];
    vorname?: string;
    nachname?: string;
  }>;
  warnings: string[];
}

/**
 * Leitet Household.personA + personB aus den IdNr-Vorkommen über alle
 * Sections ab.
 *
 * Heuristik:
 *   1. Pro Section: per detectBelegTyp() den BelegTyp bestimmen + IdNr
 *      via Regex finden.
 *   2. Häufigster IdNr (am meisten Sections) = Person A.
 *      Tie-break: IdNr in einem LStB/RBM-Beleg gewinnt vor IdNr nur in
 *      Religions-Belegen.
 *   3. Jede ANDERE IdNr = Person B (typischerweise Ehegatte mit
 *      eigener Religions-Section oder eigener LStB).
 *   4. Vorname/Nachname werden aus der ersten Section mit der jeweiligen
 *      IdNr gezogen (typisch ein LStB oder ein Stammdaten-Beleg).
 *
 * Wenn nur EINE IdNr im Dokument vorkommt → nur personA, keine personB.
 * Wenn ≥3 IdNrs → A = häufigste, B = zweithäufigste, Rest verworfen
 * mit Warning (typische Eingabe-Sanity-Issue).
 */
export function inferHousehold(sections: VastSection[]): HouseholdResolution {
  const warnings: string[] = [];
  const IDNR_RE = /\b(\d{2,3}\s?\d{3}\s?\d{3}\s?\d{2,3})\b/g;
  const LABELLED_IDNR_RE = /Identifikationsnummer[:\t ]+([0-9 ]{11,17})/i;
  // [:\t ] statt [:\s] — kein \n, sonst frisst "Vorname Hildburg\nName ..."
  // den nächsten Zeilen-Token mit ("Hildburg\nName").
  const VORNAME_RE = /\bVorname[:\t ]+([A-ZÄÖÜ][\wÄÖÜäöüß-]+(?:[ \t][A-ZÄÖÜ][\wÄÖÜäöüß-]+){0,2})/;
  const NACHNAME_RE = /\b(?:Nachname|Name)[:\t ]+([A-ZÄÖÜ][\wÄÖÜäöüß-]+(?:[ -][A-ZÄÖÜ][\wÄÖÜäöüß-]+){0,2})/;

  // BelegTypen die "starke" Identitäts-Signale tragen (echte Steuerdaten,
  // kein bloßer Religions-Beleg). Tie-break-Booster.
  const STRONG_TYPES: ReadonlySet<BelegTyp> = new Set([
    'VaSt_LStB', 'VaSt_RBM', 'VaSt_KRV', 'VaSt_Pers', 'VaSt_FSA',
  ]);

  type Acc = {
    sectionsCount: number;
    sectionIndices: number[];
    belegTypen: BelegTyp[];
    strongHit: boolean;
    vorname?: string;
    nachname?: string;
  };
  const byIdnr = new Map<string, Acc>();

  for (const sec of sections) {
    const belegTyp = detectBelegTyp(sec.text);

    // IdNr finden — bevorzugt mit Label, fallback loose-match.
    let idnr: string | undefined;
    const labelMatch = sec.text.match(LABELLED_IDNR_RE);
    if (labelMatch) {
      const digits = labelMatch[1].replace(/\s+/g, '');
      if (/^\d{11}$/.test(digits)) idnr = digits;
    }
    if (!idnr) {
      const head = sec.text.slice(0, 2500);
      const loose = head.match(IDNR_RE);
      if (loose && loose.length > 0) {
        const d = loose[0].replace(/\s+/g, '');
        if (d.length === 11) idnr = d;
      }
    }
    if (!idnr) continue;

    // Vor- und Nachname aus dieser Section
    const vm = sec.text.match(VORNAME_RE);
    const nm = sec.text.match(NACHNAME_RE);

    const acc: Acc = byIdnr.get(idnr) ?? {
      sectionsCount: 0,
      sectionIndices: [],
      belegTypen: [],
      strongHit: false,
    };
    acc.sectionsCount += 1;
    acc.sectionIndices.push(sec.index);
    if (!acc.belegTypen.includes(belegTyp)) acc.belegTypen.push(belegTyp);
    if (STRONG_TYPES.has(belegTyp)) acc.strongHit = true;
    if (!acc.vorname && vm) acc.vorname = vm[1].trim();
    if (!acc.nachname && nm) acc.nachname = nm[1].trim();
    byIdnr.set(idnr, acc);
  }

  // Ranking: Strong-Hit gewinnt > sectionsCount gewinnt > IdNr-alphabetisch
  const ranked = [...byIdnr.entries()]
    .map(([idnr, acc]) => ({ idnr, ...acc }))
    .sort((a, b) => {
      if (a.strongHit !== b.strongHit) return a.strongHit ? -1 : 1;
      if (a.sectionsCount !== b.sectionsCount) return b.sectionsCount - a.sectionsCount;
      return a.idnr.localeCompare(b.idnr);
    });

  const household: HouseholdInfo = {};
  if (ranked.length >= 1) {
    household.personA = {
      idnr: ranked[0].idnr,
      vorname: ranked[0].vorname,
      nachname: ranked[0].nachname,
    };
  }
  if (ranked.length >= 2) {
    household.personB = {
      idnr: ranked[1].idnr,
      vorname: ranked[1].vorname,
      nachname: ranked[1].nachname,
    };
  }
  if (ranked.length >= 3) {
    warnings.push(
      `${ranked.length} verschiedene IdNrs im Dokument — Person A/B als ` +
      `Top-2 angenommen, ignoriert: ${ranked.slice(2).map((r) => r.idnr).join(', ')}`,
    );
  }

  return {
    household,
    occurrences: ranked.map((r) => ({
      idnr: r.idnr,
      sectionsCount: r.sectionsCount,
      sectionIndices: r.sectionIndices,
      belegTypen: r.belegTypen,
      vorname: r.vorname,
      nachname: r.nachname,
    })),
    warnings,
  };
}

/**
 * Bequemlichkeit: pro VastSection bestimmt die zugewiesene Person aus
 * dem ermittelten Household, indem die in der Section vorkommende IdNr
 * gematcht wird.
 */
export function resolvePersonForSection(
  section: VastSection,
  household: HouseholdInfo,
): Person | 'unknown' {
  const a = household.personA;
  const b = household.personB;
  if (!a && !b) return 'unknown';
  // Direkter IdNr-Hit
  const labelMatch = section.text.match(/Identifikationsnummer[:\s]+([0-9 ]{11,17})/i);
  let idnr: string | undefined;
  if (labelMatch) {
    const d = labelMatch[1].replace(/\s+/g, '');
    if (/^\d{11}$/.test(d)) idnr = d;
  }
  if (idnr) {
    if (a?.idnr && a.idnr.replace(/\s+/g, '') === idnr) return 'A';
    if (b?.idnr && b.idnr.replace(/\s+/g, '') === idnr) return 'B';
  }
  // Fallback: Name-Match
  const vm = section.text.match(/\bVorname[:\t ]+([A-ZÄÖÜ][\wäöüÄÖÜß-]+)/);
  if (vm) {
    const v = vm[1].toLowerCase();
    if (a?.vorname && a.vorname.toLowerCase() === v) return 'A';
    if (b?.vorname && b.vorname.toLowerCase() === v) return 'B';
  }
  return 'unknown';
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Person-Attribution über den GLÄUBIGER-Namen — für Belege OHNE Steuer-IdNr
 * (typisch gescannte Bank-Steuerbescheinigungen: "Für (Gläubiger) Maria Ute
 * Stricker"). Da die VaSt für Person B oft nur die IdNr (keinen Namen) liefert,
 * wird der Vorname am Haushalts-Nachnamen erkannt und ggf. als Person B
 * GELERNT (Rückgabe `learned`).
 *
 *   - Steuer-IdNr im Beleg → eindeutiges A/B-Match (matched=true)
 *   - Vorname == personA/B.vorname → A/B (matched=true)
 *   - anderer Vorname + Haushalts-Nachname → B, `learned` gesetzt (matched=true)
 *   - sonst → A, matched=false (Default Hauptperson, KEIN positiver Treffer)
 *
 * `matched` erlaubt dem Aufrufer, bei Text-Sektionen ohne Treffer weiter zu
 * deferren statt blind auf A zu setzen.
 */
export function resolvePersonByName(
  rawText: string,
  household: HouseholdInfo,
): { person: Person; matched: boolean; learned?: { vorname: string; nachname: string } } {
  const a = household.personA;
  const b = household.personB;
  // (1) Steuer-IdNr-Match (selten auf Bank-Belegen, aber eindeutig)
  const compact = rawText.replace(/\s+/g, '');
  if (b?.idnr && compact.includes(b.idnr.replace(/\s+/g, ''))) return { person: 'B', matched: true };
  if (a?.idnr && compact.includes(a.idnr.replace(/\s+/g, ''))) return { person: 'A', matched: true };
  // (2) Gläubiger-Vorname am Haushalts-Nachnamen.
  const surname = a?.nachname ?? b?.nachname;
  if (!surname) return { person: 'A', matched: false };
  const first = (s?: string) => s?.trim().split(/\s+/)[0]?.toLowerCase();
  const aFirst = first(a?.vorname);
  const bFirst = first(b?.vorname);
  // "<Vorname[ Zweitname]> <Nachname>" — NUR auf EINER Zeile ([^\S\n] = WS ohne
  // Newline), Titlecase-Tokens; sonst zieht \s+ über Zeilenumbrüche Adress-/
  // Stadt-Tokens ("…Mainz\nHerrn Rainer Stricker") in den Namen.
  const re = new RegExp(`([A-ZÄÖÜ][a-zäöüß]+(?:[^\\S\\n]+[A-ZÄÖÜ][a-zäöüß]+){0,2})[^\\S\\n]+${escapeRe(surname)}`, 'gu');
  const givens: string[] = [];
  for (const mm of rawText.matchAll(re)) {
    const gv = mm[1].replace(/^(Herrn?|Frau|Fräulein|An)\b[^\S\n]*/i, '').trim();
    if (gv) givens.push(gv);
  }
  // (a) Bekannter Vorname gewinnt (zuverlässigstes Signal).
  for (const gv of givens) {
    const gf = first(gv);
    if (aFirst && gf === aFirst) return { person: 'A', matched: true };
    if (bFirst && gf === bFirst) return { person: 'B', matched: true };
  }
  // (b) Unbekannter Vorname + Haushalts-Nachname → Person B (Name lernen).
  for (const gv of givens) {
    const gf = first(gv);
    if (gf && aFirst && gf !== aFirst) {
      return { person: 'B', matched: true, learned: { vorname: gv, nachname: surname } };
    }
  }
  return { person: 'A', matched: false };
}
