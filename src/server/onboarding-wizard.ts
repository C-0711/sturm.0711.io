/**
 * 5-Fragen-Onboarding-Wizard für Neukunden ohne Vorjahres-Erklärung.
 *
 * Konvertiert ein typed Antwort-Shape in einen `CaseContext`, der
 * downstream identisch wie der Vorjahres-Kontext genutzt wird:
 *   • felderNarrow + phase3LlmFill engführen Extraktion auf
 *     `expected_anlagen` (bzw. `expected_ecodes_by_anlage`).
 *   • phase6BmfRechner nutzt `veranlagungsart` für Tarif-Wahl
 *     (Splitting vs. Grundtabelle).
 *   • UI rendert `daueranschnitte` (Pendlerpauschale-Schätzung etc.) als
 *     „Übernahme?"-Karten.
 *
 * Der Wizard ist absichtlich pur — kein I/O, kein Side-Effect. Persistenz
 * macht der HTTP-Handler in `onboarding-handler.ts`.
 */

import type { CaseContext } from './applications.ts';

export interface OnboardingAnswers {
  familienstand: 'ledig' | 'verheiratet' | 'geschieden' | 'verwitwet';
  /** Nur relevant wenn familienstand === 'verheiratet'. */
  veranlagung?: 'zusammen' | 'einzeln';
  /** Anzahl Kinder im Haushalt (0+). */
  kinder: number;
  einkunftsart: 'angestellt' | 'selbstaendig' | 'rentner' | 'beamter' | 'arbeitslos';
  /** Einfache Entfernung Wohnung→Arbeit in km. Nur wenn angestellt/beamter. */
  pendler_km_einfach?: number;
  /** Anzahl Arbeitstage im Jahr. Default 220. */
  pendler_tage_jahr?: number;
  konten_mit_ertraegen: 'keine' | 'tagesgeld' | 'depot' | 'mehrere';
  /** Multi-Select aus dem Wizard-Formular. */
  sonstiges: Array<
    | 'vermietung'
    | 'spenden'
    | 'krankheitskosten'
    | 'handwerker'
    | 'riester'
    | 'pendlerwohnung'
  >;
}

/** ELSTER-Anlagen-Code für „Entfernung Wohnung-Arbeit (km)". */
const ECODE_ENTFERNUNG_KM = 'E0203301';

/** Pendlerpauschale 2024: 0,30 €/km für die ersten 20 km (Vereinfachung). */
const PENDLERPAUSCHALE_PRO_KM = 0.3;

/**
 * Leitet die Belege ab, die für die per Wizard erwarteten Anlagen
 * typischerweise vorgelegt werden müssen. UI rendert das als Checkliste.
 */
function deriveMissingBelege(expectedAnlagen: string[]): string[] {
  const set = new Set(expectedAnlagen);
  const out: string[] = [];
  if (set.has('N')) out.push('Lohnsteuerbescheinigung 2024');
  if (set.has('KAP')) out.push('Kapitalertrags-Steuerbescheinigung 2024 (von Bank)');
  if (set.has('R')) out.push('Rentenbezugsmitteilung 2024');
  if (set.has('VOR')) out.push('KV/PV-Bescheinigung 2024 (falls nicht auf LStB)');
  return out;
}

/**
 * Reine Funktion — wandelt OnboardingAnswers in einen CaseContext um.
 *
 * Erwarteter Output (alle Pfade):
 *   • `source: 'onboarding'`
 *   • `setAt`: aktueller ISO-Timestamp
 *   • `expected_anlagen`: deduplizierte Anlagen-Liste, immer mit ESt1A.
 *   • optional: `daueranschnitte` (z.B. Pendler-Schätzung).
 *   • optional: `missing_belege_erwartet` (Checkliste).
 */
