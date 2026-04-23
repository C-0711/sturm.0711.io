import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Typen ────────────────────────────────────────────────────────────────

export interface BmfFeld {
  kontext: string;
  name?: string;
  beschreibung?: string;
  drucktext?: string;
  vordruckzeile?: string | number | null;
  format?: string;
  format_regex?: string;
  formatkennzeichen?: string;
  min_laenge?: number | null;
  max_laenge?: number | null;
  pflicht?: boolean;
  pflicht_fehlertext?: string;
  indexfeld?: string;
  max_zeilen?: number | null;
  // TODO: typed later — Katalog enthält vereinzelt weitere optionale Felder
  [extra: string]: unknown;
}

export interface BmfAnlage {
  felder: Record<string, BmfFeld>;
  felder_count?: number;
  pflicht_count?: number;
}

export interface BmfCatalog {
  year: number;
  source?: string;
  anlagen_count?: number;
  fields_count?: number;
  pflicht_count?: number;
  anlagen: Record<string, BmfAnlage>;
}

// JSON-Schema-Subset wie vom Build-Script erzeugt. Bewusst permissiv getypt —
// Rekursion und gemischte Formen (enum, items, properties, ...) rechtfertigen any.
// TODO: typed later
export type JsonSchemaNode = {
  type?: string;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  description?: string;
  enum?: unknown[];
  additionalProperties?: boolean;
  title?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [extra: string]: any;
};

export interface ElsterAnlageMeta {
  code: string;
  label: string;
  root_type?: string;
  max_occurs?: number;
  leaf_count?: number;
  elster_code_count?: number;
  json_schema: JsonSchemaNode;
  pydantic_code?: string;
  fields_preview?: unknown;
}

export interface ElsterCatalog {
  year: number;
  xsd_path?: string;
  root_complex_type?: string;
  anlagen_count?: number;
  anlagen: Record<string, ElsterAnlageMeta>;
}

export interface AnlagenAliase {
  aliases: Record<string, string[]>;
}

export interface BmfLabelIndexEintragZeile {
  code: string;
  anlage: string;
  kontext: string;
}
export interface BmfLabelIndexEintragKandidat {
  code: string;
  anlage: string;
  kontext: string;
}
export interface BmfLabelIndex {
  byZeile: Map<string, BmfLabelIndexEintragZeile>;
  byDrucktext: Map<string, BmfLabelIndexEintragKandidat[]>;
  byBeschreib: Map<string, BmfLabelIndexEintragKandidat[]>;
}

export interface Fundstelle {
  anlage: string;
  personen_ctx: 'A' | 'B' | null;
  zeile: string;
  drucktext_cand: string;
  wert: string;
  raw: string;
}

export interface MappedFundstelle {
  code: string;
  anlage: string;
  kontext: string;
  match: string;
  konfidenz: number;
}

export interface VisionKandidat {
  pfad: string;
  wert: unknown;
}

export interface Pflichtfeld {
  pfad: string;
  elster_code: string | null;
  typ: string;
  description: string;
}

export interface BmfValidierungErgebnis {
  ok: boolean;
  format: string;
  details: string | null;
}

interface Indices {
  bmfCatalog: BmfCatalog | null;
  elsterCatalog: ElsterCatalog | null;
  anlagenAliase: Record<string, string[]>;
  bmfLabelIndex: BmfLabelIndex | null;
  codeIndex: Map<string, Set<string>> | null;
  bmfCodeIndex: Map<string, BmfFeld> | null;
  bmfCodeIndexPerAnlage: Map<string, Map<string, BmfFeld>> | null;
  anlagenHeaderMap: Array<[RegExp, string]>;
}

// ─── Lazy Init ────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');

let _indices: Indices | null = null;

function ladeBmfCatalog(): { catalog: BmfCatalog | null; perCode: Map<string, BmfFeld>; perAnlage: Map<string, Map<string, BmfFeld>> } {
  const p = path.join(DATA_DIR, 'elster_felder_2024.json');
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const catalog = JSON.parse(raw) as BmfCatalog;
    const perCode = new Map<string, BmfFeld>();
    const perAnlage = new Map<string, Map<string, BmfFeld>>();
    for (const [anlage, a] of Object.entries(catalog.anlagen)) {
      const inner = new Map<string, BmfFeld>();
      for (const [code, feld] of Object.entries(a.felder)) {
        inner.set(code, feld);
        const bestehend = perCode.get(code);
        // Ranking: Pflicht-Varianten eines Codes dominieren — sie tragen Fehlertexte und werden im Cross-Anlage-Lookup bevorzugt.
        if (!bestehend || (feld.pflicht && !bestehend.pflicht)) perCode.set(code, feld);
      }
      perAnlage.set(anlage, inner);
    }
    return { catalog, perCode, perAnlage };
  } catch {
    return { catalog: null, perCode: new Map(), perAnlage: new Map() };
  }
}

