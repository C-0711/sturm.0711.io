import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(HERE, '..', 'data');

/**
 * Wenn ELSTER_CATALOG_PG_URL gesetzt ist, wird der Postgres-Adapter
 * (anlagen-katalog-pg.ts) als Quelle benutzt — sonst die JSON-Dateien in data/.
 * Schema-DDL + Loader: scripts/elster-catalog-db/
 */
const USE_PG = Boolean(process.env.ELSTER_CATALOG_PG_URL);

export interface AnlagenKatalog {
  vz: number;
  datenart: string;
  eric: string;
  generated: string;
  anlagen: Array<{
    name: string;
    maxLfdNrVordruck: number;
    pflicht: boolean;
    fieldCount: number;
  }>;
}

export interface FelderSchema {
  name: string;
  pflicht: boolean;
  felder: Array<{
    Kontext: string;
    Name: string;
    Beschreibung: string;
    maxZeilen: number | null;
    Format: string;
    FormatRegex: string;
    Formatkennzeichen: string;
    MinLaenge: number | null;
    MaxLaenge: number | null;
    Pflichtfeld: string;
    Vordruckzeile: string;
    Drucktext: string;
    InternesERiCFeld: string;
    pflicht: boolean;
  }>;
}

const katalogCache = new Map<number, AnlagenKatalog>();
const felderCache = new Map<string, FelderSchema>(); // key: `${vz}:${anlage}`
let currentVzCache: number | null = null;

/** Liefert die verfügbaren VZ, sortiert absteigend (neueste zuerst). */
export async function listVZ(): Promise<number[]> {
  if (USE_PG) {
    const { listVZ_PG } = await import('./anlagen-katalog-pg.ts');
    return listVZ_PG();
  }
  const entries = await readdir(DATA_ROOT, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && /^\d{4}$/.test(e.name))
    .map((e) => parseInt(e.name, 10))
    .sort((a, b) => b - a);
}

/** Default-VZ = höchster verfügbarer Ordner. */
export async function currentVZ(): Promise<number> {
  if (currentVzCache != null) return currentVzCache;
  const vzs = await listVZ();
  if (vzs.length === 0) {
    throw new Error(`Keine VZ-Unterordner in ${DATA_ROOT} gefunden`);
  }
  currentVzCache = vzs[0];
  return currentVzCache;
}


/**
 * Liefert das beste verfügbare VZ für die Anfrage:
 * - Wenn das angefragte VZ existiert, wird es zurückgegeben.
 * - Sonst wird das nächst-neuere VZ gewählt (d.h. 2023 → 2024, wenn nur 2024 da ist).
 *   ELSTER-eCodes sind historisch meist stabil, und neuere Kataloge enthalten
 *   alle Felder des Vorjahrs plus Erweiterungen.
 * Bei nur-älteren Jahren wird das älteste genommen.
 */
let resolvedVzWarned = new Set<string>();
export async function resolveVZ(vz?: number | string): Promise<number> {
  const vzs = await listVZ();
  if (vzs.length === 0) throw new Error(`Keine VZ-Ordner in ${DATA_ROOT}`);
  if (vz == null) return vzs[0];
  const target = Number(vz);
  if (!Number.isFinite(target)) {
    // eslint-disable-next-line no-console
    console.warn(`[anlagen-katalog] VZ-Parameter nicht auflösbar (${vz}), nehme neuestes VZ ${vzs[0]}`);
    return vzs[0];
  }
  if (vzs.includes(target)) return target;
  // Prefer next newer, then fallback to newest, then oldest
  const newer = vzs.filter((v) => v > target).sort((a, b) => a - b)[0];
  const picked = newer ?? vzs[0];
  const key = `${target}->${picked}`;
  if (!resolvedVzWarned.has(key)) {
    resolvedVzWarned.add(key);
    // eslint-disable-next-line no-console
    console.warn(`[anlagen-katalog] VZ ${target} nicht vorhanden, nutze VZ ${picked} als Fallback`);
  }
  return picked;
}

export async function loadKatalog(vz?: number | string): Promise<AnlagenKatalog> {
  const v = await resolveVZ(vz);
  const cached = katalogCache.get(v);
  if (cached) return cached;
  let parsed: AnlagenKatalog;
  if (USE_PG) {
    const { loadKatalog_PG } = await import('./anlagen-katalog-pg.ts');
    parsed = await loadKatalog_PG(v);
  } else {
    const raw = await readFile(join(DATA_ROOT, String(v), 'anlagen.json'), 'utf-8');
    parsed = JSON.parse(raw) as AnlagenKatalog;
  }
  katalogCache.set(v, parsed);
  return parsed;
}

export async function loadFelder(
  anlage: string,
  vz?: number | string,
): Promise<FelderSchema> {
  const v = await resolveVZ(vz);
  const key = `${v}:${anlage}`;
  const cached = felderCache.get(key);
  if (cached) return cached;
  let parsed: FelderSchema;
  if (USE_PG) {
    const { loadFelder_PG } = await import('./anlagen-katalog-pg.ts');
    parsed = await loadFelder_PG(anlage, v);
  } else {
    const raw = await readFile(
      join(DATA_ROOT, String(v), 'felder', `${anlage}.json`),
      'utf-8',
    );
    parsed = JSON.parse(raw) as FelderSchema;
  }
  felderCache.set(key, parsed);
  return parsed;
}