export function runOnboardingWizard(answers: OnboardingAnswers): CaseContext {
  if (!answers || typeof answers !== 'object') {
    throw new Error('onboarding-wizard: answers required');
  }

  // ── 1) Anlagen-Ableitung ──────────────────────────────────────────
  const anlagen = new Set<string>(['ESt1A']);

  if (answers.kinder > 0) anlagen.add('Kind');

  switch (answers.einkunftsart) {
    case 'angestellt':
      anlagen.add('N');
      anlagen.add('VOR');
      break;
    case 'selbstaendig':
      anlagen.add('S');
      anlagen.add('VOR');
      break;
    case 'rentner':
      anlagen.add('R');
      anlagen.add('VOR');
      break;
    case 'beamter':
      // Beamte erhalten Versorgungsbezüge — Anlage N greift weiterhin.
      anlagen.add('N');
      break;
    case 'arbeitslos':
      // ALG/ALG-II laufen über Hauptvordruck (Progressionsvorbehalt) — keine
      // dedizierte Einkunfts-Anlage zwingend nötig.
      break;
  }

  if (answers.konten_mit_ertraegen && answers.konten_mit_ertraegen !== 'keine') {
    anlagen.add('KAP');
  }

  const sonstiges = Array.isArray(answers.sonstiges) ? answers.sonstiges : [];
  if (sonstiges.includes('vermietung')) anlagen.add('V');
  if (sonstiges.includes('spenden')) anlagen.add('SA');
  if (sonstiges.includes('krankheitskosten')) anlagen.add('AgB');
  if (sonstiges.includes('handwerker')) anlagen.add('HA_35a');
  if (sonstiges.includes('riester')) anlagen.add('AV');

  const expected_anlagen = [...anlagen];

  // ── 2) Veranlagungsart ────────────────────────────────────────────
  let veranlagungsart: CaseContext['veranlagungsart'];
  if (answers.familienstand === 'verheiratet') {
    veranlagungsart =
      answers.veranlagung === 'einzeln' ? 'einzelveranlagung' : 'zusammenveranlagung';
  } else {
    // ledig / geschieden / verwitwet → Grundtabelle
    veranlagungsart = 'ledig';
  }

  // ── 3) Daueranschnitte (Pendlerpauschale-Schätzung) ───────────────
  const daueranschnitte: NonNullable<CaseContext['daueranschnitte']> = [];
  const km = Number(answers.pendler_km_einfach);
  if (Number.isFinite(km) && km > 0 &&
      (answers.einkunftsart === 'angestellt' || answers.einkunftsart === 'beamter')) {
    const tage = Number.isFinite(Number(answers.pendler_tage_jahr)) && Number(answers.pendler_tage_jahr) > 0
      ? Number(answers.pendler_tage_jahr)
      : 220;
    const wert = Math.round(km * tage * PENDLERPAUSCHALE_PRO_KM * 100) / 100;
    daueranschnitte.push({
      eCode: ECODE_ENTFERNUNG_KM,
      label: `Entfernungspauschale Wizard-Schätzung: ${km} km × ${tage} Tage × 0,30 €`,
      wert,
      einheit: 'EUR',
      quelle: 'onboarding-wizard',
      status: 'vorgeschlagen',
    });
  }

  // ── 4) Kontext zusammenbauen ──────────────────────────────────────
  const ctx: CaseContext = {
    source: 'onboarding',
    setAt: new Date().toISOString(),
    expected_anlagen,
    veranlagungsart,
    anzahl_kinder: Number.isFinite(answers.kinder) ? Math.max(0, Math.trunc(answers.kinder)) : 0,
  };

  if (daueranschnitte.length > 0) {
    ctx.daueranschnitte = daueranschnitte;
  }

  const missing = deriveMissingBelege(expected_anlagen);
  if (missing.length > 0) {
    ctx.missing_belege_erwartet = missing;
  }

  return ctx;
}

/**
 * Validiert das Input-Shape vor dem Mapping. Wirft `Error` mit menschen-
 * lesbarer Meldung, die der HTTP-Handler als 400 weiterreicht.
 */
export function validateOnboardingAnswers(input: unknown): OnboardingAnswers {
  if (!input || typeof input !== 'object') {
    throw new Error('OnboardingAnswers: body must be an object');
  }
  const a = input as Record<string, unknown>;

  const familienstand = a.familienstand;
  if (familienstand !== 'ledig' && familienstand !== 'verheiratet'
      && familienstand !== 'geschieden' && familienstand !== 'verwitwet') {
    throw new Error('familienstand: ledig|verheiratet|geschieden|verwitwet required');
  }

  if (familienstand === 'verheiratet'
      && a.veranlagung !== 'zusammen' && a.veranlagung !== 'einzeln') {
    throw new Error('veranlagung: zusammen|einzeln required (verheiratet)');
  }

  const einkunftsart = a.einkunftsart;
  if (einkunftsart !== 'angestellt' && einkunftsart !== 'selbstaendig'
      && einkunftsart !== 'rentner' && einkunftsart !== 'beamter'
      && einkunftsart !== 'arbeitslos') {
    throw new Error('einkunftsart: angestellt|selbstaendig|rentner|beamter|arbeitslos required');
  }

  const konten = a.konten_mit_ertraegen;
  if (konten !== 'keine' && konten !== 'tagesgeld' && konten !== 'depot' && konten !== 'mehrere') {
    throw new Error('konten_mit_ertraegen: keine|tagesgeld|depot|mehrere required');
  }

  const kinder = Number(a.kinder);
  if (!Number.isFinite(kinder) || kinder < 0) {
    throw new Error('kinder: non-negative number required');
  }

  const sonstiges = Array.isArray(a.sonstiges) ? a.sonstiges : [];
  const allowed = new Set([
    'vermietung', 'spenden', 'krankheitskosten', 'handwerker', 'riester', 'pendlerwohnung',
  ]);
  for (const s of sonstiges) {
    if (typeof s !== 'string' || !allowed.has(s)) {
      throw new Error(`sonstiges: unknown option ${String(s)}`);
    }
  }

  return {
    familienstand,
    veranlagung: a.veranlagung as OnboardingAnswers['veranlagung'],
    kinder: Math.max(0, Math.trunc(kinder)),
    einkunftsart,
    pendler_km_einfach: Number.isFinite(Number(a.pendler_km_einfach))
      ? Number(a.pendler_km_einfach)
      : undefined,
    pendler_tage_jahr: Number.isFinite(Number(a.pendler_tage_jahr))
      ? Number(a.pendler_tage_jahr)
      : undefined,
    konten_mit_ertraegen: konten,
    sonstiges: sonstiges as OnboardingAnswers['sonstiges'],
  };
}