function ladeElsterCatalog(): ElsterCatalog | null {
  const p = path.join(DATA_DIR, 'elster_schemas.json');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as ElsterCatalog;
  } catch {
    return null;
  }
}

function ladeAnlagenAliaseIntern(): Record<string, string[]> {
  const p = path.join(DATA_DIR, 'anlagen_aliase.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as AnlagenAliase;
    return parsed?.aliases ?? {};
  } catch {
    return {};
  }
}

function baueBmfLabelIndexIntern(catalog: BmfCatalog | null): BmfLabelIndex | null {
  if (!catalog) return null;
  const byZeile = new Map<string, BmfLabelIndexEintragZeile>();
  const byDrucktext = new Map<string, BmfLabelIndexEintragKandidat[]>();
  const byBeschreib = new Map<string, BmfLabelIndexEintragKandidat[]>();
  for (const [anlage, a] of Object.entries(catalog.anlagen)) {
    for (const [code, feld] of Object.entries(a.felder)) {
      const kontext = normLabel(feld.kontext);
      const dt = normLabel(feld.drucktext);
      const be = normLabel(feld.beschreibung);
      const zeile = String(feld.vordruckzeile ?? '').trim();

      if (zeile && dt) {
        const k = `${anlage}|${zeile}|${dt}`;
        if (!byZeile.has(k)) byZeile.set(k, { code, anlage, kontext: String(feld.kontext ?? '') });
      }
      if (dt) {
        const k = `${anlage}|${kontext}|${dt}`;
        let lst = byDrucktext.get(k);
        if (!lst) { lst = []; byDrucktext.set(k, lst); }
        lst.push({ code, anlage, kontext: String(feld.kontext ?? '') });
      }
      if (be) {
        let lst = byBeschreib.get(be);
        if (!lst) { lst = []; byBeschreib.set(be, lst); }
        lst.push({ code, anlage, kontext: String(feld.kontext ?? '') });
      }
    }
  }
  return { byZeile, byDrucktext, byBeschreib };
}

function baueCodeIndexIntern(elsterCatalog: ElsterCatalog | null): Map<string, Set<string>> | null {
  if (!elsterCatalog) return null;
  const idx = new Map<string, Set<string>>();
  const walk = (node: unknown, anlage: string): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node) walk(x, anlage); return; }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (/^E\d{7}$/.test(k)) {
        let s = idx.get(k);
        if (!s) { s = new Set(); idx.set(k, s); }
        s.add(anlage);
      }
      walk(v, anlage);
    }
  };
  for (const [code, a] of Object.entries(elsterCatalog.anlagen)) {
    walk(a.json_schema, code);
  }
  return idx;
}

