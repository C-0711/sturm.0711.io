/**
 * Quality-check / audit module for STURM.
 *
 * Two checks, ordered cheap → expensive. Both produce the same
 * `AuditFinding` shape so the UI can mix them in one table.
 *
 *   runConsistencyCheck(meta) — pure compute (~ms). Walks classify.kpis
 *     and extraction.annotation, verifies each value against
 *     extraction.markdown (verbatim + normalized). Plus light numeric
 *     sanity (brutto>=lohnsteuer, IBAN pattern, Steuer-ID 11-digit,
 *     date parseability). No model calls.
 *
 *   runSemanticCheck(meta, apiKey) — one mistral-small chat call (~3s,
 *     ~€0.001). Sends markdown + flat extraction back to the model
 *     and asks "for each path: ok | missing | mismatch | wrong_context"
 *     with quoted evidence.
 *
 * Both are pure structural/value comparison — no domain hardcoding.
 */

import type { DocumentMeta } from '../server/workspaces.ts';
import {
  callMistralOcrWithFallback,
  configToApiRequest,
  parseApiResponse,
  type DocumentChunk,
  type MistralOcrConfig,
} from './mistral-ocr/index.ts';

const CHAT_URL = 'https://api.mistral.ai/v1/chat/completions';
const SEMANTIC_MODEL = 'mistral-small-latest';
const VISION_MODEL = 'mistral-ocr-latest';

export interface AuditFinding {
  source: 'consistency' | 'semantic' | 'sanity' | 'structural';
  kind: 'kpi' | 'annotation' | 'numeric' | 'format';
  field: string;
  value: string;
  status: 'ok' | 'missing' | 'mismatch' | 'invented' | 'partial' | 'invalid';
  severity: 'info' | 'warn' | 'error';
  message: string;
  evidence?: string;
}

export interface AuditReport {
  ranAt: string;
  kind?: AuditKind;
  ms: number;
  consistencyMs: number;
  semanticMs?: number;
  semanticTokens?: number;
  semanticError?: string;
  visualMs?: number;
  totals: { ok: number; warn: number; error: number; total: number };
  findings: AuditFinding[];
}

// ---------- pure helpers ----------

