/**
 * Beleg-API — Ausgabe-Schreiber (per Fall).
 *
 * Pro Fall ein Unterordner. Schreibt `ausgang/<Fall>/<id>.json` (BelegResult)
 * + `ausgang/<Fall>/<id>.md` (Transkription) atomar (tmp + rename) und räumt
 * das Original nach archiv/ bzw. fehler/<Fall>/ weg.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BelegConfig } from './config.ts';
import { BelegResult } from './typen.ts';

/** Dateisystem-sicherer Ordnername für einen Fall ("Fall 1" → "Fall_1"). */
export function fallSlug(fall: string): string {
  return (fall || 'Fall').normalize('NFKD').replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'Fall';
}
export function ausgangDirFuer(c: BelegConfig, fall: string): string {
  return path.join(c.ausgang, fallSlug(fall));
}
function fehlerDirFuer(c: BelegConfig, fall: string): string {
  return path.join(c.fehler, fallSlug(fall));
}

async function schreibeAtomar(ziel: string, inhalt: string | Buffer): Promise<void> {
  const tmp = `${ziel}.${process.pid}.tmp`;
  await fs.writeFile(tmp, inhalt);
  await fs.rename(tmp, ziel);
}

function frontmatter(r: BelegResult): string {
  const z = (v: unknown) => JSON.stringify(v ?? '');
  const typen = [...new Set(r.dokumente.map((d) => d.dokument_typ))].join(', ');
  return [
    '---',
    `id: ${z(r.id)}`,
    `fall: ${z(r.fall)}`,
    `dateiname: ${z(r.dateiname)}`,
    `modus: ${z(r.modus)}`,
    `dokumenttypen: ${z(typen)}`,
    `anzahl_werte: ${r.kpi.anzahl_werte}`,
    `sha256: ${z(r.sha256)}`,
    `engine: ${z(r.verarbeitung.engine)}`,
    `erstellt: ${z(r.verarbeitung.erstellt)}`,
    '---',
    '',
  ].join('\n');
}

async function verschiebe(quelle: string, ziel: string): Promise<void> {
  try {
    await fs.rename(quelle, ziel);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    await fs.copyFile(quelle, ziel);
    await fs.unlink(quelle);
  }
}

/** Schreibt BelegResult-JSON + Markdown in ausgang/<Fall>/, räumt Original weg. */
export async function schreibeErfolg(
  c: BelegConfig,
  result: BelegResult,
  markdown: string,
  originalPfad: string,
): Promise<{ json: string; md: string }> {
  const dir = ausgangDirFuer(c, result.fall);
  await fs.mkdir(dir, { recursive: true });
  const jsonPfad = path.join(dir, `${result.id}.json`);
  const mdPfad = path.join(dir, `${result.id}.md`);

  // Markdown zuerst → eine fertige .json referenziert eine bereits vorhandene .md.
  await schreibeAtomar(mdPfad, frontmatter(result) + markdown + '\n');
  await schreibeAtomar(jsonPfad, JSON.stringify(result, null, 2) + '\n');

  if (!c.archivieren) {
    await fs.unlink(originalPfad).catch(() => {});
  } else {
    await fs.mkdir(c.archiv, { recursive: true });
    await verschiebe(originalPfad, path.join(c.archiv, `${result.id}${path.extname(originalPfad)}`)).catch(() => {});
  }
  return { json: jsonPfad, md: mdPfad };
}

/** Schreibt Original + Diagnose nach fehler/<Fall>/. */
export async function schreibeFehler(
  c: BelegConfig,
  fall: string,
  id: string,
  originalname: string,
  originalPfad: string,
  fehler: { code: string; message: string },
): Promise<void> {
  const dir = fehlerDirFuer(c, fall);
  await fs.mkdir(dir, { recursive: true });
  await verschiebe(originalPfad, path.join(dir, `${id}${path.extname(originalname)}`)).catch(() => {});
  await schreibeAtomar(
    path.join(dir, `${id}.fehler.json`),
    JSON.stringify(
      { id, fall, originalname, code: fehler.code, message: fehler.message, zeitpunkt: new Date().toISOString() },
      null, 2,
    ) + '\n',
  );
}