function baueAnlagenHeaderMapIntern(elsterCatalog: ElsterCatalog | null, aliase: Record<string, string[]>): Array<[RegExp, string]> {
  if (!elsterCatalog?.anlagen) return [];
  const entries: Array<{ regex: RegExp; code: string; spez: number; name: string }> = [];

  for (const [code, meta] of Object.entries(elsterCatalog.anlagen)) {
    const label = String(meta?.label || '');
    const namen = new Set<string>();

    if (/^Hauptvordruck\b/i.test(label)) {
      namen.add('Hauptvordruck');
      namen.add('ESt 1 A');
    }
    const kurz = label.match(/^Anlage\s+([A-Za-zÄÖÜäöüß0-9][A-Za-zÄÖÜäöüß0-9\-\s]*?)(?:\s*(?:—|–|\s-\s)|$)/i);
    if (kurz) namen.add(kurz[1].trim());
    const lang = label.match(/(?:—|–)\s*(.+?)(?:\s*[(§]|$)/);
    if (lang) namen.add(lang[1].trim());
    for (const a of (aliase[code] || [])) namen.add(a);

    for (const n of namen) {
      if (!n) continue;
      // Hauptvordruck ohne "Anlage "-Prefix matchen; sonst mit "Anlage " davor.
      const regex = /^Hauptvordruck|ESt\s*1\s*A/i.test(n)
        ? umlautToleranteRegex(n)
        : new RegExp(`Anlage\\s+${umlautToleranteRegex(n).source}\\b`, 'i');
      entries.push({ regex, code, spez: n.length, name: n });
    }
  }
  entries.sort((a, b) => b.spez - a.spez);
  return entries.map(e => [e.regex, e.code] as [RegExp, string]);
}

export function getIndices(): Indices {
  if (_indices) return _indices;
  const { catalog: bmfCatalog, perCode: bmfCodeIndex, perAnlage: bmfCodeIndexPerAnlage } = ladeBmfCatalog();
  const elsterCatalog = ladeElsterCatalog();
  const anlagenAliase = ladeAnlagenAliaseIntern();
  const bmfLabelIndex = baueBmfLabelIndexIntern(bmfCatalog);
  const codeIndex = baueCodeIndexIntern(elsterCatalog);
  const anlagenHeaderMap = baueAnlagenHeaderMapIntern(elsterCatalog, anlagenAliase);
  _indices = {
    bmfCatalog,
    elsterCatalog,
    anlagenAliase,
    bmfLabelIndex,
    codeIndex,
    bmfCodeIndex,
    bmfCodeIndexPerAnlage,
    anlagenHeaderMap,
  };
  return _indices;
}

// ─── Öffentliche Helper ───────────────────────────────────────────────────

export function normLabel(s: unknown): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^\wÄÖÜäöüß\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function bmfFeldFuerCode(code: string, anlage?: string): BmfFeld | null {
  const { bmfCodeIndex, bmfCodeIndexPerAnlage } = getIndices();
  if (!bmfCodeIndex) return null;
  if (anlage && bmfCodeIndexPerAnlage?.has(anlage)) {
    const inAnlage = bmfCodeIndexPerAnlage.get(anlage)!.get(code);
    if (inAnlage) return inAnlage;
  }
  return bmfCodeIndex.get(code) ?? null;
}

export function bmfPflichtFelderFuerKombi(anlagen: string[] | null | undefined): BmfFeld[] {
  const { bmfCodeIndexPerAnlage } = getIndices();
  const alle: BmfFeld[] = [];
  const gesehen = new Set<string>();
  for (const a of (anlagen ?? [])) {
    const perAnlage = bmfCodeIndexPerAnlage?.get(a);
    if (!perAnlage) continue;
    for (const f of perAnlage.values()) {
      const name = String(f.name ?? '');
      if (f.pflicht && !gesehen.has(name)) {
        alle.push(f);
        gesehen.add(name);
      }
    }
  }
  return alle;
}

export function bmfValidiereWert(code: string, wert: string, anlage?: string): BmfValidierungErgebnis | null {
  const feld = bmfFeldFuerCode(code, anlage);
  if (!feld) return null;
  const regex = (feld.format_regex || '').trim();
  if (!regex) {
    if (feld.min_laenge !== null || feld.max_laenge !== null) {
      const len = String(wert).length;
      const minOk = feld.min_laenge === null || feld.min_laenge === undefined || len >= feld.min_laenge;
      const maxOk = feld.max_laenge === null || feld.max_laenge === undefined || len <= feld.max_laenge;
      return {
        ok: minOk && maxOk,
        format: feld.format || '',
        details: (minOk && maxOk) ? null
          : `Laenge ${len}, erwartet ${feld.min_laenge ?? 0}..${feld.max_laenge ?? '∞'}`,
      };
    }
    return null;
  }
  let ok: boolean;
  try {
    ok = new RegExp('^(?:' + regex + ')$').test(String(wert));
  } catch {
    return null;
  }
  return {
    ok,
    format: feld.format || '',
    details: ok ? null : `"${String(wert).slice(0, 40)}" passt nicht zum BMF-Format: ${feld.format}`,
  };
}

export function sammleElsterCodes(anno: unknown, out: Set<string> = new Set()): Set<string> {
  if (!anno || typeof anno !== 'object') return out;
  if (Array.isArray(anno)) { for (const x of anno) sammleElsterCodes(x, out); return out; }
  for (const [k, v] of Object.entries(anno as Record<string, unknown>)) {
    if (/^E\d{7}$/.test(k) && v !== null && v !== undefined && v !== '') {
      if (typeof v !== 'object' || (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0)) {
        out.add(k);
      }
    }
    if (v && typeof v === 'object') sammleElsterCodes(v, out);
  }
  return out;
}

export function sammlePflichtfelder(schema: JsonSchemaNode | null | undefined, vorsatz: string[] = []): Pflichtfeld[] {
  const out: Pflichtfeld[] = [];
  if (!schema || typeof schema !== 'object') return out;
  if (schema.type === 'object' && schema.properties) {
    const req = schema.required || [];
    for (const key of req) {
      const sub = schema.properties[key];
      if (!sub) continue;
      const pfad = [...vorsatz, key];
      if (sub.type === 'object' && sub.properties) {
        out.push(...sammlePflichtfelder(sub, pfad));
      } else if (sub.type === 'array' && sub.items) {
        out.push(...sammlePflichtfelder(sub.items, [...pfad, '[]']));
      } else {
        out.push({
          pfad: pfad.join('.'),
          elster_code: /^E\d{7}$/.test(key) ? key : null,
          typ: sub.type || 'string',
          description: sub.description || '',
        });
      }
    }
  }
  return out;
}

export function leseAusPfad(obj: unknown, pfad: string): unknown {
  if (!obj) return undefined;
  let cur: unknown = obj;
  for (const seg of pfad.split('.')) {
    if (seg === '[]') {
      if (!Array.isArray(cur) || cur.length === 0) return undefined;
      cur = cur[0];
      continue;
    }
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export function istBelegt(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (typeof v === 'number') return true;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true;
}

// ─── Anlagen-Header-Erkennung ─────────────────────────────────────────────

export function umlautToleranteRegex(name: string): RegExp {
  // Erzeuge Variante mit Umlauten aus ae/oe/ue/ss und umgekehrt, verknuepfe beide.
  const mitAe = name;
  const mitUml = mitAe
    .replace(/([aA])e/g, (_m, a) => a + (a === 'A' ? 'Ä' : 'ä')).replace(/[aA][äÄ]/g, m => m[0] === 'A' ? 'Ä' : 'ä')
    .replace(/([oO])e/g, (_m, a) => a + (a === 'O' ? 'Ö' : 'ö')).replace(/[oO][öÖ]/g, m => m[0] === 'O' ? 'Ö' : 'ö')
    .replace(/([uU])e/g, (_m, a) => a + (a === 'U' ? 'Ü' : 'ü')).replace(/[uU][üÜ]/g, m => m[0] === 'U' ? 'Ü' : 'ü')
    .replace(/ss/g, 'ß');
  const mitAsciiUml = mitAe
    .replace(/ä/g, 'ae').replace(/Ä/g, 'Ae')
    .replace(/ö/g, 'oe').replace(/Ö/g, 'Oe')
    .replace(/ü/g, 'ue').replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss');
  const varianten = new Set([mitAe, mitUml, mitAsciiUml]);
  const escaped = [...varianten].map(v =>
    v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\?[-\s]+/g, '[-\\s]?')
  );
  return new RegExp(`(?:${escaped.join('|')})`, 'i');
}

// ─── Mistral-Text-Parser ──────────────────────────────────────────────────

export function parseMistralText(text: string): Fundstelle[] {
  const fundstellen: Fundstelle[] = [];
  const lines = (text || '').split('\n');
  let aktuelleAnlage = 'ESt1A';
  let aktuellerPersonenCtx: 'A' | 'B' | null = null;

  const { anlagenHeaderMap } = getIndices();
  // Personen-Kontext-Regex bleibt minimal, weil Begriffe wie "Person A"/"Ehemann"
  // nicht im BMF-Katalog stehen — deutsche Formular-Konvention.
  const personRe: Array<[RegExp, 'A' | 'B']> = [
    [/Person\s+A\b|Ehemann|Steuerpflichtige(?:\s+Person)?/i, 'A'],
    [/Person\s+B\b|Ehefrau|Ehegattin|Ehegatte(?!n)/i, 'B'],
  ];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Header-Regel: egal ob #, ##, ### — ein Header wechselt die Anlage
    // genau dann, wenn er mit "Anlage X" oder "Hauptvordruck" BEGINNT.
    // Subsection-Titles wie "## Steuerabzugsbeträge ... Anlage KAP-INV"
    // wechseln NICHT. Alle Header aktualisieren aber den Personen-Kontext.
    if (/^#{1,3}\s+/.test(line)) {
      const inhalt = line.replace(/^#{1,3}\s*/, '').trim();
      if (/^(Anlage\s+|Hauptvordruck\b)/i.test(inhalt)) {
        for (const [re, code] of anlagenHeaderMap) {
          if (re.test(inhalt)) { aktuelleAnlage = code; break; }
        }
      }
      for (const [re, p] of personRe) {
        if (re.test(inhalt)) { aktuellerPersonenCtx = p; break; }
      }
      continue;
    }

    const m = line.match(/^(?:[-*]\s+)?(\d{1,3})\s+(.+?)(?:\s{2,}|\s)([A-Za-z0-9][^]*?)$/);
    if (m) {
      const zeile = m[1];
      const rest = m[2] + ' ' + m[3];
      let drucktextCand: string;
      let wert: string;

      // BUG-2-FIX: IBAN mit Leerzeichen erkennen (DE08 5735 1030 0105 0569 49)
      const ibanM = rest.match(/\b([A-Z]{2}\d{2}[\s\d]{18,26})\b/);
      if (ibanM && (ibanM[1].replace(/\s+/g, '').length >= 20) && ibanM.index !== undefined) {
        drucktextCand = rest.slice(0, ibanM.index).trim();
        wert = ibanM[1].replace(/\s+/g, '');
      } else {
        // Generelle Heuristik: bis erster Zahl/Datum/Betrag → Label, dahinter → Wert.
        const werteRe = /\b(\d{1,3}(?:\.\d{3})*(?:,\d+)?|\d+[,.]?\d*|\d{2}\.\d{2}\.\d{4}|\d{11}|\d{5}\s*[A-Za-z-]+)\b/;
        const wm = rest.match(werteRe);
        if (wm && wm.index !== undefined && wm.index > 0) {
          drucktextCand = rest.slice(0, wm.index).trim();
          wert = rest.slice(wm.index).trim();
        } else {
          drucktextCand = rest.trim(); wert = '';
        }

        // BUG-3-FIX: "laut Nr. X ... der Lohnsteuerbescheinigung YYY"
        // → Label um den Verweis erweitern, Wert = letzte Zahl in der Zeile.
        if (/laut\s+Nr\.?\s*$/i.test(drucktextCand) || /laut\s+Nr\.?\s+\d/i.test(drucktextCand + ' ' + wert)) {
          const final = wert.match(/^(.+?)\s+(-?\d{1,3}(?:\.\d{3})*(?:,\d+)?|-?\d+(?:,\d+)?)\s*$/);
          if (final) {
            drucktextCand = `${drucktextCand} ${final[1]}`.replace(/\s+/g, ' ').trim();
            wert = final[2];
          }
        }
      }

      fundstellen.push({
        anlage: aktuelleAnlage,
        personen_ctx: aktuellerPersonenCtx,
        zeile,
        drucktext_cand: drucktextCand,
        wert,
        raw: line.slice(0, 160),
      });
      continue;
    }
  }
  return fundstellen;
}

// ─── Mapper Fundstelle → E-Code ───────────────────────────────────────────

function istPerson(cand: { kontext?: string }, p: 'A' | 'B'): boolean {
  const k = (cand.kontext || '').toLowerCase();
  const suffix = k.split('/').pop();
  if (p === 'A') return suffix === 'a' || k.endsWith('/a') || /^allg\/a/.test(k);
  if (p === 'B') return suffix === 'b' || k.endsWith('/b') || /^allg\/b/.test(k);
  return false;
}

export function mappeFundstelle(fund: Fundstelle, index: BmfLabelIndex | null = getIndices().bmfLabelIndex): MappedFundstelle | null {
  if (!index) return null;
  const dtNorm = normLabel(fund.drucktext_cand);
  if (!dtNorm) return null;

  const k1 = `${fund.anlage}|${fund.zeile}|${dtNorm}`;
  const zeileHit = index.byZeile.get(k1);
  if (zeileHit) {
    return { ...zeileHit, match: 'zeile+drucktext', konfidenz: 1.0 };
  }
  // Fuzzy mit gekürztem drucktext (nur die ersten 5 Wörter des Kandidaten).
  const dtKurz = dtNorm.split(' ').slice(0, 5).join(' ');
  if (dtKurz !== dtNorm) {
    for (const [k, v] of index.byZeile.entries()) {
      if (!k.startsWith(`${fund.anlage}|${fund.zeile}|`)) continue;
      const ctxDt = k.split('|')[2];
      if (ctxDt && (dtNorm.startsWith(ctxDt) || ctxDt.startsWith(dtKurz))) {
        return { ...v, match: 'zeile+drucktext(fuzzy)', konfidenz: 0.9 };
      }
    }
  }

  const ctxHint = fund.personen_ctx;
  const alleKandidaten: BmfLabelIndexEintragKandidat[] = [];
  for (const [k, lst] of index.byDrucktext.entries()) {
    if (!k.startsWith(`${fund.anlage}|`)) continue;
    const parts = k.split('|');
    if (parts[2] !== dtNorm) continue;
    alleKandidaten.push(...lst);
  }
  if (alleKandidaten.length === 0) return null;

  const fuerA = alleKandidaten.filter(c => istPerson(c, 'A'));
  const fuerB = alleKandidaten.filter(c => istPerson(c, 'B'));
  const neutral = alleKandidaten.filter(c => !istPerson(c, 'A') && !istPerson(c, 'B'));

  if (ctxHint === 'A') {
    if (fuerA.length) return { ...fuerA[0], match: 'drucktext+ctxA', konfidenz: 0.9 };
    if (neutral.length) return { ...neutral[0], match: 'drucktext(neutral)', konfidenz: 0.75 };
    return null;
  }
  if (ctxHint === 'B') {
    if (fuerB.length) return { ...fuerB[0], match: 'drucktext+ctxB', konfidenz: 0.9 };
    if (neutral.length) return { ...neutral[0], match: 'drucktext(neutral)', konfidenz: 0.75 };
    return null;
  }
  if (neutral.length) return { ...neutral[0], match: 'drucktext', konfidenz: 0.7 };
  if (fuerA.length) return { ...fuerA[0], match: 'drucktext(A)', konfidenz: 0.6 };
  if (fuerB.length) return { ...fuerB[0], match: 'drucktext(B)', konfidenz: 0.6 };
  return null;
}

// ─── Vision-Flattening + Mapping ──────────────────────────────────────────

export function flatteneVision(obj: unknown, pfad: string[] = [], aus: VisionKandidat[] = []): VisionKandidat[] {
  if (obj === null || obj === undefined) return aus;
  if (typeof obj !== 'object') {
    aus.push({ pfad: pfad.join('.'), wert: obj });
    return aus;
  }
  if (Array.isArray(obj)) {
    obj.forEach((x, i) => flatteneVision(x, [...pfad, String(i)], aus));
    return aus;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    flatteneVision(v, [...pfad, k], aus);
  }
  return aus;
}

export function mappeVisionKandidat(
  kand: VisionKandidat,
  index: BmfLabelIndex | null = getIndices().bmfLabelIndex,
  visionExtract: Record<string, unknown> | null = null,
): MappedFundstelle | null {
  if (!index) return null;
  const segments = kand.pfad.split('.');
  const key = segments[segments.length - 1] ?? '';
  const keyNorm = normLabel(key.replace(/_/g, ' '));
  if (!keyNorm) return null;

  // Personen-Kontext aus Pfad (z.B. "personen.0.name" oder "person_a.name")
  let ctxHint: 'A' | 'B' | null = null;
  for (let idx = 0; idx < segments.length; idx++) {
    const seg = segments[idx];
    if (/^a$|_a$|person_?a|person[_\. ]*a|ehemann|steuerpflichtig/i.test(seg)) ctxHint = 'A';
    if (/^b$|_b$|person_?b|person[_\. ]*b|ehefrau|ehegatt/i.test(seg)) ctxHint = 'B';
    if (seg === 'personen' && idx + 1 < segments.length) {
      const next = segments[idx + 1];
      if (next === '0') ctxHint = 'A';
      else if (next === '1') ctxHint = 'B';
      // Feinbestimmung: falls vision-extract verfuegbar, lese rolle-Feld
      if (visionExtract && Array.isArray((visionExtract as { personen?: unknown }).personen)) {
        const arr = (visionExtract as { personen: unknown[] }).personen;
        const p = arr[parseInt(next, 10)] as { rolle?: unknown } | undefined;
        if (p && typeof p.rolle === 'string') {
          if (p.rolle.toUpperCase() === 'A') ctxHint = 'A';
          if (p.rolle.toUpperCase() === 'B') ctxHint = 'B';
        }
      }
    }
  }

  const cands = index.byBeschreib.get(keyNorm) || [];
  if (cands.length === 0) return null;

  const fuerA = cands.filter(c => istPerson(c, 'A'));
  const fuerB = cands.filter(c => istPerson(c, 'B'));
  const neutral = cands.filter(c => !istPerson(c, 'A') && !istPerson(c, 'B'));

  // Harte Personenlogik: wenn Vision einen Personen-Hint gibt, nehmen wir NUR den passenden Bucket.
  // Gibt es nur gegenteilige Kandidaten (z.B. Hint=B, Katalog hat nur A-Codes), verwerfen.
  if (ctxHint === 'A') {
    if (fuerA.length) return { ...fuerA[0], match: 'vision+beschreibung+ctxA', konfidenz: 0.9 };
    if (neutral.length) return { ...neutral[0], match: 'vision+beschreibung(neutral)', konfidenz: 0.7 };
    return null;
  }
  if (ctxHint === 'B') {
    if (fuerB.length) return { ...fuerB[0], match: 'vision+beschreibung+ctxB', konfidenz: 0.9 };
    if (neutral.length) return { ...neutral[0], match: 'vision+beschreibung(neutral)', konfidenz: 0.7 };
    return null;
  }

  // Ohne Hint: neutral bevorzugen (person-agnostische Felder wie Finanzamt),
  // sonst ersten Kandidaten.
  if (neutral.length) return { ...neutral[0], match: 'vision+beschreibung', konfidenz: 0.7 };
  if (fuerA.length) return { ...fuerA[0], match: 'vision+beschreibung(A)', konfidenz: 0.6 };
  if (fuerB.length) return { ...fuerB[0], match: 'vision+beschreibung(B)', konfidenz: 0.6 };
  return null;
}

// ─── Fuzzy-Vergleich ──────────────────────────────────────────────────────

export function wertGleich(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const na = String(a ?? '').replace(/\s+/g, '').replace(/[,.]/g, '').toLowerCase();
  const nb = String(b ?? '').replace(/\s+/g, '').replace(/[,.]/g, '').toLowerCase();
  return !!na && !!nb && na === nb;
}

// ─── JSON-Rescue-Parser ───────────────────────────────────────────────────

export function extrahiereJson(text: unknown): unknown {
  if (!text || typeof text !== 'string') return null;
  let t = text.trim();
  // 1. Codefence mit Closing ``` (```json ... ```)
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  else {
    // 1b. Oeffnender Fence ohne Closing — Antwort wurde abgeschnitten
    const fenceOffen = t.match(/```(?:json)?\s*([\s\S]*)$/);
    if (fenceOffen) t = fenceOffen[1].trim();
  }
  try { return JSON.parse(t); } catch { /* weiter */ }
  // Erstes `{` — Zähler über `{`/`}` führen, bei Stand 0 das Ende schneiden.
  // Respektiert Strings (keine Zaehlung darin) und Escape-Sequenzen.
  const start = t.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; }
        }
      }
    }
  }
  return null;
}

// ─── Schema-Pfad-Suche + Schreiben ────────────────────────────────────────

export function findeCodePfadImSchema(schema: JsonSchemaNode | null | undefined, gesuchterCode: string, pfad: string[] = []): string[] | null {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.type === 'array' && schema.items) {
    return findeCodePfadImSchema(schema.items, gesuchterCode, pfad);
  }
  if (schema.type === 'object' && schema.properties) {
    if (schema.properties[gesuchterCode]) return pfad;
    for (const [k, v] of Object.entries(schema.properties)) {
      if (/^E\d{7}$/.test(k)) continue;
      const sub = findeCodePfadImSchema(v, gesuchterCode, [...pfad, k]);
      if (sub) return sub;
    }
  }
  return null;
}

export function setzeAnPfad(root: Record<string, unknown>, pfad: string[], code: string, wert: unknown): void {
  let cur: Record<string, unknown> = root;
  for (const seg of pfad) {
    if (!cur[seg] || typeof cur[seg] !== 'object') cur[seg] = {};
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[code] = wert;
}

// ─── Wert-Normalisierung ──────────────────────────────────────────────────

export function normalizeWert(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '') return '';
  // Zahl im deutschen Format: "63.559,90" oder "63559,90" → 63559.9
  const dm = s.match(/^-?\d{1,3}(?:\.\d{3})*(?:,\d+)?$|^-?\d+(?:,\d+)?$/);
  if (dm) {
    const num = parseFloat(s.replace(/\./g, '').replace(/,/g, '.'));
    if (!isNaN(num)) return num;
  }
  return s;
}

// ─── Schema-Pruning + Enum-Entferner ──────────────────────────────────────

export function pruneSchemaAufBelegt(node: JsonSchemaNode | null | undefined, belegtSet: Set<string>): JsonSchemaNode | null {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'array' && node.items) {
    const p = pruneSchemaAufBelegt(node.items, belegtSet);
    return p ? { ...node, items: p } : null;
  }
  if (node.type === 'object' && node.properties) {
    const props: Record<string, JsonSchemaNode> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(node.properties)) {
      if (/^E\d{7}$/.test(k)) {
        if (belegtSet.has(k)) { props[k] = v; required.push(k); }
      } else {
        const pv = pruneSchemaAufBelegt(v, belegtSet);
        if (pv) { props[k] = pv; required.push(k); }
      }
    }
    if (Object.keys(props).length === 0) return null;
    return { ...node, properties: props, required, additionalProperties: false };
  }
  // Leaf schemas ohne E-Code-Gehalt verwerfen — sonst bleiben Person-Enums
  // und aehnliches als required stehen.
  return null;
}

export function entferneGrosseEnums(node: JsonSchemaNode | null | undefined, schwelle = 8): JsonSchemaNode | null | undefined {
  if (!node || typeof node !== 'object') return node;
  // Hinweis: Original-JS verwendet hier Array-Map, was bei JSON-Schema-Subtrees
  // (die stets Objekte sind) nie greift — erhalten für 1:1-Kompatibilität.
  if (Array.isArray(node)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (node as any).map((n: JsonSchemaNode) => entferneGrosseEnums(n, schwelle));
  }
  const out: JsonSchemaNode = { ...node };
  if (Array.isArray(out.enum) && out.enum.length > schwelle) {
    delete out.enum;
    out.description = `${out.description || ''} · Klartext aus Dokument — wird nachtraeglich auf BMF-Code normalisiert.`.trim();
  }
  if (out.properties) {
    const np: Record<string, JsonSchemaNode> = {};
    for (const [k, v] of Object.entries(out.properties)) {
      const r = entferneGrosseEnums(v, schwelle);
      if (r) np[k] = r;
    }
    out.properties = np;
  }
  if (out.items) {
    const r = entferneGrosseEnums(out.items, schwelle);
    if (r) out.items = r;
  }
  return out;
}

// ─── Multi-Personen-Support ───────────────────────────────────────────────

export function findeOderErstelleAnlageInstanz(
  finalAnnotation: Record<string, unknown>,
  anlage: string,
  personenCtx: 'A' | 'B' | null | undefined,
): Record<string, unknown> {
  if (!finalAnnotation[anlage]) finalAnnotation[anlage] = personenCtx ? [] : {};
  const aktuell = finalAnnotation[anlage];
  if (Array.isArray(aktuell)) {
    const personMarker = personenCtx === 'A' ? 'PersonA' : personenCtx === 'B' ? 'PersonB' : null;
    if (personMarker) {
      let inst = aktuell.find((x: unknown) => (x as { Person?: string })?.Person === personMarker) as Record<string, unknown> | undefined;
      if (!inst) { inst = { Person: personMarker }; aktuell.push(inst); }
      return inst;
    }
    // Kein Personen-Kontext, Array existiert: in die erste Instanz einpflegen,
    // statt eine neue leere Instanz anzulegen.
    if (aktuell.length > 0) return aktuell[0] as Record<string, unknown>;
    const inst: Record<string, unknown> = {};
    aktuell.push(inst);
    return inst;
  }
  return aktuell as Record<string, unknown>;
}

// ─── Sammler ──────────────────────────────────────────────────────────────

export function sammleBelegteCodes(anno: unknown, out: Set<string> = new Set()): Set<string> {
  if (!anno || typeof anno !== 'object') return out;
  if (Array.isArray(anno)) { for (const x of anno) sammleBelegteCodes(x, out); return out; }
  for (const [k, v] of Object.entries(anno as Record<string, unknown>)) {
    if (/^E\d{7}$/.test(k) && v !== null && v !== undefined && v !== '') {
      if (typeof v !== 'object' || (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0)) {
        out.add(k);
      }
    }
    if (v && typeof v === 'object') sammleBelegteCodes(v, out);
  }
  return out;
}

export function sammleCodesAusSchema(schema: JsonSchemaNode | null | undefined, out: Set<string> = new Set()): Set<string> {
  if (!schema || typeof schema !== 'object') return out;
  if (schema.type === 'object' && schema.properties) {
    for (const [k, v] of Object.entries(schema.properties)) {
      if (/^E\d{7}$/.test(k)) out.add(k);
      sammleCodesAusSchema(v, out);
    }
  } else if (schema.type === 'array' && schema.items) {
    sammleCodesAusSchema(schema.items, out);
  }
  return out;
}
