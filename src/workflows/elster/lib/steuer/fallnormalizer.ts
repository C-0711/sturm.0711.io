/**
 * fallnormalizer — die Erkennungs- und Normalisierungs-Schicht ZWISCHEN
 * Extraktion (runLane1) und Berechnung (authoritative).
 *
 * ════════════════════════════════════════════════════════════════════════
 *  WARUM diese Schicht existiert
 *  ─────────────────────────────
 *  Die BMF-MCP rechnet stur, was sie an eCodes bekommt: Grundtarif §32a auf
 *  das übergebene zvE. Sie kennt KEINE Fallstruktur — nicht ob zwei Belege
 *  zu einem Ehepaar gehören, nicht ob Steuerklasse 3 eine
 *  Zusammenveranlagung impliziert, nicht dass „Kirchensteuer des Partners"
 *  zur zweiten Person gehört.
 *
 *  Ohne Normalizer wird jedes Ehepaar als ZWEI Singles im Grundtarif
 *  gerechnet → der Splitting-Vorteil (§32a Abs. 5 EStG) geht verloren und die
 *  Nachzahlung ist grob falsch. Konkret für den Stricker-Fall: 6.372 €
 *  Nachzahlung statt ~566 € — ein Faktor >10.
 *
 *  Der Fallnormalizer leitet aus den rohen, je Beleg gemappten E-Code-
 *  Feldern + dem inferierten Household die STEUERLICHE FALLSTRUKTUR ab:
 *
 *    1. Veranlagungsart (§26 EStG) — Einzel- vs. Zusammenveranlagung.
 *       Signale: Steuerklasse (E0200002 ∈ {3,4,5} ⇒ verheiratet), zwei
 *       Personen im Haushalt, gemeinsamer Nachname, Partner-Kirchensteuer
 *       (E0200601). Jede Entscheidung wird begründet (begruendung[]) — HiTL
 *       kann sie nachvollziehen und überstimmen.
 *
 *    2. Feld-Zuordnung — die „Kirchensteuer des Partners" (E0200601) gehört
 *       zur Partnerperson, nicht zum Arbeitnehmer. In der Einzelveranlagung
 *       wird sie zu Person B umgehängt; in der Zusammenveranlagung landet sie
 *       ohnehin im gemeinsamen Anrechnungstopf.
 *
 *    3. Dubletten — KAP-Steuerabzüge, die centgenau identisch auf A UND B
 *       auftauchen, stammen i.d.R. aus EINER doppelt zugeordneten
 *       Bankbescheinigung. Wird markiert und die B-Kopie entfernt.
 *
 *    4. Glaubensverschiedene Ehe — unterschiedliche Religions-Schlüssel bei
 *       A und B → Kirchensteuer-Halbteilung greift; wird als Hinweis
 *       markiert (die Berechnung selbst ist eine separate Verfeinerung).
 * ════════════════════════════════════════════════════════════════════════
 */
import type { HouseholdInfo } from '../field-mapper/triage.ts';
import { parseEuro, type SteuerFeld } from './adapter.ts';

export type Veranlagungsart = 'einzeln' | 'zusammen';

/** Lohnsteuerklasse (Anlage N). */
const ECODE_STEUERKLASSE = 'E0200002';
/** „Einbehaltene Kirchensteuer des Partners" — gehört zur zweiten Person. */
const ECODE_KIST_PARTNER = 'E0200601';
/** Religions-Schlüssel A / B (ESt1A) — für glaubensverschiedene Ehe. */
const ECODE_RELIGION_A = 'E0100402';
const ECODE_RELIGION_B = 'E0101002';
/** Schlüssel ohne Kirchensteuerpflicht (vd = „nicht kirchensteuerpflichtig"). */
const RELIGION_OHNE_KIRCHE = new Set(['11', '0', '00']);
/** KAP-Steuerabzug-Block einer Bankbescheinigung — für Dubletten-Erkennung. */
const ECODE_KAP_BLOCK = new Set(['E1904701', 'E1904901', 'E1904801', 'E1900701']);

export interface NormPerson {
  rolle: 'A' | 'B';
  felder: SteuerFeld[];
}

