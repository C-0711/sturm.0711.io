import { defineStage } from '../../../core/stage.ts';
import { getIndices, sammleElsterCodes } from '../lib/helpers.ts';

// ─── I/O-Typen ────────────────────────────────────────────────────────────

export interface CrossCheckInput {
  /** finalAnnotation (Merge-Ergebnis). */
  annotation: Record<string, unknown>;
  /** User-selektierte Anlagen. */
  gewaehlteAnlagen: string[];
  /** Vom Anlagen-Detector vorgeschlagene Anlagen (aktuell rein informativ). */
  erkannteAnlagen?: string[];
}

export interface CrossCheckOutput {
  /** Stimmen gewählte Anlagen mit gefundenen Codes überein? */
  passt: boolean;
  /** Aus Annotation abgeleitete Anlagen (erwartet ∪ unerwartet). */
  gefundene_anlagen: string[];
  /** Gewählte Anlagen (= Input). */
  erwartet: string[];
  /** Anlagen die Codes enthalten, aber nicht gewählt wurden. */
  unerwartet: string[];
  /** Gewählte Anlagen die keine Codes haben. */
  fehlend: string[];
  /** Codes ohne klare Anlagen-Zuordnung im codeIndex. */
  ohne_zuordnung: string[];
  /** Menschenlesbare Empfehlung. */
  empfehlung: string;
  /** Konfidenz der Empfehlung, 0..1. */
  konfidenz: number;
}

// ─── Stage-Run (Legacy server.mjs:2105-2166) ──────────────────────────────

export const crossCheckStage = defineStage<CrossCheckInput, CrossCheckOutput>({
  id: 'elster-cross-check',
  name: 'Cross-Check',
  description: 'Anlagen-Abgleich gegen gefundene Codes',

  async run(input, ctx) {
    if (!input?.annotation) throw new Error('cross-check: annotation fehlt');
    if (!Array.isArray(input?.gewaehlteAnlagen)) throw new Error('cross-check: gewaehlteAnlagen fehlt');

    const { codeIndex } = getIndices();
    const idx = codeIndex ?? new Map<string, Set<string>>();

    const codes = Array.from(sammleElsterCodes(input.annotation));
    const gewaehlt = new Set(input.gewaehlteAnlagen);

    const erwartetProAnlage = new Map<string, string[]>();
    const unerwartetProAnlage = new Map<string, string[]>();
    const ohneZuordnung: string[] = [];

    for (const c of codes) {
      const moeglich = idx.get(c);
      if (!moeglich || moeglich.size === 0) {
        ohneZuordnung.push(c);
        continue;
      }
      const ueberlapp = [...moeglich].filter(a => gewaehlt.has(a));
      const repr = ueberlapp.length ? ueberlapp.sort()[0] : [...moeglich].sort()[0];
      const bucket = ueberlapp.length ? erwartetProAnlage : unerwartetProAnlage;
      const liste = bucket.get(repr) || [];
      liste.push(c);
      bucket.set(repr, liste);
    }

    const gesamt = codes.length;
    const unerwCodes = [...unerwartetProAnlage.values()].reduce((s, arr) => s + arr.length, 0);
    const quote = gesamt > 0 ? unerwCodes / gesamt : 0;

    let empfehlung: string;
    let begruendung: string;
    let konfidenz: number;
    const unerwartetListe = [...unerwartetProAnlage.entries()].map(([anlage, c]) => ({ anlage, codes: c }));

    if (gesamt === 0) {
      empfehlung = 'uneindeutig';
      begruendung = 'Keine ELSTER-Codes in Annotation';
      konfidenz = 0.3;
    } else if (quote === 0) {
      empfehlung = 'passt';
      begruendung = `${gesamt} Codes, alle in erwarteten Anlagen (${[...erwartetProAnlage.keys()].join(', ')})`;
      konfidenz = 0.95;
    } else if (quote < 0.15) {
      empfehlung = 'passt';
      begruendung = `${gesamt} Codes, ${unerwCodes} vereinzelt ausserhalb (${unerwartetListe.map(u => u.anlage).join(', ')})`;
      konfidenz = 0.85;
    } else if (quote < 0.5) {
      empfehlung = 'erweitern';
      begruendung = `${(quote * 100).toFixed(0)}% Codes in nicht gewaehlten Anlagen: ${unerwartetListe.map(u => `${u.anlage}(${u.codes.length})`).join(', ')}`;
      konfidenz = 0.6;
    } else {
      empfehlung = 'neu_klassifizieren';
      const dom = [...unerwartetListe].sort((a, b) => b.codes.length - a.codes.length)[0];
      begruendung = `${(quote * 100).toFixed(0)}% der Codes gehoeren zu ${dom?.anlage}, nicht zu ${input.gewaehlteAnlagen.join(',')}`;
      konfidenz = 0.7;
    }

    const gefundene_anlagen = [...new Set([...erwartetProAnlage.keys(), ...unerwartetProAnlage.keys()])];
    const passt = empfehlung === 'passt';

    // "fehlend" — gewählte Anlagen, die gar keine Codes gefunden haben.
    const gefundenSet = new Set(gefundene_anlagen);
    const fehlend = input.gewaehlteAnlagen.filter(a => !gefundenSet.has(a));

    // "unerwartet" — Anlagen mit ausschliesslich nicht-gewählten Codes.
    const unerwartet = [...unerwartetProAnlage.keys()];

    const output: CrossCheckOutput = {
      passt,
      gefundene_anlagen,
      erwartet: [...input.gewaehlteAnlagen],
      unerwartet,
      fehlend,
      ohne_zuordnung: ohneZuordnung,
      empfehlung: `${empfehlung}: ${begruendung}`,
      konfidenz,
    };

    ctx.emit('cross_check_result', { passt, konfidenz });

    return output;
  },
});
