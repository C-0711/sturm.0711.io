/**
 * pipeline-orchestrator — das 5-Phasen-Modell (Königsweg).
 *
 * Entkoppelt die volatile „alles-in-einem-Rutsch"-Extraktion in saubere,
 * sequenzielle Phasen mit je EINER Verantwortung. Verkettet ausschließlich die
 * bereits VERIFIZIERTEN Bausteine — kein Rewrite:
 *
 *   P1 Normalisierte RAW-Extraktion  digital→pdftotext · Scan→lighton-OCR
 *                                    → einheitliches NormalisiertesRawDokument
 *   P2 Klassifizierung               detectBelegTyp (deterministisch) +
 *                                    Gemma-Fallback bei Unbekannt/Scan
 *   P3 Identitäts-Bootstrap          Stammdaten/IdNr → Household (Person A/B)
 *   P4 Deterministischer VaSt-Express mapBeleg je strukturiertem Beleg (100%,
 *                                    kein KI-Risiko), Person via IdNr
 *   P5 Profil-limitierte Kaskade     Gemma-Extraktion (extrahiereScanWerte) für
 *                                    den unstrukturierten Rest; Suchraum durch
 *                                    die schon belegten Anlagen eingegrenzt
 *
 * Läuft ALONGSIDE runSteuerfall — Cutover erst nach Ground-Truth-Verifikation.
 * Die Konsolidierung (harmonize/Dedup/KV-Priorität) + der Calc bleiben der
 * bestehende, verifizierte Pfad; der Orchestrator liefert die felder dafür.
 */
import { execFileSync } from 'node:child_process';
import { basename, extname } from 'node:path';
import { ocrLighton } from './ocr-lighton.ts';
import { detectBelegTyp, mapBeleg } from '../src/workflows/elster/lib/field-mapper/mapper.ts';
import type { BelegTyp, Person } from '../src/workflows/elster/lib/field-mapper/types.ts';
import { klassifiziereBeleg, type BelegKlassifikation } from './klassifiziere-beleg.ts';
import { extrahiereScanWerte } from './extrahiere-scan-werte.ts';
import type { SteuerFeld } from '../src/workflows/elster/lib/steuer/adapter.ts';
import type { Household } from './mastercase-harmonize.ts';

// ── Phase-1-Ausgabe: einheitliches Roh-Schema je Beleg ──────────────────
export interface NormalisiertesRawDokument {
  id: string;
  quellDatei: string;
  rawText: string;
  /** Key-Value-Paare aus Markdown-Tabellen (Scans); leer für Digital-PDFs. */
  tabellen: Array<Array<[string, string]>>;
  metadaten: { veranlagungszeitraum?: number; transferticket?: string };
  istScan: boolean;
}
export interface KlassifizierterBeleg extends NormalisiertesRawDokument {
  belegTyp: BelegTyp;
  /** Gemma-Anreicherung (einkunftsart, VZ, …) — nur bei Unbekannt/Scan. */
  gemma?: BelegKlassifikation | null;
}
export interface PipelineErgebnis {
  raw: NormalisiertesRawDokument[];
  belege: KlassifizierterBeleg[];
  identitaet: Household;
  felder: SteuerFeld[];
  belegteAnlagen: string[];
  phasen: Record<string, unknown>;
}

const IMG = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.gif']);
const digits = (s: string): string => (s || '').replace(/\D/g, '');
const de = (n: number): string => n.toFixed(2).replace('.', ',');

/** Pipe-Markdown-Tabellen → [erste Spalte, letzte Spalte]-Paare (best-effort). */
function markdownTabellen(md: string): Array<Array<[string, string]>> {
  const out: Array<Array<[string, string]>> = [];
  let cur: Array<[string, string]> = [];
  for (const line of md.split('\n')) {
    if (line.includes('|') && !/^[\s|:\-]+$/.test(line)) {
      const cells = line.split('|').map((c) => c.trim()).filter((c) => c.length);
      if (cells.length >= 2) { cur.push([cells[0], cells[cells.length - 1]]); continue; }
    }
    if (cur.length) { out.push(cur); cur = []; }
  }
  if (cur.length) out.push(cur);
  return out;
}

export class PipelineOrchestrator {
  // ── PHASE 1: Normalisierte RAW-Extraktion ──────────────────────────────
  async phase1Normalisieren(paths: string[]): Promise<NormalisiertesRawDokument[]> {
    const docs: NormalisiertesRawDokument[] = [];
    for (const p of paths) {
      let rawText = '';
      let istScan = false;
      if (!IMG.has(extname(p).toLowerCase())) {
        try { rawText = execFileSync('pdftotext', ['-layout', p, '-'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }); } catch { /* */ }
      }
      if (rawText.trim().length < 200) {
        try { rawText = await ocrLighton(p); istScan = true; } catch { /* */ }
      }
      const vz = rawText.match(/Veranlagungszeitraum[:\s]+(\d{4})/i);
      const tt = rawText.match(/Transferticket[:\s]+(\S+)/i);
      docs.push({
        id: basename(p),
        quellDatei: basename(p),
        rawText,
        tabellen: istScan ? markdownTabellen(rawText) : [],
        metadaten: { veranlagungszeitraum: vz ? Number(vz[1]) : undefined, transferticket: tt?.[1] },
        istScan,
      });
    }
    return docs;
  }

