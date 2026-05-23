/**
 * 🚀 EIN-SEKUNDEN-STEUERPIPELINE
 *
 * Upload PDF → Textlayer → Einbettung → eCode-Treffer → Kanonisch → Lane-1
 * → fertige Einkommensteuer-Berechnung, alles in < 1 Sekunde.
 *
 * Anwendungs-Endpunkt:
 *   POST /api/applications/:appId/instances/:caseId/upload-1sek
 *
 * Pipeline-Stufen (parallel wo möglich):
 *
 *   0. Persistieren    Upload → inbox/, sha256
 *   1. Textlayer       pdfTextLayerStage (native pdf-parse, kein OCR)
 *   2. Kennzahlen      Heuristik-Parser extrahiert Wert-Paare aus Text
 *   3. Einbetten       Alle Kennzahlen → vLLM/Ollama Batch-Einbettung
 *   4. Stufe-1-Treffer Matmul-Sidecar gegen 2219 BMF-Atome (~5ms)
 *   5. Kanonisch       Hoch-Treffer (≥0.55) direkt akzeptieren
 *   6. Lane-1          BMF-Calculator → ESt-Berechnung via /debug/test-calculation
 *
 * Externe Abhängigkeiten:
 *   - matmul-sidecar (Standard: http://host.docker.internal:7901)
 *   - Lane-1 BMF (Standard: http://host.docker.internal:12010)
 *   - vLLM für Einbettungen (Standard: env VLLM_URL)
 */
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readFileSync as fs_readFileSync, statSync as fs_statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname as path_dirname } from 'node:path';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { pdfTextLayerStage } from '../stages/pdf-text-layer.ts';
import { embedBatch, formatQuery, EMBEDDINGGEMMA_DIM } from '../lib/gemma-embed.ts';
import type { ApplicationInstance, CaseDocument } from './applications.ts';
import type { ArtifactStore, StageLogger } from '../core/types.ts';

// ───── Konfiguration ────────────────────────────────────────────

// ───── Mistral OCR (für JPG/PNG/Image-PDFs) ─────────────────────
// Sub-1s OCR via Mistral API. Audit-Qualität, kein lokales OCR-Modell
// nötig (LightOnOCR-1B + PaddleOCR-VL liegen im Cache, aber kein vLLM-
// Server dafür konfiguriert).
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY ?? '';
const MISTRAL_OCR_URL = 'https://api.mistral.ai/v1/ocr';

async function mistral_ocr_aufrufen(
  bytes: Buffer,
  mime: string,
): Promise<{ text: string; seiten: number }> {
  if (!MISTRAL_API_KEY) throw new Error('MISTRAL_API_KEY nicht gesetzt');
  const b64 = bytes.toString('base64');
  const data_url = `data:${mime};base64,${b64}`;
  const payload = {
    model: 'mistral-ocr-latest',
    document: { type: 'image_url' as const, image_url: data_url },
  };
  const antwort = await fetch(MISTRAL_OCR_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${MISTRAL_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });
  if (!antwort.ok) throw new Error(`mistral-ocr HTTP ${antwort.status}: ${await antwort.text()}`);
  const daten = await antwort.json() as { pages: Array<{ markdown: string }> };
  const seiten = daten.pages ?? [];
  const text = seiten.map(p => p.markdown ?? '').join('\n\n');
  return { text, seiten: seiten.length };
}

const MATMUL_SIDECAR_URL = process.env.MATMUL_URL ?? 'http://host.docker.internal:7901/matmul-topk';
const LANE1_BMF_URL = process.env.LANE1_BMF_URL ?? 'http://host.docker.internal:12010/debug/test-calculation';
const ATOME_PFAD = process.env.ATOME_PFAD ?? '/tmp/atoms-polar.json';

const SCHWELLE_HOCH = 0.55;
const SCHWELLE_MITTEL = 0.45;
const COLD_PREPROCESS_DIR = '/tmp/sturm-cold-preprocess';
const MAX_COLD_OCR_PAGES = Number(process.env.COLD_OCR_MAX_PAGES ?? 8);
const execFileAsync = promisify(execFile);

// ───── Stille Logger/Artefakt-Stubs für die Stage ───────────────
const stiller_logger: StageLogger = {
  debug() {}, info() {}, warn() {}, error() {},
};
const stille_artefakte: ArtifactStore = {
  async write() {},
  async writeBuffer() {},
  async read() { throw new Error('einsek: artefakte.read nicht unterstützt'); },
  async readBuffer() { throw new Error('einsek: artefakte.readBuffer nicht unterstützt'); },
  async exists() { return false; },
  absolutePath(p: string) { return p; },
};

// ───── Atom-Cache (geladen beim ersten Aufruf) ──────────────────
let _atome_cache: any[] | null = null;
async function atome_laden(): Promise<any[]> {
  if (_atome_cache) return _atome_cache;
  const inhalt = await fs.readFile(ATOME_PFAD, 'utf-8');
  _atome_cache = JSON.parse(inhalt);
  return _atome_cache!;
}

// ───── Antwort-Typ ──────────────────────────────────────────────
export interface VorverarbeitungHinweis {
  noetig: boolean;
  grund: 'scan_ohne_textlayer' | 'keine_kennzahlen';
  empfohlener_pfad: 'cold-preprocess';
  erkannte_belegklasse: string;
  hot_path_faehig: boolean;
  hinweis: string;
}

export interface EinsekundeAntwort {
  ok: boolean;
  kind: 'einsekunde-v1';
  workspaceId: string;
  dateiname: string;
  sha256: string;
  gesamt_millisek: number;
  stufen_millisek: {
    textlayer: number;
    kennzahlen_extrahieren: number;
    einbetten: number;
    stufe1_treffer: number;
    kanonisch_aufbauen: number;
    lane1: number;
  };
  belegkontext_klasse?: 'lohnsteuer' | 'einkommensteuer' | 'kapital' | 'rente' | 'sonstiges';
  belegklasse?: string;
  textlayer: {
    seiten: number;
    zeichen: number;
    hat_textlayer: boolean;
    vorschau: string;
  };
  kennzahlen: Array<{
    schluessel: string;
    wert: string | number;
    bestes_ecode: string | null;
    bestes_drucktext: string | null;
    bestes_anlage: string | null;
    punktzahl: number;
    stufe: 'hoch' | 'mittel' | 'niedrig';
  }>;
  kanonische_felder: Record<string, any>;
  vorverarbeitung?: VorverarbeitungHinweis | null;
  steuerergebnis: {
    zve: number | null;
    einkommensteuer: number | null;
    solidaritaetszuschlag: number | null;
    gesamtsteuer: number | null;
    verwendete_rechner: string[] | null;
    fehler: string | null;
  };
}

// ───── Stufe 2: Kennzahlen aus dem Textlayer extrahieren ────────
interface Kennzahl { schluessel: string; wert: string | number; }

function kennzahlen_extrahieren(text: string): Kennzahl[] {
  const treffer: Kennzahl[] = [];
  const zeilen = text.split('\n').map(z => z.trim()).filter(Boolean);

  // Heuristik A: "Label .... 1.234,56" oder "Label: 1.234,56"
  const muster_zahl_zeile = /^(.{3,80}?)[\s:]+(-?\d{1,3}(?:\.\d{3})*(?:,\d{2})?)\s*(?:€|EUR)?\s*$/;
  // Heuristik B: "Label .... Datum" (TT.MM.JJJJ)
  const muster_datum_zeile = /^(.{3,80}?)[\s:]+(\d{2}\.\d{2}\.\d{4})\s*$/;
  // Heuristik C: zwei Spalten — Label links, Wert rechts (große whitespace-Lücke)
  const muster_zwei_spalten = /^(.{3,60}?)\s{3,}(-?\d{1,3}(?:\.\d{3})*(?:,\d{2})?)\s*$/;

  for (const zeile of zeilen) {
    let m = zeile.match(muster_zahl_zeile);
    if (m) {
      const wert_str = m[2].replace(/\./g, '').replace(',', '.');
      const wert = Number(wert_str);
      if (Number.isFinite(wert)) {
        treffer.push({ schluessel: m[1].trim(), wert });
        continue;
      }
    }
    m = zeile.match(muster_datum_zeile);
    if (m) {
      treffer.push({ schluessel: m[1].trim(), wert: m[2] });
      continue;
    }
    m = zeile.match(muster_zwei_spalten);
    if (m) {
      const wert_str = m[2].replace(/\./g, '').replace(',', '.');
      const wert = Number(wert_str);
      if (Number.isFinite(wert)) {
        treffer.push({ schluessel: m[1].trim(), wert });
      }
    }
  }

  // Duplikate nach Schlüssel filtern (ersten gewinnen lassen)
  const gesehen = new Set<string>();
  return treffer.filter(t => {
    const k = t.schluessel.toLowerCase();
    if (gesehen.has(k)) return false;
    gesehen.add(k);
    return true;
  }).slice(0, 200); // Deckel für 1-sek-Budget
}


// Schlüssel-Säuberung vor dem Einbetten: führendes "3.   ", in-Klammer-Hinweise,
// und mehrfach-Whitespace raus; Wortzahl gedeckelt damit das Embedding nicht
// in Richtung Boilerplate driftet ("Bescheinigungszeitraum: Von" → einfach
// "Bescheinigungszeitraum"). Behält Diakritika und Großschreibung.
function schluessel_saeubern(s: string): string {
  let out = s;
  out = out.replace(/^\d+\.\s+/, '');            // "3.   foo" → "foo"
  out = out.replace(/\s*\(.*?\)\s*/g, ' ');     // "(ohne ...)" raus
  out = out.replace(/\s*[:\-–—]\s*$/g, '');      // trailing punctuation
  out = out.replace(/\s+/g, ' ').trim();
  const woerter = out.split(' ');
  return woerter.slice(0, 6).join(' ');
}


