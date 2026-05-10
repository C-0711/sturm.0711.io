/**
 * ELSTER Hinweisregeln evaluator.
 *
 * Parses the rule-expression syntax used in the Jahresdokumentation Regeln-
 * sheets and evaluates rules against a canonical ELSTER layer. Returns the
 * subset of rules that fired (i.e. their condition was true and the standard
 * therefore wants the user to fix something), grouped into errors and warnings.
 *
 * The expression syntax has 49 distinct function calls and supports nested
 * boolean logic. We implement the high-traffic subset; rules using functions
 * we don't recognize are skipped (status: 'unknown') rather than fake-passing.
 *
 * Supported subset (covers ~80% of real-world rules):
 *   FeldAngegeben(E0XXXXXX) / FeldNichtAngegeben
 *   KeinFeldAngegeben(...) / MindestensEinFeldAngegeben(...) / AlleFelderAngegeben(...)
 *   MehrAlsEinFeldAngegeben(...)
 *   FeldWertInWerteListe(eCode, "v1", "v2", ...) / FeldWertNichtInWerteListe
 *   FeldWertAlsZahl(eCode)
 *   Summe(eCode, eCode, ...)
 *   Min/Max/Abs/Abrunden/Aufrunden of numeric expressions
 *   Comparisons: ==, !=, <, <=, >, >=
 *   Boolean: Und/UND/und, Oder/ODER/oder
 *   Numeric/string/eCode literals
 * Not supported (rule skipped):
 *   KontextAngegeben/* (path-based context queries — would need full layer xpath model)
 *   ArbL/VBez/Einz* wildcard paths
 *   Datum-arithmetik
 */
import type { CanonicalLayer, ValidatorIssue, ValidatorResult } from '../../../lib/canonical-layer.ts';
import type { ElsterRule, HinweisregelnFull } from './elster-katalog.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Tokenizer
// ─────────────────────────────────────────────────────────────────────────────

type TokenType =
  | 'ECODE' | 'IDENT' | 'NUMBER' | 'STRING'
  | 'LPAREN' | 'RPAREN' | 'COMMA'
  | 'OP' | 'AND' | 'OR' | 'NOT' | 'EOF';

interface Token { type: TokenType; value: string; pos: number }

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = src.length;
  while (i < len) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    // String literal "..."
    if (c === '"') {
      let j = i + 1;
      while (j < len && src[j] !== '"') {
        if (src[j] === '\\') j++;
        j++;
      }
      tokens.push({ type: 'STRING', value: src.slice(i + 1, j), pos: i });
      i = j + 1;
      continue;
    }
    if (c === '(') { tokens.push({ type: 'LPAREN', value: '(', pos: i }); i++; continue; }
    if (c === ')') { tokens.push({ type: 'RPAREN', value: ')', pos: i }); i++; continue; }
    if (c === ',') { tokens.push({ type: 'COMMA', value: ',', pos: i }); i++; continue; }
    // Comparison operators (greedy 2-char first)
    if ('=<>!'.includes(c)) {
      const two = src.slice(i, i + 2);
      if (['==', '!=', '<=', '>='].includes(two)) {
        tokens.push({ type: 'OP', value: two, pos: i }); i += 2; continue;
      }
      if (c === '<' || c === '>') { tokens.push({ type: 'OP', value: c, pos: i }); i++; continue; }
      if (c === '=') { tokens.push({ type: 'OP', value: '==', pos: i }); i++; continue; }
    }
    if (c === '+' || c === '-' || c === '*' || c === '/') {
      tokens.push({ type: 'OP', value: c, pos: i }); i++; continue;
    }
    // Numeric literal
    if (c >= '0' && c <= '9') {
      let j = i;
      while (j < len && (/[0-9.,]/).test(src[j])) j++;
      tokens.push({ type: 'NUMBER', value: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    // Identifier or eCode
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' ||
         'äöüÄÖÜß'.includes(c)) {
      let j = i;
      while (j < len && (/[A-Za-z0-9_äöüÄÖÜß]/).test(src[j])) j++;
      // Allow path-like idents (slashes / asterisks) — treated as a single
      // opaque identifier for now; the parser ignores rules that try to use
      // them in unsupported ways.
      while (j < len && (src[j] === '/' || src[j] === '*')) {
        j++;
        while (j < len && (/[A-Za-z0-9_äöüÄÖÜß]/).test(src[j])) j++;
      }
      const raw = src.slice(i, j);
      const lower = raw.toLowerCase();
      let type: TokenType = 'IDENT';
      if (/^E\d{7}$/.test(raw)) type = 'ECODE';
      else if (lower === 'und') type = 'AND';
      else if (lower === 'oder') type = 'OR';
      else if (lower === 'nicht') type = 'NOT';
      tokens.push({ type, value: raw, pos: i });
      i = j;
      continue;
    }
    // Unknown char — skip
    i++;
  }
  tokens.push({ type: 'EOF', value: '', pos: len });
  return tokens;
}