function normalize(v: unknown): string {
  if (v == null) return '';
  let s = String(v).trim().toLowerCase();
  const de = s.match(/^(\d{2})\.(\d{2})\.((19|20)\d{2})$/);
  if (de) return `${de[3]}-${de[2]}-${de[1]}`;
  if (/(€|eur)/.test(s) || /^[\d.]+,\d{2}$/.test(s)) {
    s = s.replace(/€|eur/g, '').replace(/\s/g, '');
    if (/^-?[\d.]+,\d{2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  }
  return s.replace(/\s+/g, '');
}

// Generate every plausible textual form of a value: ISO ↔ DE date, with/without
// EUR/€ suffix, with/without thousand separators. The value is "found" if ANY
// variant appears (verbatim or normalized) in the markdown.
function variants(v: string): string[] {
  const out = new Set<string>([v.trim()]);
  const s = v.trim();
  // ISO date → DE date
  const iso = s.match(/^((?:19|20)\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
  if (iso) out.add(`${iso[3]}.${iso[2]}.${iso[1]}`);
  // DE date → ISO
  const de = s.match(/^(0[1-9]|[12]\d|3[01])\.(0[1-9]|1[0-2])\.((?:19|20)\d{2})$/);
  if (de) out.add(`${de[3]}-${de[2]}-${de[1]}`);
  // Number with/without currency, with/without thousand sep
  const numMatch = s.match(/^(-?[\d.]+,\d{2})\s*(€|EUR|eur)?$/);
  if (numMatch) {
    const num = numMatch[1];
    out.add(num);
    out.add(`${num} €`);
    out.add(`${num} EUR`);
    // Strip thousand separators
    const noThou = num.replace(/\./g, '');
    out.add(noThou);
    out.add(`${noThou} €`);
    out.add(`${noThou} EUR`);
  }
  return [...out];
}

function flattenLeaves(node: unknown, path = '', out: Array<{ path: string; value: string }> = []): Array<{ path: string; value: string }> {
  if (node == null) return out;
  if (Array.isArray(node)) {
    node.forEach((v, i) => flattenLeaves(v, `${path}[${i}]`, out));
  } else if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      flattenLeaves(v, path ? `${path}.${k}` : k, out);
    }
  } else {
    if (typeof node === 'string' ? node.trim() !== '' : node != null) {
      out.push({ path: path || '', value: String(node) });
    }
  }
  return out;
}

function findInMarkdown(value: string, markdown: string): { found: boolean; matchKind: 'verbatim' | 'normalized' | 'partial' | null; evidence?: string } {
  if (!markdown || !value) return { found: false, matchKind: null };
  // 1. Try every plausible variant (ISO/DE date, currency suffix, thousand sep) verbatim
  for (const variant of variants(value)) {
    const idx = markdown.indexOf(variant);
    if (idx >= 0) {
      return { found: true, matchKind: variant === value.trim() ? 'verbatim' : 'normalized', evidence: snippetAround(markdown, idx, variant.length) };
    }
  }
  // 2. Compact-normalized scan
  const target = normalize(value);
  if (target) {
    const compactMd = markdown.replace(/\s+/g, '').toLowerCase();
    const compactTarget = target.replace(/\s+/g, '');
    const cIdx = compactMd.indexOf(compactTarget);
    if (cIdx >= 0) {
      // Approximate evidence: find nearest non-whitespace span in original
      return { found: true, matchKind: 'normalized', evidence: snippetAround(markdown, Math.min(cIdx, markdown.length - 1), compactTarget.length) };
    }
  }
  // 3. Multi-token: every whitespace-separated token (≥3 chars) must appear within a window
  const tokens = value.trim().split(/\s+/).filter((t) => t.length >= 3);
  if (tokens.length >= 2) {
    const lcMd = markdown.toLowerCase();
    const positions = tokens.map((t) => lcMd.indexOf(t.toLowerCase()));
    if (positions.every((p) => p >= 0)) {
      const min = Math.min(...positions);
      const max = Math.max(...positions);
      // Within 200 chars of each other = same context (table row, paragraph)
      if (max - min < 200) {
        return { found: true, matchKind: 'normalized', evidence: snippetAround(markdown, min, max - min + 20) };
      }
    }
  }
  // 4. Partial: at least 70% of digits/letters present on some line
  const stripped = (target || value).replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (stripped.length >= 6) {
    const lines = markdown.split(/\n/);
    for (const line of lines) {
      const lineStripped = line.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (lineStripped.includes(stripped)) {
        return { found: true, matchKind: 'partial', evidence: line.trim().slice(0, 200) };
      }
    }
  }
  return { found: false, matchKind: null };
}

function snippetAround(text: string, idx: number, len: number, span = 80): string {
  const start = Math.max(0, idx - 30);
  const end = Math.min(text.length, idx + len + (span - 30));
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
}

// ---------- consistency check (pure compute) ----------

export function runConsistencyCheck(meta: DocumentMeta): { findings: AuditFinding[]; ms: number } {
  const t0 = Date.now();
  const findings: AuditFinding[] = [];
  const markdown = meta.extraction?.markdown ?? '';
  const haveMarkdown = markdown.length > 0;

  // No markdown = nothing to check against. Return ONE actionable warning instead
  // of N "partial" findings that pretend to be checks.
  if (!haveMarkdown) {
    return {
      findings: [{
        source: 'consistency', kind: 'annotation', field: '*', value: '',
        status: 'partial', severity: 'warn',
        message: 'Kein OCR-Text vorhanden. Klick „Extrahieren" einmal — danach kann der Konsistenz-Check jeden Wert gegen den Text prüfen.',
      }],
      ms: Date.now() - t0,
    };
  }

  // KPIs: each must appear in markdown
  for (const kpi of meta.classification?.kpis ?? []) {
    const m = findInMarkdown(kpi.value, markdown);
    if (m.found) {
      findings.push({
        source: 'consistency', kind: 'kpi', field: kpi.key, value: kpi.value,
        status: m.matchKind === 'verbatim' ? 'ok' : m.matchKind === 'normalized' ? 'ok' : 'partial',
        severity: m.matchKind === 'verbatim' ? 'info' : 'info',
        message: m.matchKind === 'verbatim' ? 'wortgleich im OCR-Text gefunden'
          : m.matchKind === 'normalized' ? 'umformatiert im OCR-Text gefunden'
          : 'teilweise im OCR-Text gefunden',
        evidence: m.evidence,
      });
    } else {
      findings.push({
        source: 'consistency', kind: 'kpi', field: kpi.key, value: kpi.value,
        status: 'invented', severity: 'error',
        message: 'KPI-Wert nicht im OCR-Text — möglicherweise vom Modell halluziniert',
      });
    }
  }

  // Annotation leaves: same check
  const flat = flattenLeaves(meta.extraction?.annotation);
  for (const leaf of flat) {
    const m = findInMarkdown(leaf.value, markdown);
    if (m.found) {
      findings.push({
        source: 'consistency', kind: 'annotation', field: leaf.path, value: leaf.value,
        status: m.matchKind === 'verbatim' ? 'ok' : m.matchKind === 'normalized' ? 'ok' : 'partial',
        severity: 'info',
        message: m.matchKind === 'verbatim' ? 'wortgleich im OCR-Text'
          : m.matchKind === 'normalized' ? 'umformatiert im OCR-Text'
          : 'partielle Übereinstimmung',
        evidence: m.evidence,
      });
    } else {
      findings.push({
        source: 'consistency', kind: 'annotation', field: leaf.path, value: leaf.value,
        status: 'invented', severity: 'error',
        message: 'Annotation-Wert nicht im OCR-Text gefunden',
      });
    }
  }

  // Numeric sanity (purely structural — no domain rules)
  const numericLeaves = flat.filter((l) => /^[\d.]+,\d{2}$/.test(l.value.replace(/\s|€|EUR/gi, '')));
  for (const leaf of numericLeaves) {
    const num = parseFloat(leaf.value.replace(/\s|€|EUR/gi, '').replace(/\./g, '').replace(',', '.'));
    if (!Number.isFinite(num) || num < 0) {
      findings.push({
        source: 'sanity', kind: 'numeric', field: leaf.path, value: leaf.value,
        status: 'invalid', severity: 'warn',
        message: `Wert lässt sich nicht als positive Zahl interpretieren (${num})`,
      });
    }
  }

  // IBAN sanity: 22 chars for DE, basic alphanumeric
  for (const leaf of flat) {
    if (/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(leaf.value)) {
      if (leaf.value.startsWith('DE') && leaf.value.length !== 22) {
        findings.push({
          source: 'sanity', kind: 'format', field: leaf.path, value: leaf.value,
          status: 'invalid', severity: 'warn',
          message: `DE-IBAN sollte 22 Zeichen lang sein (ist ${leaf.value.length})`,
        });
      }
    }
  }

  // Steuer-ID sanity: 11 digits
  for (const leaf of flat) {
    if (/steuer[-_ ]?id|identifikationsnummer/i.test(leaf.path)) {
      const digits = leaf.value.replace(/\D/g, '');
      if (digits.length !== 11) {
        findings.push({
          source: 'sanity', kind: 'format', field: leaf.path, value: leaf.value,
          status: 'invalid', severity: 'warn',
          message: `Steuer-Identifikationsnummer sollte 11 Ziffern haben (hat ${digits.length})`,
        });
      }
    }
  }

  // Dates sanity
  for (const leaf of flat) {
    if (/datum|date/i.test(leaf.path) && leaf.value) {
      const isIso = /^(19|20)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(leaf.value);
      const isDe  = /^(0[1-9]|[12]\d|3[01])\.(0[1-9]|1[0-2])\.(19|20)\d{2}$/.test(leaf.value);
      if (!isIso && !isDe) {
        findings.push({
          source: 'sanity', kind: 'format', field: leaf.path, value: leaf.value,
          status: 'invalid', severity: 'warn',
          message: 'Wert sieht nicht wie ein parsbares Datum (yyyy-mm-dd / dd.mm.yyyy) aus',
        });
      }
    }
  }

  return { findings, ms: Date.now() - t0 };
}

// ---------- semantic check (one mistral-small call) ----------

const SEMANTIC_PROMPT =
  'Du bist strenger Auditor für Dokumentenextraktion. Du erhältst (a) den ROHEN OCR-TEXT eines Dokuments und ' +
  '(b) eine Liste extrahierter Werte (path: value). Der Pfad sagt dir, WAS der Wert sein soll ' +
  '(z.B. "person_a.geburtsdatum" = das Geburtsdatum der ersten Person).\n\n' +
  'WICHTIG — was du IGNORIEREN sollst (das sind keine Fehler):\n' +
  '- Datumsformat: "1963-05-27" und "27.05.1963" sind derselbe Wert.\n' +
  '- Zahlenformat: "302,37 €", "302,37 EUR", "302,37" und "302.37" sind derselbe Wert.\n' +
  '- Reihenfolge bei Namen: "Rainer Stricker" und "Stricker, Rainer" sind derselbe Wert.\n' +
  '- Groß-/Kleinschreibung, Whitespace, Zeilenumbrüche.\n' +
  '- Abstrakte Rollennamen im path: "person_a"/"person_b" entspricht im Dokument typischerweise ' +
  '"Steuerpflichtiger"/"Ehegatte"/"Lebenspartner"/"Partner". Kein wrong_context, wenn der Wert ' +
  'inhaltlich korrekt ist — nur die Beschriftung im Dokument anders heißt.\n' +
  '- Schlüsselbeschriftung (z.B. KPI-Name) ist KEIN Fehler — auditiere NUR den value, nicht den path.\n\n' +
  'Du sollst NUR melden:\n' +
  '- "missing": der Wert kommt im Dokument GAR NICHT vor (auch nicht umformatiert).\n' +
  '- "mismatch": ein ähnlicher Wert IST im Dokument, aber inhaltlich abweichend (anderer Betrag, anderes Datum, Tippfehler).\n' +
  '- "wrong_context": der Wert KOMMT IM DOKUMENT VOR, gehört aber laut Pfad zu einer anderen Stelle ' +
  '(z.B. person_a.geburtsdatum=27.05.1963, aber 27.05.1963 ist im Dokument das Geburtsdatum von Person B).\n' +
  '- "ok": Wert ist korrekt UND dem richtigen Feld zugeordnet (auch wenn umformatiert).\n\n' +
  'Sei streng bei Kontext-Verwechslungen (Person A vs Person B, Arbeitnehmer vs Arbeitgeber, Brutto vs Netto). ' +
  'Sei großzügig bei Format-Unterschieden — die sind nie ein Fehler.\n' +
  'Bei "missing"/"mismatch"/"wrong_context": kurze Begründung auf Deutsch + Zitat aus dem OCR-Text als evidence.\n' +
  'WICHTIG: Du MUSST für JEDEN gelieferten Wert genau ein finding zurückgeben — gleicher path, gleicher value, ' +
  'in derselben Reihenfolge. Lass keinen Wert weg.\n' +
  'Antworte ausschließlich gemäß dem vorgegebenen JSON-Schema.';

const SEMANTIC_SCHEMA = {
  type: 'object',
  required: ['findings'],
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'value', 'status'],
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          value: { type: 'string' },
          status: { type: 'string', enum: ['ok', 'missing', 'mismatch', 'wrong_context'] },
          message: { type: 'string' },
          evidence: { type: 'string' },
        },
      },
    },
  },
};

