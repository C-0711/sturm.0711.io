/**
 * Cross-Validator — deterministic per-field rule engine.
 *
 * Runs exact algorithms (mod-97 IBAN checksum, BMF IDNr-Prüfziffer,
 * sum-checks, regex, range checks) against fields in the extraction.
 * Output: list of violations + global pass flag. No heuristics, no LLM.
 *
 * Built-in rule kinds (extensible):
 *   - iban-checksum           Mod-97-10 over rearranged digits
 *   - german-tax-idnr         11-digit Prüfziffer per BMF spec
 *   - steuernummer-format     Regional 10–13 digit format (loose)
 *   - sum-check               fields:[a,b,...] expected total c (±tolerance)
 *   - date-iso / date-de      Valid date, optional range
 *   - enum                    Value in allowed list
 *   - regex                   Custom regex match
 *   - range                   Number in [min, max]
 *   - required-nonempty       Value present and not "" / null / undefined
 */
import { defineStage } from '../../core/stage.ts';

export interface CrossValidatorInput {
  /** The extraction. Field paths in rules are dotted: "lohn.bruttoarbeitslohn". */
  extracted: unknown;
  /**
   * Optional per-leaf metadata from container-field-mapper. When provided AND
   * `config.rules` is empty, rules are auto-generated from container atoms:
   *   - `datentyp: idnr` → german-tax-idnr rule (severity block)
   *   - `datentyp: iban` → iban-checksum rule (severity block)
   *   - `metadata.formatRegex` → regex rule (severity warn)
   *   - `metadata.pflicht: true` → required-nonempty rule (severity block)
   */
  field_meta?: Record<string, {
    ecode?: string;
    drucktext?: string;
    anlage?: string;
    vordruckzeile?: string;
    datentyp?: string;
    formatRegex?: string | null;
    pflicht?: boolean;
  } | null>;
}

export interface ValidationViolation {
  field: string;
  kind: string;
  severity: 'block' | 'warn' | 'info';
  msg: string;
  expected?: unknown;
  actual?: unknown;
}

export interface CrossValidatorOutput {
  validated: unknown;     // input + `_validation` summary
  violations: ValidationViolation[];
  pass: boolean;          // no block-level violations
  ms: number;
}

export type RuleKind =
  | 'iban-checksum'
  | 'german-tax-idnr'
  | 'steuernummer-format'
  | 'sum-check'
  | 'date-iso'
  | 'date-de'
  | 'enum'
  | 'regex'
  | 'range'
  | 'required-nonempty';

export interface RuleSpec {
  /** Dotted path to the field — sum-check ignores this and uses `args.fields[]`. */
  field: string;
  kind: RuleKind;
  severity?: 'block' | 'warn' | 'info';
  args?: Record<string, unknown>;
}

export interface CrossValidatorConfig {
  /**
   * Explicit rules — wins over auto-generation when present.
   * If empty/omitted AND `input.field_meta` is provided, rules are auto-derived
   * from the container atoms.
   */
  rules?: RuleSpec[];
  /**
   * Severity to use for auto-generated regex rules (from `metadata.formatRegex`).
   * Default 'warn' — formatRegex from BMF is informative but the LLM extractor
   * has already converted German formats, so strict-block would be too aggressive.
   */
  autoRegexSeverity?: 'block' | 'warn' | 'info';
}

/**
 * Translate container atom metadata into validator rules. Called when no
 * explicit `config.rules` is provided. Each atom yields up to 3 rules:
 *   - required-nonempty (if pflicht)
 *   - kind-specific (idnr / iban / datum)
 *   - regex (always, severity=warn by default)
 */
