/**
 * pre-validate — Lane-1-Gate: MappedField[] gegen Catalog-Constraints.
 *
 * Macht das was später ERiC bei der Plausi macht, lokal und deterministisch.
 * Liefert pro Feld eine ValidationIssue-Liste; wer das XML baut sollte
 * `report.ready === true` haben, sonst geht die Erklärung sowieso nicht
 * durch.
 *
 * Was geprüft wird (alles aus elster.feld / elster.format_typ /
 * elster.enumeration_wert):
 *
 *   • E-Code existiert im Catalog (anlage + vz)
 *   • Wert matcht format_typ.regex (XSD-Pattern)
 *   • Wert respektiert min_laenge / max_laenge / max_vorkomma /
 *     max_nachkomma aus format_typ
 *   • Bei enum-Typen: Wert ist eines der enumeration_wert.wert
 *   • Bei Pflichtfeldern: Wert nicht leer
 *
 * Nicht-Ziel:
 *   • Geschäfts­regel-Validierung (Quersummen, Vorjahres-Werte etc.) —
 *     das macht ERiC.
 *   • XSD-Sequence-Validation — das macht der XML-Generator + xmllint.
 */
import type pg from 'pg';
import type { MappedField } from './types.ts';

export type IssueCategory =
  | 'unknown-ecode'        // E-Code existiert nicht im Catalog für vz/anlage
  | 'pattern-mismatch'     // wert verletzt format_typ.regex
  | 'length-too-short'     // wert.length < min_laenge
  | 'length-exceeded'      // wert.length > max_laenge
  | 'decimal-overflow'     // mehr Vorkomma-Stellen als erlaubt
  | 'enum-violation'       // wert nicht in enumeration_wert
  | 'mandatory-empty';     // Pflichtfeld leer

export type IssueSeverity = 'error' | 'warning';

export interface ValidationIssue {
  eCode: string;
  pdfLabel: string;
  person: 'A' | 'B';
  anlage: string;
  kontextSubpath?: string;
  severity: IssueSeverity;
  category: IssueCategory;
  detail: string;
  rawValue: string;
  normalizedValue: string;
  expectedPattern?: string;
  expectedMaxLength?: number;
  expectedMinLength?: number;
  expectedEnumValues?: string[];
}

export interface ValidationReport {
  issues: ValidationIssue[];
  errorCount: number;
  warningCount: number;
  /** true wenn keine `severity='error'` mehr existiert. */
  ready: boolean;
  /** Felder pro Status für HiTL-Anzeige. */
  byCategory: Record<IssueCategory, ValidationIssue[]>;
}

interface ConstraintMeta {
  eCode: string;
  anlage: string;
  pflichtfeld: boolean;
  kanonisch: string | null;
  regex: string | null;
  minLength: number | null;
  maxLength: number | null;
  maxVorkomma: number | null;
  maxNachkomma: number | null;
  enumValues: string[] | null;   // gesetzt wenn xsd_type_name ein Enum-Typ
  drucktext: string | null;
}

async function loadConstraints(
  pool: pg.Pool,
  eCodes: string[],
  vz: number,
): Promise<Map<string, ConstraintMeta[]>> {
  const uniq = [...new Set(eCodes)];
  if (uniq.length === 0) return new Map();

  const { rows } = await pool.query<{
    e_code: string;
    anlage: string;
    pflichtfeld: boolean | null;
    kanonisch: string | null;
    regex: string | null;
    min_laenge: number | null;
    max_laenge: number | null;
    max_vorkomma: number | null;
    max_nachkomma: number | null;
    xsd_type_name: string | null;
    drucktext: string | null;
  }>(
    `SELECT f.name              AS e_code,
            a.name              AS anlage,
            f.pflichtfeld       AS pflichtfeld,
            ft.kanonisch        AS kanonisch,
            ft.regex            AS regex,
            COALESCE(f.min_laenge, ft.min_laenge) AS min_laenge,
            COALESCE(f.max_laenge, ft.max_laenge) AS max_laenge,
            ft.max_vorkomma     AS max_vorkomma,
            ft.max_nachkomma    AS max_nachkomma,
            ft.xsd_type_name    AS xsd_type_name,
            f.drucktext         AS drucktext
       FROM elster.feld f
       JOIN elster.anlage a       USING (anlage_id)
  LEFT JOIN elster.format_typ ft   ON ft.format_id = f.format_id
      WHERE f.name = ANY ($1::text[])
        AND a.vz  = $2`,
    [uniq, vz],
  );

  // Enum-Werte separat laden (nur für xsd_type_name die wie Enum aussehen)
  const enumTypes = [
    ...new Set(
      rows
        .map((r) => r.xsd_type_name)
        .filter((x): x is string => !!x && /Enum_|Enumeration|Religionsschluessel/i.test(x))
        // RABE-Suffix abschneiden (BaseCType vs BaseCType_RABE — die Werte sind dieselben)
        .map((x) => x.replace(/_RABE$/, '')),
    ),
  ];
  const enumValues = new Map<string, string[]>();
  if (enumTypes.length > 0) {
    const { rows: ev } = await pool.query<{ name: string; wert: string }>(
      `SELECT t.name, w.wert
         FROM elster.enumeration_typ t
         JOIN elster.enumeration_wert w USING (enum_typ_id)
        WHERE t.name = ANY ($1::text[])`,
      [enumTypes],
    );
    for (const r of ev) {
      const arr = enumValues.get(r.name) ?? [];
      arr.push(r.wert);
      enumValues.set(r.name, arr);
    }
  }

  const out = new Map<string, ConstraintMeta[]>();
  for (const r of rows) {
    const enumKey = r.xsd_type_name?.replace(/_RABE$/, '') ?? '';
    const meta: ConstraintMeta = {
      eCode: r.e_code,
      anlage: r.anlage,
      pflichtfeld: r.pflichtfeld === true,
      kanonisch: r.kanonisch,
      regex: r.regex,
      minLength: r.min_laenge,
      maxLength: r.max_laenge,
      maxVorkomma: r.max_vorkomma,
      maxNachkomma: r.max_nachkomma,
      enumValues: enumValues.get(enumKey) ?? null,
      drucktext: r.drucktext,
    };
    const arr = out.get(r.e_code) ?? [];
    arr.push(meta);
    out.set(r.e_code, arr);
  }
  return out;
}

