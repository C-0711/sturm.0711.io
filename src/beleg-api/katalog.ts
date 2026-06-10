/**
 * Beleg-API — ELSTER-Katalog-Resolver (SSoT).
 *
 * Lädt die Kennzahlen-SSoT (elster_kennzahlen.json) und löst eine vom Kurator
 * gelesene Roh-Position deterministisch zu ELSTER-Feldern auf:
 *   (anlage, zeile)      → e_code + kennzahl + Katalog-Bezeichnung   (aufgeloest="zeile")
 *   (anlage, kennzahl)   → e_code                                    (aufgeloest="zeile")
 *   bezeichnung (fuzzy)  → e_code per Label-Match + resolver_score   (aufgeloest="label")
 *
 * Die SSoT bleibt die EINZIGE Wahrheit für e_codes (das, was im Spec
 * "SSoT 11111" heißt). Fehlt die Datei, degradiert der Resolver sauber
 * (e_code=null, unsicher=true) — der Daemon läuft trotzdem.
 */
import * as fs from 'node:fs';

interface KennzahlRecord {
  steuerjahr: number;
  anlage: string;
  kennzahl: string;
  bezeichnung: string;
  zeile: string;
  elster_code: string;
}

export interface PositionRoh {
  bezeichnung: string;
  anlage?: string | null;
  zeile?: string | null;
  kennzahl?: string | null;
  rolle?: 'A' | 'B' | null;
  jahr?: number | null;
}

export interface PositionAufloesung {
  e_code: string | null;
  kennzahl: string[];
  bezeichnung_katalog: string | null;
  anlage: string | null;          // Display, z. B. "Anlage KAP"
  zeile: string | null;           // Display, z. B. "Zeile 7"
  elster_kennziffer: string | null;
  aufgeloest: 'zeile' | 'label';
  resolver_score?: number;
  unsicher: boolean;
}

// ─── Normalisierung ──────────────────────────────────────────────────────