function text_normalisieren(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORTE = new Set(['der','die','das','den','dem','des','und','oder','bei','nur','fuer','fur','von','vom','mit','ohne','laut','zeile','nr','des','zur','zum','im','in']);
function tokenisieren(s: string): string[] {
  return text_normalisieren(s).split(' ').filter(t => t.length >= 3 && !STOPWORTE.has(t));
}

function lexikalischer_score(query: string, kandidat: string): number {
  const qn = text_normalisieren(query);
  const kn = text_normalisieren(kandidat);
  if (!qn || !kn) return 0;
  if (qn === kn) return 0.35;
  if (kn.startsWith(qn) || qn.startsWith(kn)) return 0.22;
  const qt = new Set(tokenisieren(query));
  const kt = new Set(tokenisieren(kandidat));
  if (qt.size === 0 || kt.size === 0) return 0;
  let hit = 0;
  for (const t of qt) if (kt.has(t)) hit++;
  return Math.min(0.28, (hit / qt.size) * 0.28);
}

interface BelegKontext {
  klasse: 'lohnsteuer' | 'einkommensteuer' | 'kapital' | 'rente' | 'sonstiges';
  docClass: string;
  bevorzugte_anlagen: Set<string>;
  flags?: { freistellungsauftrag?: boolean; steuerbescheinigungKapital?: boolean; gesetzlicheRente?: boolean };
}

function belegkontext_ermitteln(text: string, kennzahlen: Kennzahl[], dateiname = ''): BelegKontext {
  const corpus = `${dateiname}\n${text}\n${kennzahlen.map(k => k.schluessel).join('\n')}`;

  // EARLY-OUT: Lohnsteuerbescheinigung dominant wenn echte Lohn-Kennzahlen extrahiert wurden.
  // Eine VaSt (VAST-Belege)-PDF kann oben "Steuerbescheinigung" stehen haben, aber wenn
  // bruttoarbeitslohn UND lohnsteuer UND (steuerklasse ODER kirchensteuer) als KENNZAHLEN
  // erkannt wurden, dann ist es eindeutig eine Lohnsteuerbescheinigung im Kontext.
  const k_schluessel = kennzahlen.map(k => String(k.schluessel ?? '').toLowerCase()).join('|');
  const hat_bruttolohn = /bruttoarbeitslohn|bruttolohn/.test(k_schluessel);
  const hat_lohnsteuer = /lohnsteuer/.test(k_schluessel);
  const hat_steuerklasse = /steuerklasse/.test(k_schluessel);
  const hat_kirchensteuer = /kirchensteuer/.test(k_schluessel);
  const hat_hauptvordruck_marker = /einkommensteuererkl[a-zäöü_-]*|hauptvordruck|mantelbogen|elster[_ -]?hv|art der erklärung|allgemeine angaben|steuernummer|datum der ausfertigung|finanzamt/iu.test(corpus);
  const hat_starke_lohnmarker = /lohnsteuerbescheinigung|ausdruck der elektronischen lohnsteuerbescheinigung|elektronischen lohnsteuerbescheinigung|nachstehende daten wurden maschinell an die finanzverwaltung ubertragen|nachstehende daten wurden maschinell an die finanzverwaltung übertragen/iu.test(corpus);
  const hat_kranken_marker = /beitragsbescheinigung|krankenversicherungsverein|krankenversicherung|pflegepflichtversicherung|basisabsicherung|debeka|beitrage zur kranken|beiträge zur kranken/iu.test(corpus);
  const hat_renten_quelle = /rentenbezugsmitteilung|renten-?\/?leistungsempf[aä]nger|deutsche rentenversicherung bund|deutsche rentenversicherung|rentenservice|mitteilung zur vorlage beim finanzamt/iu.test(corpus);
  const hat_renten_feldmarker = /renten-?\/?leistungsbetrag|beginn der rente\/?leistung|beginn der rente|rentenanpassungsbetrag/iu.test(corpus);
  const hat_starke_rentenmarker = hat_renten_quelle || (!hat_hauptvordruck_marker && hat_renten_feldmarker && !hat_kranken_marker && !hat_starke_lohnmarker);
  if (hat_starke_lohnmarker) {
    return { klasse: 'lohnsteuer', docClass: 'lohnsteuerbescheinigung', bevorzugte_anlagen: new Set(['N', 'N_AUS', 'ESt1A_U', 'WA_ESt']), flags: {} };
  }
  if (hat_kranken_marker) {
    return { klasse: 'sonstiges', docClass: 'beitragsbescheinigung_kranken_p', bevorzugte_anlagen: new Set(['ESt1A']), flags: {} };
  }
  if (hat_starke_rentenmarker) {
    return { klasse: 'rente', docClass: 'rentenbezugsmitteilung', bevorzugte_anlagen: new Set(['R', 'R_AUS', 'ESt1A']), flags: { gesetzlicheRente: /deutsche rentenversicherung|rentenbezugsmitteilung|leibrente aus einer gesetzlichen/i.test(corpus) } };
  }
  if (!hat_hauptvordruck_marker && hat_bruttolohn && hat_lohnsteuer && (hat_steuerklasse || hat_kirchensteuer)) {
    return { klasse: 'lohnsteuer', docClass: 'lohnsteuerbescheinigung', bevorzugte_anlagen: new Set(['N', 'N_AUS', 'ESt1A_U', 'WA_ESt']), flags: {} };
  }
  if (hat_hauptvordruck_marker) {
    return { klasse: 'einkommensteuer', docClass: 'einkommensteuer_hauptvordruck', bevorzugte_anlagen: new Set(['ESt1A', 'ESt1A_U', 'WA_ESt']), flags: {} };
  }
  if (/kapitalertragsteuer|freistellungsauftrag|freigestellte kapitalertr|jahressteuerbescheinigung|steuerbescheinigung(?!.*lohnsteuer)|kapitalertr|volksbank|vr bank/iu.test(corpus)) {
    return { klasse: 'kapital', docClass: (/steuerbescheinigung|jahressteuerbescheinigung|volksbank|vr bank/i.test(corpus) ? 'steuerbescheinigung_kapitalertraege' : 'mitteilung_kapitalertraege'), bevorzugte_anlagen: new Set(['KAP', 'KAP_BET', 'ESt1A']), flags: { freistellungsauftrag: /freistellungsauftrag|freigestellte kapitalertr/i.test(corpus), steuerbescheinigungKapital: /steuerbescheinigung|jahressteuerbescheinigung|volksbank|vr bank/i.test(corpus) } };
  }
  if (/lohnsteuerbescheinigung|bruttoarbeitslohn|einbehaltene lohnsteuer|steuerklasse|kirchensteuer des arbeitnehmers|solidarit[aä]tszuschlag/iu.test(corpus)) {
    return { klasse: 'lohnsteuer', docClass: 'lohnsteuerbescheinigung', bevorzugte_anlagen: new Set(['N', 'N_AUS', 'ESt1A_U', 'WA_ESt']), flags: {} };
  }
  if (/rentenbezugsmitteilung|rente|rentenleistung|rentenanpassungsbetrag/iu.test(corpus)) {
    return { klasse: 'rente', docClass: 'rentenbezugsmitteilung', bevorzugte_anlagen: new Set(['R', 'R_AUS', 'ESt1A']), flags: { gesetzlicheRente: /deutsche rentenversicherung|rentenbezugsmitteilung/i.test(corpus) } };
  }
  return { klasse: 'sonstiges', docClass: 'unbekannt', bevorzugte_anlagen: new Set(['ESt1A']), flags: {} };
}

function kontext_bonus(query: string, kandidat: { anlage: string | null; drucktext: string | null; ecode: string | null }, kontext: BelegKontext): number {
  let bonus = 0;
  if (kandidat.anlage && kontext.bevorzugte_anlagen.has(kandidat.anlage)) bonus += 0.12;
  bonus += lexikalischer_score(query, kandidat.drucktext ?? '');

  const q = text_normalisieren(query);
  if (/bruttoarbeitslohn/.test(q) && /^E020020|^E0121101/.test(kandidat.ecode ?? '')) bonus += 0.25;
  if (/lohnsteuer/.test(q) && /^E020030|^E0201201/.test(kandidat.ecode ?? '')) bonus += 0.25;
  if (/solidaritatszuschlag|solidaritaetszuschlag/.test(q) && /^E020040|^E0201202|^E0110205|^E0141907/.test(kandidat.ecode ?? '')) bonus += 0.25;
  if (/kirchensteuer/.test(q) && /^E020050|^E0201301/.test(kandidat.ecode ?? '')) bonus += 0.25;
  if (/steuerklasse/.test(q) && /^E020000/.test(kandidat.ecode ?? '')) bonus += 0.25;
  return bonus;
}

function direkte_ecode_vorgabe(query: string, kontext: BelegKontext, atome: any[]): { ecode: string; anlage: string | null; drucktext: string | null; vordruckzeile: string | null; punktzahl: number; rohe_punktzahl: number } | null {
  const q = text_normalisieren(query);
  let ecode: string | null = null;
  if (kontext.klasse === 'lohnsteuer') {
    if (/steuerklasse/.test(q)) ecode = 'E0200001';
    else if (/versorgungsbezuge/.test(q)) ecode = 'E0200801';
    else if (/bruttoarbeitslohn/.test(q)) ecode = 'E0200201';
    else if (/lohnsteuer/.test(q)) ecode = 'E0200301';
    else if (/solidaritatszuschlag|solidaritaetszuschlag/.test(q)) ecode = 'E0200401';
    else if (/kirchensteuer/.test(q)) ecode = 'E0200501';
  } else if (kontext.klasse === 'kapital') {
    if (kontext.flags?.freistellungsauftrag && /betrag|kapitalertr/.test(q)) ecode = 'E1901401';
    else if (/kapitalertragsteuer/.test(q)) ecode = 'E1904701';
    else if (/kirchensteuer/.test(q)) ecode = 'E1904801';
    else if (/kapitalertr/.test(q) && kontext.flags?.steuerbescheinigungKapital) ecode = 'E1900701';
  } else if (kontext.klasse === 'rente') {
    if (/beginn der rente|rentenbeginn|beginn/.test(q)) ecode = kontext.flags?.gesetzlicheRente ? 'E1800501' : 'E1801701';
    else if (/rentenanpassungsbetrag/.test(q)) ecode = 'E1800606';
    else if (/renten|leistungsbetrag|rentenbetrag/.test(q)) ecode = 'E1800301';
  }
  if (!ecode) return null;
  const atom = atome.find((a) => a?.field_name === ecode);
  return {
    ecode,
    anlage: atom?.metadata?.anlage ?? null,
    drucktext: atom?.metadata?.drucktext ?? atom?.value ?? null,
    vordruckzeile: atom?.metadata?.vordruckzeile ?? null,
    punktzahl: 2.0,
    rohe_punktzahl: 2.0,
  };
}


function kennzahl_ignorieren(kz: Kennzahl, kontext: BelegKontext): boolean {
  const q = text_normalisieren(String(kz.schluessel));
  if (!q) return true;
  if (/^transferticket|^seite \d+ von|abfragedatum|ubermittlungszeitpunkt|uebermittlungszeitpunkt/.test(q)) return true;
  if (kontext.klasse === 'rente') {
    if (/erster monat des zeitraums|letzter monat des zeitraums/.test(q)) return true;
    if (/beitrage zuschusse|beitragezuschusse/.test(q)) return true;
  }
  if (kontext.klasse === 'kapital') {
    if (q == 'betrag' && !(kontext.flags?.freistellungsauftrag || kontext.flags?.steuerbescheinigungKapital)) return true;
    if (/betroffene person|betroffenes jahr|institut|vorname|name$|identifikationsnummer/.test(q)) return true;
  }
  if (kontext.klasse === 'einkommensteuer') {
    if (/transferticket|abfragedatum/.test(q)) return true;
  }
  return false;
}


function vorverarbeitung_hinweis(kontext: BelegKontext, hat_textlayer: boolean, zeichen_count: number): VorverarbeitungHinweis {
  const grund = (!hat_textlayer || zeichen_count < 20) ? 'scan_ohne_textlayer' : 'keine_kennzahlen';
  return {
    noetig: true,
    grund,
    empfohlener_pfad: 'cold-preprocess',
    erkannte_belegklasse: kontext.docClass,
    hot_path_faehig: false,
    hinweis: grund === 'scan_ohne_textlayer'
      ? 'PDF ist im Hot-Path nicht textlayer-faehig; erst Vorverarbeitung/OCR im Cold-Path, dann audit-now.'
      : 'Belegklasse erkannt, aber keine belastbaren Kennzahlen im Hot-Path extrahierbar; bitte Cold-Preprocess laufen lassen.',
  };
}

// ───── Stufe 4: Stufe-1-Treffer via Matmul-Sidecar ──────────────
// TIER-D instrumentation: stores last-run sub-timings of stufe1
export const stufe1_sub_timings: Record<string, number> = {};

// ───── TIER B.1: Stufe-1 result-cache ───────────────────────────
//
// Cache key: sha1(
//   kennzahl_strings_sorted +
//   kontext.klasse +
//   kontext.docClass +
//   sorted(kontext.bevorzugte_anlagen) +
//   sorted(kontext.flags)
// )
//
// Why deterministic: given the same kennzahl-strings (-> same embeddings,
// already cached by A.1) and the same belegkontext, stufe1_treffer_holen
// is a pure function of (vektoren, atome). Atoms are loaded-once. Vectors
// are cache-deterministic. Output -> cache.
//
// Cache value: full ergebnis array (kennzahl + top: [...])
// We store kennzahl as data, NOT reference, to keep cache portable across
// different upload contexts (each upload has its own kennzahl-instances).

interface Stufe1CacheEntry {
  ergebnis: Array<{ kennzahl: Kennzahl; top: any[] }>;
  hits: number;
}

class Stufe1LRU {
  private map = new Map<string, Stufe1CacheEntry>();
  private capacity: number;
  hits = 0;
  misses = 0;
  evictions = 0;

  constructor(capacity = 1_000) {
    this.capacity = capacity;
  }

  get(key: string): Array<{ kennzahl: Kennzahl; top: any[] }> | undefined {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    entry.hits++;
    this.hits++;
    return JSON.parse(JSON.stringify(entry.ergebnis));
  }

  set(key: string, ergebnis: Array<{ kennzahl: Kennzahl; top: any[] }>): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        this.map.delete(oldest);
        this.evictions++;
      }
    }
    this.map.set(key, {
      ergebnis: JSON.parse(JSON.stringify(ergebnis)),
      hits: 0,
    });
  }

  stats() {
    return {
      size: this.map.size,
      capacity: this.capacity,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      hit_rate: this.hits + this.misses > 0
        ? this.hits / (this.hits + this.misses)
        : 0,
    };
  }

  clear() {
    this.map.clear();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }
}

