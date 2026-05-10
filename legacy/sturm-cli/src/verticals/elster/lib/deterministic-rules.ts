/**
 * Layer 4: Deterministic rules engine.
 *
 * Probabilistic tools (LLMs, OCR, embed cascades) cannot do deterministic
 * legal logic — that requires this module. Walks nested JSON, applies:
 *   - filterArray(path, predicate)   — filter out non-deductible items
 *   - aggregate(path, agg)           — sum / max / first / count
 *   - validateChecksum(value, type)  — Steuer-ID Modulo-11, IBAN, BIC
 *   - applyCeiling(value, rule)      — § 10b 20%, § 35a max etc.
 *
 * Hand-curated domain rules live in this module (not data/) because they
 * encode legal predicates, not catalog data. The catalog data they reference
 * (eCodes) is verified at startup against feld_katalog_full.json — same
 * integrity gate as the rest of the v1 cascade.
 */

import type { CanonicalLayer, CanonicalValue } from '../../../lib/canonical-layer.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Checksums
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Steueridentifikationsnummer (11-digit). Modulo-11/10 verification per
 * BMF spec. Returns true if the checksum digit at position 11 is correct.
 *
 * Algorithm (BZSt official):
 *   - 10 leading digits + 1 check digit
 *   - exactly one digit must appear exactly twice OR thrice in the leading 10
 *     and not all other digits be unique
 *   - Computed via iterative product/sum over Modulo 11/10
 */
export function validateSteuerId(value: string): boolean {
  const s = String(value).replace(/\s+/g, '');
  if (!/^\d{11}$/.test(s)) return false;
  // Cannot start with 0
  if (s[0] === '0') return false;
  // Digit-frequency check (BZSt rule)
  const counts: Record<string, number> = {};
  for (const c of s.slice(0, 10)) counts[c] = (counts[c] ?? 0) + 1;
  const freqs = Object.values(counts);
  // Exactly one digit appears 2-3 times, others unique (or all unique)
  // BZSt says: exactly one digit occurs 2x or 3x in the first 10 digits
  const hasRepeat = freqs.filter((f) => f >= 2).length === 1;
  if (!hasRepeat) return false;
  // Compute check digit
  let p = 10;
  for (let i = 0; i < 10; i++) {
    let s_ = (parseInt(s[i], 10) + p) % 10;
    if (s_ === 0) s_ = 10;
    p = (2 * s_) % 11;
  }
  let c = 11 - p;
  if (c === 10) c = 0;
  return c === parseInt(s[10], 10);
}

/**
 * IBAN checksum (ISO 13616). Letters → digits (A=10, ..., Z=35), move first
 * 4 chars to the end, mod 97 must equal 1.
 */
export function validateIban(value: string): boolean {
  const s = String(value).replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{1,30}$/.test(s)) return false;
  if (s.length < 15 || s.length > 34) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  // Convert to numeric string
  let numeric = '';
  for (const c of rearranged) {
    if (c >= '0' && c <= '9') numeric += c;
    else numeric += String(c.charCodeAt(0) - 'A'.charCodeAt(0) + 10);
  }
  // Mod 97 over big numeric (chunked)
  let remainder = 0;
  for (let i = 0; i < numeric.length; i += 7) {
    const chunk = remainder.toString() + numeric.slice(i, i + 7);
    remainder = parseInt(chunk, 10) % 97;
  }
  return remainder === 1;
}

/** BIC: 8 or 11 chars, first 4 letters, then 2 country, 2 alnum, optional 3 alnum */
export function validateBic(value: string): boolean {
  const s = String(value).replace(/\s+/g, '').toUpperCase();
  return /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(s);
}

// ─────────────────────────────────────────────────────────────────────────────
// Nested-path traversal
// ─────────────────────────────────────────────────────────────────────────────

/** Get value at path like "donations.0.amount" or "donor.tax_id" */
export function getPath(obj: unknown, path: string): unknown {
  let cur: any = obj;
  for (const p of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = parseInt(p, 10);
      if (Number.isFinite(idx)) { cur = cur[idx]; continue; }
      // path through array means: collect from each element
      cur = cur.map((e) => e?.[p]).filter((x) => x !== undefined);
      continue;
    }
    cur = cur[p];
  }
  return cur;
}

