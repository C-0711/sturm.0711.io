import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(HERE, '..', 'data');

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

let katalogCache: AnlagenKatalog | null = null;
const felderCache = new Map<string, FelderSchema>();

export async function loadKatalog(): Promise<AnlagenKatalog> {
  if (!katalogCache) {
    const raw = await readFile(join(DATA_ROOT, 'anlagen.json'), 'utf-8');
    katalogCache = JSON.parse(raw) as AnlagenKatalog;
  }
  return katalogCache;
}

export async function loadFelder(anlage: string): Promise<FelderSchema> {
  const cached = felderCache.get(anlage);
  if (cached) return cached;
  const raw = await readFile(
    join(DATA_ROOT, 'felder', `${anlage}.json`),
    'utf-8',
  );
  const parsed = JSON.parse(raw) as FelderSchema;
  felderCache.set(anlage, parsed);
  return parsed;
}
