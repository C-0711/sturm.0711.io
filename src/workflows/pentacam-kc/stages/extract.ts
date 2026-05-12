/**
 * pentacam/extract — heuristische Feldextraktion aus Pentacam-OCR-Volltext.
 *
 * Bewusst regex-basiert für MVP. Vorteil: deterministisch, kein API-Key,
 * <50 ms pro Bericht. Nachteil: bricht bei schlechter OCR-Qualität oder
 * deutlich abweichendem Pentacam-Layout (z.B. uralten Software-Versionen).
 *
 * Upgrade-Pfad: Wenn die Trefferquote über realen Berichten unter ~95 %
 * fällt, ersetze diese Stage durch eine Anthropic/Constrained-Decoding-
 * Variante nach dem elster-v3-Pattern (Schema-as-Contract). Workflow-
 * Definition bleibt identisch — nur `uses` der Extract-Stage swappen.
 */

import { defineStage } from '../../../core/stage.ts';
import { PENTACAM_FIELDS, type FieldKind } from '../data/fields.ts';

export interface PentacamExtractInput {
  text: string;
}

export type PentacamExtractedValue = {
  kind: FieldKind;
  value: string;          // raw matched string, "30,5" or "OD" or "543"
  numeric: number | null; // parsed numeric form, comma → dot, null for non-numeric kinds
  unit: string | undefined;
  /** Char offset of capture group 1 in the source OCR text. Truth-layer anchor. */
  offset: number;
  /** Optional: short context window around the match for human review. */
  context: string;
};

export interface PentacamExtractedDoc {
  side: 'OD' | 'OS' | null;
  patientId: string | null;
  examDate: string | null;
  values: Record<FieldKind, PentacamExtractedValue | null>;
  missing: FieldKind[];
  /** Fraction of expected KC-indicating fields that were found. 0..1. */
  completeness: number;
}

const KC_CORE_FIELDS: FieldKind[] = [
  'bad_d', 'bad_df', 'bad_db', 'bad_dp', 'bad_dt', 'bad_da',
  'pachymetry_thinnest', 'pachymetry_apex',
  'k_anterior', 'elev_front', 'elev_back',
];

export const pentacamExtractStage = defineStage<PentacamExtractInput, PentacamExtractedDoc, never>({
  id: 'pentacam/extract',
  name: 'Pentacam-Feldextraktion',
  description: 'Regex-basierter Extract der Belin/Ambrósio-Indizes, Pachymetrie und Keratometrie aus dem OCR-Volltext.',

  async run(input, ctx) {
    if (typeof input?.text !== 'string' || input.text.length === 0) {
      throw new Error('extract: input.text fehlt oder leer');
    }
    const text = input.text;
    const values: PentacamExtractedDoc['values'] = Object.fromEntries(
      KC_CORE_FIELDS.concat(['eye_side', 'patient_id', 'exam_date']).map((k) => [k, null]),
    ) as PentacamExtractedDoc['values'];

    for (const pat of PENTACAM_FIELDS) {
      if (values[pat.kind]) continue; // first-hit wins, per pattern order
      const m = pat.re.exec(text);
      if (!m || m.index === undefined) continue;
      const raw = m[1];
      const offset = m.index + m[0].indexOf(raw);
      const numeric =
        pat.unit === 'string' || pat.unit === 'date'
          ? null
          : Number.parseFloat(raw.replace(',', '.'));
      values[pat.kind] = {
        kind: pat.kind,
        value: raw,
        numeric: Number.isFinite(numeric) ? numeric : null,
        unit: pat.unit,
        offset,
        context: text.slice(Math.max(0, offset - 30), offset + raw.length + 30).replace(/\s+/g, ' '),
      };
    }

    const side =
      values.eye_side?.value === 'OD' ? 'OD' :
      values.eye_side?.value === 'OS' ? 'OS' : null;
    const patientId = values.patient_id?.value ?? null;
    const examDate = values.exam_date?.value ?? null;

    const missing = KC_CORE_FIELDS.filter((k) => values[k] === null);
    const completeness = (KC_CORE_FIELDS.length - missing.length) / KC_CORE_FIELDS.length;

    ctx.logger.info(
      `pentacam/extract: ${KC_CORE_FIELDS.length - missing.length}/${KC_CORE_FIELDS.length} Felder erkannt (Completeness ${(completeness * 100).toFixed(0)} %)`,
      { missing, side },
    );
    ctx.emit('pentacam_extract_progress', { completeness, missing });

    // Truth-layer artifact: write the extracted JSON so per-stage GitChain
    // commit anchors it as part of the workflow snapshot.
    await ctx.artifacts.write('data/pentacam-extract.json', {
      side, patientId, examDate, values, missing, completeness,
    });

    return { side, patientId, examDate, values, missing, completeness };
  },
});
