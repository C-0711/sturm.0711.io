/**
 * Pentacam-Feldnamen mit deutschen + englischen Aliassen.
 *
 * Die Pentacam-Software gibt je nach Spracheinstellung (DE / EN) abweichende
 * Beschriftungen aus. Der OCR-Volltext kann zudem Tippfehler, fehlende
 * Sonderzeichen oder gebrochene Zeilenumbrüche enthalten. Die Aliases sind
 * deshalb absichtlich permissiv (`re` ist ein Regex-Pattern, kein wörtlicher
 * String).
 *
 * Quellen:
 *   - Pentacam AXL Instruction Manual G/70100/EN Rev04 (2021)
 *   - Belin/Ambrósio Enhanced Ectasia Display (BAD-D) — Belin, Ambrósio 2016
 *   - OCULUS Interpretation Guide 2024 (öffentlich)
 */

export type FieldKind =
  | 'k_anterior'         // K1, K2 anterior keratometry (D)
  | 'k_posterior'        // K1, K2 posterior keratometry (D)
  | 'astigmatism'        // dpt
  | 'pachymetry_apex'    // µm at corneal apex / pupil center
  | 'pachymetry_thinnest'// µm at thinnest point
  | 'thinnest_xy'        // x/y coordinates of thinnest pachymetry, in mm
  | 'bad_d'              // Belin/Ambrósio Final D
  | 'bad_df'             // Df — front elevation index
  | 'bad_db'             // Db — back elevation index
  | 'bad_dp'             // Dp — pachymetry progression index
  | 'bad_dt'             // Dt — thinnest pachymetry index
  | 'bad_da'             // Da — displacement (relational thickness) index
  | 'elev_front'         // Anterior elevation peak (µm)
  | 'elev_back'          // Posterior elevation peak (µm)
  | 'eye_side'           // 'OD' (right) | 'OS' (left)
  | 'patient_id'         // case-internal pseudonym
  | 'exam_date';

export interface FieldPattern {
  kind: FieldKind;
  /**
   * Anchor regex. Capture group 1 must be the numeric value (or string for
   * eye_side / patient_id / exam_date). Patterns are flagged `i` and `u`.
   */
  re: RegExp;
  /** Unit hint for downstream classifiers. */
  unit?: 'D' | 'µm' | 'mm' | 'index' | 'date' | 'string';
}

// Pattern library. ORDER MATTERS — the first match wins; place more
// specific patterns ahead of looser ones.
export const PENTACAM_FIELDS: FieldPattern[] = [
  // ── BAD-D Final + components — these are the load-bearing KC indices.
  { kind: 'bad_d',  re: /(?:bad[ -]?d|final[ -]?d|final\s+d-werte?|gesamt[- ]?d)\s*[:=]?\s*([+-]?\d+[.,]\d+)/iu,                                  unit: 'index' },
  { kind: 'bad_df', re: /\bdf\b\s*[:=]?\s*([+-]?\d+[.,]\d+)/iu,                                                                                    unit: 'index' },
  { kind: 'bad_db', re: /\bdb\b\s*[:=]?\s*([+-]?\d+[.,]\d+)/iu,                                                                                    unit: 'index' },
  { kind: 'bad_dp', re: /\bdp\b\s*[:=]?\s*([+-]?\d+[.,]\d+)/iu,                                                                                    unit: 'index' },
  { kind: 'bad_dt', re: /\bdt\b\s*[:=]?\s*([+-]?\d+[.,]\d+)/iu,                                                                                    unit: 'index' },
  { kind: 'bad_da', re: /\bda\b\s*[:=]?\s*([+-]?\d+[.,]\d+)/iu,                                                                                    unit: 'index' },

  // ── Pachymetry. Pentacam reports both apex/pupil-center and thinnest.
  { kind: 'pachymetry_apex',     re: /pachy(?:metrie)?[\s\S]{0,30}?(?:apex|pupille|pupil)[\s\S]{0,20}?(\d{3})\s*µm/iu,                              unit: 'µm' },
  { kind: 'pachymetry_thinnest', re: /(?:d(?:ü|u)nnste\s*stelle|thinnest|min(?:imum)?[ -]?pachy)[\s\S]{0,30}?(\d{3})\s*µm/iu,                       unit: 'µm' },

  // ── Keratometry. Pentacam shows K1/K2 vorne (anterior) and hinten (posterior).
  // We grab the first numeric immediately after K1/K2 within a 60-char window,
  // tagging anterior unless preceded by "post" / "hinten".
  { kind: 'k_anterior',  re: /(?<!post|hinten[\s\S]{0,15})\bK\s?1\b[\s\S]{0,30}?(\d{2}[.,]\d)\s*(?:D|dpt)/iu,                                       unit: 'D' },
  { kind: 'k_posterior', re: /(?:post|hinten)[\s\S]{0,30}?K\s?1[\s\S]{0,30}?([+-]?\d[.,]\d{1,2})\s*(?:D|dpt)/iu,                                    unit: 'D' },

  // ── Elevation peaks (µm; can be negative for depressions, positive for cones).
  { kind: 'elev_front', re: /(?:anteriore?\s*elevation|elev(?:ation)?\s*vorne|front\s*elev)[\s\S]{0,30}?([+-]?\d{1,3})\s*µm/iu,                     unit: 'µm' },
  { kind: 'elev_back',  re: /(?:posteriore?\s*elevation|elev(?:ation)?\s*hinten|back\s*elev)[\s\S]{0,30}?([+-]?\d{1,3})\s*µm/iu,                    unit: 'µm' },

  // ── Side: Pentacam header shows "OD" / "OS" or "R" / "L".
  { kind: 'eye_side',   re: /\b(OD|OS)\b/u,                                                                                                          unit: 'string' },

  // ── Patient-ID + Datum (heuristic, only used for context — never auth).
  // Patient identifier. Pentacam shows "Patient:", "Patient-ID:", "Pat-Nr.", "PatID" — be permissive.
  { kind: 'patient_id', re: /(?:patient(?:[ -]?id)?|pat[ -]?(?:id|nr)\.?)[\s:=._-]{0,6}([A-Z]{2,4}[ _-]?\d{3,8}|[A-Z0-9][A-Z0-9_-]{3,19})/iu,    unit: 'string' },
  { kind: 'exam_date',  re: /(?:datum|date)[\s\S]{0,8}?(\d{2}[./]\d{2}[./]\d{2,4})/iu,                                                              unit: 'date' },
];