export async function runSemanticCheck(meta: DocumentMeta, opts: { apiKey: string; signal?: AbortSignal; baseUrl?: string }): Promise<{ findings: AuditFinding[]; ms: number; tokens?: number; error?: string }> {
  const t0 = Date.now();
  const markdown = meta.extraction?.markdown ?? '';
  // Semantic checks BOTH classification.kpis AND extraction.annotation. Even
  // without an extracted annotation, the model can audit the classification's
  // claimed KPI values.
  const kpis = (meta.classification?.kpis ?? []).map((k) => ({ path: `kpi.${k.key}`, value: k.value }));
  const ann = flattenLeaves(meta.extraction?.annotation).map((l) => ({ path: l.path, value: l.value }));
  const flat = [...kpis, ...ann];
  if (!markdown || flat.length === 0) {
    return {
      findings: [{
        source: 'semantic', kind: 'annotation', field: '*', value: '',
        status: 'partial', severity: 'warn',
        message: !markdown
          ? 'Kein OCR-Text vorhanden. Klick „Extrahieren" oder „Visuelles Audit" zuerst.'
          : 'Weder Klassifikation-KPIs noch Extraktion vorhanden.',
      }],
      ms: 0,
      error: !markdown ? 'no markdown' : 'no values',
    };
  }
  const flatLines = flat.map((l) => `${l.path}: ${l.value}`).join('\n');
  // Cap markdown to ~12 KB to stay under context limits comfortably
  const mdCapped = markdown.length > 12_000 ? markdown.slice(0, 12_000) + '\n…[gekürzt]' : markdown;

  const body = {
    model: SEMANTIC_MODEL,
    stream: false,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: SEMANTIC_PROMPT },
          { type: 'text', text: '\n\n=== OCR-TEXT ===\n' + mdCapped },
          { type: 'text', text: '\n\n=== EXTRAHIERT (path: value) ===\n' + flatLines },
        ],
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'audit_findings', schema: SEMANTIC_SCHEMA, strict: true },
    },
  };

  const url = opts.baseUrl ?? CHAT_URL;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  const text = await resp.text();
  if (!resp.ok) {
    return { findings: [], ms: Date.now() - t0, error: `mistral ${resp.status}: ${text.slice(0, 300)}` };
  }
  let json: { choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number } };
  try { json = JSON.parse(text); } catch { return { findings: [], ms: Date.now() - t0, error: 'response not JSON' }; }
  const content = json.choices?.[0]?.message?.content;
  if (!content) return { findings: [], ms: Date.now() - t0, error: 'empty content' };
  let parsed: { findings: Array<{ path: string; value: string; status: string; message?: string; evidence?: string }> };
  try { parsed = JSON.parse(content); } catch { return { findings: [], ms: Date.now() - t0, error: 'content not JSON' }; }

  const findings: AuditFinding[] = (parsed.findings ?? []).map((f) => {
    const sev = f.status === 'ok' ? 'info' : f.status === 'mismatch' || f.status === 'wrong_context' ? 'error' : 'warn';
    return {
      source: 'semantic',
      kind: 'annotation',
      field: f.path,
      value: f.value,
      status: f.status as AuditFinding['status'],
      severity: sev as AuditFinding['severity'],
      message: f.message ?? defaultMessageForStatus(f.status),
      evidence: f.evidence,
    };
  });
  return { findings, ms: Date.now() - t0, tokens: json.usage?.total_tokens };
}