const STUFE1_CACHE_ENABLED = process.env.STUFE1_CACHE_ENABLED !== '0';
const STUFE1_CACHE_CAPACITY = Number(process.env.STUFE1_CACHE_CAPACITY ?? '1000') || 1_000;
const stufe1_cache = new Stufe1LRU(STUFE1_CACHE_CAPACITY);

export function getStufe1CacheStats() {
  return stufe1_cache.stats();
}

export function clearStufe1Cache() {
  stufe1_cache.clear();
}

function stufe1_cache_key(
  kennzahlen: Kennzahl[],
  kontext: BelegKontext,
): string {
  // Normalize: kennzahl-strings sorted (order shouldn't matter for cache identity)
  // We include kennzahl.wert too because direkte_ecode_vorgabe doesn't, but kennzahl
  // matters for the output structure (kennzahl is in the output).
  const keys_sorted = kennzahlen
    .map(k => `${String(k.schluessel)}::${String(k.wert ?? '')}`)
    .sort();
  const anlagen_sorted = Array.from(kontext.bevorzugte_anlagen).sort();
  const flags_sorted = Object.keys(kontext.flags ?? {}).sort()
    .map(k => `${k}=${String((kontext.flags as any)[k])}`);
  const composite = [
    keys_sorted.join('|'),
    kontext.klasse,
    kontext.docClass,
    anlagen_sorted.join(','),
    flags_sorted.join(','),
  ].join('::');
  return createHash('sha1').update(composite).digest('hex').slice(0, 24);
}

async function stufe1_treffer_holen(
  kennzahlen: Kennzahl[],
  vektoren: Float32Array[],
  atome: any[],
  kontext: BelegKontext,
): Promise<Array<{ kennzahl: Kennzahl; top: any[] }>> {
  // TIER B.1: cache lookup
  if (STUFE1_CACHE_ENABLED) {
    const ckey = stufe1_cache_key(kennzahlen, kontext);
    const cached = stufe1_cache.get(ckey);
    if (cached !== undefined) {
      // Re-stitch the kennzahl references — cached values have plain-object
      // kennzahl-data, but downstream may compare by reference. Reattach the
      // live kennzahl objects by index.
      return cached.map((entry, i) => ({
        kennzahl: kennzahlen[i] ?? entry.kennzahl,
        top: entry.top,
      }));
    }
    const ergebnis = await _stufe1_treffer_holen_uncached(kennzahlen, vektoren, atome, kontext);
    stufe1_cache.set(ckey, ergebnis);
    return ergebnis;
  }
  return _stufe1_treffer_holen_uncached(kennzahlen, vektoren, atome, kontext);
}

async function _stufe1_treffer_holen_uncached(
  kennzahlen: Kennzahl[],
  vektoren: Float32Array[],
  atome: any[],
  kontext: BelegKontext,
): Promise<Array<{ kennzahl: Kennzahl; top: any[] }>> {
  const t_serialize = performance.now();
  const anfragen_payload = vektoren.map(v => Array.from(v));
  const body = JSON.stringify({ queries: anfragen_payload, top_k: 12 });
  stufe1_sub_timings.serialize_ms = performance.now() - t_serialize;
  stufe1_sub_timings.payload_bytes = body.length;

  const t_http = performance.now();
  const antwort = await fetch(MATMUL_SIDECAR_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!antwort.ok) throw new Error(`matmul-sidecar HTTP ${antwort.status}`);
  stufe1_sub_timings.http_roundtrip_ms = performance.now() - t_http;

  const t_parse = performance.now();
  const daten = await antwort.json() as { topk: Array<Array<{ idx: number; score: number }>> };
  stufe1_sub_timings.parse_ms = performance.now() - t_parse;

  const t_postproc = performance.now();
  const ergebnis = kennzahlen.map((kz, i) => {
    const query = schluessel_saeubern(String(kz.schluessel));
    const roh = (daten.topk[i] ?? []).map(t => {
      const atom = atome[t.idx] ?? {};
      const anlage = atom?.metadata?.anlage ?? null;
      const drucktext = atom?.metadata?.drucktext ?? atom?.value ?? null;
      const kandidat = {
        ecode: atom?.field_name ?? null,
        anlage,
        drucktext,
        vordruckzeile: atom?.metadata?.vordruckzeile ?? null,
        punktzahl: t.score,
        rohe_punktzahl: t.score,
      };
      return {
        ...kandidat,
        punktzahl: t.score + kontext_bonus(query, kandidat, kontext),
      };
    });
    const direkt = direkte_ecode_vorgabe(query, kontext, atome);
    if (direkt) {
      roh.unshift(direkt);
    }
    const gesehen = new Set<string>();
    const dedup = roh.filter((k) => {
      const key = `${k.ecode ?? ''}|${k.drucktext ?? ''}`;
      if (gesehen.has(key)) return false;
      gesehen.add(key);
      return true;
    });
    dedup.sort((a, b) => b.punktzahl - a.punktzahl);
    return { kennzahl: kz, top: dedup.slice(0, 5) };
  });
  stufe1_sub_timings.postproc_ms = performance.now() - t_postproc;
  return ergebnis;
}


// ───── eCode → Lane-1 BMF-Param-Mapping ─────────────────────────
// VOLLDYNAMISCH: wird einmalig aus dem ELSTER-Katalog (feld_katalog_full.json,
// 2287 Codes) abgeleitet anhand der Drucktexte. KEINE manuell gepflegte Tabelle.
//
// Match-Regeln: Drucktext-Pattern → Lane-1 BMF-Param-Name. Die Pattern beschreiben
// die fachlichen Konzepte die Lane-1 versteht — nicht die ECodes. Ein neuer ECode
// in einer neuen ELSTER-Jahresversion wird automatisch gemappt, sobald sein
// Drucktext zu einem dieser fachlichen Konzepte passt.
// Dynamischer Drucktext-Lookup: einmal aus feld_katalog_full.json laden
// (2287 ELSTER-Codes über 35 Anlagen — die offizielle ELSTER-Spec).
let ECODE_DRUCKTEXT_CACHE: Record<string, { anlage: string; drucktext: string }> | null = null;

function ecode_drucktext_laden(): Record<string, { anlage: string; drucktext: string }> {
  if (ECODE_DRUCKTEXT_CACHE) return ECODE_DRUCKTEXT_CACHE;
  const cache: Record<string, { anlage: string; drucktext: string }> = {};
  try {
    // __dirname in ESM: vom import.meta.url ableiten
    let here = '';
    try { here = path_dirname(fileURLToPath(import.meta.url)); } catch {}
    const kandidaten = [
      here ? `${here}/../verticals/elster/data/feld_katalog_full.json` : '',
      `${process.cwd()}/src/verticals/elster/data/feld_katalog_full.json`,
      '/app/src/verticals/elster/data/feld_katalog_full.json',
    ].filter(Boolean);
    let pfad: string | null = null;
    for (const k of kandidaten) {
      try { if (fs_statSync(k).isFile()) { pfad = k; break; } } catch {}
    }
    if (!pfad) {
      console.warn('[einsekunde] feld_katalog_full.json nicht gefunden — drucktext-Lookup leer');
      ECODE_DRUCKTEXT_CACHE = cache;
      return cache;
    }
    const j = JSON.parse(fs_readFileSync(pfad, 'utf-8'));
    const anlagen = j.anlagen || {};
    for (const [anlage_name, blob] of Object.entries<any>(anlagen)) {
      for (const c of (blob.codes || [])) {
        const ec = c.eCode;
        if (!ec) continue;
        const dt = (c.drucktext || c.bezeichnung || '').toString();
        // Erst-Treffer behalten (Anlage-Reihenfolge ist alphabetisch konsistent).
        if (!cache[ec]) cache[ec] = { anlage: anlage_name, drucktext: dt };
      }
    }
    console.log(`[einsekunde] feld_katalog_full geladen: ${Object.keys(cache).length} ECodes`);
  } catch (e) {
    console.warn('[einsekunde] feld_katalog_full Ladefehler:', (e as Error).message);
  }
  ECODE_DRUCKTEXT_CACHE = cache;
  return cache;
}