function autoGenerateRules(
  fieldMeta: NonNullable<CrossValidatorInput['field_meta']>,
  regexSeverity: 'block' | 'warn' | 'info',
): RuleSpec[] {
  const rules: RuleSpec[] = [];
  for (const [path, m] of Object.entries(fieldMeta)) {
    if (!m) continue;
    if (m.pflicht) {
      rules.push({ field: path, kind: 'required-nonempty', severity: 'block' });
    }
    const dt = (m.datentyp || '').toLowerCase();
    if (dt === 'idnr' || dt === 'identifikationsnummer') {
      rules.push({ field: path, kind: 'german-tax-idnr', severity: 'block' });
    } else if (dt === 'iban') {
      rules.push({ field: path, kind: 'iban-checksum', severity: 'block' });
    } else if (dt === 'date' || dt === 'datum') {
      rules.push({ field: path, kind: 'date-de', severity: 'warn' });
    }
    // Schema-level regex from BMF — warn-level by default since the extractor
    // usually has already converted German-formatted numbers to JSON numbers.
    if (m.formatRegex) {
      rules.push({ field: path, kind: 'regex', severity: regexSeverity, args: { pattern: m.formatRegex } });
    }
  }
  return rules;
}

// ── Path access ────────────────────────────────────────────────────────────
function getByPath(root: unknown, dotted: string): unknown {
  if (!dotted) return root;
  let cur: unknown = root;
  for (const part of dotted.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    const m = part.match(/^([^[]+)(?:\[(\d+)\])?$/);
    if (!m) return undefined;
    cur = (cur as Record<string, unknown>)[m[1]];
    if (m[2] !== undefined && Array.isArray(cur)) cur = cur[Number(m[2])];
  }
  return cur;
}

// ── Rule implementations ───────────────────────────────────────────────────
function checkIban(raw: string): { ok: boolean; reason?: string } {
  const iban = raw.replace(/\s+/g, '').toUpperCase();
  if (iban.length < 15 || iban.length > 34) return { ok: false, reason: 'length out of 15-34' };
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return { ok: false, reason: 'malformed' };
  // Move first 4 chars to the end, then numerify (A=10, B=11, …).
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let num = '';
  for (const ch of rearranged) {
    num += /[0-9]/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
  }
  // Mod 97 on long number — process in chunks.
  let mod = 0;
  for (let i = 0; i < num.length; i += 7) {
    const chunk = String(mod) + num.slice(i, i + 7);
    mod = Number(chunk) % 97;
  }
  return mod === 1 ? { ok: true } : { ok: false, reason: `mod-97 = ${mod}, expected 1` };
}

function checkGermanTaxIdnr(raw: string): { ok: boolean; reason?: string } {
  // BMF spec: 11 digits. Sum the first 10 with Aktenzeichen-Verfahren, modulo 11.
  // See https://www.bzst.de/.../identifikationsnummer for the canonical algorithm.
  const s = raw.replace(/\s+/g, '');
  if (!/^\d{11}$/.test(s)) return { ok: false, reason: '11 digits required' };
  let product = 10;
  for (let i = 0; i < 10; i++) {
    let sum = (Number(s[i]) + product) % 10;
    if (sum === 0) sum = 10;
    product = (sum * 2) % 11;
  }
  const expected = (11 - product) % 10;
  return expected === Number(s[10]) ? { ok: true } : { ok: false, reason: `check digit ${s[10]}, expected ${expected}` };
}

function checkSteuernummerFormat(raw: string): { ok: boolean; reason?: string } {
  // Loose: 10–13 digits (with optional `/`-separator, regional variance).
  const s = raw.replace(/[\s\/]/g, '');
  return /^\d{10,13}$/.test(s) ? { ok: true } : { ok: false, reason: 'expected 10-13 digits' };
}

function parseGermanNumber(v: unknown): number | null {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v !== 'string') return null;
  // "69.291,80 €" → 69291.80
  const cleaned = v.replace(/[€$\s]/g, '').replace(/\./g, '').replace(/,/g, '.');
  const n = Number(cleaned);
  return isFinite(n) ? n : null;
}