export interface NormalisierterFall {
  veranlagungsart: Veranlagungsart;
  /** Felder je Person nach Reattribution/Dedup. Bei 'zusammen' werden A und
   *  B zu EINEM Splitting-Fall zusammengeführt, die Trennung bleibt aber für
   *  den __B-Suffix in der MCP erhalten. */
  personen: NormPerson[];
  /** Welche Signale zur Veranlagungs-Entscheidung geführt haben (HiTL). */
  begruendung: string[];
  warnungen: string[];
  /** Anteil der gemeinsamen ESt, auf den Kirchensteuer erhoben wird:
   *  1 = beide Ehegatten kirchensteuerpflichtig (volle KiSt, ggf. je Konfession
   *  hälftig, Summe = voll); 0.5 = glaubensverschiedene Ehe, nur EIN Ehegatte
   *  kirchensteuerpflichtig → KiSt nur auf dessen Hälfte (§ KiStG-Halbteilung);
   *  0 = keiner kirchensteuerpflichtig. Bei Einzelveranlagung bedeutungslos (1). */
  kistAnteil: number;
}

/** Steuerklasse einer Person (oder undefined). Nimmt die erste gefundene. */
function steuerklasse(felder: SteuerFeld[], person?: 'A' | 'B'): number | undefined {
  const f = (person ? felder.find((x) => x.eCode === ECODE_STEUERKLASSE && x.person === person) : undefined)
        ?? felder.find((x) => x.eCode === ECODE_STEUERKLASSE);
  if (!f) return undefined;
  const n = parseInt(f.wert.replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? n : undefined;
}

function hatPerson(p?: { vorname?: string; nachname?: string; idnr?: string }): boolean {
  return Boolean(p && (p.vorname || p.nachname || p.idnr));
}

/**
 * Erkennt die Veranlagungsart aus Steuerklasse, Household und Partner-Feldern.
 * Reine Funktion, einzeln testbar.
 */
export function erkenneVeranlagungsart(
  felder: SteuerFeld[],
  household: HouseholdInfo,
): { art: Veranlagungsart; begruendung: string[] } {
  const begruendung: string[] = [];
  const stkl = steuerklasse(felder);
  const beidePersonen = hatPerson(household.personA) && hatPerson(household.personB);
  const gleicherName = Boolean(
    household.personA?.nachname && household.personB?.nachname &&
    household.personA.nachname.trim().toLowerCase() === household.personB.nachname.trim().toLowerCase(),
  );
  const partnerKiSt = felder.some((f) => f.eCode === ECODE_KIST_PARTNER && (f.wert ?? '').trim() !== '');
  const feldA = felder.some((f) => f.person === 'A');
  const feldB = felder.some((f) => f.person === 'B');

  // Steuerklasse 3/5 ist nur als Ehegatten-Kombination (3+5) vergebbar;
  // StKl 4 nur für (beiderseits erwerbstätige) Verheiratete.
  if (stkl === 3 || stkl === 5) begruendung.push(`Steuerklasse ${stkl} → Ehegatten-Kombination 3/5 (verheiratet)`);
  else if (stkl === 4) begruendung.push('Steuerklasse 4 → verheiratet (beide erwerbstätig)');
  if (beidePersonen) begruendung.push('zwei Steuerpflichtige im Haushalt erkannt');
  if (gleicherName) begruendung.push(`gemeinsamer Nachname „${household.personA?.nachname}"`);
  if (partnerKiSt) begruendung.push('Feld „Kirchensteuer des Partners" (E0200601) vorhanden');

  const eheSignal =
    stkl === 3 || stkl === 4 || stkl === 5 ||
    (beidePersonen && (gleicherName || partnerKiSt));

  // Zusammenveranlagung nur, wenn ein Ehe-Signal vorliegt UND tatsächlich
  // zwei Steuerpflichtige beteiligt sind (sonst ist die zweite Seite leer).
  if (eheSignal && (beidePersonen || (feldA && feldB))) {
    begruendung.push('→ Zusammenveranlagung (Splittingtarif §32a Abs. 5)');
    return { art: 'zusammen', begruendung };
  }
  if (eheSignal) {
    begruendung.push('verheiratet erkannt, aber nur eine Person mit Feldern → vorerst Einzelveranlagung');
  } else {
    begruendung.push('keine Ehe-Signale → Einzelveranlagung (Grundtarif)');
  }
  return { art: 'einzeln', begruendung };
}

/** Religions-Schlüssel-Wert einer Person aus den Feldern (oder undefined). */
function religion(felder: SteuerFeld[], eCode: string): string | undefined {
  const f = felder.find((x) => x.eCode === eCode);
  return f?.wert?.trim() || undefined;
}

/**
 * Normalisiert den extrahierten Haushalt zu einem rechenbaren Fall:
 * Veranlagungsart erkennen, Felder reattribuieren, Dubletten entfernen.
 * Reine Funktion (kein I/O).
 */
export function normalisiereSteuerfall(
  felder: SteuerFeld[],
  household: HouseholdInfo,
): NormalisierterFall {
  const warnungen: string[] = [];
  const { art, begruendung } = erkenneVeranlagungsart(felder, household);

  // ── 1. KAP-Dubletten: centgenau identischer Bank-Steuerabzug auf A UND B.
  const kapSig = (p: 'A' | 'B') =>
    felder.filter((f) => f.person === p && ECODE_KAP_BLOCK.has(f.eCode))
          .map((f) => `${f.eCode}=${(f.wert ?? '').trim()}`)
          .sort()
          .join('|');
  const kapA = kapSig('A');
  const kapB = kapSig('B');
  let arbeit = felder;
  if (kapA && kapA === kapB) {
    warnungen.push(
      `KAP-Dublette: identischer Bankabzug auf A und B (${kapA}) — vermutlich EINE ` +
      'Bescheinigung doppelt zugeordnet; B-Kopie entfernt.',
    );
    arbeit = felder.filter((f) => !(f.person === 'B' && ECODE_KAP_BLOCK.has(f.eCode)));
  }

  // ── 2. Partner-Kirchensteuer (E0200601) gehört zur zweiten Person.
  //    NUR umhängen, wenn der Betrag > 0 ist: jede Lohnsteuerbescheinigung
  //    führt Nr. 7 „KiSt des Ehegatten" mit 0,00 als Formular-Platzhalter —
  //    ein Single würde sonst eine leere Person B mit zvE 0 spawnen.
  let partnerKiStUmgehaengt = false;
  arbeit = arbeit.map((f) => {
    if (f.eCode === ECODE_KIST_PARTNER && f.person === 'A' && art === 'einzeln'
        && (parseEuro(f.wert) ?? 0) > 0) {
      partnerKiStUmgehaengt = true;
      return { ...f, person: 'B' as const };
    }
    return f;
  });
  if (partnerKiStUmgehaengt) {
    warnungen.push('Kirchensteuer des Partners (E0200601) der Person B zugeordnet (Einzelveranlagung).');
  }

  // ── 3. Kirchensteuer-Anteil (nur Zusammenveranlagung relevant).
  //    Unbekannte/fehlende Religions-Schlüssel ⇒ konservativ als
  //    kirchensteuerpflichtig behandeln (KiSt war i.d.R. einbehalten).
  let kistAnteil = 1;
  if (art === 'zusammen') {
    const relA = religion(arbeit, ECODE_RELIGION_A);
    const relB = religion(arbeit, ECODE_RELIGION_B);
    const aKirche = relA === undefined || !RELIGION_OHNE_KIRCHE.has(relA);
    const bKirche = relB === undefined || !RELIGION_OHNE_KIRCHE.has(relB);
    if (!aKirche && !bKirche) {
      kistAnteil = 0;
      warnungen.push('Beide Ehegatten ohne Kirchensteuerpflicht → keine Kirchensteuer.');
    } else if (aKirche !== bKirche) {
      kistAnteil = 0.5;
      warnungen.push(
        `Glaubensverschiedene Ehe (Religion A=${relA ?? '—'}, B=${relB ?? '—'}): nur EIN ` +
        'Ehegatte kirchensteuerpflichtig → Kirchensteuer nach Halbteilungsgrundsatz nur ' +
        'auf dessen Hälfte der gemeinsamen ESt (kistAnteil 0.5).',
      );
    }
  }

  const personen: NormPerson[] = (['A', 'B'] as const)
    .map((rolle) => ({ rolle, felder: arbeit.filter((f) => f.person === rolle) }))
    .filter((p) => p.felder.length > 0);

  return { veranlagungsart: art, personen, begruendung, warnungen, kistAnteil };
}