const BMF_DRUCKTEXT_REGELN: Array<{ bmf: string; muster: RegExp; anlagen?: string[]; ohne?: RegExp }> = [
  // Lohnsteuerbescheinigung-Felder (Anlage N)
  { bmf: 'bruttolohn',            muster: /^bruttoarbeitslohn(?!.*minijob)/i, anlagen: ['N', 'ESt1A_U'] },
  { bmf: 'lohnsteuer',            muster: /^(einbehaltene\s+)?lohnsteuer\b/i, anlagen: ['N'] },
  { bmf: 'solidaritaetszuschlag', muster: /^(einbehaltener?\s+)?solidarit[aä]tszuschlag(?!\s+zu\s+Zeile)/i, anlagen: ['N'] },
  { bmf: 'kirchensteuer',         muster: /^(einbehaltene\s+)?kirchensteuer\s+des\s+arbeitnehmers/i, anlagen: ['N'] },
  { bmf: 'steuerklasse',          muster: /^steuerklasse$/i, anlagen: ['N'] },

  // Sozialabgaben (Anlage VOR)
  { bmf: 'rv_beitraege', muster: /arbeitnehmeranteil\s+laut\s+Nr\.\s*23/i, anlagen: ['VOR'] },
  { bmf: 'kv_beitraege', muster: /arbeitnehmerbeitr[aä]ge\s+zu\s+Krankenversicherungen\s+laut\s+Nr\.\s*25/i, anlagen: ['VOR'] },
  { bmf: 'pv_beitraege', muster: /arbeitnehmerbeitr[aä]ge\s+zu\s+sozialen\s+Pflegeversicherungen\s+laut\s+Nr\.\s*26/i, anlagen: ['VOR'] },
  { bmf: 'av_beitraege', muster: /arbeitnehmerbeitr[aä]ge\s+zur\s+Arbeitslosenversicherung\s+laut\s+Nr\.\s*27/i, anlagen: ['VOR'] },

  // Renten (Anlage R)
  { bmf: 'renteneinkuenfte', muster: /^(Renten-?\/?Leistungsbetrag|Rentenbetrag)/i, anlagen: ['R'] },
  { bmf: 'rentenbeginn',     muster: /^Beginn\s+der\s+Rente/i, anlagen: ['R'] },

  // Kapital (Anlage KAP)
  { bmf: 'kapitalertraege',           muster: /^Kapitalertr[aä]ge(?!.*ausl[aä]ndisch)/i, anlagen: ['KAP'] },
  { bmf: 'kapitalertragsteuer',       muster: /^Kapitalertragsteuer/i, anlagen: ['KAP'] },
  { bmf: 'kirchensteuer_kapital',     muster: /^Kirchensteuer.*Kapital/i, anlagen: ['KAP'] },
  { bmf: 'sparer_pauschbetrag_genutzt', muster: /Sparer-Pauschbetrag/i, anlagen: ['KAP'] },
];

let ECODE_ZU_BMF_CACHE: Record<string, string> | null = null;
function ECODE_ZU_BMF_compute(): Record<string, string> {
  if (ECODE_ZU_BMF_CACHE) return ECODE_ZU_BMF_CACHE;
  const cache = ecode_drucktext_laden();
  const out: Record<string, string> = {};
  for (const [ecode, entry] of Object.entries(cache)) {
    for (const regel of BMF_DRUCKTEXT_REGELN) {
      if (regel.anlagen && !regel.anlagen.includes(entry.anlage)) continue;
      if (regel.ohne && regel.ohne.test(entry.drucktext)) continue;
      if (regel.muster.test(entry.drucktext)) {
        out[ecode] = regel.bmf;
        break;
      }
    }
  }
  ECODE_ZU_BMF_CACHE = out;
  console.log(`[einsekunde] ECODE_ZU_BMF dynamisch abgeleitet: ${Object.keys(out).length} ECodes auf ${BMF_DRUCKTEXT_REGELN.length} BMF-Param-Regeln gemappt`);
  return out;
}

// Hinweis: aus historischen Gründen wird ECODE_ZU_BMF an manchen Stellen als
// statisches Record<string,string> verwendet. Wir bauen einen Proxy, der lazy
// computiert wird beim ersten Lookup.
const ECODE_ZU_BMF = new Proxy({} as Record<string, string>, {
  get(_, key: string) { return ECODE_ZU_BMF_compute()[key]; },
  has(_, key: string) { return key in ECODE_ZU_BMF_compute(); },
  ownKeys() { return Object.keys(ECODE_ZU_BMF_compute()); },
  getOwnPropertyDescriptor(_, key: string) {
    const v = ECODE_ZU_BMF_compute()[key];
    if (v === undefined) return undefined;
    return { value: v, enumerable: true, configurable: true, writable: false };
  },
});


function bmf_params_aus_ecodes(
  kanonisch: Record<string, any>,
): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [ecode, wert] of Object.entries(kanonisch)) {
    const bmf_name = ECODE_ZU_BMF[ecode];
    if (!bmf_name) continue;
    if (typeof wert === 'number' && typeof out[bmf_name] === 'number') {
      out[bmf_name] = (out[bmf_name] as number) + wert;
    } else if (out[bmf_name] === undefined) {
      out[bmf_name] = wert;
    }
  }
  return out;
}

// ───── TIER A.3: Lane-1 BMF result-cache ────────────────────────
//
// Lane-1 ist deterministisch gegeben (steuerjahr + bmf_params).
// Selbe BMF-params -> selbes ESt-result. 100% safe to cache.
//
// Cache key: sha1(canonical-JSON(steuerjahr + bmf_params))
// Cache val: EinsekundeAntwort['steuerergebnis'] (deep-clone on get/set)
//
// Toggle: LANE1_CACHE_ENABLED=0 disables

interface Lane1CacheEntry {
  result: any;
  hits: number;
}

class Lane1LRU {
  private map = new Map<string, Lane1CacheEntry>();
  private capacity: number;
  hits = 0;
  misses = 0;
  evictions = 0;

  constructor(capacity = 5_000) {
    this.capacity = capacity;
  }

  get(key: string): any | undefined {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    entry.hits++;
    this.hits++;
    // Defensive copy via JSON-roundtrip
    return JSON.parse(JSON.stringify(entry.result));
  }

  set(key: string, result: any): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        this.map.delete(oldest);
        this.evictions++;
      }
    }
    this.map.set(key, {
      result: JSON.parse(JSON.stringify(result)),
      hits: 0,
    });
  }

  stats() {
    return {
      size: this.map.size,
      capacity: this.capacity,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      hit_rate: this.hits + this.misses > 0
        ? this.hits / (this.hits + this.misses)
        : 0,
    };
  }

  clear() {
    this.map.clear();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }
}

const LANE1_CACHE_ENABLED = process.env.LANE1_CACHE_ENABLED !== '0';
const LANE1_CACHE_CAPACITY = Number(process.env.LANE1_CACHE_CAPACITY ?? '5000') || 5_000;
const lane1_cache = new Lane1LRU(LANE1_CACHE_CAPACITY);

export function getLane1CacheStats() {
  return lane1_cache.stats();
}

export function clearLane1Cache() {
  lane1_cache.clear();
}

function canonical_json(obj: Record<string, any>): string {
  // Sort keys for stable serialization (parameter order shouldn't change cache key)
  const sorted_keys = Object.keys(obj).sort();
  const out: Record<string, any> = {};
  for (const k of sorted_keys) {
    out[k] = obj[k];
  }
  return JSON.stringify(out);
}

async function _lane1_fetch_uncached(
  parameter: Record<string, any>,
): Promise<EinsekundeAntwort['steuerergebnis']> {
  const antwort = await fetch(LANE1_BMF_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parameters: parameter }),
  });
  if (!antwort.ok) {
    return {
      zve: null, einkommensteuer: null, solidaritaetszuschlag: null,
      gesamtsteuer: null, verwendete_rechner: null,
      fehler: `lane1 HTTP ${antwort.status}`,
    };
  }
  const ergebnis = await antwort.json() as any;
  if (ergebnis?.fehler) {
    return {
      zve: null, einkommensteuer: null, solidaritaetszuschlag: null,
      gesamtsteuer: null, verwendete_rechner: null,
      fehler: String(ergebnis.fehler),
    };
  }
  const daten = ergebnis?.calculation_result?.daten ?? {};
  const orch = daten?.berechnungsdetails?.orchestrierung ?? {};
  return {
    zve: daten.zve ?? null,
    einkommensteuer: daten.einkommensteuer ?? null,
    solidaritaetszuschlag: daten.solidaritaetszuschlag ?? null,
    gesamtsteuer: daten.gesamtsteuer ?? null,
    verwendete_rechner: orch.ausgewaehlte_rechner ?? null,
    fehler: null,
  };
}

// ───── Stufe 6: Lane-1 BMF anstoßen ─────────────────────────────
async function lane1_aufrufen(
  jahr: number,
  kanonische_felder: Record<string, any>,
): Promise<EinsekundeAntwort['steuerergebnis']> {
  // eCodes → Lane-1-BMF-Param-Namen mappen, dann Steuerjahr ergänzen
  const bmf_params = bmf_params_aus_ecodes(kanonische_felder);
  const parameter: Record<string, any> = {
    steuerjahr: jahr,
    ...bmf_params,
  };

  // Wenn keine Einkommensquelle erkannt wurde, Lane-1 nicht aufrufen
  // (er würde mit "Mindestens eine Einkommensquelle erforderlich" 500en).
  const hat_einkommen = (
    'bruttolohn' in bmf_params ||
    'freiberufliche_einkuenfte' in bmf_params ||
    'renteneinkuenfte' in bmf_params ||
    'kapitalertraege' in bmf_params
  );
  if (!hat_einkommen) {
    return {
      zve: null, einkommensteuer: null, solidaritaetszuschlag: null,
      gesamtsteuer: null, verwendete_rechner: null,
      fehler: 'keine Einkommensquelle in den Belegen erkannt (bruttolohn/freiberufliche/rente)',
    };
  }

  try {
    // TIER A.3: cache lookup
    if (LANE1_CACHE_ENABLED) {
      const cache_key = createHash('sha1').update(canonical_json(parameter)).digest('hex').slice(0, 24);
      const cached = lane1_cache.get(cache_key);
      if (cached !== undefined) {
        return cached;
      }
      // miss -> fetch + store
      const result = await _lane1_fetch_uncached(parameter);
      // Only cache successful results (don't cache HTTP errors)
      if (result.fehler === null) {
        lane1_cache.set(cache_key, result);
      }
      return result;
    }
    // Cache disabled: pass-through
    return await _lane1_fetch_uncached(parameter);
  } catch (e: any) {
    return {
      zve: null, einkommensteuer: null, solidaritaetszuschlag: null,
      gesamtsteuer: null, verwendete_rechner: null,
      fehler: e?.message ?? String(e),
    };
  }
}