function normAnlage(a?: string | null): string {
  if (!a) return '';
  return a.replace(/^anlage\s+/i, '').trim().toUpperCase();
}
function normZeile(z?: string | null): string {
  if (!z) return '';
  return z.replace(/^zeile\s+/i, '').trim();
}
function displayAnlage(code: string): string {
  if (!code) return '';
  if (code.toUpperCase() === 'EST1A') return 'Hauptvordruck (ESt1A)';
  return `Anlage ${code}`;
}
const WORT = /[a-zäöüß0-9]+/gi;
function tokens(s: string): Set<string> {
  return new Set((s.toLowerCase().match(WORT) ?? []).filter((w) => w.length > 2));
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

// ─── Katalog ─────────────────────────────────────────────────────────────

export class ElsterKatalog {
  private records: KennzahlRecord[] = [];
  private byAnlageZeile = new Map<string, KennzahlRecord[]>();
  private byAnlageKennzahl = new Map<string, KennzahlRecord[]>();
  private byAnlage = new Map<string, KennzahlRecord[]>();
  readonly geladen: number;

  constructor(pfad: string) {
    this.records = ladeRecords(pfad);
    for (const r of this.records) {
      const a = r.anlage.toUpperCase();
      push(this.byAnlageZeile, `${a}|${r.zeile}`, r);
      push(this.byAnlageKennzahl, `${a}|${r.kennzahl}`, r);
      push(this.byAnlage, a, r);
    }
    this.geladen = this.records.length;
  }

  /** Distinkte Anlagen-Codes im Katalog (Diagnose). */
  anlagen(): string[] {
    return [...this.byAnlage.keys()].sort();
  }

  /** Löst eine Roh-Position auf. Wirft nie — liefert immer eine Auflösung. */
  aufloesen(p: PositionRoh): PositionAufloesung {
    const a = normAnlage(p.anlage);
    const z = normZeile(p.zeile);
    const k = (p.kennzahl ?? '').trim();

    // 1) Primär: (anlage, zeile)
    let cands = filterJahr(this.byAnlageZeile.get(`${a}|${z}`) ?? [], p.jahr);
    if (cands.length) return this.ausCandidates(cands, a, p, 'zeile');

    // 2) Sekundär: (anlage, kennzahl)
    if (k) {
      cands = filterJahr(this.byAnlageKennzahl.get(`${a}|${k}`) ?? [], p.jahr);
      if (cands.length) return this.ausCandidates(cands, a, p, 'zeile');
    }

    // 3) Fallback: Label-Match innerhalb der Anlage (oder global, wenn Anlage unbekannt)
    const pool = a && this.byAnlage.has(a) ? this.byAnlage.get(a)! : this.records;
    const ziel = tokens(p.bezeichnung);
    let best: KennzahlRecord | null = null;
    let bestScore = 0;
    for (const r of filterJahr(pool, p.jahr)) {
      const s = jaccard(ziel, tokens(r.bezeichnung));
      if (s > bestScore) { bestScore = s; best = r; }
    }
    if (best && bestScore >= 0.34) {
      const anlageCode = best.anlage.toUpperCase();
      const kennzahlen = [best.kennzahl];
      return {
        e_code: best.elster_code,
        kennzahl: kennzahlen,
        bezeichnung_katalog: best.bezeichnung,
        anlage: displayAnlage(anlageCode),
        zeile: best.zeile ? `Zeile ${best.zeile}` : null,
        elster_kennziffer: `${displayAnlage(anlageCode)} Zeile ${best.zeile} · Kz ${kennzahlen.join('/')}`,
        aufgeloest: 'label',
        resolver_score: Math.round(bestScore * 1000) / 1000,
        unsicher: bestScore < 0.5,
      };
    }

    // 4) Nichts gefunden
    return {
      e_code: null,
      kennzahl: k ? [k] : [],
      bezeichnung_katalog: null,
      anlage: a ? displayAnlage(a) : null,
      zeile: z ? `Zeile ${z}` : null,
      elster_kennziffer: null,
      aufgeloest: 'label',
      resolver_score: best ? Math.round(bestScore * 1000) / 1000 : 0,
      unsicher: true,
    };
  }

  /** Baut die Auflösung aus deterministischen Kandidaten (zeile/kennzahl). */
  private ausCandidates(
    cands: KennzahlRecord[],
    anlageCode: string,
    p: PositionRoh,
    aufgeloest: 'zeile',
  ): PositionAufloesung {
    // Distinkte Kennzahlen an dieser Zeile (z. B. ["210","410"] = Person A/B).
    const kennzahlen = [...new Set(cands.map((c) => c.kennzahl))];
    // e_code nach Person/Kennzahl wählen.
    let gewaehlt = cands[0];
    if (p.kennzahl) {
      const k = p.kennzahl.trim();
      gewaehlt = cands.find((c) => c.kennzahl === k) ?? gewaehlt;
    } else if (p.rolle === 'B' && cands.length > 1) {
      gewaehlt = cands[1];
    }
    const a = (anlageCode || gewaehlt.anlage).toUpperCase();
    return {
      e_code: gewaehlt.elster_code,
      kennzahl: kennzahlen,
      bezeichnung_katalog: gewaehlt.bezeichnung,
      anlage: displayAnlage(a),
      zeile: gewaehlt.zeile ? `Zeile ${gewaehlt.zeile}` : null,
      elster_kennziffer: `${displayAnlage(a)} Zeile ${gewaehlt.zeile} · Kz ${kennzahlen.join('/')}`,
      aufgeloest,
      unsicher: false,
    };
  }
}

function filterJahr(recs: KennzahlRecord[], jahr?: number | null): KennzahlRecord[] {
  if (!jahr) return recs;
  const m = recs.filter((r) => r.steuerjahr === jahr);
  return m.length ? m : recs; // SSoT-Dump kann jahr-lückenhaft sein → nicht leer fallen
}

function push<T>(m: Map<string, T[]>, key: string, v: T): void {
  const arr = m.get(key);
  if (arr) arr.push(v); else m.set(key, [v]);
}

function ladeRecords(pfad: string): KennzahlRecord[] {
  try {
    const raw = fs.readFileSync(pfad, 'utf-8');
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((r): r is KennzahlRecord =>
        r && typeof r === 'object' &&
        typeof (r as KennzahlRecord).anlage === 'string' &&
        typeof (r as KennzahlRecord).elster_code === 'string')
      .map((r) => ({
        steuerjahr: Number((r as KennzahlRecord).steuerjahr) || 0,
        anlage: String((r as KennzahlRecord).anlage),
        kennzahl: String((r as KennzahlRecord).kennzahl ?? ''),
        bezeichnung: String((r as KennzahlRecord).bezeichnung ?? ''),
        zeile: String((r as KennzahlRecord).zeile ?? ''),
        elster_code: String((r as KennzahlRecord).elster_code),
      }));
  } catch {
    return [];
  }
}
