/**
 * Beleg-API — ID- und Datei-Helfer.
 *
 * Die Beleg-ID ist content-adressiert + menschenlesbar:
 *   <bereinigter-basisname>__<sha8>
 * Gleiche Datei → gleiche ID → idempotente Ausgabe. Verschiedene Dateien mit
 * gleichem Namen → verschiedene sha8 → keine Kollision.
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { Quellart } from './typen.ts';

export function sha256hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Macht einen Dateinamen-Teil dateisystem- und URL-sicher. */
export function bereinige(s: string): string {
  return (
    s
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'beleg'
  );
}

/**
 * Berechnet die Beleg-ID. `vorgabe` erlaubt Aufrufern (z. B. HTTP-Header
 * `X-Beleg-Id`) eine eigene Korrelations-ID statt des Basisnamens.
 */
export function belegId(buf: Buffer, originalname: string, vorgabe?: string): string {
  const sha8 = sha256hex(buf).slice(0, 8);
  const basis = vorgabe ? bereinige(vorgabe) : bereinige(path.basename(originalname, path.extname(originalname)));
  // Idempotenz: heißt die Datei bereits `<x>__<sha8>` (z. B. weil das HTTP-Intake
  // sie so abgelegt hat), nicht erneut anhängen — sonst doppeltes Suffix.
  if (basis.endsWith(`__${sha8}`)) return basis;
  return `${basis}__${sha8}`;
}

const BILD = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const TEXT = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml',
  '.html', '.htm', '.log', '.yaml', '.yml', '.ini', '.rtf',
]);
const BILD_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export interface QuellInfo {
  art: Quellart;
  mimeType: string;
  /** Nur bei art==='text': dekodierter Inhalt. */
  text?: string;
}

/**
 * Bestimmt Quellart + MIME aus Endung und Inhalt. Unbekannte Endungen werden
 * als Text versucht, sofern der Inhalt nicht binär aussieht (NUL-Bytes).
 * Liefert `null`, wenn die Datei nicht verarbeitbar ist.
 */
export function bestimmeQuelle(originalname: string, buf: Buffer): QuellInfo | null {
  const ext = path.extname(originalname).toLowerCase();
  if (ext === '.pdf') return { art: 'pdf', mimeType: 'application/pdf' };
  if (BILD.has(ext)) return { art: 'bild', mimeType: BILD_MIME[ext] };
  if (TEXT.has(ext)) return { art: 'text', mimeType: 'text/plain', text: buf.toString('utf-8') };

  // Unbekannte Endung: als Text versuchen, falls nicht offensichtlich binär.
  const probe = buf.subarray(0, 4096);
  const nul = probe.includes(0);
  if (!nul) return { art: 'text', mimeType: 'text/plain', text: buf.toString('utf-8') };
  return null;
}