// ───── Haupt-Handler ────────────────────────────────────────────
export async function einsekunde_pipeline(
  rootCwd: string,
  inst: ApplicationInstance,
  doc: CaseDocument,
): Promise<EinsekundeAntwort> {
  const t_start = performance.now();

  const wsAbs = path.isAbsolute(inst.workspacePath)
    ? inst.workspacePath
    : path.join(rootCwd, inst.workspacePath);
  const quell_pfad = path.join(wsAbs, doc.inboxPath);

  // ─ Stufe 1: Textlayer ─
  const t1 = performance.now();
  const ctrl = new AbortController();
  const textlayer_out = await pdfTextLayerStage.run(
    { filePath: quell_pfad, filename: doc.filename },
    {
      runId: `einsek-${Date.now().toString(36)}`,
      workflowId: 'einsekunde',
      stageId: 'extract/pdf-text-layer',
      config: { layout: true },
      logger: stiller_logger,
      artifacts: stille_artefakte,
      emit() {},
      signal: ctrl.signal,
      results: {},
      tools: {} as never,
    },
  );
  const ms_textlayer = performance.now() - t1;
  const voller_text = textlayer_out.text ?? '';
  const seiten_count = textlayer_out.pages.length;
  const zeichen_count = textlayer_out.chars;
  const hat_textlayer = textlayer_out.hasTextLayer;

  // ─ Stufe 2: Kennzahlen extrahieren ─
  const t2 = performance.now();
  const kennzahlen = kennzahlen_extrahieren(voller_text);
  const ms_kennzahlen = performance.now() - t2;
  const belegkontext = belegkontext_ermitteln(voller_text, kennzahlen, doc.filename);

  // Wenn keine Kennzahlen — früh return
  if (kennzahlen.length === 0) {
    return {
      ok: true, kind: 'einsekunde-v1',
      workspaceId: path.basename(inst.workspacePath),
      dateiname: doc.filename, sha256: doc.sha256,
      gesamt_millisek: performance.now() - t_start,
      belegkontext_klasse: belegkontext.klasse,
      belegklasse: belegkontext.docClass,
      stufen_millisek: {
        textlayer: ms_textlayer, kennzahlen_extrahieren: ms_kennzahlen,
        einbetten: 0, stufe1_treffer: 0, kanonisch_aufbauen: 0, lane1: 0,
      },
      textlayer: {
        seiten: seiten_count, zeichen: zeichen_count,
        hat_textlayer,
        vorschau: voller_text.slice(0, 280),
      },
      kennzahlen: [], kanonische_felder: {},
      vorverarbeitung: vorverarbeitung_hinweis(belegkontext, hat_textlayer, zeichen_count),
      steuerergebnis: {
        zve: null, einkommensteuer: null, solidaritaetszuschlag: null,
        gesamtsteuer: null, verwendete_rechner: null,
        fehler: 'keine Kennzahlen aus Textlayer extrahierbar',
      },
    };
  }

  // ─ Stufe 3+4: Einbetten + Matmul parallel mit Atom-Laden ─
  const t3 = performance.now();
  // Schlüssel säubern + KEIN formatQuery (asymmetric prompt verzerrt diesen Catalog,
  // empirisch verifiziert: RAW gewinnt in 4/4 getesteten Fällen).
  const t3a = performance.now();
  const anfragen = kennzahlen.map(k => schluessel_saeubern(String(k.schluessel)));
  const ms_saeubern = performance.now() - t3a;

  const t3b = performance.now();
  const [vektoren, atome] = await Promise.all([
    embedBatch(anfragen),
    atome_laden(),
  ]);
  const ms_embed_plus_atome = performance.now() - t3b;
  const ms_einbetten = performance.now() - t3;

  const t4 = performance.now();
  const treffer = await stufe1_treffer_holen(kennzahlen, vektoren, atome, belegkontext);
  const ms_stufe1 = performance.now() - t4;
  // TIER-D: capture sub-timings (mutates global)
  const stufe1_sub = { ...stufe1_sub_timings };

  // ─ Stufe 5: kanonische Felder aufbauen ─
  const t5 = performance.now();
  const kanonische_felder: Record<string, any> = {};
  const kennzahlen_bericht: EinsekundeAntwort['kennzahlen'] = [];
  for (const t of treffer) {
    if (kennzahl_ignorieren(t.kennzahl, belegkontext)) continue;
    const top = t.top[0];
    const punktzahl = top?.punktzahl ?? 0;
    let stufe: 'hoch' | 'mittel' | 'niedrig';
    if (punktzahl >= SCHWELLE_HOCH) stufe = 'hoch';
    else if (punktzahl >= SCHWELLE_MITTEL) stufe = 'mittel';
    else stufe = 'niedrig';

    kennzahlen_bericht.push({
      schluessel: t.kennzahl.schluessel,
      wert: t.kennzahl.wert,
      bestes_ecode: top?.ecode ?? null,
      bestes_drucktext: top?.drucktext ?? null,
      bestes_anlage: top?.anlage ?? null,
      punktzahl,
      stufe,
    });

    // Nur Hoch-Treffer in kanonische_felder (Stufe-2-Disambig wäre 200ms+)
    if (stufe === 'hoch' && top?.ecode) {
      kanonische_felder[top.ecode] = t.kennzahl.wert;
    }
  }
  const ms_kanonisch = performance.now() - t5;

  // ─ Stufe 6: Lane-1 BMF ─
  const t6 = performance.now();
  const jahr = inst.veranlagungsjahr ?? new Date().getFullYear();
  const steuerergebnis = await lane1_aufrufen(jahr, kanonische_felder);
  const ms_lane1 = performance.now() - t6;

  return {
    ok: true,
    kind: 'einsekunde-v1',
    workspaceId: path.basename(inst.workspacePath),
    dateiname: doc.filename,
    sha256: doc.sha256,
    gesamt_millisek: performance.now() - t_start,
    stufen_millisek: {
      textlayer: ms_textlayer,
      kennzahlen_extrahieren: ms_kennzahlen,
      einbetten: ms_einbetten,
      stufe1_treffer: ms_stufe1,
      kanonisch_aufbauen: ms_kanonisch,
      lane1: ms_lane1,
    },
    // TIER-D detailed sub-timings (instrumentation; not part of stable API contract)
    detailed_timings: {
      stufe3_saeubern_ms: ms_saeubern,
      stufe3_embed_plus_atome_ms: ms_embed_plus_atome,
      stufe4_serialize_ms: stufe1_sub.serialize_ms,
      stufe4_payload_bytes: stufe1_sub.payload_bytes,
      stufe4_http_roundtrip_ms: stufe1_sub.http_roundtrip_ms,
      stufe4_parse_ms: stufe1_sub.parse_ms,
      stufe4_postproc_ms: stufe1_sub.postproc_ms,
    } as any,
    textlayer: {
      seiten: seiten_count,
      zeichen: zeichen_count,
      hat_textlayer,
      vorschau: voller_text.slice(0, 280),
    },
    kennzahlen: kennzahlen_bericht,
    kanonische_felder,
    vorverarbeitung: null,
    steuerergebnis,
    belegkontext_klasse: belegkontext.klasse,
  };
}


// ───── Fall-/Mandanten-freie Variante ───────────────────────────
// Nimmt nur einen PDF-Pfad + optionales Steuerjahr und führt dieselbe
// Pipeline durch. Schreibt NICHTS in den Workspace, persistiert nichts.
// Für Quick-Tests, Studio-Vorschau und das case-unabhängige Upload-Widget.
export interface FreistehendeAntwort {
  ok: boolean;
  kind: 'einsekunde-freistehend-v1';
  dateiname: string;
  gesamt_millisek: number;
  stufen_millisek: {
    textlayer: number;
    kennzahlen_extrahieren: number;
    einbetten: number;
    stufe1_treffer: number;
    kanonisch_aufbauen: number;
    lane1: number;
  };
  belegkontext_klasse?: 'lohnsteuer' | 'einkommensteuer' | 'kapital' | 'rente' | 'sonstiges';
  belegklasse?: string;
  textlayer: {
    seiten: number;
    zeichen: number;
    hat_textlayer: boolean;
    vorschau: string;
  };
  kennzahlen: Array<{
    schluessel: string;
    wert: string | number;
    bestes_ecode: string | null;
    bestes_drucktext: string | null;
    bestes_anlage: string | null;
    punktzahl: number;
    stufe: 'hoch' | 'mittel' | 'niedrig';
  }>;
  kanonische_felder: Record<string, any>;
  vorverarbeitung?: VorverarbeitungHinweis | null;
  steuerergebnis: {
    zve: number | null;
    einkommensteuer: number | null;
    solidaritaetszuschlag: number | null;
    gesamtsteuer: number | null;
    verwendete_rechner: string[] | null;
    fehler: string | null;
  };
}

