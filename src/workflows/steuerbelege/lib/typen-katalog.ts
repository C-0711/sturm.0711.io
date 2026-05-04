import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(HERE, '..', 'data');

export interface Dokumenttyp {
  id: string;
  label: string;
  /**
   * ELSTER-Anlagen, in die dieser Beleg einfließt. Leer = Beleg wird nur
   * als Dokumentation gesammelt, aber nicht in eCodes extrahiert
   * (z. B. Betriebsausgaben ohne EÜR).
   */
  anlagen: string[];
  patterns: string[];
  ecodeHintsProAnlage: Record<string, string[]>;
}

export interface DokumenttypenKatalog {
  version: number;
  beschreibung: string;
  typen: Dokumenttyp[];
}

let cache: DokumenttypenKatalog | null = null;

export async function loadDokumenttypen(): Promise<DokumenttypenKatalog> {
  if (!cache) {
    const raw = await readFile(join(DATA_ROOT, 'dokumenttypen.json'), 'utf-8');
    cache = JSON.parse(raw) as DokumenttypenKatalog;
  }
  return cache;
}
