/**
 * Myopia-Master Felder.
 *
 * Quellen:
 *   - OCULUS Myopia Master Anwenderhandbuch (öffentlich)
 *   - IMI 2021 Clinical Management Guidelines (Wolffsohn et al.,
 *     Invest Ophthalmol Vis Sci 2019; Bullimore & Brennan 2019)
 *   - Brien Holden Vision Institute Myopia Progression Model
 */

export type MyopiaFieldKind =
  | 'axial_length_mm'     // current AL in mm
  | 'axial_length_prev'   // previous AL in mm (longitudinal)
  | 'days_since_prev'     // months between measurements (we'll convert)
  | 'spherical_equiv_d'   // SE refraction in D
  | 'k_mean_d'            // mean keratometry (anterior)
  | 'age_years'           // patient age (we round to int)
  | 'eye_side'            // OD | OS
  | 'patient_id'
  | 'exam_date';

export interface MyopiaFieldPattern {
  kind: MyopiaFieldKind;
  re: RegExp;
  unit?: 'mm' | 'D' | 'years' | 'months' | 'string' | 'date';
}

export const MYOPIA_FIELDS: MyopiaFieldPattern[] = [
  // ── Axial length, current vs previous. Myopia Master labels both.
  // Look for "AL aktuell 24,12 mm" / "Achslänge 24.12 mm" / "current AL 24.12".
  { kind: 'axial_length_mm',
    re: /(?:al(?:[ -]aktuell|[ -]?current)?|achs(?:en)?l(?:ä|a)nge|axial[ -]?length)[\s:=]{0,4}?(\d{2}[.,]\d{1,2})\s*mm/iu, unit: 'mm' },
  { kind: 'axial_length_prev',
    re: /(?:al[ -]?(?:vorherig|previous|vor)|prev[ -]?al|vor[ -]?messung)[\s:=]{0,4}?(\d{2}[.,]\d{1,2})\s*mm/iu, unit: 'mm' },

  // ── Inter-measurement gap. Myopia Master shows "Δt 6 Monate" or "180 Tage".
  { kind: 'days_since_prev',
    re: /(?:δt|delta[ -]?t|zeit\s*(?:abstand|seit\s*letzter))[\s:=]{0,4}?(\d{1,3})\s*(?:tag|day)/iu, unit: 'months' },

  // ── Spherical equivalent. "SE -3,50 D" / "Sph.Äq. -3.5 D".
  { kind: 'spherical_equiv_d',
    re: /(?:s(?:ph)?\.?[ -]?(?:ä|ae|e)q\.?|spherical[ -]?equivalent|se)[\s:=]{0,4}?([+-]?\d{1,2}[.,]\d{1,2})\s*(?:d|dpt)/iu, unit: 'D' },

  // ── Keratometry mean. "Km 43,2 D" / "K mean 43.2".
  { kind: 'k_mean_d',
    re: /\bk(?:\s?mean|m|[ -]mittel)\b[\s:=]{0,4}?(\d{2}[.,]\d{1,2})\s*(?:d|dpt)/iu, unit: 'D' },

  // ── Age in years.
  { kind: 'age_years',
    re: /(?:alter|age)\s*[:=]?\s*(\d{1,2})\s*(?:jahre?|j|y(?:ears?)?)/iu, unit: 'years' },

  // ── Side + identity.
  { kind: 'eye_side',   re: /\b(OD|OS)\b/u, unit: 'string' },
  { kind: 'patient_id', re: /(?:patient(?:[ -]?id)?|pat[ -]?(?:id|nr)\.?)[\s:=._-]{0,6}([A-Z]{2,4}[ _-]?\d{3,8}|[A-Z0-9][A-Z0-9_-]{3,19})/iu, unit: 'string' },
  { kind: 'exam_date',  re: /(?:datum|date)[\s:=]{0,8}?(\d{2}[./]\d{2}[./]\d{2,4})/iu, unit: 'date' },
];