export async function einsekunde_pipeline_freistehend(
  pdf_pfad: string,
  dateiname: string,
  steuerjahr?: number,
): Promise<FreistehendeAntwort> {
  const t_start = performance.now();

  // ─ Stufe 1: Text aus Datei (PDF → Textlayer; JPG/PNG → Mistral-OCR) ─
  const t1 = performance.now();
  const ist_bild = /\.(jpe?g|png|webp|gif)$/i.test(dateiname);
  let voller_text = '';
  let seiten_count = 0;
  let zeichen_count = 0;
  let hat_textlayer = false;
  let ocr_genutzt = false;

  if (ist_bild) {
    const bytes = await fs.readFile(pdf_pfad);
    const mime = dateiname.match(/\.png$/i) ? 'image/png'
               : dateiname.match(/\.webp$/i) ? 'image/webp'
               : dateiname.match(/\.gif$/i) ? 'image/gif'
               : 'image/jpeg';
    const ocr = await mistral_ocr_aufrufen(bytes, mime);
    voller_text = ocr.text;
    seiten_count = ocr.seiten;
    zeichen_count = ocr.text.length;
    hat_textlayer = true;
    ocr_genutzt = true;
  } else {
    const ctrl = new AbortController();
    const textlayer_out = await pdfTextLayerStage.run(
      { filePath: pdf_pfad, filename: dateiname },
      {
        runId: `freistehend-${Date.now().toString(36)}`,
        workflowId: 'einsekunde-freistehend',
        stageId: 'extract/pdf-text-layer',
        config: { layout: true },
        logger: stiller_logger,
        artifacts: stille_artefakte,
        emit() {},
        signal: ctrl.signal,
        results: {},
        tools: {} as never,
      },
    );
    voller_text = textlayer_out.text ?? '';
    seiten_count = textlayer_out.pages.length;
    zeichen_count = textlayer_out.chars;
    hat_textlayer = textlayer_out.hasTextLayer;

    // PDF ohne Textlayer? Fallback auf Mistral-OCR (jede Seite einzeln wäre
    // ideal, hier MVP: erste Seite als JPG rendern via pdftoppm würde extra
    // Toolchain brauchen — daher hier: wenn kein Textlayer → Fehler, der
    // User soll JPG hochladen).
    if (!hat_textlayer || zeichen_count < 20) {
      // Lass alte Logik weiterlaufen — kein OCR-Auto-Fallback für PDFs (MVP)
    }
  }
  const ms_textlayer = performance.now() - t1;

  // ─ Stufe 2: Kennzahlen extrahieren ─
  const t2 = performance.now();
  const kennzahlen = kennzahlen_extrahieren(voller_text);
  const ms_kennzahlen = performance.now() - t2;
  const belegkontext = belegkontext_ermitteln(voller_text, kennzahlen, dateiname);

  if (kennzahlen.length === 0) {
    return {
      ok: true,
      kind: 'einsekunde-freistehend-v1',
      dateiname,
      gesamt_millisek: performance.now() - t_start,
      belegkontext_klasse: belegkontext.klasse,
      belegklasse: belegkontext.docClass,
      stufen_millisek: {
        textlayer: ms_textlayer, kennzahlen_extrahieren: ms_kennzahlen,
        einbetten: 0, stufe1_treffer: 0, kanonisch_aufbauen: 0, lane1: 0,
      },
      textlayer: {
        seiten: seiten_count, zeichen: zeichen_count,
        hat_textlayer: hat_textlayer,
        vorschau: voller_text.slice(0, 280),
      },
      kennzahlen: [], kanonische_felder: {},
      vorverarbeitung: vorverarbeitung_hinweis(belegkontext, hat_textlayer, zeichen_count),
      steuerergebnis: {
        zve: null, einkommensteuer: null, solidaritaetszuschlag: null,
        gesamtsteuer: null, verwendete_rechner: null,
        fehler: 'keine Kennzahlen aus Textlayer extrahierbar',
      },
    };
  }

  // ─ Stufe 3+4: Einbetten + Matmul parallel mit Atom-Laden ─
  const t3 = performance.now();
  const t3a = performance.now();
  const anfragen = kennzahlen.map(k => schluessel_saeubern(String(k.schluessel)));
  const ms_saeubern = performance.now() - t3a;

  const t3b = performance.now();
  const [vektoren, atome] = await Promise.all([
    embedBatch(anfragen),
    atome_laden(),
  ]);
  const ms_embed_plus_atome = performance.now() - t3b;
  const ms_einbetten = performance.now() - t3;

  const t4 = performance.now();
  const treffer = await stufe1_treffer_holen(kennzahlen, vektoren, atome, belegkontext);
  const ms_stufe1 = performance.now() - t4;
  // TIER-D: capture sub-timings
  const stufe1_sub_freistehend = { ...stufe1_sub_timings };

  // ─ Stufe 5: kanonische Felder aufbauen ─
  const t5 = performance.now();
  const kanonische_felder: Record<string, any> = {};
  const kennzahlen_bericht: FreistehendeAntwort['kennzahlen'] = [];
  for (const t of treffer) {
    if (kennzahl_ignorieren(t.kennzahl, belegkontext)) continue;
    const top = t.top[0];
    const punktzahl = top?.punktzahl ?? 0;
    let stufe: 'hoch' | 'mittel' | 'niedrig';
    if (punktzahl >= SCHWELLE_HOCH) stufe = 'hoch';
    else if (punktzahl >= SCHWELLE_MITTEL) stufe = 'mittel';
    else stufe = 'niedrig';

    kennzahlen_bericht.push({
      schluessel: t.kennzahl.schluessel,
      wert: t.kennzahl.wert,
      bestes_ecode: top?.ecode ?? null,
      bestes_drucktext: top?.drucktext ?? null,
      bestes_anlage: top?.anlage ?? null,
      punktzahl,
      stufe,
    });

    if (stufe === 'hoch' && top?.ecode) {
      kanonische_felder[top.ecode] = t.kennzahl.wert;
    }
  }
  const ms_kanonisch = performance.now() - t5;

  // ─ Stufe 6: Lane-1 BMF ─
  const t6 = performance.now();
  const jahr = steuerjahr ?? new Date().getFullYear();
  const steuerergebnis = await lane1_aufrufen(jahr, kanonische_felder);
  const ms_lane1 = performance.now() - t6;

  return {
    ok: true,
    kind: 'einsekunde-freistehend-v1',
    dateiname,
    gesamt_millisek: performance.now() - t_start,
    belegkontext_klasse: belegkontext.klasse,
    belegklasse: belegkontext.docClass,
    stufen_millisek: {
      textlayer: ms_textlayer,
      kennzahlen_extrahieren: ms_kennzahlen,
      einbetten: ms_einbetten,
      stufe1_treffer: ms_stufe1,
      kanonisch_aufbauen: ms_kanonisch,
      lane1: ms_lane1,
    },
    // TIER-D detailed sub-timings (instrumentation; not part of stable API contract)
    detailed_timings: {
      stufe3_saeubern_ms: ms_saeubern,
      stufe3_embed_plus_atome_ms: ms_embed_plus_atome,
      stufe4_serialize_ms: stufe1_sub_freistehend.serialize_ms,
      stufe4_payload_bytes: stufe1_sub_freistehend.payload_bytes,
      stufe4_http_roundtrip_ms: stufe1_sub_freistehend.http_roundtrip_ms,
      stufe4_parse_ms: stufe1_sub_freistehend.parse_ms,
      stufe4_postproc_ms: stufe1_sub_freistehend.postproc_ms,
    } as any,
    textlayer: {
      seiten: seiten_count,
      zeichen: zeichen_count,
      hat_textlayer: hat_textlayer,
      vorschau: voller_text.slice(0, 280),
    },
    kennzahlen: kennzahlen_bericht,
    kanonische_felder,
    vorverarbeitung: null,
    steuerergebnis,
  };
}


async function pdf_seitenzahl(pdf_pfad: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync('pdfinfo', [pdf_pfad]);
    const m = String(stdout).match(/^Pages:\s+(\d+)/m);
    return m ? Number(m[1]) : 1;
  } catch {
    return 1;
  }
}

async function pdf_zu_pngs_rendern(pdf_pfad: string, job_id: string): Promise<{ dir: string; seiten: number; pngs: string[] }> {
  const seiten = Math.max(1, Math.min(await pdf_seitenzahl(pdf_pfad), MAX_COLD_OCR_PAGES));
  const dir = path.join(COLD_PREPROCESS_DIR, job_id);
  await fs.mkdir(dir, { recursive: true });
  const prefix = path.join(dir, 'page');
  await execFileAsync('pdftoppm', ['-png', '-f', '1', '-l', String(seiten), pdf_pfad, prefix]);
  const files = (await fs.readdir(dir))
    .filter((f) => /^page-\d+\.png$/i.test(f))
    .sort((a, b) => {
      const na = Number(a.match(/(\d+)/)?.[1] ?? 0);
      const nb = Number(b.match(/(\d+)/)?.[1] ?? 0);
      return na - nb;
    })
    .map((f) => path.join(dir, f));
  return { dir, seiten, pngs: files };
}

async function cold_ocr_pdf_ausfuehren(pdf_pfad: string, job_id: string): Promise<{ text: string; seiten: number; render_dir: string }> {
  const rendered = await pdf_zu_pngs_rendern(pdf_pfad, job_id);
  const texte: string[] = [];
  for (const png of rendered.pngs) {
    const bytes = await fs.readFile(png);
    const ocr = await mistral_ocr_aufrufen(bytes, 'image/png');
    if (ocr.text) texte.push(ocr.text);
  }
  return {
    text: texte.join('\n\n'),
    seiten: rendered.pngs.length || rendered.seiten,
    render_dir: rendered.dir,
  };
}