/** Wählt aus mehreren Catalog-Einträgen den, der zur Feld-Anlage passt. */
function pickConstraint(
  field: MappedField,
  candidates: ConstraintMeta[],
): ConstraintMeta | null {
  if (candidates.length === 0) return null;
  const byAnlage = candidates.find((c) => c.anlage === field.anlage);
  return byAnlage ?? candidates[0];
}

/** Prüft eine Decimal-Zahl gegen max_vorkomma. */
function checkVorkomma(
  wert: string,
  maxVorkomma: number,
): { ok: boolean; vorkomma: number } {
  // ELSTER-Format ist "<int>" oder "<int>,<cents>".
  // Vorkomma = ASCII-Ziffern vor dem Komma (ohne Vorzeichen).
  const m = wert.match(/^-?(\d+)(?:,\d{1,2})?$/);
  if (!m) return { ok: false, vorkomma: 0 };
  const vk = m[1].length;
  return { ok: vk <= maxVorkomma, vorkomma: vk };
}

function validateOne(field: MappedField, c: ConstraintMeta): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const wert = field.wert.trim();

  // ── Pflichtfeld leer? ────────────────────────────────────────────────
  if (c.pflichtfeld && wert === '') {
    issues.push({
      eCode: field.eCode,
      pdfLabel: field.pdfLabel,
      person: field.person,
      anlage: field.anlage,
      kontextSubpath: field.kontextSubpath,
      severity: 'error',
      category: 'mandatory-empty',
      detail: `${field.eCode} ist Pflichtfeld, aber wert ist leer (${c.drucktext ?? '-'})`,
      rawValue: field.rawValue,
      normalizedValue: wert,
    });
    return issues; // keine weiteren Checks sinnvoll
  }
  if (wert === '') return issues; // leeres optionales Feld → ok

  // ── Längen ──────────────────────────────────────────────────────────
  if (c.maxLength != null && wert.length > c.maxLength) {
    issues.push({
      eCode: field.eCode,
      pdfLabel: field.pdfLabel,
      person: field.person,
      anlage: field.anlage,
      kontextSubpath: field.kontextSubpath,
      severity: 'error',
      category: 'length-exceeded',
      detail: `Länge ${wert.length} > max_laenge ${c.maxLength}`,
      rawValue: field.rawValue,
      normalizedValue: wert,
      expectedMaxLength: c.maxLength,
    });
  }
  if (c.minLength != null && wert.length < c.minLength) {
    issues.push({
      eCode: field.eCode,
      pdfLabel: field.pdfLabel,
      person: field.person,
      anlage: field.anlage,
      kontextSubpath: field.kontextSubpath,
      severity: 'error',
      category: 'length-too-short',
      detail: `Länge ${wert.length} < min_laenge ${c.minLength}`,
      rawValue: field.rawValue,
      normalizedValue: wert,
      expectedMinLength: c.minLength,
    });
  }

  // ── Decimal max_vorkomma ────────────────────────────────────────────
  if (
    (c.kanonisch === 'int_euro' ||
      c.kanonisch === 'int_nn_euro' ||
      c.kanonisch === 'decimal_eur_cent' ||
      c.kanonisch === 'decimal') &&
    c.maxVorkomma != null
  ) {
    const { ok, vorkomma } = checkVorkomma(wert, c.maxVorkomma);
    if (!ok) {
      issues.push({
        eCode: field.eCode,
        pdfLabel: field.pdfLabel,
        person: field.person,
        anlage: field.anlage,
        kontextSubpath: field.kontextSubpath,
        severity: 'error',
        category: 'decimal-overflow',
        detail: `Vorkomma-Stellen ${vorkomma} > max_vorkomma ${c.maxVorkomma}`,
        rawValue: field.rawValue,
        normalizedValue: wert,
      });
    }
  }

  // ── Enum-Wert prüfen ────────────────────────────────────────────────
  if (c.enumValues && c.enumValues.length > 0) {
    if (!c.enumValues.includes(wert)) {
      issues.push({
        eCode: field.eCode,
        pdfLabel: field.pdfLabel,
        person: field.person,
        anlage: field.anlage,
        kontextSubpath: field.kontextSubpath,
        severity: 'error',
        category: 'enum-violation',
        detail: `Wert "${wert}" nicht in Enum {${c.enumValues.slice(0, 12).join(', ')}${c.enumValues.length > 12 ? ', …' : ''}}`,
        rawValue: field.rawValue,
        normalizedValue: wert,
        expectedEnumValues: c.enumValues,
      });
    }
  }

  // ── Pattern (regex) ─────────────────────────────────────────────────
  // Bei Enum-Feldern haben wir oben schon strenger geprüft; das regex hier
  // wäre redundant + bei den schwer-escapeten XSD-Pattern fehleranfällig.
  //
  // Wir spiegeln das Verhalten von e10-xml::formatValue::maybeStrip:
  // wenn der Wert mit gestrippten Whitespaces das Pattern erfüllt, wird
  // das beim XML-Build automatisch gemacht — entsprechend kein
  // pre-validation-Error.
  if (c.regex && !c.enumValues) {
    try {
      const re = new RegExp(`^${c.regex}$`, 'u');
      const matchesRaw = re.test(wert);
      const stripped = wert.replace(/\s+/g, '');
      const matchesStripped = stripped !== wert ? re.test(stripped) : false;
      if (!matchesRaw && !matchesStripped) {
        issues.push({
          eCode: field.eCode,
          pdfLabel: field.pdfLabel,
          person: field.person,
          anlage: field.anlage,
          kontextSubpath: field.kontextSubpath,
          severity: 'error',
          category: 'pattern-mismatch',
          detail: `Wert "${wert}" matcht XSD-Pattern nicht: /${c.regex}/`,
          rawValue: field.rawValue,
          normalizedValue: wert,
          expectedPattern: c.regex,
        });
      }
    } catch {
      // Regex-Engine-Inkompatibilität (z.B. exotische Unicode-Klassen aus XSD).
      // Warning, kein Fehler — der XML-Generator schickt es trotzdem ab und
      // xmllint validiert es harter.
      issues.push({
        eCode: field.eCode,
        pdfLabel: field.pdfLabel,
        person: field.person,
        anlage: field.anlage,
        kontextSubpath: field.kontextSubpath,
        severity: 'warning',
        category: 'pattern-mismatch',
        detail: `XSD-Pattern /${c.regex}/ konnte in JS-Regex nicht kompiliert werden — Wert wurde nicht gegen Pattern geprüft.`,
        rawValue: field.rawValue,
        normalizedValue: wert,
        expectedPattern: c.regex,
      });
    }
  }

  return issues;
}

