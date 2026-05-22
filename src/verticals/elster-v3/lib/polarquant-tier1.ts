/**
 * PolarQuant Tier-1 Wert-Extractor (deterministic, no LLM).
 * v2 — with anlage-whitelist + belegtyp-context query + margin-threshold + ELSTER-XML rounding.
 */
import { readFile } from 'node:fs/promises';
import { ExactFp32Index } from '../../../lib/quantum-index.ts';
import { embedQueries } from '../../../lib/gemma-embed.ts';

// ─── Types ──────────────────────────────────────────────────────────────

export interface AtomMeta {
  atom_id: string;
  container_id: string;
  ecode: string;
  anlage: string;
  vordruckzeile: string | null;
  drucktext: string;
  datentyp: 'currency' | 'string' | 'date' | string;
  formatRegex: string;
  formatkennzeichen: string;       // NEW: N|U|C|D|G|%|J|H|X|I|F|A|…
  maxLaenge: number | null;
  kontextPaths: string[];
  embedding_idx: number;
}

export interface Section {
  heading: string;
  level: number;
  content: string;
  body: string;
  offset_start: number;
  offset_end: number;
}

export interface BelegContext {
  /** Allowed anlage codes — e.g. ['VOR','AV','N','KAP','ESt1A'] for Stpfl-eigene Belege. */
  allowedAnlagen?: string[];
  /** Insurer / 'Übermittelnde Stelle' if known — pushed into query embedding. */
  uebermittelndeStelle?: string;
  /** Belegtyp hint, e.g. 'private Krankenversicherung' */
  belegtyp?: string;
  /** Beitragstragung */
  beitragstragung?: 'arbeitgeber' | 'arbeitnehmer' | 'unbekannt';
  /** Versicherer-Typ */
  versichererTyp?: 'privat' | 'gesetzlich' | 'unbekannt';
  /** LStB-Bezug erkannt */
  hasLStBBezug?: boolean;
  /** Preferred kontextPaths (XSD-Vokabular) — Tier-2 nutzt diese als Hauptfilter */
  preferredKontextPaths?: string[];
  /** Versicherungsnehmer Identifikationsnummer */
  versicherungsnehmerSteuerId?: string;
  /** Mandant-Profil als Freitext (z.B. "Hildburg, Rentnerin, verwitwet, Anlagen R/VOR aktiv") */
  profileSummary?: string;
}

export type Tier1Strategy =
  | 'vordruckzeile-anchor'
  | 'drucktext-proximity'
  | 'section-single'
  | 'no-match'
  | 'ambiguous'
  | 'low-margin';

export interface Tier1Result {
  ecode: string;
  wert: string | null;
  wert_numeric: number | null;
  wert_elster_xml: string | null;    // NEW: ELSTER-XML normalized (integer for currency-N|U|G)
  strategy: Tier1Strategy;
  confidence: number;
  audit: {
    section_offset: [number, number];
    section_heading: string;
    matched_text: string;
    container_atom_id: string;
    container_id: string;
    polar_score: number;
    polar_margin: number;           // NEW: top1 - top2 score
    extract_ms: number;
  };
}

// ─── Section Splitter ───────────────────────────────────────────────────

