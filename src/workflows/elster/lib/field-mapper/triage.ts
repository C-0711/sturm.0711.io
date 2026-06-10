/**
 * triage — Front-door für jeden eingehenden Beleg.
 *
 * Nimmt einen PDF-Pfad, klassifiziert den Beleg und routet ihn:
 *
 *   1. PDF-Text extrahieren (pdftotext -layout)
 *   2. Wenn zu wenig Text rauskommt → Lane 2 (OCR) flaggen, nicht hier machen
 *   3. Beleg-Typ aus Titel ableiten (re-use von mapper.ts::detectBelegTyp)
 *   4. Identifikationsnummer regex-matchen → optional gegen Household
 *      resolven um person A/B zu bestimmen
 *   5. Vorname/Nachname best-effort aus dem Text ziehen (für HiTL-Anzeige)
 *
 * NICHT-Ziel:
 *   • OCR aufrufen — die Triage entscheidet NUR, ob OCR nötig ist.
 *   • Werte-Mapping — das macht mapBeleg() im nächsten Schritt.
 *   • Person-Detection ohne Household — wenn der Caller keine IdNrs kennt,
 *     bleibt person='unknown'. Das ist OK, der Caller weist später zu.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { detectBelegTyp } from './mapper.ts';
import type { BelegTyp, Person } from './types.ts';

export interface PersonInfo {
  /** 11-stellige IdNr (ggf. mit oder ohne Leerzeichen — wir normalisieren). */
  idnr?: string;
  vorname?: string;
  nachname?: string;
}

export interface HouseholdInfo {
  personA?: PersonInfo;
  personB?: PersonInfo;
}

export type RenderMode =
  | 'text-extract'    // pdftotext liefert nutzbaren Text → Lane 1
  | 'ocr-required'    // image-only oder zu wenig Text → Lane 2
  | 'unsupported';    // PDF nicht lesbar (encrypted etc.) → Manual / Fail

export interface TriageDetected {
  idnr?: string;
  vorname?: string;
  nachname?: string;
  textChars: number;
  /** 1.0 wenn ein titlePattern matched, 0.0 wenn Beleg-Typ Unbekannt. */
  belegTypConfidence: number;
}

export interface TriageResult {
  pdfPath: string;
  pdfBytes: number;
  belegTyp: BelegTyp;
  person: Person | 'unknown';
  renderMode: RenderMode;
  detected: TriageDetected;
  /** Bei renderMode='text-extract': der raw text, sonst null. */
  rawText: string | null;
  warnings: string[];
}

export interface TriageOptions {
  /** Schwelle: textChars < dieser Wert → ocr-required (default 200). */
  minTextChars?: number;
  /** Bekanntes Household für Person-A/B-Auflösung. */
  household?: HouseholdInfo;
  /** Override pdftotext-Binary (default: 'pdftotext'). */
  pdftotextBin?: string;
}

