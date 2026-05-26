/**
 * Postgres-Adapter für den Elster-Felder-Katalog.
 *
 * Liest aus dem Schema `elster.*` (siehe scripts/elster-catalog-db/schema.sql)
 * und liefert die exakt selbe Datenstruktur (`AnlagenKatalog`, `FelderSchema`)
 * zurück wie die JSON-basierte Variante. Damit ist `anlagen-katalog.ts` ein
 * dünner Router (DB wenn ELSTER_CATALOG_PG_URL gesetzt, sonst Dateisystem).
 *
 * Wird nur in anlagen-katalog.ts importiert — niemals direkt aus einer Stage.
 */
import pg from 'pg';
import type { AnlagenKatalog, FelderSchema } from './anlagen-katalog.ts';

const { Pool } = pg;

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (pool) return pool;
  const url = process.env.ELSTER_CATALOG_PG_URL;
  if (!url) {
    throw new Error(
      'ELSTER_CATALOG_PG_URL ist nicht gesetzt — Postgres-Adapter darf nicht aufgerufen werden',
    );
  }
  pool = new Pool({
    connectionString: url,
    max: 8,
    idleTimeoutMillis: 30_000,
    // TCP keep-alive: hält Connections warm zum lokalen Postgres so dass
    // Wiederbenutzung ohne Reconnect-Handshake erfolgt (~0.5ms gespart pro
    // Query). Effekt vor allem bei vielen Round-Trips, fast invisible
    // für ein-/zwei-Query-Runs.
    keepAlive: true,
    keepAliveInitialDelayMillis: 5_000,
  });
  pool.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[anlagen-katalog-pg] Pool-Error:', err.message);
  });
  return pool;
}

/** Optional: in Tests aufrufen, sonst überlebt der Pool den Prozess. */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** Liefert die im Postgres vorhandenen VZ-Jahre, neueste zuerst. */
export async function listVZ_PG(): Promise<number[]> {
  const { rows } = await getPool().query<{ vz: number }>(
    `SELECT vz FROM elster.vz ORDER BY vz DESC`,
  );
  return rows.map((r) => Number(r.vz));
}

export async function loadKatalog_PG(vz: number): Promise<AnlagenKatalog> {
  const client = await getPool().connect();
  try {
    const headRes = await client.query<{
      vz: number; datenart: string; eric_version: string | null;
      generated_at: Date | null;
    }>(
      `SELECT vz, datenart, eric_version, generated_at
         FROM elster.vz WHERE vz = $1`,
      [vz],
    );
    if (headRes.rowCount === 0) throw new Error(`VZ ${vz} nicht im Postgres-Katalog`);
    const head = headRes.rows[0];

    const anlagenRes = await client.query<{
      name: string; pflicht: boolean | null; max_lfd_nr: number | null;
      field_count: number | null;
    }>(
      `SELECT name, pflicht, max_lfd_nr, field_count
         FROM elster.anlage
        WHERE vz = $1
        ORDER BY name`,
      [vz],
    );

    return {
      vz: head.vz,
      datenart: head.datenart,
      eric: head.eric_version ?? '',
      generated: head.generated_at ? head.generated_at.toISOString() : '',
      anlagen: anlagenRes.rows.map((r) => ({
        name: r.name,
        maxLfdNrVordruck: r.max_lfd_nr ?? 1,
        pflicht: Boolean(r.pflicht),
        fieldCount: r.field_count ?? 0,
      })),
    };
  } finally {
    client.release();
  }
}

export async function loadFelder_PG(
  anlage: string,
  vz: number,
): Promise<FelderSchema> {
  const client = await getPool().connect();
  try {
    const anlageRes = await client.query<{ anlage_id: number; pflicht: boolean | null }>(
      `SELECT anlage_id, pflicht FROM elster.anlage WHERE vz = $1 AND name = $2`,
      [vz, anlage],
    );
    if (anlageRes.rowCount === 0) {
      throw new Error(`Anlage ${anlage} nicht im Postgres-Katalog (VZ ${vz})`);
    }
    const { anlage_id, pflicht } = anlageRes.rows[0];

    const felderRes = await client.query<{
      kontext: string | null;
      name: string;
      beschreibung: string | null;
      max_zeilen: number | null;
      format_label: string | null;
      format_regex: string | null;
      formatkennzeichen: string | null;
      min_laenge: number | null;
      max_laenge: number | null;
      pflichtfeld: boolean | null;
      vordruckzeile: string | null;
      drucktext: string | null;
      internes_eric: boolean | null;
    }>(
      `SELECT k.pfad                                            AS kontext,
              f.name                                            AS name,
              f.beschreibung,
              f.max_zeilen,
              f.format_label,
              f.format_regex,
              f.formatkennzeichen,
              f.min_laenge,
              f.max_laenge,
              f.pflichtfeld,
              f.vordruckzeile,
              f.drucktext,
              f.internes_eric
         FROM elster.feld f
         LEFT JOIN elster.kontext k ON k.kontext_id = f.kontext_id
        WHERE f.anlage_id = $1
        ORDER BY f.vordruckzeile NULLS LAST, f.name`,
      [anlage_id],
    );

    return {
      name: anlage,
      pflicht: Boolean(pflicht),
      felder: felderRes.rows.map((r) => ({
        // Kontext-Stripping: '/N/ArbL/LStB_1_5_Sum' -> 'ArbL/LStB_1_5_Sum'
        // damit es 1:1 mit dem JSON-Format übereinstimmt
        Kontext: (r.kontext ?? '').replace(new RegExp(`^/${anlage}/?`), ''),
        Name: r.name,
        Beschreibung: r.beschreibung ?? '',
        maxZeilen: r.max_zeilen,
        Format: r.format_label ?? '',
        FormatRegex: r.format_regex ?? '',
        Formatkennzeichen: r.formatkennzeichen ?? '',
        MinLaenge: r.min_laenge,
        MaxLaenge: r.max_laenge,
        Pflichtfeld: r.pflichtfeld ? 'Ja' : '',
        Vordruckzeile: r.vordruckzeile ?? '',
        Drucktext: r.drucktext ?? '',
        InternesERiCFeld: r.internes_eric ? 'Ja' : 'Nein',
        pflicht: r.pflichtfeld === true,
      })),
    };
  } finally {
    client.release();
  }
}