async function freistehend_aus_rohtext(
  voller_text: string,
  dateiname: string,
  steuerjahr: number | undefined,
  textlayer_meta: { seiten: number; zeichen: number; hat_textlayer: boolean; vorschau: string },
  ms_textlayer: number,
): Promise<FreistehendeAntwort> {
  const t_start = performance.now();
  const t2 = performance.now();
  const kennzahlen = kennzahlen_extrahieren(voller_text);
  const ms_kennzahlen = performance.now() - t2;
  const belegkontext = belegkontext_ermitteln(voller_text, kennzahlen, dateiname);

  if (kennzahlen.length === 0) {
    return {
      ok: true,
      kind: 'einsekunde-freistehend-v1',
      dateiname,
      gesamt_millisek: performance.now() - t_start,
      belegkontext_klasse: belegkontext.klasse,
      belegklasse: belegkontext.docClass,
      stufen_millisek: {
        textlayer: ms_textlayer, kennzahlen_extrahieren: ms_kennzahlen,
        einbetten: 0, stufe1_treffer: 0, kanonisch_aufbauen: 0, lane1: 0,
      },
      textlayer: textlayer_meta,
      kennzahlen: [],
      kanonische_felder: {},
      vorverarbeitung: vorverarbeitung_hinweis(belegkontext, textlayer_meta.hat_textlayer, textlayer_meta.zeichen),
      steuerergebnis: {
        zve: null, einkommensteuer: null, solidaritaetszuschlag: null,
        gesamtsteuer: null, verwendete_rechner: null,
        fehler: 'keine Kennzahlen aus Textlayer extrahierbar',
      },
    };
  }

  const t3 = performance.now();
  const anfragen = kennzahlen.map(k => schluessel_saeubern(String(k.schluessel)));
  const [vektoren, atome] = await Promise.all([embedBatch(anfragen), atome_laden()]);
  const ms_einbetten = performance.now() - t3;

  const t4 = performance.now();
  const treffer = await stufe1_treffer_holen(kennzahlen, vektoren, atome, belegkontext);
  const ms_stufe1 = performance.now() - t4;

  const t5 = performance.now();
  const kanonische_felder: Record<string, any> = {};
  const kennzahlen_bericht: FreistehendeAntwort['kennzahlen'] = [];
  for (const t of treffer) {
    if (kennzahl_ignorieren(t.kennzahl, belegkontext)) continue;
    const top = t.top[0];
    const punktzahl = top?.punktzahl ?? 0;
    let stufe: 'hoch' | 'mittel' | 'niedrig';
    if (punktzahl >= SCHWELLE_HOCH) stufe = 'hoch';
    else if (punktzahl >= SCHWELLE_MITTEL) stufe = 'mittel';
    else stufe = 'niedrig';
    kennzahlen_bericht.push({
      schluessel: t.kennzahl.schluessel,
      wert: t.kennzahl.wert,
      bestes_ecode: top?.ecode ?? null,
      bestes_drucktext: top?.drucktext ?? null,
      bestes_anlage: top?.anlage ?? null,
      punktzahl,
      stufe,
    });
    if (stufe === 'hoch' && top?.ecode) kanonische_felder[top.ecode] = t.kennzahl.wert;
  }
  const ms_kanonisch = performance.now() - t5;

  const t6 = performance.now();
  const jahr = steuerjahr ?? new Date().getFullYear();
  const steuerergebnis = await lane1_aufrufen(jahr, kanonische_felder);
  const ms_lane1 = performance.now() - t6;

  return {
    ok: true,
    kind: 'einsekunde-freistehend-v1',
    dateiname,
    gesamt_millisek: performance.now() - t_start,
    belegkontext_klasse: belegkontext.klasse,
    belegklasse: belegkontext.docClass,
    stufen_millisek: {
      textlayer: ms_textlayer,
      kennzahlen_extrahieren: ms_kennzahlen,
      einbetten: ms_einbetten,
      stufe1_treffer: ms_stufe1,
      kanonisch_aufbauen: ms_kanonisch,
      lane1: ms_lane1,
    },
    textlayer: textlayer_meta,
    kennzahlen: kennzahlen_bericht,
    kanonische_felder,
    vorverarbeitung: null,
    steuerergebnis,
    belegkontext_klasse: belegkontext.klasse,
    belegklasse: belegkontext.docClass,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Mega-Case Profil (in-memory, TTL 1h, MVP)
// ═══════════════════════════════════════════════════════════════════
//
// Konzept: Bei einem Lohnsteuerbescheinigungs- / ESt-Bescheid-Upload wird
// EIN "Profil" angelegt das die kanonischen Felder + ESt-Basis-Berechnung
// enthält. Folgende Belege (Spendenquittung, Handwerkerrechnung, …) werden
// gegen dieses Profil PATCHED und zeigen direkt die ESt-Differenz. Da
// Atome / Mapping bereits im Hot-Path sind und das Profil im RAM liegt,
// brauchen Folge-Belege < 50ms (ohne OCR; OCR addiert ~1s wenn JPG).
//
// Persistenz: für jetzt nur Memory + TTL. Spaeter → SQLite/Redis.
//

interface MegaCaseProfil {
  profil_id: string;
  steuerjahr: number;
  erstellt_ms: number;
  basis_beleg_dateiname: string;
  basis_beleg_klasse: BelegKontext['klasse'];
  kanonische_felder: Record<string, number | string>;
  kanonische_felder_detail?: Array<{
    schluessel: string;
    ist_bmf_name: boolean;
    ecodes: string[];
    drucktext: string;
    anlage: string | null;
    wert: any;
  }>;
  rohe_kennzahlen?: Array<{
    schluessel: string;
    wert: any;
    bestes_ecode: string | null;
    bestes_drucktext: string | null;
    bestes_anlage: string | null;
    punktzahl: number;
    stufe: string;
    quelle_beleg: string;
  }>;
  ergebnis_basis: {
    zve?: number; einkommensteuer?: number;
    solidaritaetszuschlag?: number; gesamtsteuer?: number;
    verwendete_rechner?: string[];
  };
  belege: Array<{
    beleg_id: string;
    dateiname: string;
    klasse: BelegKontext['klasse'];
    patches: Record<string, number | string>;
    ergebnis_neu?: {
      zve?: number; einkommensteuer?: number;
      solidaritaetszuschlag?: number; gesamtsteuer?: number;
    };
    differenz?: {
      einkommensteuer_delta?: number;
      gesamtsteuer_delta?: number;
      kommentar?: string;
    };
    millisek: number;
  }>;
}


export interface ColdPreprocessStubAntwort {
  ok: boolean;
  kind: 'cold-preprocess-v1';
  job_id: string;
  status: 'queued_for_cold_preprocess' | 'hot_path_ready' | 'completed';
  dateiname: string;
  steuerjahr?: number;
  artefakt_pfad: string;
  belegklasse: string;
  belegkontext_klasse: 'lohnsteuer' | 'einkommensteuer' | 'kapital' | 'rente' | 'sonstiges';
  vorverarbeitung: VorverarbeitungHinweis | null;
  textlayer: { seiten: number; zeichen: number; hat_textlayer: boolean; vorschau: string };
  naechster_schritt: string;
  analyse?: FreistehendeAntwort | null;
}

function cold_job_id_erzeugen(): string {
  return 'cp_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export async function cold_preprocess_stub_freistehend(
  pdf_pfad: string,
  dateiname: string,
  steuerjahr?: number,
): Promise<ColdPreprocessStubAntwort> {
  const job_id = cold_job_id_erzeugen();
  await fs.mkdir(COLD_PREPROCESS_DIR, { recursive: true });
  const artefakt_pfad = path.join(COLD_PREPROCESS_DIR, `${job_id}.json`);

  let analyse = await einsekunde_pipeline_freistehend(pdf_pfad, dateiname, steuerjahr);
  let status: ColdPreprocessStubAntwort['status'] = analyse.vorverarbeitung?.noetig ? 'queued_for_cold_preprocess' : 'hot_path_ready';
  let render_dir: string | null = null;

  if (analyse.vorverarbeitung?.grund === 'scan_ohne_textlayer' && /\.pdf$/i.test(dateiname)) {
    try {
      const ocr = await cold_ocr_pdf_ausfuehren(pdf_pfad, job_id);
      render_dir = ocr.render_dir;
      analyse = await freistehend_aus_rohtext(
        ocr.text,
        dateiname,
        steuerjahr,
        {
          seiten: ocr.seiten,
          zeichen: ocr.text.length,
          hat_textlayer: true,
          vorschau: ocr.text.slice(0, 280),
        } as any,
        0,
      );
      status = 'completed';
    } catch (err) {
      status = 'queued_for_cold_preprocess';
      const e = err as Error;
      analyse = {
        ...analyse,
        vorverarbeitung: analyse.vorverarbeitung ? {
          ...analyse.vorverarbeitung,
          hinweis: `${analyse.vorverarbeitung.hinweis} OCR-Start fehlgeschlagen: ${e.message}`,
        } : analyse.vorverarbeitung,
      };
    }
  }

  const out: ColdPreprocessStubAntwort = {
    ok: true,
    kind: 'cold-preprocess-v1',
    job_id,
    status,
    dateiname,
    steuerjahr,
    artefakt_pfad,
    belegklasse: analyse.belegklasse ?? 'unbekannt',
    belegkontext_klasse: analyse.belegkontext_klasse ?? 'sonstiges',
    vorverarbeitung: analyse.vorverarbeitung ?? null,
    textlayer: analyse.textlayer,
    naechster_schritt: status === 'completed'
      ? 'OCR/Facts liegen vor; naechster Schritt ist Materialisierung ins Case-Fact-Layer bzw. audit-now.'
      : status === 'queued_for_cold_preprocess'
      ? 'Cold-Preprocess/OCR ausfuehren und strukturierte Facts materialisieren; danach audit-now.'
      : 'Hot-Path-faehig; direkt upload-1sek oder audit-now verwenden.',
    analyse,
  };
  await fs.writeFile(artefakt_pfad, JSON.stringify({ ...out, render_dir }, null, 2), 'utf-8');
  return out;
}

const PROFIL_CACHE = new Map<string, MegaCaseProfil>();
const PROFIL_TTL_MS = 60 * 60 * 1000; // 1 Stunde

function profil_id_erzeugen(): string {
  return 'mc_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function profil_gc(): void {
  const now = Date.now();
  for (const [id, p] of PROFIL_CACHE.entries()) {
    if (now - p.erstellt_ms > PROFIL_TTL_MS) PROFIL_CACHE.delete(id);
  }
}

export function megacase_profil_holen(profil_id: string): MegaCaseProfil | null {
  profil_gc();
  return PROFIL_CACHE.get(profil_id) ?? null;
}

export function megacase_profil_loeschen(profil_id: string): boolean {
  return PROFIL_CACHE.delete(profil_id);
}

export function megacase_alle_profile(): Array<{ profil_id: string; steuerjahr: number; erstellt_ms: number; basis_beleg_dateiname: string; belege_anzahl: number }> {
  profil_gc();
  return [...PROFIL_CACHE.values()].map(p => ({
    profil_id: p.profil_id,
    steuerjahr: p.steuerjahr,
    erstellt_ms: p.erstellt_ms,
    basis_beleg_dateiname: p.basis_beleg_dateiname,
    belege_anzahl: p.belege.length,
  }));
}

// Sub-Funktion: aus einer freistehend-Pipeline-Antwort die Patches ableiten
// → konvertiert ECodes (E0200203) in BMF-Param-Namen (bruttolohn) fuer Lesbarkeit
function patches_aus_pipeline_antwort(antwort: any): Record<string, number | string> {
  const kf = antwort?.kanonische_felder ?? {};
  const out: Record<string, number | string> = {};
  for (const [ecode, v] of Object.entries(kf)) {
    const bmf_name = ECODE_ZU_BMF[ecode];
    const key = bmf_name ?? ecode; // unbekannte ECodes bleiben als ECode drin (audit)
    if (typeof v === 'number' && !isNaN(v)) {
      if (typeof out[key] === 'number') {
        // Mehrere ECodes mappen auf denselben BMF-Namen → summieren
        out[key] = (out[key] as number) + v;
      } else {
        out[key] = v;
      }
    } else if (key === 'steuerklasse' && typeof v !== 'undefined') {
      out[key] = String(v);
    }
  }
  return out;
}


// Reverse: BMF-Name → liste der bekannten ECodes (für UI-Drill-Down)
const BMF_ZU_ECODES: Record<string, string[]> = (() => {
  const map: Record<string, string[]> = {};
  for (const [ecode, bmf] of Object.entries(ECODE_ZU_BMF)) {
    (map[bmf] ??= []).push(ecode);
  }
  return map;
})();


function drucktext_fuer_bmf_name(bmf_name: string): string {
  // Erst aus dem ersten gemappten ECode den Drucktext holen
  const ecodes = BMF_ZU_ECODES[bmf_name] ?? [];
  const cache = ecode_drucktext_laden();
  for (const ec of ecodes) {
    const entry = cache[ec];
    if (entry?.drucktext) return entry.drucktext;
  }
  return bmf_name; // Fallback: snake_case-Name
}

function felder_detail_aufbauen(kanonische_felder: Record<string, any>): Array<{
  schluessel: string;
  ist_bmf_name: boolean;
  ecodes: string[];
  drucktext: string;
  anlage: string | null;
  wert: any;
}> {
  const cache = ecode_drucktext_laden();
  return Object.entries(kanonische_felder).map(([k, v]) => {
    const ist_ecode = /^E[0-9]+$/.test(k);
    let drucktext: string;
    let anlage: string | null = null;
    let ecodes: string[];
    if (ist_ecode) {
      ecodes = [k];
      const entry = cache[k];
      drucktext = entry?.drucktext ?? 'Unbekannter ELSTER-Code';
      anlage = entry?.anlage ?? null;
    } else {
      ecodes = BMF_ZU_ECODES[k] ?? [];
      drucktext = drucktext_fuer_bmf_name(k);
      // Erste Anlage aus den gemappten ECodes
      for (const ec of ecodes) {
        if (cache[ec]?.anlage) { anlage = cache[ec].anlage; break; }
      }
    }
    return { schluessel: k, ist_bmf_name: !ist_ecode, ecodes, drucktext, anlage, wert: v };
  });
}

// Lane-1 Aufruf mit den kombinierten Profil-Feldern (nutzt existing lane1_aufrufen,
// das ECODE_ZU_BMF schon macht — wir geben den Profil-Felder-Dict direkt rein,
// die ECodes/BMF-Namen werden korrekt durchgereicht).
async function lane1_rechnen(
  felder: Record<string, number | string>,
  steuerjahr: number,
): Promise<MegaCaseProfil[ergebnis_basis]> {
  // felder kann jetzt schon BMF-Namen (bruttolohn) oder ECodes (E0xxxxxx) gemischt enthalten.
  // lane1_aufrufen ruft bmf_params_aus_ecodes() das nur ECodes mapped; BMF-Namen die
  // schon BMF-Namen sind landen via unbekannter ecode im out-dict, das ist OK weil
  // sie dann durch den finalen merge mit eingehen.
  // Wir bauen daher das parameters-dict hier direkt.
  const params: Record<string, any> = { steuerjahr };
  for (const [k, v] of Object.entries(felder)) {
    // ECode (E*) → durch ECODE_ZU_BMF mappen
    if (/^E[0-9]+$/.test(k)) {
      const bmf = ECODE_ZU_BMF[k];
      if (!bmf) continue; // unbekannter ECode ignorieren
      if (typeof v === 'number') {
        if (typeof params[bmf] === 'number') params[bmf] += v;
        else params[bmf] = v;
      } else if (bmf === 'steuerklasse') {
        params[bmf] = String(v);
      }
    } else {
      // schon BMF-Name → direkt uebernehmen
      if (typeof v === 'number') params[k] = v;
      else if (k === 'steuerklasse') params[k] = String(v);
    }
  }
  const hat_einkommen = (
    'bruttolohn' in params ||
    'renteneinkuenfte' in params ||
    'kapitalertraege' in params ||
    'freiberufliche_einkuenfte' in params
  );
  if (!hat_einkommen) return { verwendete_rechner: [] };

  try {
    const antwort = await fetch(LANE1_BMF_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parameters: params }),
    });
    if (!antwort.ok) return { verwendete_rechner: [] };
    const r = await antwort.json() as any;
    if (r?.fehler) return { verwendete_rechner: [] };
    const daten = r?.calculation_result?.daten ?? {};
    const orch = daten?.berechnungsdetails?.orchestrierung ?? {};
    return {
      zve: daten?.zve ?? r?.zve,
      einkommensteuer: daten?.einkommensteuer ?? r?.einkommensteuer,
      solidaritaetszuschlag: daten?.solidaritaetszuschlag ?? r?.solidaritaetszuschlag ?? 0,
      gesamtsteuer: daten?.gesamtsteuer ?? r?.gesamtsteuer,
      verwendete_rechner: orch?.verwendete_rechner ?? r?.verwendete_rechner ?? ['precision_layer'],
    };
  } catch {
    return { verwendete_rechner: [] };
  }
}