/** Set/replace value at path; creates objects along the way */
export function setPath(obj: any, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] === undefined) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Filter + aggregate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Filter an array at the given nested path by a predicate.
 * Returns a NEW nested object (immutable) with the filtered array in place.
 */
export function filterArray<T = any>(
  nested: any,
  arrayPath: string,
  predicate: (item: T) => boolean,
): any {
  const arr = getPath(nested, arrayPath);
  if (!Array.isArray(arr)) return nested;
  const filtered = arr.filter((x) => predicate(x as T));
  // Deep clone via JSON to avoid mutation
  const out = JSON.parse(JSON.stringify(nested));
  setPath(out, arrayPath, filtered);
  return out;
}

export type Aggregator = 'sum' | 'count' | 'first' | 'max' | 'min' | 'avg';

export function aggregate(values: unknown[], agg: Aggregator): number {
  const nums = values
    .map((v) => typeof v === 'number' ? v : parseFloat(String(v).replace(/\./g, '').replace(',', '.')))
    .filter((n) => Number.isFinite(n));
  if (nums.length === 0) return 0;
  switch (agg) {
    case 'sum':   return nums.reduce((a, b) => a + b, 0);
    case 'count': return values.length;
    case 'first': return nums[0];
    case 'max':   return Math.max(...nums);
    case 'min':   return Math.min(...nums);
    case 'avg':   return nums.reduce((a, b) => a + b, 0) / nums.length;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Domain rules — each rule is a Projection: nested-JSON → eCode value
// ─────────────────────────────────────────────────────────────────────────────

export interface ProjectionRule {
  /** Output canonical eCode */
  targetCode: string;
  /** Which document classifications this applies to */
  applicableDocClasses?: string[];
  /** Path to the input array (or single value) */
  sourcePath: string;
  /** Optional filter predicate over array elements */
  filter?: (item: any) => boolean;
  /** How to aggregate filtered items into single value */
  aggregator?: Aggregator;
  /** Optional cap (§-ceiling) */
  ceiling?: number;
  /** Optional floor */
  floor?: number;
  /** Human-readable rule description */
  description: string;
  /** Legal grounding */
  rechtsgrundlage?: string;
}

/**
 * Hand-curated projection rules. Each emits one canonical eCode value.
 *
 * Predicates expect the Layer-2 entity-resolver shape: every entity field
 * has been augmented with a `_resolution: { isCharitableCertified, type, country, region, ... }`
 * shadow object. The filter uses that, NOT raw top-level fields, because the
 * raw recipient string carries no certification info on its own.
 */
function isCertifiedDE(d: any): boolean {
  const r = d?._resolution ?? d?.recipient_resolution ?? {};
  if (r.isCharitableCertified !== true) return false;
  const country = r.country ?? 'DE';
  return country === 'DE' || country === 'Deutschland';
}

function isCertifiedEU(d: any): boolean {
  const r = d?._resolution ?? d?.recipient_resolution ?? {};
  if (r.isCharitableCertified !== true) return false;
  const region = String(r.region ?? '').toUpperCase();
  const country = r.country ?? '';
  return country !== 'DE' && country !== 'Deutschland'
    && (region === 'EU' || region === 'EWR');
}

export const PROJECTION_RULES: ProjectionRule[] = [
  {
    targetCode: 'E0108405',
    applicableDocClasses: ['spendenquittung'],
    sourcePath: 'spenden',
    filter: (d: any) => d?.art === 'Spende' && isCertifiedDE(d),
    aggregator: 'sum',
    description: 'Geleistete Spenden an Empfänger im Inland (gemeinnützige Zwecke), § 10b EStG',
    rechtsgrundlage: '§ 10b EStG',
  },
  {
    targetCode: 'E0108508',
    applicableDocClasses: ['spendenquittung'],
    sourcePath: 'spenden',
    filter: (d: any) => d?.art === 'Mitgliedsbeitrag' && isCertifiedDE(d),
    aggregator: 'sum',
    description: 'Mitgliedsbeiträge an steuerbegünstigte Körperschaften (separate Behandlung von Spenden), § 10b Abs. 1 Satz 8 EStG',
    rechtsgrundlage: '§ 10b Abs. 1 Satz 8 EStG',
  },
  {
    targetCode: 'E0105502',
    applicableDocClasses: ['spendenquittung'],
    sourcePath: 'spenden',
    filter: (d: any) => d?.art === 'Spende' && isCertifiedEU(d),
    aggregator: 'sum',
    description: 'Geleistete Spenden an Empfänger im EU/EWR-Ausland, § 10b EStG',
    rechtsgrundlage: '§ 10b EStG',
  },
  {
    targetCode: 'E0107208',
    applicableDocClasses: ['haushaltsnahe_dienstleistungen'],
    sourcePath: 'service_items',
    filter: (s: any) => s?.category === 'haushaltsnah' || s?.is_haushaltsnah === true,
    aggregator: 'sum',
    ceiling: 4000,
    description: 'Haushaltsnahe Dienstleistungen, § 35a Abs. 2 EStG',
    rechtsgrundlage: '§ 35a Abs. 2 EStG',
  },

  // ── Lohnsteuerbescheinigung — single-item projections (no array) ──
  // Unlike donations, an LStB has flat scalar fields. We model these as
  // sourcePath pointing directly at the value; aggregator 'first' just emits it.
  {
    targetCode: 'E0200201',
    applicableDocClasses: ['lohnsteuerbescheinigung'],
    sourcePath: 'lohn.bruttoarbeitslohn',
    aggregator: 'first',
    description: 'Bruttoarbeitslohn (Anlage N Zeile 5)',
    rechtsgrundlage: '§ 19 Abs. 1 EStG',
  },
  {
    targetCode: 'E0200301',
    applicableDocClasses: ['lohnsteuerbescheinigung'],
    sourcePath: 'lohn.lohnsteuer_einbehalten',
    aggregator: 'first',
    description: 'Einbehaltene Lohnsteuer',
    rechtsgrundlage: '§ 38 EStG',
  },
  {
    targetCode: 'E0200401',
    applicableDocClasses: ['lohnsteuerbescheinigung'],
    sourcePath: 'lohn.solidaritaetszuschlag_einbehalten',
    aggregator: 'first',
    description: 'Einbehaltener Solidaritätszuschlag',
    rechtsgrundlage: 'SolzG',
  },
  {
    targetCode: 'E0200501',
    applicableDocClasses: ['lohnsteuerbescheinigung'],
    sourcePath: 'lohn.kirchensteuer_arbeitnehmer_einbehalten',
    aggregator: 'first',
    description: 'Kirchensteuer des Arbeitnehmers',
    rechtsgrundlage: '§ 51a EStG',
  },
  {
    targetCode: 'E0200801',
    applicableDocClasses: ['lohnsteuerbescheinigung'],
    sourcePath: 'versorgungsbezug.versorgungsbezug_brutto',
    aggregator: 'first',
    description: 'Steuerbegünstigte Versorgungsbezüge (im Bruttoarbeitslohn enthalten)',
    rechtsgrundlage: '§ 19 Abs. 2 EStG',
  },
  {
    targetCode: 'E0200902',
    applicableDocClasses: ['lohnsteuerbescheinigung'],
    sourcePath: 'versorgungsbezug.bemessungsgrundlage_freibetrag',
    aggregator: 'first',
    description: 'Bemessungsgrundlage für den Versorgungsfreibetrag',
    rechtsgrundlage: '§ 19 Abs. 2 EStG',
  },
  // ── Versorgungsbezug-Detailfelder (Anlage N) ──
  {
    targetCode: 'E0201003',
    applicableDocClasses: ['lohnsteuerbescheinigung'],
    sourcePath: 'zeitraum.von_monat',
    aggregator: 'first',
    description: 'Bei unterjähriger Zahlung: erster Monat, für den Versorgungsbezüge gezahlt wurden (laut Nr. 30 LStB)',
    rechtsgrundlage: '§ 19 Abs. 2 EStG',
  },
  {
    targetCode: 'E0201203',
    applicableDocClasses: ['lohnsteuerbescheinigung'],
    sourcePath: 'zeitraum.bis_monat',
    aggregator: 'first',
    description: 'Bei unterjähriger Zahlung: letzter Monat, für den Versorgungsbezüge gezahlt wurden (laut Nr. 30 LStB)',
    rechtsgrundlage: '§ 19 Abs. 2 EStG',
  },
  {
    targetCode: 'E0201307',
    applicableDocClasses: ['lohnsteuerbescheinigung'],
    sourcePath: 'versorgungsbezug.versorgungsbeginn_jahr',
    aggregator: 'first',
    description: 'Maßgebendes Kalenderjahr des Versorgungsbeginns (laut Nr. 30 LStB)',
    rechtsgrundlage: '§ 19 Abs. 2 EStG',
  },
  // ── Steuerklasse + Konfession (ESt1A + Anlage N) ──
  {
    targetCode: 'E0200002',
    applicableDocClasses: ['lohnsteuerbescheinigung'],
    sourcePath: 'arbeitnehmer.steuerklasse',
    aggregator: 'first',
    description: 'Steuerklasse (Anlage N)',
    rechtsgrundlage: '§ 38b EStG',
  },
  {
    targetCode: 'E0100402',
    applicableDocClasses: ['lohnsteuerbescheinigung', 'religionszugehoerigkeit', 'steuerkonto_transferticket'],
    sourcePath: 'arbeitnehmer.konfession',
    aggregator: 'first',
    description: 'Religion / Konfession Person A (ESt1A)',
    rechtsgrundlage: '§ 51a EStG',
  },
  // ── ESt1A Person A identification ──
  {
    targetCode: 'E0100081',
    applicableDocClasses: ['lohnsteuerbescheinigung', 'rentenbezugsmitteilung', 'steuerkonto_transferticket', 'beitragsbescheinigung_kranken_p'],
    sourcePath: 'arbeitnehmer.steuer_id',
    aggregator: 'first',
    description: 'Steuer-Identifikationsnummer Person A (ESt1A)',
    rechtsgrundlage: '§ 139b AO',
  },
  {
    targetCode: 'E0100201',
    applicableDocClasses: ['lohnsteuerbescheinigung', 'rentenbezugsmitteilung', 'steuerkonto_transferticket'],
    sourcePath: 'arbeitnehmer.familienname',
    aggregator: 'first',
    description: 'Familienname Person A (ESt1A)',
    rechtsgrundlage: '§ 25 EStG',
  },
  {
    targetCode: 'E0100301',
    applicableDocClasses: ['lohnsteuerbescheinigung', 'rentenbezugsmitteilung', 'steuerkonto_transferticket'],
    sourcePath: 'arbeitnehmer.vorname',
    aggregator: 'first',
    description: 'Vorname Person A (ESt1A)',
    rechtsgrundlage: '§ 25 EStG',
  },
  // ── Anlage VOR — private KV/PV from LStB Nr. 24b ──
  {
    targetCode: 'E2003807',
    applicableDocClasses: ['lohnsteuerbescheinigung'],
    sourcePath: 'sozialversicherung.private_kv_pv_nachgewiesen',
    aggregator: 'first',
    description: 'Private Krankenversicherung laut Nr. 24b der Lohnsteuerbescheinigung (Anlage VOR)',
    rechtsgrundlage: '§ 10 Abs. 1 Nr. 3 EStG',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Apply all projections to nested JSON, write into canonical layer
// ─────────────────────────────────────────────────────────────────────────────

export interface ProjectionResult {
  appliedRules: Array<{
    rule: string;
    targetCode: string;
    inputCount: number;
    filteredCount: number;
    aggregatedValue: number | string | boolean;
    ceilingApplied: boolean;
  }>;
}

/**
 * De-duplicate items by (canonical_recipient, amount). Documents often have
 * both a hand-written summary list and the formal entries — Layer 1 extracts
 * both, but they describe the same transaction. Use the entity-resolved
 * canonical name to detect duplicates after Layer 2 has normalized names.
 *
 * Date is included only as a tie-breaker — donations on the same day with
 * the same canonical recipient AND same amount are very likely the same
 * transaction (or two halves of one bank record).
 */
function dedupeByCanonicalRecipient<T extends { _resolution?: { canonical?: string }; empfaenger?: string; betrag_eur?: number; datum?: string; art?: string }>(items: T[]): T[] {
  // Two items collapse only when ALL identifying fields match: canonical
  // recipient, amount, date, and kind. This protects legitimate repeat
  // donations (same charity, same amount, different month/kind) from being
  // collapsed while still catching summary-list duplicates of the same
  // formal entry.
  //
  // When date is missing on one but the other has it, we still consider them
  // potential duplicates (the summary line typically has no date) — so we
  // collapse if (canonical, amount, kind) match and at least one has no date.
  const out: T[] = [];
  const seen = new Map<string, T>();
  for (const item of items) {
    const canon = (item._resolution?.canonical ?? item.empfaenger ?? '').trim();
    const amount = item.betrag_eur ?? 0;
    const date = (item.datum ?? '').trim();
    const kind = (item.art ?? '').trim();
    // Strict key includes date — only exact-duplicate items collapse
    const strictKey = `${canon}|${amount}|${date}|${kind}`;
    if (seen.has(strictKey)) continue;
    // Loose key for summary-vs-formal deduplication: same canonical+amount+kind,
    // but one entry has no date (summary line). Only collapses if a more
    // detailed entry already exists.
    if (!date) {
      const looseKey = `${canon}|${amount}|${kind}`;
      const datedExists = [...seen.keys()].some((k) => k.startsWith(looseKey + '|') && !k.endsWith('|' + kind));
      const anyExisting = [...seen.values()].some((e) => {
        const eCanon = (e._resolution?.canonical ?? e.empfaenger ?? '').trim();
        return eCanon === canon && (e.betrag_eur ?? 0) === amount
          && (e.art ?? '') === kind && (e.datum ?? '').length > 0;
      });
      if (anyExisting) continue;
    }
    seen.set(strictKey, item);
    out.push(item);
  }
  return out;
}

export function applyProjections(
  nested: any,
  layer: CanonicalLayer,
  docClass: string | undefined,
): ProjectionResult {
  const result: ProjectionResult = { appliedRules: [] };
  for (const rule of PROJECTION_RULES) {
    if (rule.applicableDocClasses && docClass && !rule.applicableDocClasses.includes(docClass)) continue;
    const raw = getPath(nested, rule.sourcePath);
    if (raw === undefined) continue;
    const itemsRaw = Array.isArray(raw) ? raw : [raw];
    const inputCount = itemsRaw.length;
    // Dedupe BEFORE filtering — collapses summary-list duplicates of formal entries
    const items = rule.sourcePath === 'spenden' ? dedupeByCanonicalRecipient(itemsRaw) : itemsRaw;
    const filtered = rule.filter ? items.filter(rule.filter) : items;
    const filteredCount = filtered.length;
    if (filteredCount === 0) continue;
    // Determine if aggregator applies. For arrays-of-objects (donations[]) we
    // pick the numeric fields. For scalar paths (income.bruttoarbeitslohn,
    // employee.surname) the value just passes through with type preserved.
    let value: CanonicalValue;
    let ceilingApplied = false;
    const isArrayOfObjects = filtered.length > 1 ||
      (filtered.length === 1 && typeof filtered[0] === 'object' && filtered[0] !== null);
    if (rule.aggregator && isArrayOfObjects) {
      const numericValues = filtered.map((it: any) => {
        if (typeof it === 'number') return it;
        if (typeof it === 'object' && it !== null) {
          return it.betrag_eur ?? it.amount_eur ?? it.amount ?? it.value ?? it.betrag ?? 0;
        }
        return 0;
      });
      const num = aggregate(numericValues, rule.aggregator);
      value = num;
      if (rule.ceiling !== undefined && num > rule.ceiling) { value = rule.ceiling; ceilingApplied = true; }
      if (rule.floor !== undefined && (value as number) < rule.floor) value = rule.floor;
    } else {
      // Scalar: pass through with type preserved (string, number, boolean)
      const raw = filtered[0];
      if (raw === null || raw === undefined) continue;
      if (typeof raw === 'number') {
        value = raw;
        if (rule.ceiling !== undefined && raw > rule.ceiling) { value = rule.ceiling; ceilingApplied = true; }
        if (rule.floor !== undefined && (value as number) < rule.floor) value = rule.floor;
      } else if (typeof raw === 'string' || typeof raw === 'boolean') {
        value = raw;
      } else if (typeof raw === 'object') {
        // Skip — object scalars don't translate to a single eCode value
        continue;
      } else {
        value = String(raw);
      }
    }
    // Write to layer
    layer.codes[rule.targetCode] = value;
    layer.traces.push({
      code: rule.targetCode,
      value,
      cascadeStage: 'deterministic-projection',
      confidence: 1.0,
      reasoning: `${rule.description}${ceilingApplied ? ` [ceiling ${rule.ceiling} applied]` : ''} ` +
                 `[${filteredCount}/${inputCount} items aggregated by ${rule.aggregator}]`,
    });
    result.appliedRules.push({
      rule: rule.description,
      targetCode: rule.targetCode,
      inputCount,
      filteredCount,
      aggregatedValue: value,
      ceilingApplied,
    });
  }
  return result;
}