function defaultMessageForStatus(s: string): string {
  switch (s) {
    case 'ok': return 'Wert im OCR-Text bestätigt';
    case 'missing': return 'Wert nicht im OCR-Text gefunden';
    case 'mismatch': return 'Abweichung gegenüber OCR-Text';
    case 'wrong_context': return 'Wert in falschem Kontext zugeordnet';
    default: return s;
  }
}

// ---------- vision audit (mistral-ocr-latest re-reads the document image) ----------

const VISION_AUDIT_PROMPT =
  'Du bist strenger Auditor. Du SIEHST das Dokument als Bild. ' +
  'Du erhältst eine Liste behaupteter Werte (path: value). ' +
  'Für JEDEN Wert: schau im Dokument nach, ob er dort SO vorkommt — und ob er dem ' +
  'durch den path beschriebenen Feld zugeordnet ist (Person, Zeile, Spalte, Posten).\n\n' +
  'IGNORIEREN (keine Fehler):\n' +
  '- Datumsformat (1963-05-27 = 27.05.1963), Zahlenformat (302,37 € = 302,37 EUR = 302,37).\n' +
  '- Reihenfolge bei Namen, Groß-/Kleinschreibung, Whitespace.\n' +
  '- Abstrakte Rollen im path: person_a/person_b ↔ Steuerpflichtiger/Ehegatte/Partner.\n\n' +
  'MELDEN als Fehler:\n' +
  '- "missing": Wert ist im Dokument nirgends sichtbar.\n' +
  '- "mismatch": ähnlicher Wert sichtbar, aber numerisch/textlich abweichend ' +
  '(falscher Betrag, falsches Datum, Tippfehler — auch wenn die OCR-Text-Form gleich aussieht).\n' +
  '- "wrong_context": Wert ist sichtbar, gehört aber zu einer ANDEREN Person/Zeile/Spalte als der path sagt.\n\n' +
  'Bei jedem Fehler: kurze Begründung + Seitenzahl (1-basiert) + Zitat dessen, was du auf der Seite siehst.\n' +
  'Du MUSST für JEDEN gelieferten Wert ein finding zurückgeben (gleicher path, gleicher value, gleiche Reihenfolge).';

const VISION_AUDIT_SCHEMA = {
  type: 'object',
  required: ['findings'],
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'value', 'status'],
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          value: { type: 'string' },
          status: { type: 'string', enum: ['ok', 'missing', 'mismatch', 'wrong_context'] },
          page: { type: 'integer' },
          message: { type: 'string' },
          evidence: { type: 'string' },
        },
      },
    },
  },
};

export async function runVisionAudit(meta: DocumentMeta, opts: { apiKey: string; document: DocumentChunk; signal?: AbortSignal }): Promise<{ findings: AuditFinding[]; ms: number; error?: string }> {
  const t0 = Date.now();
  const kpis = (meta.classification?.kpis ?? []).map((k) => ({ path: `kpi.${k.key}`, value: k.value }));
  const ann = flattenLeaves(meta.extraction?.annotation).map((l) => ({ path: l.path, value: l.value }));
  const flat = [...kpis, ...ann];
  if (flat.length === 0) {
    return {
      findings: [{
        source: 'semantic', kind: 'annotation', field: '*', value: '',
        status: 'partial', severity: 'warn',
        message: 'Keine Werte zum Auditieren — weder Klassifikation-KPIs noch Extraktion vorhanden.',
      }],
      ms: 0,
      error: 'no values',
    };
  }
  const flatLines = flat.map((l) => `${l.path}: ${l.value}`).join('\n');
  const prompt = VISION_AUDIT_PROMPT + '\n\n=== ZU AUDITIERENDE WERTE ===\n' + flatLines;

  const cfg: MistralOcrConfig = {
    model: VISION_MODEL,
    documentAnnotation: {
      schema: VISION_AUDIT_SCHEMA,
      name: 'audit_findings',
      prompt,
    },
  };
  const apiReq = configToApiRequest(cfg, opts.document, { runId: 'workspace-audit', stageId: 'vision' });
  try {
    const { response, degradation } = await callMistralOcrWithFallback(apiReq, { apiKey: opts.apiKey, signal: opts.signal });
    const parsed = parseApiResponse(response, cfg, t0, degradation);
    const ann = parsed.documentAnnotation as { findings?: Array<{ path: string; value: string; status: string; page?: number; message?: string; evidence?: string }> } | null;
    if (!ann || !Array.isArray(ann.findings)) {
      return { findings: [], ms: Date.now() - t0, error: 'no findings in vision response' };
    }
    const findings: AuditFinding[] = ann.findings.map((f) => {
      const sev = f.status === 'ok' ? 'info' : f.status === 'mismatch' || f.status === 'wrong_context' ? 'error' : 'warn';
      const pageHint = f.page ? `S.${f.page}` : null;
      const evidence = f.evidence ? (pageHint ? `${pageHint}: ${f.evidence}` : f.evidence) : pageHint ?? undefined;
      return {
        source: 'semantic',
        kind: 'annotation',
        field: f.path,
        value: f.value,
        status: f.status as AuditFinding['status'],
        severity: sev as AuditFinding['severity'],
        message: f.message ?? defaultMessageForStatus(f.status),
        evidence,
      };
    });
    return { findings, ms: Date.now() - t0 };
  } catch (e) {
    const err = e as Error;
    return { findings: [], ms: Date.now() - t0, error: err.message ?? String(err) };
  }
}

// ---------- visual / per-page locator (uses persisted pagesMarkdown if present) ----------