export async function megacase_profil_erstellen(
  pdf_pfad: string, dateiname: string, steuerjahr: number,
): Promise<{ ok: boolean; profil_id?: string; profil?: MegaCaseProfil; error?: string }> {
  // Erst-Upload: nutzt freistehend-Pipeline + persistiert Ergebnis als Profil
  const antwort = await einsekunde_pipeline_freistehend(pdf_pfad, dateiname, steuerjahr);
  if (!antwort.ok) return { ok: false, error: antwort.fehler ?? 'pipeline fehlgeschlagen' };

  const klasse = (antwort.belegkontext_klasse ?? 'sonstiges') as BelegKontext['klasse'];
  if (klasse !== 'lohnsteuer' && klasse !== 'einkommensteuer' && klasse !== 'rente') {
    return {
      ok: false,
      error: `Basis-Beleg muss Lohnsteuerbescheinigung, ESt-Bescheid oder Rentenbezugsmitteilung sein. Erkannt: ${klasse}.`,
    };
  }

  const profil: MegaCaseProfil = {
    profil_id: profil_id_erzeugen(),
    steuerjahr,
    erstellt_ms: Date.now(),
    basis_beleg_dateiname: dateiname,
    basis_beleg_klasse: klasse,
    kanonische_felder: patches_aus_pipeline_antwort(antwort),
    kanonische_felder_detail: felder_detail_aufbauen(patches_aus_pipeline_antwort(antwort)),
    rohe_kennzahlen: (antwort?.kennzahlen ?? []).map((k: any) => ({ ...k, quelle_beleg: dateiname })),
    ergebnis_basis: {
      zve: antwort.steuerergebnis?.zve,
      einkommensteuer: antwort.steuerergebnis?.einkommensteuer,
      solidaritaetszuschlag: antwort.steuerergebnis?.solidaritaetszuschlag,
      gesamtsteuer: antwort.steuerergebnis?.gesamtsteuer,
      verwendete_rechner: antwort.steuerergebnis?.verwendete_rechner,
    },
    belege: [],
  };
  PROFIL_CACHE.set(profil.profil_id, profil);
  return { ok: true, profil_id: profil.profil_id, profil };
}

export async function megacase_beleg_hinzufuegen(
  profil_id: string, pdf_pfad: string, dateiname: string,
): Promise<{ ok: boolean; profil?: MegaCaseProfil; beleg?: MegaCaseProfil['belege'][0]; error?: string; millisek?: number }> {
  const t_start = performance.now();
  const profil = PROFIL_CACHE.get(profil_id);
  if (!profil) return { ok: false, error: `Profil ${profil_id} nicht gefunden (TTL 1h)` };

  // Folge-Beleg: Pipeline ohne Lane-1 (wir rechnen Lane-1 EINMAL mit dem aktualisierten Profil)
  const antwort = await einsekunde_pipeline_freistehend(pdf_pfad, dateiname, profil.steuerjahr);
  if (!antwort.ok) return { ok: false, error: antwort.fehler ?? 'pipeline fehlgeschlagen' };

  const patches = patches_aus_pipeline_antwort(antwort);
  // Profil-Felder + Patches mergen (Patches additiv addieren wo sinnvoll, sonst ersetzen)
  const felder_neu = { ...profil.kanonische_felder };
  for (const [k, v] of Object.entries(patches)) {
    if (typeof v === 'number' && typeof felder_neu[k] === 'number') {
      // Additive Felder (Spenden, Werbungskosten, Sonderausgaben, Handwerker)
      if (/spenden|werbungskosten|sonderausgaben|handwerker|haushaltsnah|aussergewoehnlich/.test(k)) {
        felder_neu[k] = (felder_neu[k] as number) + (v as number);
      } else {
        // Ersetzen (z.B. Bruttolohn wenn neue Lohnsteuerbescheinigung)
        felder_neu[k] = v;
      }
    } else {
      felder_neu[k] = v;
    }
  }

  profil.kanonische_felder_detail = felder_detail_aufbauen(felder_neu);
  const neue_kennzahlen = (antwort?.kennzahlen ?? []).map((k: any) => ({ ...k, quelle_beleg: dateiname }));
  profil.rohe_kennzahlen = [...(profil.rohe_kennzahlen ?? []), ...neue_kennzahlen];
  const ergebnis_neu = await lane1_rechnen(felder_neu, profil.steuerjahr);
  const est_alt = profil.ergebnis_basis.einkommensteuer ?? 0;
  const est_neu = ergebnis_neu.einkommensteuer ?? est_alt;
  const gesamt_alt = profil.ergebnis_basis.gesamtsteuer ?? 0;
  const gesamt_neu = ergebnis_neu.gesamtsteuer ?? gesamt_alt;

  const millisek = performance.now() - t_start;
  const beleg = {
    beleg_id: 'b_' + Math.random().toString(36).slice(2, 8),
    dateiname,
    klasse: (antwort.belegkontext_klasse ?? 'sonstiges') as BelegKontext['klasse'],
    patches,
    ergebnis_neu: ergebnis_neu.einkommensteuer != null ? ergebnis_neu : undefined,
    differenz: ergebnis_neu.einkommensteuer != null ? {
      einkommensteuer_delta: est_neu - est_alt,
      gesamtsteuer_delta: gesamt_neu - gesamt_alt,
      kommentar: gesamt_neu < gesamt_alt
        ? `Steuerersparnis: ${(gesamt_alt - gesamt_neu).toFixed(2)} EUR`
        : gesamt_neu > gesamt_alt
        ? `Steuermehrbelastung: ${(gesamt_neu - gesamt_alt).toFixed(2)} EUR`
        : 'Keine Aenderung der Steuerlast',
    } : undefined,
    millisek,
  };

  profil.belege.push(beleg);
  // Profil mit neuen Feldern + neuem Ergebnis fortschreiben
  profil.kanonische_felder = felder_neu;
  if (ergebnis_neu.einkommensteuer != null) {
    profil.ergebnis_basis = ergebnis_neu;
  }
  return { ok: true, profil, beleg, millisek };
}