export function splitSections(md: string): Section[] {
  const lines = md.split('\n');
  const sections: Section[] = [];
  let cur: { heading: string; level: number; start_offset: number } | null = null;
  let off = 0;
  const lineOffsets: number[] = [];
  for (const l of lines) { lineOffsets.push(off); off += l.length + 1; }
  lineOffsets.push(off);

  const flush = (endLine: number) => {
    if (!cur) return;
    const start = cur.start_offset;
    const end = lineOffsets[endLine] - 1;
    const content = md.slice(start, end);
    const headingMatch = content.match(/^#{1,6}\s+(.*)/);
    const headingLine = headingMatch ? headingMatch[0] : cur.heading;
    const body = content.slice(headingLine.length).replace(/^\n+/, '');
    sections.push({
      heading: cur.heading,
      level: cur.level,
      content,
      body,
      offset_start: start,
      offset_end: end,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m) {
      flush(i);
      cur = { heading: m[2].trim(), level: m[1].length, start_offset: lineOffsets[i] };
    }
  }
  flush(lines.length);
  return sections;
}

// ─── Beleg-Header Extractor ────────────────────────────────────────────

export function extractBelegContext(md: string): BelegContext {
  const ctx: BelegContext = {};
  // 'Übermittelnde Stelle' value
  const us = md.match(/Übermittelnde Stelle\s*\|?\s*([A-Z][^\n|]{5,80})/);
  if (us) ctx.uebermittelndeStelle = us[1].trim();
  // Versicherer-Typ Heuristik
  const u = (ctx.uebermittelndeStelle || '').toLowerCase();
  if (/a\.?\s*g\.?|versicherungsverein|debeka|dkv|axa|allianz\s+privat|barmenia|hallesche|hanse[\- ]?merkur|continentale|gothaer|signal\s+iduna/i.test(u))
    ctx.versichererTyp = 'privat';
  else if (/^(aok|barmer|tk\b|techniker|dak|ikk|bkk|kkh|knappschaft)/i.test(u))
    ctx.versichererTyp = 'gesetzlich';
  else ctx.versichererTyp = 'unbekannt';
  // Belegtyp heuristic from H1
  const h1 = md.match(/^#\s+(.+?)$/m);
  if (h1) {
    const t = h1[1].toLowerCase();
    if (t.includes('kranken') && t.includes('pflege')) ctx.belegtyp = 'private Krankenversicherung und Pflegeversicherung';
    else if (t.includes('lohnsteuer')) ctx.belegtyp = 'Lohnsteuerbescheinigung';
    else if (t.includes('rente')) ctx.belegtyp = 'Rentenbezugsmitteilung';
    else if (t.includes('kapital')) ctx.belegtyp = 'Kapitalertragsbescheinigung';
  }
  // Beitragstragung
  const bt = md.match(/Beitragstragung\s*\|\s*([^|\n]+)/i);
  if (bt) {
    const v = bt[1].toLowerCase();
    if (v.includes('arbeitgeber')) ctx.beitragstragung = 'arbeitgeber';
    else if (v.includes('arbeitnehmer')) ctx.beitragstragung = 'arbeitnehmer';
    else ctx.beitragstragung = 'unbekannt';
  }
  // LStB-Bezug
  ctx.hasLStBBezug = /Lohnsteuerbescheinigung|LStB|Nr\.?\s*2[3-7]\b/.test(md);
  // Versicherungsnehmer Steuer-ID
  const vnId = md.match(/Versicherungsnehmer:?\s*Identifikationsnummer\s*\|\s*([\d\s]{10,14})/i);
  if (vnId) ctx.versicherungsnehmerSteuerId = vnId[1].replace(/\s/g, '');
  // Preferred kontextPaths
  const preferred: string[] = [];
  if (ctx.belegtyp === 'Lohnsteuerbescheinigung' || ctx.beitragstragung === 'arbeitgeber' || ctx.hasLStBBezug) {
    preferred.push('Uebern_KV_PV_Beitr');
    preferred.push('Beitr_g_KV_PV_Inl/AN');
  } else if (ctx.versichererTyp === 'privat') {
    preferred.push('Beitr_p_KV_PV_Inl');
    preferred.push('Beitr_p_KV_PV_Inl/WL_Zvers');
  } else if (ctx.versichererTyp === 'gesetzlich') {
    preferred.push('Beitr_g_KV_PV_Inl/AN');
    preferred.push('Beitr_g_KV_PV_Inl/And_Pers');
  }
  ctx.preferredKontextPaths = preferred;
  // Default Stpfl-eigener Beleg → broad allowlist
  ctx.allowedAnlagen = ['VOR','AV','N','KAP','ESt1A','SO','G','S','R','SA','AgB','FW','EM_35c'];
  return ctx;
}

// ─── Polar Match (section → top-K atom candidates) ──────────────────────

export async function polarMatchSection(
  section: Section,
  index: ExactFp32Index,
  atomMetaByIdx: AtomMeta[],
  belegCtx: BelegContext,
  topK = 5,
  ollamaUrl = 'http://localhost:11434',
): Promise<{ candidates: Array<{ atom: AtomMeta; score: number }>; margin: number; queryText: string }> {
  const beitragsartMatch = section.body.match(/Beitragsart\s*\|\s*([^|\n]+)/);
  const baseText = beitragsartMatch
    ? beitragsartMatch[1].trim()
    : (section.heading + ' — ' + section.body.slice(0, 200));

  // Belegtyp + Stelle prefix into the query embedding
  const prefix = [belegCtx.belegtyp, belegCtx.uebermittelndeStelle].filter(Boolean).join(' — ');
  const queryText = prefix ? prefix + ' — ' + baseText : baseText;

  const [qv] = await embedQueries([queryText], { url: ollamaUrl } as { url: string });

  // Filter candidate pool by anlage-whitelist
  const allowed = new Set(belegCtx.allowedAnlagen ?? []);
  const poolIdx = atomMetaByIdx
    .map((a, i) => (allowed.size === 0 || allowed.has(a.anlage)) ? i : -1)
    .filter(i => i >= 0);

  const top = index.rerank(qv, poolIdx, Math.max(topK, 2));
  const margin = top.length >= 2 ? (top[0].score - top[1].score) : 1.0;
  return {
    candidates: top.slice(0, topK).map(t => ({ atom: atomMetaByIdx[t.idx], score: t.score })),
    margin,
    queryText,
  };
}

// ─── 3-Strategy Wert Extractor ─────────────────────────────────────────

const CURRENCY_RE = /(?<![\d.,])([\d]{1,3}(?:\.[\d]{3})*,[\d]{2}|[\d]+,[\d]{2})(?![\d.,])/g;

function parseDeNumber(s: string): number {
  return Number(s.replace(/\./g, '').replace(',', '.'));
}

function matchesFormat(s: string, regex: string, datentyp?: string, formatkennzeichen?: string): boolean {
  try {
    const re = new RegExp(regex);
    // For currency in formatkennzeichen N|U (Euro without cents), validate the
    // rounded integer-euro representation — that is what gets emitted in the
    // ELSTER XML. "1.781,98" → 1782 → matches "^\d{1,5}$".
    if (datentyp === 'currency' && (formatkennzeichen === 'N' || formatkennzeichen === 'U' || !formatkennzeichen)) {
      const num = Number(s.replace(/\./g, '').replace(',', '.'));
      if (!Number.isFinite(num)) return false;
      const euro = String(Math.round(num));
      return re.test(euro);
    }
    // For G (cents allowed) and other currency variants: keep compact-string validation.
    const compact = s.replace(/\./g, '').replace(',', '');
    return re.test(compact);
  } catch { return false; }
}

/** ELSTER-XML normalization. Currency in formatkennzeichen N|U|G is Euro WITHOUT cents. */
function toElsterXml(numeric: number, atom: AtomMeta): string {
  if (atom.datentyp === 'currency') {
    const k = atom.formatkennzeichen;
    if (k === 'N' || k === 'U') return String(Math.round(numeric));      // Euro, no cents
    if (k === 'G' || k === '%') return numeric.toFixed(2).replace('.', ','); // Cents allowed
    return String(Math.round(numeric));
  }
  if (atom.datentyp === 'date') return ''; // caller provides date strings already
  return String(numeric);
}

export function tier1Extract(
  section: Section,
  atom: AtomMeta,
  polarScore: number,
  polarMargin: number,
): Tier1Result {
  const t0 = Date.now();
  const body = section.body;
  const baseAudit = {
    section_offset: [section.offset_start, section.offset_end] as [number, number],
    section_heading: section.heading,
    container_atom_id: atom.atom_id,
    container_id: atom.container_id,
    polar_score: polarScore,
    polar_margin: polarMargin,
  };

  // ── Strategy A: vordruckzeile-anchor (Layout B)
  if (atom.vordruckzeile) {
    const z = atom.vordruckzeile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const reHint = new RegExp(
      String.raw`\(\s*Zeile\s+${z}(?:\s+bzw\.?\s*\d+)?\s*\)[^\n]{0,60}?([\d.]+,[\d]{2})`,
      'i',
    );
    const m = body.match(reHint);
    if (m && (atom.datentyp !== 'currency' || matchesFormat(m[1], atom.formatRegex, atom.datentyp, atom.formatkennzeichen))) {
      const numeric = parseDeNumber(m[1]);
      return {
        ecode: atom.ecode, wert: m[1], wert_numeric: numeric,
        wert_elster_xml: toElsterXml(numeric, atom),
        strategy: 'vordruckzeile-anchor', confidence: 0.99,
        audit: { ...baseAudit, matched_text: m[0].slice(0, 120), extract_ms: Date.now() - t0 },
      };
    }
  }

  // ── Strategy B: drucktext-proximity (Layout A) — use polar score + margin
  if (atom.datentyp === 'currency') {
    const hoeheMatch = body.match(/Höhe\s+der[^|\n]{0,80}?\|\s*([\d.]+,[\d]{2})/);
    if (hoeheMatch && matchesFormat(hoeheMatch[1], atom.formatRegex, atom.datentyp, atom.formatkennzeichen)) {
      // Margin-aware confidence
      let conf = 0.5 + polarScore * 0.5;
      if (polarMargin >= 0.02) conf += 0.05;
      conf = Math.max(0.7, Math.min(0.95, conf));
      const numeric = parseDeNumber(hoeheMatch[1]);
      return {
        ecode: atom.ecode, wert: hoeheMatch[1], wert_numeric: numeric,
        wert_elster_xml: toElsterXml(numeric, atom),
        strategy: 'drucktext-proximity', confidence: conf,
        audit: { ...baseAudit, matched_text: hoeheMatch[0].slice(0, 120), extract_ms: Date.now() - t0 },
      };
    }

    // ── Strategy C: section-single fallback
    const allCurr = [...body.matchAll(CURRENCY_RE)].map(m => m[1]);
    const valid = allCurr.filter(v => matchesFormat(v, atom.formatRegex, atom.datentyp, atom.formatkennzeichen));
    const unique = Array.from(new Set(valid));
    if (unique.length === 1) {
      const conf = Math.max(0.65, Math.min(0.8, 0.4 + polarScore * 0.5));
      const numeric = parseDeNumber(unique[0]);
      return {
        ecode: atom.ecode, wert: unique[0], wert_numeric: numeric,
        wert_elster_xml: toElsterXml(numeric, atom),
        strategy: 'section-single', confidence: conf,
        audit: { ...baseAudit, matched_text: unique[0], extract_ms: Date.now() - t0 },
      };
    }
    if (unique.length > 1) {
      return {
        ecode: atom.ecode, wert: null, wert_numeric: null, wert_elster_xml: null,
        strategy: 'ambiguous', confidence: 0,
        audit: { ...baseAudit, matched_text: unique.join(' / '), extract_ms: Date.now() - t0 },
      };
    }
  }

  return {
    ecode: atom.ecode, wert: null, wert_numeric: null, wert_elster_xml: null,
    strategy: 'no-match', confidence: 0,
    audit: { ...baseAudit, matched_text: '', extract_ms: Date.now() - t0 },
  };
}

// ─── Container Loader ──────────────────────────────────────────────────

export async function loadContainerAtoms(
  atomsPath: string,
): Promise<{ atomsByIdx: AtomMeta[]; atomsByEcode: Map<string, AtomMeta> }> {
  const raw = JSON.parse((await readFile(atomsPath, 'utf-8')) as string) as Array<Record<string, unknown>>;
  const atomsByIdx: AtomMeta[] = [];
  const atomsByEcode = new Map<string, AtomMeta>();
  raw.forEach((a, i) => {
    const m = (a.metadata ?? {}) as Record<string, unknown>;
    const am: AtomMeta = {
      atom_id: String(a.atom_id),
      container_id: String(a.container_id),
      ecode: String(a.field_name),
      anlage: String(m.anlage ?? ''),
      vordruckzeile: m.vordruckzeile != null ? String(m.vordruckzeile) : null,
      drucktext: String(m.drucktext ?? ''),
      datentyp: String(m.datentyp ?? 'string'),
      formatRegex: String(m.formatRegex ?? '.*'),
      formatkennzeichen: String(m.formatkennzeichen ?? ''),
      maxLaenge: m.maxLaenge != null ? Number(m.maxLaenge) : null,
      kontextPaths: Array.isArray(m.kontextPaths) ? (m.kontextPaths as string[]) : [],
      embedding_idx: i,
    };
    atomsByIdx.push(am);
    atomsByEcode.set(am.ecode, am);
  });
  return { atomsByIdx, atomsByEcode };
}
