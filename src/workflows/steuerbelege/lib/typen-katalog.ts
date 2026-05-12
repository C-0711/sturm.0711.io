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
   *
   * Einkunftsart-Information ist NICHT hier dupliziert — sie wird aus dem
   * elster quantum container abgeleitet (kontextPaths-Prefix der Atome
   * dieser Anlagen). Siehe src/lib/elster-catalog.ts → einkunftsartVonAtom.
   */
  anlagen: string[];
  /**
   * Bekannte Aliase für diesen Dokumenttyp (alte Schema-Namen, externe
   * Bezeichnungen aus Gold-Fixtures, BMF-Kürzel etc.). findDokumenttyp()
   * matcht über id ODER aliases. Hält den Katalog als Single-Source-of-Truth
   * statt verstreute Mapping-Tabellen in Skripten.
   */
  aliases?: string[];
  patterns: string[];
  ecodeHintsProAnlage: Record<string, string[]>;
}

export interface DokumenttypenKatalog {
  version: number;
  beschreibung: string;
  typen: Dokumenttyp[];
}

let cache: DokumenttypenKatalog | null = null;
let aliasIndex: Map<string, Dokumenttyp> | null = null;

function buildAliasIndex(katalog: DokumenttypenKatalog): Map<string, Dokumenttyp> {
  const idx = new Map<string, Dokumenttyp>();
  for (const t of katalog.typen) {
    idx.set(t.id, t);
    for (const a of t.aliases ?? []) {
      if (idx.has(a) && idx.get(a)!.id !== t.id) {
        throw new Error(
          `dokumenttypen.json: Alias "${a}" doppelt belegt (Konflikt zwischen "${idx.get(a)!.id}" und "${t.id}")`,
        );
      }
      idx.set(a, t);
    }
  }
  return idx;
}

export async function loadDokumenttypen(): Promise<DokumenttypenKatalog> {
  if (!cache) {
    const raw = await readFile(join(DATA_ROOT, 'dokumenttypen.json'), 'utf-8');
    cache = JSON.parse(raw) as DokumenttypenKatalog;
    aliasIndex = buildAliasIndex(cache);
  }
  return cache;
}

/**
 * Findet einen Dokumenttyp über id ODER alias. Single point of truth für
 * jegliche dokumenttyp_id-Auflösung — Skripte und Stages müssen keine
 * eigenen Alias-Maps mehr halten.
 */
export async function findDokumenttyp(idOrAlias: string): Promise<Dokumenttyp | undefined> {
  await loadDokumenttypen();
  return aliasIndex?.get(idOrAlias);
}

/** Synchron, vorausgesetzt loadDokumenttypen() lief vorher. */
export function findDokumenttypSync(idOrAlias: string): Dokumenttyp | undefined {
  if (!aliasIndex) {
    throw new Error('findDokumenttypSync: loadDokumenttypen() muss vorher ausgeführt werden');
  }
  return aliasIndex.get(idOrAlias);
}
