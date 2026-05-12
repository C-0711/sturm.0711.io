import { defineStage } from '../../../core/stage.ts';
import { MYOPIA_FIELDS, type MyopiaFieldKind } from '../data/fields.ts';

export interface MyopiaExtractInput { text: string; }

export type MyopiaExtractedValue = {
  kind: MyopiaFieldKind;
  value: string;
  numeric: number | null;
  unit: string | undefined;
  offset: number;
  context: string;
};

export interface MyopiaExtractedDoc {
  side: 'OD' | 'OS' | null;
  patientId: string | null;
  examDate: string | null;
  values: Record<MyopiaFieldKind, MyopiaExtractedValue | null>;
  missing: MyopiaFieldKind[];
  completeness: number;
}

const CORE: MyopiaFieldKind[] = [
  'axial_length_mm', 'axial_length_prev', 'days_since_prev',
  'spherical_equiv_d', 'k_mean_d', 'age_years',
];

export const myopiaExtractStage = defineStage<MyopiaExtractInput, MyopiaExtractedDoc, never>({
  id: 'myopia/extract',
  name: 'Myopia-Master-Feldextraktion',
  description: 'Regex-Extraction von Achslänge (aktuell + vorherig), SE, Km, Alter aus dem OCR-Volltext.',

  async run(input, ctx) {
    if (typeof input?.text !== 'string' || input.text.length === 0) {
      throw new Error('extract: input.text fehlt');
    }
    const text = input.text;
    const values: MyopiaExtractedDoc['values'] = Object.fromEntries(
      CORE.concat(['eye_side', 'patient_id', 'exam_date']).map((k) => [k, null]),
    ) as MyopiaExtractedDoc['values'];

    for (const pat of MYOPIA_FIELDS) {
      if (values[pat.kind]) continue;
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

    const side = values.eye_side?.value === 'OD' ? 'OD'
               : values.eye_side?.value === 'OS' ? 'OS' : null;
    const missing = CORE.filter((k) => values[k] === null);
    const completeness = (CORE.length - missing.length) / CORE.length;

    ctx.logger.info(
      `myopia/extract: ${CORE.length - missing.length}/${CORE.length} Felder erkannt`,
      { missing, side },
    );
    ctx.emit('myopia_extract_progress', { completeness, missing });

    const out: MyopiaExtractedDoc = {
      side,
      patientId: values.patient_id?.value ?? null,
      examDate: values.exam_date?.value ?? null,
      values, missing, completeness,
    };
    await ctx.artifacts.write('data/myopia-extract.json', out);
    return out;
  },
});
