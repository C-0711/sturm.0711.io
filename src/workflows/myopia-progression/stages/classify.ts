/**
 * myopia/classify — Progressions-Risiko nach IMI 2021 + Brien-Holden.
 *
 * Primärer Treiber: Δ-AL pro Jahr.
 *   < 0.10 mm/y  → green   (stable)
 *   0.10–0.20    → yellow  (slow progression)
 *   ≥ 0.20       → red     (fast progression — Atropin / Ortho-K Indikation)
 *
 * Sekundärer Modifikator: Alter. Junge Patienten (<10 J.) mit >0.15 mm/y
 * werden auf red eskaliert, weil ihre erwartete Lebens-Progression in
 * höhere AL-Werte mündet.
 *
 * Tertiärer Modifikator: aktuelle AL. > 26 mm → "high myopia"-Tag, weil
 * pathologische Myopie-Risiken (Netzhautablösung, myope Makulopathie)
 * exponentiell steigen.
 *
 * Disclaimer: kein klinischer Befund.
 */

import { defineStage } from '../../../core/stage.ts';
import type { MyopiaExtractedDoc } from './extract.ts';

export interface MyopiaClassifyInput { extracted: MyopiaExtractedDoc; }
export type RiskClass = 'green' | 'yellow' | 'red';

export interface MyopiaClassifyOutput {
  riskClass: RiskClass;
  score10: number;
  deltaAlPerYear: number | null;
  bandLabel: string;
  tags: string[];
  rationale: string[];
  caveats: string[];
  disclaimer: string;
}

const DISCLAIMER =
  'Progressions-Risk nach IMI/Brien-Holden-Schwellen. Kein klinischer Befund. ' +
  'Therapieentscheidung (Atropin, Ortho-K, Myopie-Brille) obliegt dem behandelnden Augenarzt.';

export const myopiaClassifyStage = defineStage<MyopiaClassifyInput, MyopiaClassifyOutput, never>({
  id: 'myopia/classify',
  name: 'Myopia-Progressions-Klassifikation',
  description: 'Bestimmt Progression nach Δ-AL/Jahr mit Alter + High-Myopia-Modifikatoren.',

  async run(input, ctx) {
    const e = input?.extracted;
    if (!e) throw new Error('classify: extracted fehlt');

    const alNow   = e.values.axial_length_mm?.numeric  ?? null;
    const alPrev  = e.values.axial_length_prev?.numeric ?? null;
    const days    = e.values.days_since_prev?.numeric  ?? null;
    const age     = e.values.age_years?.numeric        ?? null;
    const se      = e.values.spherical_equiv_d?.numeric ?? null;

    const rationale: string[] = [];
    const caveats:   string[] = [];
    const tags:      string[] = [];

    let deltaAlPerYear: number | null = null;
    if (alNow !== null && alPrev !== null && days !== null && days > 0) {
      const deltaMm = alNow - alPrev;
      deltaAlPerYear = (deltaMm / days) * 365;
    } else {
      caveats.push('Δ-AL nicht berechenbar — vorherige Messung oder Zeitabstand fehlt.');
    }

    let risk: RiskClass = 'green';
    if (deltaAlPerYear !== null) {
      const d = deltaAlPerYear;
      if (d >= 0.20)      { risk = 'red';    rationale.push(`Δ-AL ${d.toFixed(2)} mm/y ≥ 0.20 → fast progression`); }
      else if (d >= 0.10) { risk = 'yellow'; rationale.push(`Δ-AL ${d.toFixed(2)} mm/y ≥ 0.10 → slow progression`); }
      else                {                  rationale.push(`Δ-AL ${d.toFixed(2)} mm/y < 0.10 → stable`); }

      if (age !== null && age < 10 && d >= 0.15 && risk !== 'red') {
        risk = 'red';
        rationale.push(`Alter ${age} J. < 10 + Δ-AL ${d.toFixed(2)} mm/y → red (Lebensprogression hoch)`);
      }
    }

    if (alNow !== null && alNow >= 26.0) {
      tags.push('high-myopia');
      rationale.push(`AL ${alNow.toFixed(2)} mm ≥ 26.0 → high-myopia tag`);
      if (risk === 'green') risk = 'yellow';
    }

    if (se !== null && se <= -6.0) {
      tags.push('high-degree-myopia');
      rationale.push(`SE ${se.toFixed(2)} D ≤ -6.0 → high-degree-myopia tag`);
    }

    if (e.completeness < 0.5) {
      caveats.push(`Nur ${(e.completeness * 100).toFixed(0)} % Pflichtfelder erkannt — Score-Qualität reduziert.`);
    }

    const score10 =
      risk === 'red'    ? Math.min(10, Math.round(7 + (deltaAlPerYear ?? 0.2) * 10))
    : risk === 'yellow' ? Math.min(6,  Math.round(3 + (deltaAlPerYear ?? 0.1) * 15))
    :                     Math.max(0,  Math.round((deltaAlPerYear ?? 0) * 20));

    const bandLabel =
      deltaAlPerYear === null ? 'AL-Δ unbekannt' :
      risk === 'red'    ? `Δ-AL ${deltaAlPerYear.toFixed(2)} mm/y (fast)` :
      risk === 'yellow' ? `Δ-AL ${deltaAlPerYear.toFixed(2)} mm/y (slow)` :
                          `Δ-AL ${deltaAlPerYear.toFixed(2)} mm/y (stable)`;

    const out: MyopiaClassifyOutput = {
      riskClass: risk, score10, deltaAlPerYear, bandLabel,
      tags, rationale, caveats, disclaimer: DISCLAIMER,
    };
    ctx.logger.info(`myopia/classify: risk=${risk}, score=${score10}/10, Δ-AL=${deltaAlPerYear?.toFixed(2) ?? 'n/a'}`, { tags });
    ctx.emit('myopia_classify_decision', { riskClass: risk, score10, bandLabel, tags });

    await ctx.artifacts.write('data/myopia-classify.json', out);
    return out;
  },
});
