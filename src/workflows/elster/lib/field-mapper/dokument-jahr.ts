/**
 * dokument-jahr — erkennt das STEUERJAHR eines einzelnen Belegs aus seinem Text.
 *
 * Warum: ein Fall hat EINEN Veranlagungszeitraum (VZ). Wird z.B. in einen
 * VZ-2024-Fall eine Einkommensteuererklärung 2023 mitgeladen, dürfen deren
 * Werte NICHT in die Berechnung fließen (sie würden im aggregate() auf die
 * 2024-Werte aufsummiert — z.B. Bruttoarbeitslohn 2023 + 2024). Der Detektor
 * liefert das Belegjahr, damit lane1 fremdjährige Belege aus der Rechnung
 * heraushält und stattdessen als Vorjahres-Kontext (Prefill/Rückfrage) führt.
 *
 * Bewusst konservativ: nur ein Jahr DIREKT an einem steuerlichen Zeitraum-
 * Begriff zählt als „high". Bloße Datumsangaben (Geburtsdatum, Buchungstage)
 * werden nicht als Belegjahr fehlinterpretiert. Bei Mehrdeutigkeit → 'low'
 * (lane1 fragt nach), bei keinem Anker → 'none' (gilt als VZ, kein Eingriff).
 */

export type JahrConfidence = 'high' | 'low' | 'none';

export interface DokumentJahr {
  /** Erkanntes Steuerjahr des Belegs, oder null wenn nicht ableitbar. */
  jahr: number | null;
  /** high = eindeutiger Anker; low = mehrdeutig/schwach; none = kein Signal. */
  confidence: JahrConfidence;
  /** Menschlich lesbarer Beleg für die Erkennung (Logging/Audit). */
  evidence: string | null;
}

const PLAUSIBEL_MIN = 2000;
const PLAUSIBEL_MAX = 2099;

/**
 * Anker-Muster: ein vierstelliges Jahr UNMITTELBAR an einem Zeitraum-Begriff.
 * Reihenfolge = Stärke (das erste Muster gewinnt bei Gleichstand und liefert
 * die evidence-Beschriftung).
 */
const ANKER: Array<{ re: RegExp; label: string }> = [
  // ELSTER-/Steuersoftware-Druck: Seitenfußzeile „<Steuerjahr> Seite N von M".
  // Sehr verlässlich — steht auf jeder Seite und trägt das echte Veranlagungsjahr
  // (im Gegensatz zum Software-Banner „WISO Steuer 2024" oder dem Ausfertigungsdatum).
  { re: /\b(20\d{2})\s+Seite\s+\d+\s+von\s+\d+/gi, label: 'ELSTER-Seitenfuß' },
  { re: /Einkommensteuererkl[äa]rung\s+(20\d{2})/gi, label: 'Einkommensteuererklärung' },
  { re: /Lohnsteuerbescheinigung\s+f[üu]r\s+(?:das\s+(?:Kalender)?jahr\s+)?(20\d{2})/gi, label: 'Lohnsteuerbescheinigung für' },
  { re: /f[üu]r\s+das\s+(?:Kalender|Steuer|Leistungs)?jahr\s+(20\d{2})/gi, label: 'für das Jahr' },
  { re: /(?:Kalenderjahr|Steuerjahr|Leistungsjahr|Veranlagungszeitraum)\D{0,16}(20\d{2})/gi, label: 'Kalender-/Steuerjahr' },
  { re: /(?:bis|–|—|-)\s*31\.12\.(20\d{2})/gi, label: 'Zeitraum bis 31.12.' },
  { re: /Steuerbescheinigung[^\n]{0,40}?f[üu]r\s+(?:das\s+Kalenderjahr\s+)?(20\d{2})/gi, label: 'Steuerbescheinigung für' },
];

const plausibel = (y: number): boolean => y >= PLAUSIBEL_MIN && y <= PLAUSIBEL_MAX;

/** Häufigstes Jahr in einer Liste; bei Gleichstand das zuerst gesehene (Eingabe-Reihenfolge = Stärke). */
function dominant(years: number[]): { jahr: number; eindeutig: boolean } {
  const count = new Map<number, number>();
  for (const y of years) count.set(y, (count.get(y) ?? 0) + 1);
  let best = years[0];
  let bestN = -1;
  let tie = false;
  for (const [y, n] of count) {
    if (n > bestN) { best = y; bestN = n; tie = false; }
    else if (n === bestN && y !== best) tie = true;
  }
  return { jahr: best, eindeutig: count.size === 1 || (!tie && bestN > years.length - bestN) };
}

/**
 * Erkennt das Steuerjahr eines Belegs aus seinem Rohtext.
 *
 * @param text  pdftotext-/OCR-Rohtext des Belegs (eine Section).
 */
export function detectDokumentJahr(text: string, source?: string): DokumentJahr {
  if (text && text.length >= 4) {
    // 1. Verankerte Treffer sammeln (Jahr + Quelle-Label, Reihenfolge = Stärke).
    const hits: Array<{ jahr: number; label: string }> = [];
    for (const a of ANKER) {
      for (const m of text.matchAll(a.re)) {
        const y = parseInt(m[1], 10);
        if (plausibel(y)) hits.push({ jahr: y, label: a.label });
      }
    }
    if (hits.length) {
      const years = hits.map((h) => h.jahr);
      const distinct = [...new Set(years)];
      if (distinct.length === 1) {
        const h = hits[0];
        return { jahr: distinct[0], confidence: 'high', evidence: `${h.label} ${distinct[0]}` };
      }
      // Mehrere Jahre verankert → mehrdeutig. Bester Tipp = häufigstes/stärkstes.
      const { jahr } = dominant(years);
      return { jahr, confidence: 'low', evidence: `mehrdeutig: ${distinct.sort().join(', ')}` };
    }

    // 2. Kein Anker → blanke Jahreszahlen. Vorher Software-Banner („WISO Steuer
    //    2024") und Druckdatum („der Ausfertigung: 11.11.2025") entfernen — sonst
    //    überstimmt das Software-/Druckjahr das echte Steuerjahr. Dann sehr
    //    zurückhaltend: nur wenn EIN plausibles Jahr klar dominiert.
    const clean = text
      .replace(/WIS0?\s+Steuer\s+20\d{2}[^\n]*/gi, ' ')
      .replace(/der\s+Ausfertigung:[^\n]*/gi, ' ');
    const bare = [...clean.matchAll(/\b(20\d{2})\b/g)].map((m) => parseInt(m[1], 10)).filter(plausibel);
    if (bare.length >= 2) {
      const { jahr, eindeutig } = dominant(bare);
      const n = bare.filter((y) => y === jahr).length;
      if (eindeutig && n >= 2) return { jahr, confidence: 'low', evidence: `häufigstes Jahr ${jahr} (${n}×, ohne Anker)` };
    }
  }

  // 3. Fallback: Jahr aus dem Dateinamen (Belege werden oft „…2023….pdf" benannt).
  //    Nur 'low' — der Dateiname ist suggestiv, nicht maßgeblich.
  if (source) {
    const base = String(source).split(/[\\/]/).pop() ?? '';
    // Jahr ggf. von Unterstrichen umgeben („…_2023_…") → Nicht-Ziffer-Grenzen statt \b.
    const m = base.match(/(?<!\d)(20\d{2})(?!\d)/);
    if (m) {
      const y = parseInt(m[1], 10);
      if (plausibel(y)) return { jahr: y, confidence: 'low', evidence: `Dateiname „${base.slice(0, 40)}"` };
    }
  }

  return { jahr: null, confidence: 'none', evidence: null };
}