/** Extrahiert Text aus PDF via poppler-utils. Liefert '' bei Fehler. */
function extractText(pdfPath: string, bin: string): { text: string; error?: string } {
  try {
    const text = execFileSync(bin, ['-layout', pdfPath, '-'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return { text };
  } catch (err) {
    return { text: '', error: (err as Error).message };
  }
}

/** 11-stellige IdNr im Text finden (mit oder ohne Spaces). */
function findIdNr(text: string): string | undefined {
  // Pattern: "Identifikationsnummer" + bis zu 80 chars + 11 digits (ggf. mit
  // Spaces). Fallback: irgendwo im ersten 1000 chars 11 zusammenhängende
  // Ziffern.
  const labelM = text.match(/Identifikationsnummer[\s:]*([0-9 ]{11,17})/i);
  if (labelM) {
    const digits = labelM[1].replace(/\s+/g, '');
    if (/^\d{11}$/.test(digits)) return digits;
  }
  const head = text.slice(0, 2000);
  const looseM = head.match(/\b(\d{2,3}\s?\d{3}\s?\d{3}\s?\d{2,3})\b/);
  if (looseM) {
    const digits = looseM[1].replace(/\s+/g, '');
    if (digits.length === 11) return digits;
  }
  return undefined;
}

/** Vorname/Nachname-Heuristik. */
function findName(text: string): { vorname?: string; nachname?: string } {
  // "Vorname    Hildburg" / "Vorname: Hildburg" / "Name    Haubrich-Koch"
  const vM = text.match(/\bVorname[:\s]+([A-ZÄÖÜ][\wÄÖÜäöüß-]+(?:\s[A-ZÄÖÜ][\wÄÖÜäöüß-]+){0,2})/);
  const nM = text.match(/\b(?:Nachname|Name)[:\s]+([A-ZÄÖÜ][\wÄÖÜäöüß-]+(?:[ -][A-ZÄÖÜ][\wÄÖÜäöüß-]+){0,2})/);
  return { vorname: vM?.[1]?.trim(), nachname: nM?.[1]?.trim() };
}

/** Matched IdNr/Name gegen Household → 'A' / 'B' / 'unknown'. */
function resolvePerson(
  detected: { idnr?: string; vorname?: string; nachname?: string },
  household: HouseholdInfo | undefined,
): Person | 'unknown' {
  if (!household) return 'unknown';
  const a = household.personA;
  const b = household.personB;
  // 1) IdNr-Match — exakt
  if (detected.idnr) {
    if (a?.idnr && a.idnr.replace(/\s+/g, '') === detected.idnr) return 'A';
    if (b?.idnr && b.idnr.replace(/\s+/g, '') === detected.idnr) return 'B';
  }
  // 2) Nachname-Match
  if (detected.nachname) {
    const dn = detected.nachname.toLowerCase();
    if (a?.nachname && a.nachname.toLowerCase() === dn) return 'A';
    if (b?.nachname && b.nachname.toLowerCase() === dn) return 'B';
  }
  // 3) Vorname-Match
  if (detected.vorname) {
    const dv = detected.vorname.toLowerCase();
    if (a?.vorname && a.vorname.toLowerCase() === dv) return 'A';
    if (b?.vorname && b.vorname.toLowerCase() === dv) return 'B';
  }
  return 'unknown';
}

/** Hauptfunktion. */
export function triageBeleg(pdfPath: string, opts: TriageOptions = {}): TriageResult {
  const warnings: string[] = [];
  const minTextChars = opts.minTextChars ?? 200;
  const pdftotextBin = opts.pdftotextBin ?? 'pdftotext';

  // ── Datei-Existenz / Größe ──────────────────────────────────────────
  if (!existsSync(pdfPath)) {
    return {
      pdfPath,
      pdfBytes: 0,
      belegTyp: 'Unbekannt',
      person: 'unknown',
      renderMode: 'unsupported',
      detected: { textChars: 0, belegTypConfidence: 0 },
      rawText: null,
      warnings: [`Datei nicht gefunden: ${pdfPath}`],
    };
  }
  const pdfBytes = statSync(pdfPath).size;

  // ── Text extrahieren ────────────────────────────────────────────────
  const { text, error } = extractText(pdfPath, pdftotextBin);
  if (error) {
    warnings.push(`pdftotext-Fehler: ${error}`);
  }
  const textChars = text.length;

  // ── Beleg-Typ erkennen ──────────────────────────────────────────────
  const belegTyp = textChars > 0 ? detectBelegTyp(text) : 'Unbekannt';
  const belegTypConfidence = belegTyp === 'Unbekannt' ? 0 : 1;

  // ── Identifikation extrahieren ──────────────────────────────────────
  const idnr = textChars > 0 ? findIdNr(text) : undefined;
  const { vorname, nachname } = textChars > 0 ? findName(text) : {};

  // ── Person resolven ─────────────────────────────────────────────────
  const person = resolvePerson({ idnr, vorname, nachname }, opts.household);
  if (person === 'unknown' && opts.household) {
    warnings.push(
      'Person-Routing fehlgeschlagen — IdNr/Name matcht weder Person A noch B im Household.',
    );
  }

  // ── Render-Modus entscheiden ────────────────────────────────────────
  let renderMode: RenderMode;
  if (pdfBytes === 0) {
    renderMode = 'unsupported';
  } else if (textChars >= minTextChars) {
    renderMode = 'text-extract';
  } else {
    renderMode = 'ocr-required';
    warnings.push(
      `Nur ${textChars} Zeichen aus pdftotext (Schwelle ${minTextChars}) — Lane 2 (OCR) nötig.`,
    );
  }

  // Belegtyp-Erkennung kommt nur bei genug Text in Frage; bei OCR-required
  // bleibt belegTyp evtl. 'Unbekannt' — das ist OK, der OCR-Service wird
  // später re-klassifizieren.
  if (belegTyp === 'Unbekannt' && renderMode === 'text-extract') {
    warnings.push(
      'Beleg-Typ konnte aus dem Titel nicht erkannt werden — Schema-Mapping nicht möglich.',
    );
  }

  return {
    pdfPath,
    pdfBytes,
    belegTyp,
    person,
    renderMode,
    detected: { idnr, vorname, nachname, textChars, belegTypConfidence },
    rawText: renderMode === 'text-extract' ? text : null,
    warnings,
  };
}

/** Batch-Variante: ein Verzeichnis durchgehen. */
export function triageDirectory(
  dir: string,
  opts: TriageOptions & { glob?: (filename: string) => boolean } = {},
): TriageResult[] {
  const accept = opts.glob ?? ((f: string) => f.toLowerCase().endsWith('.pdf'));
  const entries = readdirSync(dir).filter(accept);
  return entries.map((name) => triageBeleg(join(dir, name), opts));
}