export function runVisualLocator(meta: DocumentMeta): { findings: AuditFinding[]; ms: number; coverage: { located: number; missing: number } } {
  const t0 = Date.now();
  const findings: AuditFinding[] = [];
  const pages = meta.extraction?.pagesMarkdown ?? [];
  if (pages.length === 0) {
    return {
      findings: [{
        source: 'consistency', kind: 'annotation', field: '*', value: '',
        status: 'partial', severity: 'warn',
        message: 'Per-Seiten OCR-Text nicht verfügbar — Dokument vor Aktivierung dieses Features extrahiert. Re-Extrahieren nötig.',
      }],
      ms: Date.now() - t0,
      coverage: { located: 0, missing: 0 },
    };
  }
  // Locate every claimed value (KPIs from classification + annotation leaves)
  // on a specific page. Discrepancies = values the eye can't find anywhere.
  const targets: Array<{ kind: 'kpi' | 'annotation'; field: string; value: string }> = [
    ...(meta.classification?.kpis ?? []).map((k) => ({ kind: 'kpi' as const, field: k.key, value: k.value })),
    ...flattenLeaves(meta.extraction?.annotation).map((l) => ({ kind: 'annotation' as const, field: l.path, value: l.value })),
  ];
  let located = 0, missing = 0;
  for (const t of targets) {
    let foundPage: number | null = null;
    let evidence: string | undefined;
    for (let i = 0; i < pages.length; i++) {
      const m = findInMarkdown(t.value, pages[i]);
      if (m.found) { foundPage = i + 1; evidence = m.evidence; break; }
    }
    if (foundPage != null) {
      located++;
      findings.push({
        source: 'consistency', kind: t.kind, field: t.field, value: t.value,
        status: 'ok', severity: 'info',
        message: `Auf Seite ${foundPage} lokalisiert`,
        evidence: evidence ? `S.${foundPage}: ${evidence}` : `S.${foundPage}`,
      });
    } else {
      missing++;
      findings.push({
        source: 'consistency', kind: t.kind, field: t.field, value: t.value,
        status: 'missing', severity: 'error',
        message: 'Auf keiner Seite lokalisierbar',
      });
    }
  }
  return { findings, ms: Date.now() - t0, coverage: { located, missing } };
}

// ---------- cross-model audit (Claude Haiku 4.5 second opinion) ----------

export interface CrossModelInput {
  fileBase64: string;
  mediaType: string;
  anthropicApiKey: string;
}

export async function runCrossModelAudit(meta: DocumentMeta, opts: { signal?: AbortSignal } & CrossModelInput): Promise<{ findings: AuditFinding[]; ms: number; otherKpis?: number; error?: string }> {
  const t0 = Date.now();
  const mistralKpis = meta.classification?.kpis ?? [];
  if (mistralKpis.length === 0) {
    return {
      findings: [{
        source: 'semantic', kind: 'kpi', field: '*', value: '',
        status: 'partial', severity: 'warn',
        message: 'Keine Mistral-KPIs zum Vergleichen — Klassifikation zuerst ausführen.',
      }],
      ms: 0, error: 'no mistral kpis',
    };
  }
  const { classifyDocumentClaude } = await import('./classify-claude.ts');
  let claude;
  try {
    claude = await classifyDocumentClaude({
      fileBase64: opts.fileBase64,
      mediaType: opts.mediaType,
      apiKey: opts.anthropicApiKey,
      signal: opts.signal,
    });
  } catch (e) {
    return { findings: [], ms: Date.now() - t0, error: (e as Error).message };
  }
  const claudeKpis = claude.kpis;

  // Match KPIs across models by normalized key. Then compare values.
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const claudeMap = new Map<string, string>();
  for (const k of claudeKpis) {
    const nk = norm(k.key);
    if (nk && !claudeMap.has(nk)) claudeMap.set(nk, k.value);
  }
  const mistralMap = new Map<string, string>();
  for (const k of mistralKpis) {
    const nk = norm(k.key);
    if (nk && !mistralMap.has(nk)) mistralMap.set(nk, k.value);
  }

  const valuesEqual = (a: string, b: string) => {
    if (a === b) return true;
    const na = normalize(a), nb = normalize(b);
    if (na && na === nb) return true;
    // Try variants for date/number format equivalence
    const va = new Set(variants(a).map((v) => v.toLowerCase().replace(/\s/g, '')));
    for (const v of variants(b)) {
      if (va.has(v.toLowerCase().replace(/\s/g, ''))) return true;
    }
    return false;
  };

  const findings: AuditFinding[] = [];
  // 1. For every Mistral KPI, check if Claude agrees
  for (const mk of mistralKpis) {
    const ck = claudeMap.get(norm(mk.key));
    if (ck === undefined) {
      findings.push({
        source: 'semantic', kind: 'kpi', field: mk.key, value: mk.value,
        status: 'partial', severity: 'warn',
        message: 'Claude Haiku hat dieses Feld nicht extrahiert — Mistral könnte halluziniert haben oder Feld ist randständig.',
      });
    } else if (!valuesEqual(ck, mk.value)) {
      findings.push({
        source: 'semantic', kind: 'kpi', field: mk.key, value: mk.value,
        status: 'mismatch', severity: 'error',
        message: `Modelle widersprechen sich: Mistral „${mk.value}" vs Claude „${ck}". Mindestens eines liest falsch.`,
        evidence: `Claude: ${ck}`,
      });
    } else {
      findings.push({
        source: 'semantic', kind: 'kpi', field: mk.key, value: mk.value,
        status: 'ok', severity: 'info',
        message: 'Beide Modelle stimmen überein',
        evidence: `Claude: ${ck}`,
      });
    }
  }
  // 2. KPIs Claude found that Mistral didn't = potential extraction gaps
  for (const ck of claudeKpis) {
    if (!mistralMap.has(norm(ck.key))) {
      findings.push({
        source: 'semantic', kind: 'kpi', field: ck.key, value: ck.value,
        status: 'missing', severity: 'warn',
        message: 'Nur Claude Haiku hat diesen Wert extrahiert — Mistral hat ihn übersehen. Lücke in der Klassifikation.',
        evidence: `Claude: ${ck.value}`,
      });
    }
  }
  return { findings, ms: Date.now() - t0, otherKpis: claudeKpis.length };
}

// ---------- structural / algorithmic audit (regex token extraction) ----------
//
// Pure-compute deterministic check. Extracts typed tokens (IBAN, Steuer-ID,
// PLZ, currency, date, phone, BIC, email) from the OCR markdown, then verifies
// each claimed value of a known type against the actual token set. Catches
// hallucinations (claimed value isn't in the OCR's token set) and truncations
// (claimed IBAN has 20 chars, OCR has the full 22). ~10 ms, no model calls.

interface TypedToken {
  kind: 'iban' | 'steuer_id' | 'plz' | 'currency' | 'date' | 'phone' | 'bic' | 'email' | 'percent' | 'checkbox';
  value: string;
  position: number; // index in markdown
}