// ─────────────────────────────────────────────────────────────────────────────
// AST
// ─────────────────────────────────────────────────────────────────────────────

type Node =
  | { kind: 'literal'; value: number | string | boolean | null }
  | { kind: 'ecode'; code: string }
  | { kind: 'pathRef'; path: string }   // unsupported (e.g. ArbL/VBez/...)
  | { kind: 'call'; name: string; args: Node[] }
  | { kind: 'binop'; op: string; left: Node; right: Node }
  | { kind: 'and'; parts: Node[] }
  | { kind: 'or'; parts: Node[] }
  | { kind: 'not'; inner: Node };

interface ParseResult {
  ast: Node | null;
  /** True if any sub-node had a path-based reference we don't model */
  hasUnsupportedPath: boolean;
  /** Function names encountered we don't implement */
  unknownFunctions: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Recursive-descent parser
// ─────────────────────────────────────────────────────────────────────────────

class Parser {
  private p = 0;
  hasUnsupportedPath = false;
  unknownFunctions: string[] = [];
  constructor(private toks: Token[]) {}
  private peek(off = 0): Token { return this.toks[this.p + off]; }
  private eat(): Token { return this.toks[this.p++]; }
  private expect(type: TokenType): Token {
    const t = this.toks[this.p];
    if (t.type !== type) throw new ParseError(`expected ${type} got ${t.type} (${t.value}) at ${t.pos}`);
    this.p++; return t;
  }
  parseExpr(): Node { return this.parseOr(); }
  private parseOr(): Node {
    const parts: Node[] = [this.parseAnd()];
    while (this.peek().type === 'OR') { this.eat(); parts.push(this.parseAnd()); }
    return parts.length === 1 ? parts[0] : { kind: 'or', parts };
  }
  private parseAnd(): Node {
    const parts: Node[] = [this.parseNot()];
    while (this.peek().type === 'AND') { this.eat(); parts.push(this.parseNot()); }
    return parts.length === 1 ? parts[0] : { kind: 'and', parts };
  }
  private parseNot(): Node {
    if (this.peek().type === 'NOT') { this.eat(); return { kind: 'not', inner: this.parseCmp() }; }
    return this.parseCmp();
  }
  private parseCmp(): Node {
    let left = this.parseAddSub();
    while (this.peek().type === 'OP' && ['==','!=','<','<=','>','>='].includes(this.peek().value)) {
      const op = this.eat().value;
      const right = this.parseAddSub();
      left = { kind: 'binop', op, left, right };
    }
    return left;
  }
  private parseAddSub(): Node {
    let left = this.parseMulDiv();
    while (this.peek().type === 'OP' && (this.peek().value === '+' || this.peek().value === '-')) {
      const op = this.eat().value;
      const right = this.parseMulDiv();
      left = { kind: 'binop', op, left, right };
    }
    return left;
  }
  private parseMulDiv(): Node {
    let left = this.parseAtom();
    while (this.peek().type === 'OP' && (this.peek().value === '*' || this.peek().value === '/')) {
      const op = this.eat().value;
      const right = this.parseAtom();
      left = { kind: 'binop', op, left, right };
    }
    return left;
  }
  private parseAtom(): Node {
    const t = this.peek();
    if (t.type === 'LPAREN') {
      this.eat();
      const inner = this.parseExpr();
      this.expect('RPAREN');
      return inner;
    }
    if (t.type === 'NUMBER') {
      this.eat();
      const n = parseFloat(t.value.replace('.', '').replace(',', '.'));
      return { kind: 'literal', value: Number.isFinite(n) ? n : 0 };
    }
    if (t.type === 'STRING') {
      this.eat();
      return { kind: 'literal', value: t.value };
    }
    if (t.type === 'ECODE') {
      this.eat();
      return { kind: 'ecode', code: t.value };
    }
    if (t.type === 'IDENT') {
      const name = this.eat().value;
      // Function call?
      if (this.peek().type === 'LPAREN') {
        this.eat();
        const args: Node[] = [];
        if (this.peek().type !== 'RPAREN') {
          args.push(this.parseExpr());
          while (this.peek().type === 'COMMA') { this.eat(); args.push(this.parseExpr()); }
        }
        this.expect('RPAREN');
        if (!IMPLEMENTED.has(name) && !this.unknownFunctions.includes(name)) {
          this.unknownFunctions.push(name);
        }
        return { kind: 'call', name, args };
      }
      // Path reference like ArbL/VBez/Einz*/E0200801 (containing a slash)
      if (name.includes('/')) {
        this.hasUnsupportedPath = true;
        return { kind: 'pathRef', path: name };
      }
      // Bare identifier — treat as opaque path reference
      return { kind: 'pathRef', path: name };
    }
    throw new ParseError(`unexpected token ${t.type} (${t.value}) at ${t.pos}`);
  }
}
class ParseError extends Error {}

const IMPLEMENTED = new Set([
  'FeldAngegeben', 'FeldNichtAngegeben',
  'KeinFeldAngegeben', 'MindestensEinFeldAngegeben',
  'AlleFelderAngegeben', 'MehrAlsEinFeldAngegeben',
  'NichtAlleFelderOderKeinFeldAngegeben',
  'Angegeben',
  'FeldWertInWerteListe', 'FeldWertNichtInWerteListe',
  'MindestensEinFeldWertInWerteListe', 'NichtAlleFeldWerteInWerteListe',
  'FeldWertAlsZahl',
  'Summe', 'Min', 'Max', 'MinWert', 'MaxWert', 'Abs', 'AbsWert',
  'Abrunden', 'Aufrunden',
  'Und', 'UND', 'Oder', 'ODER',
]);

function parseRuleExpression(src: string): ParseResult {
  if (!src.trim()) return { ast: null, hasUnsupportedPath: false, unknownFunctions: [] };
  try {
    const tokens = tokenize(src);
    const p = new Parser(tokens);
    const ast = p.parseExpr();
    return { ast, hasUnsupportedPath: p.hasUnsupportedPath, unknownFunctions: p.unknownFunctions };
  } catch {
    return { ast: null, hasUnsupportedPath: false, unknownFunctions: [] };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluator
// ─────────────────────────────────────────────────────────────────────────────

type EvalResult = { ok: true; value: unknown } | { ok: false; reason: string };

interface EvalEnv {
  layer: CanonicalLayer;
}

function present(env: EvalEnv, code: string): boolean {
  return env.layer.codes[code] !== undefined && env.layer.codes[code] !== null;
}

function valueAsNumber(env: EvalEnv, code: string): number {
  const v = env.layer.codes[code];
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function evalNode(node: Node, env: EvalEnv): EvalResult {
  switch (node.kind) {
    case 'literal': return { ok: true, value: node.value };
    case 'ecode':
      // Bare eCode in rvalue context = "is the field present"
      return { ok: true, value: present(env, node.code) };
    case 'pathRef':
      return { ok: false, reason: `unsupported path: ${node.path}` };
    case 'and': {
      let anyUnknown = false;
      for (const p of node.parts) {
        const r = evalNode(p, env);
        if (!r.ok) { anyUnknown = true; continue; }
        if (!truthy(r.value)) return { ok: true, value: false };
      }
      if (anyUnknown) return { ok: false, reason: 'and: subexpr unsupported' };
      return { ok: true, value: true };
    }
    case 'or': {
      let anyUnknown = false;
      for (const p of node.parts) {
        const r = evalNode(p, env);
        if (!r.ok) { anyUnknown = true; continue; }
        if (truthy(r.value)) return { ok: true, value: true };
      }
      if (anyUnknown) return { ok: false, reason: 'or: subexpr unsupported' };
      return { ok: true, value: false };
    }
    case 'not': {
      const r = evalNode(node.inner, env);
      if (!r.ok) return r;
      return { ok: true, value: !truthy(r.value) };
    }
    case 'binop': {
      const l = evalNode(node.left, env);
      const r = evalNode(node.right, env);
      if (!l.ok) return l;
      if (!r.ok) return r;
      const lv = l.value, rv = r.value;
      switch (node.op) {
        case '==': return { ok: true, value: cmpEq(lv, rv) };
        case '!=': return { ok: true, value: !cmpEq(lv, rv) };
        case '<':  return { ok: true, value: numOf(lv) < numOf(rv) };
        case '<=': return { ok: true, value: numOf(lv) <= numOf(rv) };
        case '>':  return { ok: true, value: numOf(lv) > numOf(rv) };
        case '>=': return { ok: true, value: numOf(lv) >= numOf(rv) };
        case '+':  return { ok: true, value: numOf(lv) + numOf(rv) };
        case '-':  return { ok: true, value: numOf(lv) - numOf(rv) };
        case '*':  return { ok: true, value: numOf(lv) * numOf(rv) };
        case '/':  return { ok: true, value: numOf(rv) === 0 ? 0 : numOf(lv) / numOf(rv) };
      }
      return { ok: false, reason: `unsupported op ${node.op}` };
    }
    case 'call': return evalCall(node, env);
  }
}

function evalCall(node: Extract<Node, { kind: 'call' }>, env: EvalEnv): EvalResult {
  const codes = node.args.map((a) => a.kind === 'ecode' ? a.code : null);
  const fn = node.name;
  switch (fn) {
    case 'FeldAngegeben':
    case 'Angegeben':
      return { ok: true, value: codes[0] ? present(env, codes[0]) : false };
    case 'FeldNichtAngegeben':
      return { ok: true, value: codes[0] ? !present(env, codes[0]) : true };
    case 'KeinFeldAngegeben':
      return { ok: true, value: codes.every((c) => !c || !present(env, c)) };
    case 'MindestensEinFeldAngegeben':
      return { ok: true, value: codes.some((c) => c !== null && present(env, c)) };
    case 'AlleFelderAngegeben':
      return { ok: true, value: codes.every((c) => c !== null && present(env, c)) };
    case 'MehrAlsEinFeldAngegeben':
      return { ok: true, value: codes.filter((c) => c !== null && present(env, c)).length > 1 };
    case 'NichtAlleFelderOderKeinFeldAngegeben': {
      const presentCount = codes.filter((c) => c !== null && present(env, c)).length;
      return { ok: true, value: presentCount > 0 && presentCount < codes.length };
    }
    case 'FeldWertAlsZahl':
      return codes[0] ? { ok: true, value: valueAsNumber(env, codes[0]) }
                      : { ok: false, reason: 'FeldWertAlsZahl: missing code' };
    case 'FeldWertInWerteListe': {
      if (!codes[0]) return { ok: false, reason: 'FeldWertInWerteListe: missing code' };
      const v = String(env.layer.codes[codes[0]] ?? '');
      const allowed = node.args.slice(1).map((a) =>
        a.kind === 'literal' ? String(a.value) : null,
      ).filter((x): x is string => x !== null);
      return { ok: true, value: allowed.includes(v) };
    }
    case 'FeldWertNichtInWerteListe': {
      if (!codes[0]) return { ok: false, reason: 'FeldWertNichtInWerteListe: missing code' };
      const v = String(env.layer.codes[codes[0]] ?? '');
      const allowed = node.args.slice(1).map((a) =>
        a.kind === 'literal' ? String(a.value) : null,
      ).filter((x): x is string => x !== null);
      return { ok: true, value: !allowed.includes(v) };
    }
    case 'Summe': {
      let s = 0;
      for (const c of codes) if (c) s += valueAsNumber(env, c);
      return { ok: true, value: s };
    }
    case 'Min':
    case 'MinWert': {
      const vals = codes.filter((c): c is string => c !== null).map((c) => valueAsNumber(env, c));
      return vals.length ? { ok: true, value: Math.min(...vals) }
                         : { ok: false, reason: `${fn}: no codes` };
    }
    case 'Max':
    case 'MaxWert': {
      const vals = codes.filter((c): c is string => c !== null).map((c) => valueAsNumber(env, c));
      return vals.length ? { ok: true, value: Math.max(...vals) }
                         : { ok: false, reason: `${fn}: no codes` };
    }
    case 'Abs':
    case 'AbsWert': {
      const r = evalNode(node.args[0], env);
      return r.ok ? { ok: true, value: Math.abs(numOf(r.value)) } : r;
    }
    case 'Abrunden': {
      const r = evalNode(node.args[0], env);
      return r.ok ? { ok: true, value: Math.floor(numOf(r.value)) } : r;
    }
    case 'Aufrunden': {
      const r = evalNode(node.args[0], env);
      return r.ok ? { ok: true, value: Math.ceil(numOf(r.value)) } : r;
    }
    case 'Und': case 'UND': {
      let anyUnknown = false;
      for (const a of node.args) {
        const r = evalNode(a, env);
        if (!r.ok) { anyUnknown = true; continue; }
        if (!truthy(r.value)) return { ok: true, value: false };
      }
      return anyUnknown ? { ok: false, reason: 'Und: subexpr unsupported' }
                        : { ok: true, value: true };
    }
    case 'Oder': case 'ODER': {
      let anyUnknown = false;
      for (const a of node.args) {
        const r = evalNode(a, env);
        if (!r.ok) { anyUnknown = true; continue; }
        if (truthy(r.value)) return { ok: true, value: true };
      }
      return anyUnknown ? { ok: false, reason: 'Oder: subexpr unsupported' }
                        : { ok: true, value: false };
    }
  }
  return { ok: false, reason: `unsupported function: ${fn}` };
}

function truthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  return Boolean(v);
}
function numOf(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
function cmpEq(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' || typeof b === 'number') return numOf(a) === numOf(b);
  return String(a) === String(b);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: evaluate the full ruleset against a canonical layer
// ─────────────────────────────────────────────────────────────────────────────

export interface EvaluateOptions {
  /** Only evaluate rules from these Anlagen (default: all anlagen referenced by codes in the layer) */
  anlagen?: string[];
  /** Skip rules that reference any pathRef we don't model (default true — we don't fake-pass them) */
  skipUnsupported?: boolean;
}

export interface RuleEvalDetail {
  rule: ElsterRule;
  fired: boolean;
  status: 'fired' | 'passed' | 'skipped';
  reason?: string;
}

export function evaluateRules(
  layer: CanonicalLayer,
  rules: HinweisregelnFull,
  opts: EvaluateOptions = {},
): { result: ValidatorResult; details: RuleEvalDetail[] } {
  const targetAnlagen = opts.anlagen ?? Object.keys(rules.anlagen);
  const skipUnsupported = opts.skipUnsupported !== false;
  const result: ValidatorResult = { passes: 0, warnings: [], errors: [] };
  const details: RuleEvalDetail[] = [];

  for (const anlage of targetAnlagen) {
    const bucket = rules.anlagen[anlage];
    if (!bucket) continue;
    for (const rule of bucket.rules) {
      const parsed = parseRuleExpression(rule.pruefbedingung);
      if (!parsed.ast) {
        details.push({ rule, fired: false, status: 'skipped', reason: 'unparseable' });
        continue;
      }
      if (parsed.hasUnsupportedPath && skipUnsupported) {
        details.push({ rule, fired: false, status: 'skipped', reason: 'path-references' });
        continue;
      }
      const e = evalNode(parsed.ast, { layer });
      if (!e.ok) {
        details.push({ rule, fired: false, status: 'skipped', reason: e.reason });
        continue;
      }
      const fired = truthy(e.value);
      if (fired) {
        const issue: ValidatorIssue = {
          ruleId: rule.fehlercode || rule.name,
          severity: rule.severity === 'hinweis' ? 'hinweis'
                  : rule.severity === 'fehler' ? 'fehler'
                  : 'info',
          message: rule.fehlertext,
          cited: rule.referencedECodes,
        };
        if (issue.severity === 'fehler') result.errors.push(issue);
        else result.warnings.push(issue);
        details.push({ rule, fired: true, status: 'fired' });
      } else {
        result.passes++;
        details.push({ rule, fired: false, status: 'passed' });
      }
    }
  }
  return { result, details };
}
