/**
 * Beleg-API — Kurator-Cache (content-adressiert).
 *
 * Der teure Teil pro Beleg ist der Opus-Call (kuratiere → KuratorRoh). Kommt
 * derselbe Inhalt erneut (gleicher sha256 — z. B. dieselbe Datei in einem
 * anderen Fall), wird das Kurator-Ergebnis aus dem Cache bedient statt neu
 * berechnet. Die Katalog-Auflösung + Assemblierung läuft trotzdem frisch, damit
 * eine VOLLE Kopie (JSON + MD) mit korrektem Fall/Dateinamen im neuen Ordner
 * landet.
 *
 * Ablage: cache/kurator-<VERSION>/<sha256>.json. Die VERSION invalidiert den
 * Cache bei Prompt-/Schema-Änderungen (einfach hochzählen).
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BelegConfig } from './config.ts';
import { KuratorRoh } from './typen.ts';

const VERSION = 'v1';

function kuratorDir(c: BelegConfig): string {
  return path.join(c.cache, `kurator-${VERSION}`);
}
function pfad(c: BelegConfig, sha: string): string {
  return path.join(kuratorDir(c), `${sha}.json`);
}

/** Liefert das gecachte Kurator-Ergebnis oder null (Cache-Miss / defekt). */
export async function leseKuratorCache(c: BelegConfig, sha: string): Promise<KuratorRoh | null> {
  try {
    const roh = JSON.parse(await fs.readFile(pfad(c, sha), 'utf-8')) as KuratorRoh;
    return roh && Array.isArray(roh.dokumente) ? roh : null;
  } catch {
    return null;
  }
}

/** Schreibt das Kurator-Ergebnis atomar in den Cache. */
export async function schreibeKuratorCache(c: BelegConfig, sha: string, roh: KuratorRoh): Promise<void> {
  const dir = kuratorDir(c);
  await fs.mkdir(dir, { recursive: true });
  const ziel = pfad(c, sha);
  const tmp = `${ziel}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(roh));
  await fs.rename(tmp, ziel);
}
