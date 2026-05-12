/**
 * pentacam/classify — Belin/Ambrósio Risk-Klassifikation.
 *
 * Schwellenwerte aus dem öffentlich publizierten Belin/Ambrósio Enhanced
 * Ectasia Display (Belin & Ambrósio 2016; OCULUS Interpretation Guide 2024,
 * S. 14 — "BAD-D ≥ 1.6 suspicious, ≥ 2.6 abnormal").
 *
 * Wir geben zwei Ausgaben aus:
 *   - `riskClass`: green | yellow | red — die drei klinisch handhabbaren
 *      Klassen, exakt so wie sie das Atlas-Console-UI rendert (v-lo / v-md /
 *      v-hi Tailwind-Coloring).
 *   - `score10`: 0..10 Skala, damit das UI "KC X/10" anzeigen kann analog
 *      zum Atlas-Console-Design-Mockup.
 *
 * Wichtig: KEINE diagnostische Aussage. Output ist ein **Risk-Score**, kein
 * Befund. Der Ophthalmologe diagnostiziert. Dieser Disclaimer landet im
 * Citation-Evidence-Artefakt und wandert mit in die GitChain-Truth-Bundle.
 */

import { defineStage } from '../../../core/stage.ts';
import type { PentacamExtractedDoc } from './extract.ts';

export interface PentacamClassifyInput {
  extracted: PentacamExtractedDoc;
}

export type RiskClass = 'green' | 'yellow' | 'red';

export interface PentacamClassifyOutput {
  riskClass: RiskClass;
  score10: number;          // 0..10, rounded
  bandLabel: string;        // human label, e.g. "BAD-D 3.4 (abnormal)"
  rationale: string[];      // ordered list of which thresholds triggered
  caveats: string[];        // data-quality caveats (e.g. low completeness)
  disclaimer: string;
  inputs: {
    badD: number | null;
    pachymetryThinnest: number | null;
    elevationBack: number | null;
    completeness: number;
  };
}

const DISCLAIMER =
  'Risk-Score nach Belin/Ambrósio-Schwellenwerten. Kein klinischer Befund. ' +
  'Indikationsstellung und Diagnose obliegen dem behandelnden Ophthalmologen.';

export const pentacamClassifyStage = defineStage<PentacamClassifyInput, PentacamClassifyOutput, never>({
  id: 'pentacam/classify',
  name: 'KC-Risk Klassifikation',
  description: 'Wendet die publizierten Belin/Ambrósio-Schwellen auf die extrahierten Pentacam-Indizes an.',

  async run(input, ctx) {
    const e = input?.extracted;
    if (!e) throw new Error('classify: extracted fehlt');

    const badD     = e.values.bad_d?.numeric ?? null;
    const pachyMin = e.values.pachymetry_thinnest?.numeric ?? null;
    const elevBack = e.values.elev_back?.numeric ?? null;

    const rationale: string[] = [];
    const caveats: string[]   = [];

    // Primary: Final BAD-D.
    let risk: RiskClass = 'green';
    if (badD !== null) {
      if (badD >= 2.6)      { risk = 'red';    rationale.push(`BAD-D ${badD.toFixed(2)} ≥ 2.6 → abnormal`); }
      else if (badD >= 1.6) { risk = 'yellow'; rationale.push(`BAD-D ${badD.toFixed(2)} ≥ 1.6 → suspicious`); }
      else                  {                  rationale.push(`BAD-D ${badD.toFixed(2)} < 1.6 → normal`); }
    } else {
      caveats.push('Final BAD-D nicht erkannt — Klassifikation auf Sekundär-Indizes gestützt.');
    }

    // Secondary: Pachymetrie dünnste Stelle. < 470 µm pathologisch, 470–500 grenzwertig.
    if (pachyMin !== null) {
      if (pachyMin < 470 && risk !== 'red') {
        risk = 'red';
        rationale.push(`Pachymetrie dünnste Stelle ${pachyMin} µm < 470 → abnormal`);
      } else if (pachyMin < 500 && risk === 'green') {
        risk = 'yellow';
        rationale.push(`Pachymetrie dünnste Stelle ${pachyMin} µm < 500 → grenzwertig`);
      } else if (pachyMin >= 500) {
        rationale.push(`Pachymetrie dünnste Stelle ${pachyMin} µm ≥ 500 → unauffällig`);
      }
    }

    // Tertiary: posteriore Elevations-Peak. > +20 µm KC-typisch.
    if (elevBack !== null) {
      if (elevBack >= 20 && risk !== 'red') {
        risk = 'yellow';
        rationale.push(`Posteriore Elevation +${elevBack} µm ≥ 20 → KC-typisch erhöht`);
      } else if (elevBack >= 30) {
        risk = 'red';
        rationale.push(`Posteriore Elevation +${elevBack} µm ≥ 30 → abnormal`);
      }
    }

    if (e.completeness < 0.5) {
      caveats.push(`Nur ${(e.completeness * 100).toFixed(0)} % der Pentacam-Felder erkannt — Score-Qualität reduziert.`);
    }

    // Map to 0..10 score for the UI. Same encoding the design-system table uses.
    const score10 =
      risk === 'red'    ? Math.min(10, Math.round(7 + (badD ?? 2.6) - 2.6))
    : risk === 'yellow' ? Math.min(6,  Math.round(4 + (badD ?? 1.6) - 1.6))
    :                     Math.max(0,  Math.round((badD ?? 0) * 2));

    const bandLabel =
      risk === 'red'    ? `BAD-D ${badD?.toFixed(2) ?? '—'} (abnormal)`
    : risk === 'yellow' ? `BAD-D ${badD?.toFixed(2) ?? '—'} (suspicious)`
    :                     `BAD-D ${badD?.toFixed(2) ?? '—'} (normal)`;

    const out: PentacamClassifyOutput = {
      riskClass: risk,
      score10,
      bandLabel,
      rationale,
      caveats,
      disclaimer: DISCLAIMER,
      inputs: { badD, pachymetryThinnest: pachyMin, elevationBack: elevBack, completeness: e.completeness },
    };

    ctx.logger.info(`pentacam/classify: risk=${risk}, score=${score10}/10`, { rationale });
    ctx.emit('pentacam_classify_decision', { riskClass: risk, score10, bandLabel });

    await ctx.artifacts.write('data/pentacam-classify.json', out);
    return out;
  },
});