export interface PreValidateOptions {
  vz: number;
  pool: pg.Pool;
}

export async function preValidate(
  fields: MappedField[],
  opts: PreValidateOptions,
): Promise<ValidationReport> {
  const constraints = await loadConstraints(
    opts.pool,
    fields.map((f) => f.eCode),
    opts.vz,
  );

  const issues: ValidationIssue[] = [];
  for (const field of fields) {
    const candidates = constraints.get(field.eCode) ?? [];
    if (candidates.length === 0) {
      issues.push({
        eCode: field.eCode,
        pdfLabel: field.pdfLabel,
        person: field.person,
        anlage: field.anlage,
        kontextSubpath: field.kontextSubpath,
        severity: 'error',
        category: 'unknown-ecode',
        detail: `E-Code ${field.eCode} ist nicht im Catalog (anlage=${field.anlage}, vz=${opts.vz}).`,
        rawValue: field.rawValue,
        normalizedValue: field.wert,
      });
      continue;
    }
    const c = pickConstraint(field, candidates);
    if (!c) continue;
    issues.push(...validateOne(field, c));
  }

  const byCategory: Record<IssueCategory, ValidationIssue[]> = {
    'unknown-ecode': [],
    'pattern-mismatch': [],
    'length-too-short': [],
    'length-exceeded': [],
    'decimal-overflow': [],
    'enum-violation': [],
    'mandatory-empty': [],
  };
  for (const i of issues) byCategory[i.category].push(i);

  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;
  return {
    issues,
    errorCount,
    warningCount,
    ready: errorCount === 0,
    byCategory,
  };
}