const TOKEN_PATTERNS: Array<{ kind: TypedToken['kind']; re: RegExp; clean?: (s: string) => string }> = [
  // IBAN: 2 letters + 2 digits + up to 30 alphanumerics. Strip whitespace inside.
  { kind: 'iban', re: /\b([A-Z]{2})\s?(\d{2})\s?((?:[A-Z0-9]\s?){11,30})/g, clean: (s) => s.replace(/\s/g, '') },
  // Steuer-Identifikationsnummer: 11 digits (often after "Identifikationsnummer" but we capture all)
  { kind: 'steuer_id', re: /\b\d{11}\b/g },
  // PLZ: 5 digits, typically followed by space + city name. We restrict to "5 digits whitespace [Capital]" to avoid matching random 5-digit numbers.
  { kind: 'plz', re: /\b(\d{5})\s+[A-ZÄÖÜ][a-zäöüß]/g, clean: (s) => s.match(/\d{5}/)![0] },
  // Currency with cents: -?123.456,78 with optional € or EUR.
  { kind: 'currency', re: /-?\b\d{1,3}(?:\.\d{3})*,\d{2}\b\s?(?:€|EUR)?/g },
  // Bare integer amounts: 2-6 digit integers. Tax docs routinely show
  // whole-euro values without the ",00". OCR layout flattening means we
  // can't reliably distinguish line numbers ("Nr. 27") from amounts at
  // regex level — we accept both and let the gap-detection's normalized
  // value-claim check do the suppression (KPIs claiming "27" or "43"
  // remove those line-number tokens from gap warnings).
  { kind: 'currency', re: /-?\b\d{1,6}\b\s?(?:€|EUR)/g },
  { kind: 'currency', re: /(?<![,.\d])\b([1-9]\d{1,5})\b(?![,.\d])/g, clean: (s) => s.match(/\d+/)![0] },
  // Date DE: dd.mm.yyyy
  { kind: 'date', re: /\b(0[1-9]|[12]\d|3[01])\.(0[1-9]|1[0-2])\.((?:19|20)\d{2})\b/g },
  // Date ISO: yyyy-mm-dd
  { kind: 'date', re: /\b((?:19|20)\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g },
  // Phone: German formats — 02747-9149585, +49 30 12345678, (030) 12345678, 0151 12345678
  { kind: 'phone', re: /(?:\+49|0)[\d\s\-()/]{7,20}\d/g },
  // BIC: 8 or 11 chars, 4 letters + 2 letters + 2 alphanum + optional 3 alphanum
  { kind: 'bic', re: /\b[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/g },
  // Email
  { kind: 'email', re: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g },
  // Percent: 12,5 % or 12.5%
  { kind: 'percent', re: /\b\d{1,3}(?:[.,]\d{1,2})?\s?%/g },
  // Checkbox: ☒ ☑ [X] [x] mark a "true"; ☐ □ [ ] mark "false". Capture the next ~30 chars as label hint.
  { kind: 'checkbox', re: /[☒☑✓✔]|\[[xX]\]/g },
];

export function extractTypedTokens(markdown: string): TypedToken[] {
  const tokens: TypedToken[] = [];
  for (const { kind, re, clean } of TOKEN_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(markdown)) !== null) {
      const raw = m[0];
      const v = clean ? clean(raw) : raw.trim();
      if (v) tokens.push({ kind, value: v, position: m.index });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  // Post-filter: drop bare-integer "currency" tokens that are obviously not
  // amounts — 4-digit years (1900-2099), or values that overlap with a
  // higher-confidence token (Steuer-ID, PLZ, phone, BIC) at the same position.
  const claimedRanges = tokens
    .filter((t) => ['steuer_id', 'plz', 'phone', 'bic'].includes(t.kind))
    .map((t) => ({ start: t.position, end: t.position + t.value.length }));
  const isInsideClaimed = (pos: number, len: number) => claimedRanges.some((r) => pos >= r.start && pos + len <= r.end);
  const filtered = tokens.filter((t) => {
    if (t.kind !== 'currency') return true;
    const n = parseFloat(t.value.replace(/[€EUR\s.]/gi, '').replace(',', '.'));
    if (Number.isNaN(n)) return true;
    // Years 1900-2099 in the bare-integer form (4 digits, no comma) are not amounts
    if (/^\d{4}$/.test(t.value) && n >= 1900 && n <= 2099) return false;
    // Overlapping with already-typed token (steuer-id, phone) — suppress
    if (isInsideClaimed(t.position, t.value.length)) return false;
    return true;
  });
  // Dedupe identical (kind, value, position)
  const seen = new Set<string>();
  return filtered.filter((t) => {
    const k = `${t.kind}:${t.value}:${t.position}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Classify a claimed value into one of our typed kinds. Returns null for
// values that aren't typed (names, free text, addresses) — those bypass the
// structural check.
function classifyValue(value: string, fieldHint?: string): TypedToken['kind'] | null {
  const v = value.trim();
  if (!v) return null;
  // IBAN
  if (/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(v.replace(/\s/g, ''))) return 'iban';
  // Steuer-ID
  if (/^\d{11}$/.test(v)) return 'steuer_id';
  // PLZ — only when field hint suggests location
  if (/^\d{5}$/.test(v) && /(plz|postleitzahl|zip|postal)/i.test(fieldHint ?? '')) return 'plz';
  // Currency with cents — high-confidence amount form
  if (/^-?\d{1,3}(\.\d{3})*,\d{2}\s?(€|EUR)?$/.test(v)) return 'currency';
  // Bare integer with explicit €/EUR suffix — also high-confidence
  if (/^-?\d{1,6}\s?(€|EUR)$/.test(v)) return 'currency';
  // Bare integer without suffix — NOT classified here (no domain keywords).
  // It will still be reachable via the OCR token pool: a KPI value "841" with
  // no type still appears in confirmed/conflict/gap math through the
  // value-equality checks; we just don't fire structural-only verification.
  // Date
  if (/^(0[1-9]|[12]\d|3[01])\.(0[1-9]|1[0-2])\.(19|20)\d{2}$/.test(v)) return 'date';
  if (/^(19|20)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(v)) return 'date';
  // Phone — at least one separator/space and length 8-20
  if (/^(\+49|0)[\d\s\-()/]{6,20}\d$/.test(v)) return 'phone';
  // Email
  if (/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(v)) return 'email';
  // Percent
  if (/^\d{1,3}([.,]\d{1,2})?\s?%$/.test(v)) return 'percent';
  return null;
}

// Currency-equivalent: ignore EUR/€ suffix, thousand separators, AND
// bare-integer ↔ decimal-cents form ("841" matches "841,00" matches "841,00 €").
function currencyEqual(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/€|EUR|\s/gi, '').replace(/\./g, '').replace(',', '.');
  const na = norm(a), nb = norm(b);
  if (na === nb) return true;
  const fa = parseFloat(na), fb = parseFloat(nb);
  if (Number.isFinite(fa) && Number.isFinite(fb) && fa === fb) return true;
  return false;
}
function dateEqual(a: string, b: string): boolean {
  const toIso = (s: string) => {
    const de = s.match(/^(\d{2})\.(\d{2})\.((?:19|20)\d{2})$/);
    if (de) return `${de[3]}-${de[2]}-${de[1]}`;
    return s;
  };
  return toIso(a) === toIso(b);
}
function tokensMatch(claimed: string, found: string, kind: TypedToken['kind']): boolean {
  if (claimed === found) return true;
  if (kind === 'currency') return currencyEqual(claimed, found);
  if (kind === 'date') return dateEqual(claimed, found);
  if (kind === 'iban') return claimed.replace(/\s/g, '') === found.replace(/\s/g, '');
  return claimed.toLowerCase() === found.toLowerCase();
}

export function runStructuralCheck(meta: DocumentMeta): { findings: AuditFinding[]; ms: number; tokensFound: number } {
  const t0 = Date.now();
  const findings: AuditFinding[] = [];
  const markdown = meta.extraction?.markdown ?? '';
  if (!markdown) {
    return {
      findings: [{
        source: 'structural', kind: 'annotation', field: '*', value: '',
        status: 'partial', severity: 'warn',
        message: 'Kein OCR-Text vorhanden. Klick „Extrahieren" oder „Visuelles Audit" zuerst — danach kann der Strukturchecker laufen.',
      }],
      ms: Date.now() - t0,
      tokensFound: 0,
    };
  }

  const tokens = extractTypedTokens(markdown);
  // Group tokens by kind for fast lookup
  const tokensByKind = new Map<TypedToken['kind'], string[]>();
  for (const t of tokens) {
    if (!tokensByKind.has(t.kind)) tokensByKind.set(t.kind, []);
    tokensByKind.get(t.kind)!.push(t.value);
  }

  // Build the set of claimed values (KPIs + annotation leaves)
  const claimed: Array<{ field: string; value: string; sourceKind: 'kpi' | 'annotation' }> = [
    ...(meta.classification?.kpis ?? []).map((k) => ({ field: k.key, value: k.value, sourceKind: 'kpi' as const })),
    ...flattenLeaves(meta.extraction?.annotation).map((l) => ({ field: l.path, value: l.value, sourceKind: 'annotation' as const })),
  ];

  // Build a normalized lookup of EVERY claimed value (typed or not) so gap
  // detection compares against all claims — including untyped ones like bare
  // integer amounts where field-name doesn't reveal the type.
  const claimedAnyValue = new Set<string>();
  for (const c of claimed) {
    const v = c.value.trim();
    if (!v) continue;
    claimedAnyValue.add(v);
    claimedAnyValue.add(v.toLowerCase());
    // Currency-equivalent normalizations so "841" matches "841,00", "841 €", etc.
    claimedAnyValue.add(v.replace(/€|EUR|\s/gi, '').replace(/\./g, '').replace(',', '.'));
    const num = parseFloat(v.replace(/€|EUR|\s/gi, '').replace(/\./g, '').replace(',', '.'));
    if (Number.isFinite(num)) claimedAnyValue.add(String(num));
    // Date normalizations
    const de = v.match(/^(\d{2})\.(\d{2})\.((?:19|20)\d{2})$/);
    if (de) claimedAnyValue.add(`${de[3]}-${de[2]}-${de[1]}`);
    const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) claimedAnyValue.add(`${iso[3]}.${iso[2]}.${iso[1]}`);
    // IBAN: stripped form
    if (/^[A-Z]{2}\d{2}/.test(v)) claimedAnyValue.add(v.replace(/\s/g, ''));
  }
  const tokenIsClaimed = (t: TypedToken): boolean => {
    const v = t.value.trim();
    if (claimedAnyValue.has(v) || claimedAnyValue.has(v.toLowerCase())) return true;
    const norm = v.replace(/€|EUR|\s/gi, '').replace(/\./g, '').replace(',', '.');
    if (claimedAnyValue.has(norm)) return true;
    const num = parseFloat(norm);
    if (Number.isFinite(num) && claimedAnyValue.has(String(num))) return true;
    return false;
  };

  for (const c of claimed) {
    const kind = classifyValue(c.value, c.field);
    if (!kind) continue; // free-text values not subject to structural check
    const haystack = tokensByKind.get(kind) ?? [];
    const exact = haystack.find((h) => tokensMatch(c.value, h, kind));
    if (exact) {
      continue; // ok — no finding emitted
    }
    // Not found. Look for a partial / similar token to give a useful diagnosis.
    let near: string | undefined;
    if (kind === 'iban') {
      // Trunkation case: claimed is prefix of, or shorter version of, an OCR token
      const claimedClean = c.value.replace(/\s/g, '');
      near = haystack.find((h) => h.startsWith(claimedClean) || claimedClean.startsWith(h));
    }
    if (!near && kind === 'currency') {
      // Same digits but different decimal placement?
      const claimedDigits = c.value.replace(/\D/g, '');
      near = haystack.find((h) => h.replace(/\D/g, '') === claimedDigits || h.replace(/\D/g, '').includes(claimedDigits));
    }
    findings.push({
      source: 'structural', kind: c.sourceKind === 'kpi' ? 'kpi' : 'annotation',
      field: c.field, value: c.value,
      status: near ? 'mismatch' : 'invented',
      severity: 'error',
      message: near
        ? `${kindLabel(kind)}-Wert weicht vom OCR-Token ab. Modell hat „${c.value}", OCR enthält „${near}".`
        : `${kindLabel(kind)}-Wert „${c.value}" kommt im OCR-Text nicht vor (kein passender ${kindLabel(kind)}-Token gefunden). Hinweis auf Halluzination.`,
      evidence: near ? `OCR-Token: ${near}` : `${haystack.length} ${kindLabel(kind)}-Token im Dokument: ${haystack.slice(0, 5).join(', ')}${haystack.length > 5 ? '…' : ''}`,
    });
  }

  // Gap detection: tokens in OCR that no claimed value covers
  for (const t of tokens) {
    if (tokenIsClaimed(t)) continue;
    // Skip checkbox tokens (too noisy; many docs have many checkboxes)
    if (t.kind === 'checkbox') continue;
    // Skip phone/email — often part of header/footer not a target field
    if (t.kind === 'phone' || t.kind === 'email') continue;
    findings.push({
      source: 'structural', kind: 'annotation',
      field: `gap.${t.kind}`, value: t.value,
      status: 'missing', severity: 'warn',
      message: `${kindLabel(t.kind)}-Wert „${t.value}" steht im Dokument, wurde aber von keinem KPI/Annotation-Feld erfasst. Mögliche Extraktionslücke.`,
      evidence: snippetAround(markdown, t.position, t.value.length),
    });
  }

  // Pure-info: total tokens scanned (one finding so the UI shows progress)
  findings.push({
    source: 'structural', kind: 'annotation',
    field: '_summary', value: '',
    status: 'ok', severity: 'info',
    message: `Strukturchecker: ${tokens.length} typisierte Tokens im OCR-Text gescannt — ` +
      [...tokensByKind.entries()].map(([k, vs]) => `${vs.length} ${kindLabel(k)}`).join(', '),
  });

  return { findings, ms: Date.now() - t0, tokensFound: tokens.length };
}

function kindLabel(k: TypedToken['kind']): string {
  switch (k) {
    case 'iban': return 'IBAN';
    case 'steuer_id': return 'Steuer-ID';
    case 'plz': return 'PLZ';
    case 'currency': return 'Geldbetrag';
    case 'date': return 'Datum';
    case 'phone': return 'Telefon';
    case 'bic': return 'BIC';
    case 'email': return 'E-Mail';
    case 'percent': return 'Prozent';
    case 'checkbox': return 'Checkbox';
  }
}

// ---------- combined entry point ----------

export type AuditKind = 'consistency' | 'semantic' | 'visual' | 'vision' | 'cross-model' | 'structural';

export async function runAudit(meta: DocumentMeta, opts: { apiKey: string; kind: AuditKind; signal?: AbortSignal; document?: DocumentChunk; crossModel?: CrossModelInput }): Promise<AuditReport> {
  const t0 = Date.now();
  // Each mode is a complete check on its own — no consistency baseline mixed in,
  // because that produces duplicate findings on the same value.
  let consFindings: AuditFinding[] = [];
  let consMs = 0;
  let semFindings: AuditFinding[] = [];
  let visFindings: AuditFinding[] = [];
  let semMs: number | undefined;
  let semTokens: number | undefined;
  let semError: string | undefined;
  let visMs: number | undefined;

  if (opts.kind === 'consistency') {
    const cons = runConsistencyCheck(meta);
    consFindings = cons.findings;
    consMs = cons.ms;
  } else if (opts.kind === 'structural') {
    const struc = runStructuralCheck(meta);
    consFindings = struc.findings;
    consMs = struc.ms;
  } else if (opts.kind === 'semantic') {
    // Semantic is the highest-quality signal — it understands format equivalence
    // and context. Running consistency in parallel just floods false-positive
    // errors from brittle text matching.
    const sem = await runSemanticCheck(meta, { apiKey: opts.apiKey, signal: opts.signal });
    semFindings = sem.findings;
    semMs = sem.ms;
    semTokens = sem.tokens;
    semError = sem.error;
    if (sem.findings.length === 0 && sem.error) {
      semFindings = [{
        source: 'semantic', kind: 'annotation', field: '*', value: '',
        status: 'invalid', severity: 'error',
        message: `Semantischer Re-Read fehlgeschlagen: ${sem.error}`,
      }];
    }
  } else if (opts.kind === 'visual') {
    // Visual is a strict superset of consistency (per-page localization),
    // so consistency does not run separately.
    const vis = runVisualLocator(meta);
    visFindings = vis.findings;
    visMs = vis.ms;
  } else if (opts.kind === 'cross-model') {
    if (!opts.crossModel) {
      visFindings = [{
        source: 'semantic', kind: 'kpi', field: '*', value: '',
        status: 'invalid', severity: 'error',
        message: 'Cross-Model-Audit benötigt das Datei-Handle (fehlt im Server-Aufruf).',
      }];
    } else {
      const cm = await runCrossModelAudit(meta, { ...opts.crossModel, signal: opts.signal });
      visFindings = cm.findings;
      visMs = cm.ms;
      if (cm.findings.length === 0 && cm.error) {
        visFindings = [{
          source: 'semantic', kind: 'kpi', field: '*', value: '',
          status: 'invalid', severity: 'error',
          message: `Cross-Model-Audit fehlgeschlagen: ${cm.error}`,
        }];
      }
    }
  } else if (opts.kind === 'vision') {
    // True vision pass: mistral-ocr-latest re-reads the document IMAGE and
    // audits each claimed value against what it actually sees on the page.
    if (!opts.document) {
      visFindings = [{
        source: 'semantic', kind: 'annotation', field: '*', value: '',
        status: 'invalid', severity: 'error',
        message: 'Vision-Audit benötigt das Dokument-Handle (fehlt im Server-Aufruf).',
      }];
    } else {
      const vis = await runVisionAudit(meta, { apiKey: opts.apiKey, document: opts.document, signal: opts.signal });
      visFindings = vis.findings;
      visMs = vis.ms;
      if (vis.findings.length === 0 && vis.error) {
        visFindings = [{
          source: 'semantic', kind: 'annotation', field: '*', value: '',
          status: 'invalid', severity: 'error',
          message: `Vision-Audit fehlgeschlagen: ${vis.error}`,
        }];
      }
    }
  }
  const findings = [...consFindings, ...semFindings, ...visFindings];
  // Count by severity — every finding lands in exactly one bucket so totals
  // always sum to total. (Earlier the `ok` bucket required status==='ok' which
  // dropped many info-level findings into a fourth invisible bucket.)
  const totals = findings.reduce(
    (acc, f) => {
      acc.total++;
      if (f.severity === 'error') acc.error++;
      else if (f.severity === 'warn') acc.warn++;
      else acc.ok++; // info or anything else falls here — visible by default
      return acc;
    },
    { ok: 0, warn: 0, error: 0, total: 0 },
  );
  return {
    ranAt: new Date().toISOString(),
    kind: opts.kind,
    ms: Date.now() - t0,
    consistencyMs: consMs,
    semanticMs: semMs,
    semanticTokens: semTokens,
    semanticError: semError,
    visualMs: visMs,
    totals,
    findings,
  };
}
