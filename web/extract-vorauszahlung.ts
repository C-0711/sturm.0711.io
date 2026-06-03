/**
 * web/extract-vorauszahlung — deterministischer Parser für die ELSTER-
 * „Steuerkontoabfrage" (Ergebnis_Steuerkontoabfrage.pdf).
 *
 * Liest die GELEISTETEN Vorauszahlungen des Veranlagungsjahres je Steuerart
 * (Einkommensteuer / Solidaritätszuschlag / Kirchensteuer) — nur die Quartals-
 * buchungen „X.Vj.<VZ>"; Vorjahres-Reste (Zeitraum = nacktes Jahr, z.B. „2023")
 * und Umbuchungen werden ausgeschlossen. Die Summe wird auf die festgesetzte
 * Steuer angerechnet (Anrechnung).
 *
 * KEIN Mock, KEINE Case-Werte: rein strukturelles Parsing über die ELSTER-Form
 * (Sektions-Überschrift + „X.Vj.JJJJ"-Zeilen). Gilt für jeden Mandanten.
 */
import { execFileSync } from 'node:child_process';
import { extname } from 'node:path';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.webp', '.bmp', '.gif']);

function pdfText(path: string): string {
  try {
    return execFileSync('pdftotext', ['-layout', path, '-'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch { return ''; }
}

/** Deutsche Zahl „1.112,00" / „-8,00" → number. */
function parseDe(s: string): number {
  const n = Number(String(s).trim().replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}
const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface Vorauszahlungen { est: number; solz: number; kist: number; summe: number; }

/**
 * Parst eine Steuerkontoabfrage. Liefert die VZ-Summen je Steuerart für `vz`,
 * oder `null`, wenn `path`/`text` keine Steuerkontoabfrage ist bzw. keine
 * Quartals-VZ des Jahres enthält.
 */
export function parseVorauszahlungen(path: string, vz: number, text?: string): Vorauszahlungen | null {
  const t = text ?? (IMAGE_EXT.has(extname(path).toLowerCase()) ? '' : pdfText(path));
  if (!t || !/Steuerkontoabfrage|Kontoabfrage/i.test(t)) return null;

  const sums: Record<'est' | 'solz' | 'kist', number> = { est: 0, solz: 0, kist: 0 };
  let art: 'est' | 'solz' | 'kist' | null = null;
  let matched = false;

  for (const line of t.split('\n')) {
    // Quartals-VZ-Zeile: „1.Vj.2024   10.03.2024   683,00   Lastschrifteinzug"
    const m = line.match(/^\s*\d\.Vj\.(\d{4})\s+\d{2}\.\d{2}\.\d{4}\s+(-?[\d.]+,\d{2})/);
    if (m) {
      if (art && m[1] === String(vz)) { sums[art] += parseDe(m[2]); matched = true; }
      continue;
    }
    // jede andere datierte Zeile (Vorjahres-Rest/Umbuchung) → nie Sektions-Header
    if (/\d{2}\.\d{2}\.\d{4}/.test(line)) continue;
    // Sektions-Überschriften (reiner Text, kein Datum)
    if (/^\s*Einkommensteuer\s*$/.test(line)) art = 'est';
    else if (/Solidarit[äa]tszuschlag/i.test(line)) art = 'solz';
    else if (/Kirchensteuer/i.test(line)) art = 'kist';
  }
  if (!matched) return null;

  const est = round2(sums.est), solz = round2(sums.solz), kist = round2(sums.kist);
  return { est, solz, kist, summe: round2(est + solz + kist) };
}