  // ── PHASE 2: Dokumenten-Klassifizierung ────────────────────────────────
  async phase2Klassifizieren(docs: NormalisiertesRawDokument[]): Promise<KlassifizierterBeleg[]> {
    const out: KlassifizierterBeleg[] = [];
    for (const d of docs) {
      const belegTyp = detectBelegTyp(d.rawText);
      // Deterministisch zuerst; Gemma nur als Fallback/Anreicherung bei
      // Unbekannt oder Scan (lighton-Markdown bricht die Regex-Klassifikation).
      const gemma = (belegTyp === 'Unbekannt' || d.istScan) ? await klassifiziereBeleg(d.rawText).catch(() => null) : null;
      out.push({ ...d, belegTyp, gemma });
    }
    return out;
  }

  // ── PHASE 3: Identitäts-Bootstrapping ──────────────────────────────────
  phase3IdentitaetBootstrap(belege: KlassifizierterBeleg[]): Household {
    // IdNr-Häufigkeit über alle Belege: häufigste = Person A, zweite = B.
    const count = new Map<string, number>();
    for (const b of belege) {
      for (const m of b.rawText.matchAll(/\b(\d{2}[ .]?\d{3}[ .]?\d{3}[ .]?\d{3})\b/g)) {
        const d = digits(m[1]); if (d.length === 11) count.set(d, (count.get(d) ?? 0) + 1);
      }
    }
    const ranked = [...count.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    const nameOf = (idnr: string): { vorname?: string; nachname?: string } => {
      for (const b of belege) {
        if (!digits(b.rawText).includes(idnr)) continue;
        const vn = b.rawText.match(/Vorname\s*[:|]?\s*([A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß \-]{1,38})/);
        const nn = b.rawText.match(/(?:Nachname|Familienname|^Name)\s*[:|]?\s*([A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß \-]{1,38})/m);
        if (vn || nn) return { vorname: vn?.[1]?.trim(), nachname: nn?.[1]?.trim() };
      }
      return {};
    };
    const hh: Household = {};
    if (ranked[0]) hh.personA = { idnr: ranked[0], ...nameOf(ranked[0]) };
    if (ranked[1]) hh.personB = { idnr: ranked[1], ...nameOf(ranked[1]) };
    return hh;
  }

  // ── PHASE 4: Deterministischer VaSt-Express (100% Treffer) ─────────────
  phase4VastExpress(belege: KlassifizierterBeleg[], ident: Household): SteuerFeld[] {
    const idA = digits(ident.personA?.idnr ?? '');
    const idB = digits(ident.personB?.idnr ?? '');
    const personOf = (b: KlassifizierterBeleg): Person => {
      const d = digits(b.rawText);
      if (idB && d.includes(idB) && (!idA || !d.includes(idA))) return 'B';
      return 'A';
    };
    const felder: SteuerFeld[] = [];
    for (const b of belege) {
      const strukturiert = b.belegTyp.startsWith('VaSt') || b.belegTyp === 'Steuerbescheinigung_Bank';
      if (!strukturiert || b.istScan) continue; // Scans → Phase 5 (Markdown ≠ Positionstext)
      try {
        const r = mapBeleg({ belegTyp: b.belegTyp, person: personOf(b), rawText: b.rawText, source: { pdfPath: b.quellDatei } });
        for (const f of r.felder) felder.push({ eCode: f.eCode, wert: f.wert, person: f.person, anlage: f.anlage, pdfLabel: f.pdfLabel });
      } catch { /* Beleg isoliert: ein Fehler kippt den Express nicht */ }
    }
    return felder;
  }

  // ── PHASE 5: Profil-limitierte Gemma/Vektor-Kaskade (Auffangnetz) ──────
  async phase5VektorKaskade(belege: KlassifizierterBeleg[]): Promise<SteuerFeld[]> {
    const felder: SteuerFeld[] = [];
    for (const b of belege) {
      // Nur den unstrukturierten Rest (Scans / Unbekannt), den Phase 4 NICHT
      // deterministisch erfassen konnte.
      if (!b.istScan && b.belegTyp !== 'Unbekannt') continue;
      const w = await extrahiereScanWerte(b.rawText).catch(() => null);
      if (!w) continue;
      if (w.haushaltsnahe_dienstleistung) felder.push({ eCode: 'E0107301', wert: de(w.haushaltsnahe_dienstleistung), person: 'A', anlage: 'HA', pdfLabel: 'haushaltsnahe Dienstleistungen §35a' });
      if (w.spende) felder.push({ eCode: 'E0108701', wert: de(w.spende), person: 'A', anlage: 'SA', pdfLabel: 'Spenden §10b' });
      if (w.darlehenszinsen) felder.push({ eCode: 'E1900701', wert: de(w.darlehenszinsen), person: 'A', anlage: 'KAP', pdfLabel: 'Kapitalerträge — Darlehnszinsen (§20)' });
    }
    return felder;
  }

  // ── Orchestrierung: die 5 Phasen sequenziell ───────────────────────────
  async run(paths: string[]): Promise<PipelineErgebnis> {
    const raw = await this.phase1Normalisieren(paths);
    const belege = await this.phase2Klassifizieren(raw);
    const identitaet = this.phase3IdentitaetBootstrap(belege);
    const vastFelder = this.phase4VastExpress(belege, identitaet);
    const belegteAnlagen = [...new Set(vastFelder.map((f) => f.anlage ?? '').filter(Boolean))];
    const restFelder = await this.phase5VektorKaskade(belege);
    const typen: Record<string, number> = {};
    for (const b of belege) typen[b.belegTyp] = (typen[b.belegTyp] ?? 0) + 1;
    return {
      raw, belege, identitaet, felder: [...vastFelder, ...restFelder], belegteAnlagen,
      phasen: { p1_dokumente: raw.length, p1_scans: raw.filter((d) => d.istScan).length, p2_typen: typen, p4_felder: vastFelder.length, p5_felder: restFelder.length },
    };
  }
}