function checkSum(root: unknown, fields: string[], total: string, tolerance: number): { ok: boolean; expected: number; actual: number; reason?: string } | null {
  const parts = fields.map((f) => parseGermanNumber(getByPath(root, f)));
  const sumExpected = parseGermanNumber(getByPath(root, total));
  if (parts.some((p) => p === null) || sumExpected === null) {
    return { ok: false, expected: NaN, actual: NaN, reason: 'one or more operands not numeric' };
  }
  const sum = parts.reduce((a: number, b) => a + (b as number), 0);
  return {
    ok: Math.abs(sum - sumExpected) <= tolerance,
    expected: sumExpected,
    actual: sum,
    reason: Math.abs(sum - sumExpected) <= tolerance ? undefined : `${sum} ≠ ${sumExpected} (Toleranz ${tolerance})`,
  };
}

function checkDate(raw: string, kind: 'iso' | 'de', min?: string, max?: string): { ok: boolean; reason?: string } {
  let iso: string;
  if (kind === 'iso') {
    iso = raw;
  } else {
    // "01.01.2024" → 2024-01-01
    const m = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (!m) return { ok: false, reason: 'not in dd.MM.yyyy' };
    iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { ok: false, reason: 'invalid date' };
  if (min && new Date(min).getTime() > d.getTime()) return { ok: false, reason: `before min ${min}` };
  if (max && new Date(max).getTime() < d.getTime()) return { ok: false, reason: `after max ${max}` };
  return { ok: true };
}

// ── Stage ──────────────────────────────────────────────────────────────────
export const crossValidatorStage = defineStage<CrossValidatorInput, CrossValidatorOutput, CrossValidatorConfig>({
  id: 'extract/cross-validator',
  name: 'Cross-Validator — deterministic field checks',
  description:
    'Deterministische Pflichtprüfungen per Feldtyp: IBAN-Prüfsumme, IDNr-Prüfziffer ' +
    '(BMF), Summen-Check, Datumsformat, Enum, Regex, Range. Liefert per-Feld Violations ' +
    'mit Severity und globalen Pass-Flag. Kein LLM, keine Heuristik.',
  hints: {
    inputs: 'extracted (nested-json oder mit-spans)',
    outputs: 'validated (input + _validation), violations[], pass (bool)',
    configExample: '{"rules": [{"field": "bank.iban", "kind": "iban-checksum", "severity": "block"}, {"field": "person.idnr", "kind": "german-tax-idnr"}, {"field": "lohn.brutto", "kind": "sum-check", "args": {"fields": ["lohn.basis", "lohn.zulagen"], "tolerance": 0.01}}]}',
    inputPorts: [
      { name: 'extracted', type: 'nested-json', description: 'Accepts span-linked or raw extraction' },
      { name: 'field_meta', type: 'json', description: 'Optional per-leaf container metadata — when present, rules auto-generate from formatRegex + pflicht + datentyp' },
    ],
    outputPorts: [
      { name: 'validated', type: 'nested-json', description: 'Input + _validation summary' },
      { name: 'violations', type: 'json' },
      { name: 'pass', type: 'boolean' },
    ],
  },

  async run(input, ctx) {
    if (!input?.extracted) throw new Error('cross-validator: input.extracted fehlt');
    const cfg = ctx.config ?? ({} as CrossValidatorConfig);
    let rules: RuleSpec[] = Array.isArray(cfg.rules) ? cfg.rules : [];
    // Auto-generate rules from container metadata when no explicit rules given.
    // Lets workflows omit `config.rules` entirely and still get IBAN/IDNr/regex
    // checks driven by the BMF catalog.
    if (rules.length === 0 && input.field_meta && Object.keys(input.field_meta).length > 0) {
      rules = autoGenerateRules(input.field_meta, cfg.autoRegexSeverity ?? 'warn');
      ctx.emit('rules_autogenerated', { ruleCount: rules.length });
    }
    const t0 = Date.now();
    const violations: ValidationViolation[] = [];

    for (const rule of rules) {
      const severity = rule.severity ?? 'block';
      const args = rule.args ?? {};
      // sum-check uses args.fields[] + (rule.field as total) instead of plain field value
      if (rule.kind === 'sum-check') {
        const fields = Array.isArray(args.fields) ? (args.fields as string[]) : [];
        const tol = typeof args.tolerance === 'number' ? args.tolerance : 0.01;
        const res = checkSum(input.extracted, fields, rule.field, tol);
        if (res && !res.ok) {
          violations.push({
            field: rule.field, kind: rule.kind, severity,
            msg: `Summen-Check fehlgeschlagen: ${res.reason}`,
            expected: res.expected, actual: res.actual,
          });
        }
        continue;
      }

      const value = getByPath(input.extracted, rule.field);
      // required-nonempty handles missing/empty values directly
      if (rule.kind === 'required-nonempty') {
        if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) {
          violations.push({ field: rule.field, kind: rule.kind, severity, msg: 'Pflichtfeld fehlt' });
        }
        continue;
      }
      if (value == null) {
        // Other rules skip silently if value is absent — use required-nonempty to enforce presence.
        continue;
      }

      switch (rule.kind) {
        case 'iban-checksum': {
          const r = checkIban(String(value));
          if (!r.ok) violations.push({ field: rule.field, kind: rule.kind, severity, msg: `IBAN ungültig: ${r.reason}`, actual: value });
          break;
        }
        case 'german-tax-idnr': {
          const r = checkGermanTaxIdnr(String(value));
          if (!r.ok) violations.push({ field: rule.field, kind: rule.kind, severity, msg: `IDNr ungültig: ${r.reason}`, actual: value });
          break;
        }
        case 'steuernummer-format': {
          const r = checkSteuernummerFormat(String(value));
          if (!r.ok) violations.push({ field: rule.field, kind: rule.kind, severity, msg: `Steuernummer-Format: ${r.reason}`, actual: value });
          break;
        }
        case 'date-iso':
        case 'date-de': {
          const r = checkDate(String(value), rule.kind === 'date-iso' ? 'iso' : 'de',
            typeof args.min === 'string' ? args.min : undefined,
            typeof args.max === 'string' ? args.max : undefined);
          if (!r.ok) violations.push({ field: rule.field, kind: rule.kind, severity, msg: `Datum: ${r.reason}`, actual: value });
          break;
        }
        case 'enum': {
          const allowed = Array.isArray(args.values) ? (args.values as unknown[]) : [];
          if (!allowed.includes(value)) violations.push({
            field: rule.field, kind: rule.kind, severity,
            msg: `Wert nicht in erlaubter Liste`, expected: allowed, actual: value,
          });
          break;
        }
        case 'regex': {
          const pattern = typeof args.pattern === 'string' ? args.pattern : '';
          if (!pattern) break;
          let re: RegExp;
          try { re = new RegExp(pattern); } catch { break; }
          if (!re.test(String(value))) violations.push({
            field: rule.field, kind: rule.kind, severity,
            msg: `Regex-Mismatch`, expected: pattern, actual: value,
          });
          break;
        }
        case 'range': {
          const min = typeof args.min === 'number' ? args.min : Number.NEGATIVE_INFINITY;
          const max = typeof args.max === 'number' ? args.max : Number.POSITIVE_INFINITY;
          const n = parseGermanNumber(value);
          if (n === null) {
            violations.push({ field: rule.field, kind: rule.kind, severity, msg: `Range-Check: kein Zahlenwert`, actual: value });
          } else if (n < min || n > max) {
            violations.push({ field: rule.field, kind: rule.kind, severity, msg: `außerhalb ${min}…${max}`, actual: n });
          }
          break;
        }
      }
    }

    const pass = !violations.some((v) => v.severity === 'block');
    const validated = typeof input.extracted === 'object' && input.extracted !== null
      ? { ...(input.extracted as object), _validation: { pass, violations, rules_run: rules.length } }
      : input.extracted;
    const ms = Date.now() - t0;
    ctx.emit('cross_validator_done', { ms, violations: violations.length, blocks: violations.filter((v) => v.severity === 'block').length, pass });

    return { validated, violations, pass, ms };
  },
});
