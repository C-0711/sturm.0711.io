/**
 * Beleg-API — Prozessor.
 *
 * „Ein Beleg → BelegResult + Markdown". Liest die geclaimte Datei, lässt den
 * Kurator (Opus 4.8) sie lesen, löst jede Position gegen die ELSTER-SSoT auf,
 * bringt den Wert in die typgerechte Form und baut das `BelegResult`.
 * Wirft `BelegFehler`; der Aufrufer (index.ts) entscheidet über Erfolg/Fehler.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BelegConfig } from './config.ts';
import { kuratiere } from './opus-kurator.ts';
import { bestimmeQuelle, belegId, sha256hex } from './ids.ts';
import { ElsterKatalog } from './katalog.ts';
import { inferDatentyp, coerce } from './datentyp.ts';
import { leseKuratorCache, schreibeKuratorCache } from './cache.ts';
import {
  BelegFehler, BelegJob, BelegResult, Dokument, Kpi, KuratorDokumentRoh, KuratorPositionRoh,
  Modus, Position, Quellart,
} from './typen.ts';

export interface ProzessErgebnis {
  id: string;
  result: BelegResult;
  markdown: string;
}

function modusFuer(art: Quellart): Modus {
  return art === 'bild' ? 'bild' : art === 'pdf' ? 'scan-pdf' : 'text';
}

/** Löst eine Roh-Position gegen den Katalog auf + coerced den Wert. */
function bauePosition(
  roh: KuratorPositionRoh,
  dok: KuratorDokumentRoh,
  katalog: ElsterKatalog,
): Position {
  const rolle = roh.rolle ?? dok.rolle ?? undefined;
  const auf = katalog.aufloesen({
    bezeichnung: roh.bezeichnung,
    anlage: roh.anlage,
    zeile: roh.zeile,
    kennzahl: roh.kennzahl,
    rolle: rolle ?? null,
    jahr: dok.kalenderjahr ?? null,
  });
  const datentyp = inferDatentyp(roh.bezeichnung, roh.wert);
  const { wert, wert_code } = coerce(roh.wert, datentyp);

  return {
    bezeichnung: roh.bezeichnung,
    anlage: auf.anlage,
    zeile: auf.zeile,
    wert,
    e_code: auf.e_code,
    kennzahl: auf.kennzahl,
    datentyp,
    elster_kennziffer: auf.elster_kennziffer,
    aufgeloest: auf.aufgeloest,
    ...(auf.resolver_score !== undefined ? { resolver_score: auf.resolver_score } : {}),
    unsicher: auf.unsicher,
    ...(wert_code ? { wert_code } : {}),
    person: roh.person ?? dok.person ?? null,
    ...(rolle ? { rolle } : {}),
  };
}

export async function verarbeiteBeleg(
  c: BelegConfig,
  job: BelegJob,
  katalog: ElsterKatalog,
): Promise<ProzessErgebnis> {
  const buf = await fs.readFile(job.claimPfad);
  if (buf.length === 0) throw new BelegFehler('leer', 'Datei ist leer');
  if (buf.length > c.maxMb * 1024 * 1024) {
    throw new BelegFehler('zu_gross', `Datei größer als ${c.maxMb} MB (${buf.length} Bytes)`);
  }
  const quelle = bestimmeQuelle(job.originalname, buf);
  if (!quelle) {
    throw new BelegFehler('nicht_unterstuetzt', `Dateityp nicht verarbeitbar: ${path.extname(job.originalname) || '(ohne Endung)'}`);
  }

  const sha = sha256hex(buf);
  const id = belegId(buf, job.originalname);

  // Cache: gleicher Inhalt (sha256) → kein erneuter Opus-Call. Die Auflösung +
  // Assemblierung läuft trotzdem frisch, damit eine VOLLE Kopie (JSON + MD) mit
  // korrektem Fall/Dateinamen im neuen Ordner landet.
  let roh = c.cacheAktiv ? await leseKuratorCache(c, sha) : null;
  const ausCache = roh !== null;
  if (!roh) {
    roh = await kuratiere({ buf, quelle, apiKey: c.anthropicKey, modell: c.modell });
    if (c.cacheAktiv) await schreibeKuratorCache(c, sha, roh).catch(() => {});
  }

  // Dokumente + Positionen auflösen.
  const dokumente: Dokument[] = roh.dokumente.map((dok) => ({
    dokument_typ: dok.dokument_typ ?? 'unbekannt',
    aussteller: dok.aussteller ?? null,
    person: dok.person ?? null,
    kalenderjahr: dok.kalenderjahr ?? null,
    finanzamt: dok.finanzamt ?? null,
    ...(dok.rolle ? { rolle: dok.rolle } : {}),
    positionen: (dok.positionen ?? []).map((p) => bauePosition(p, dok, katalog)),
  }));

  // Flacher Spiegel ALLER Positionen, angereichert um Herkunft.
  const positionen: Position[] = [];
  for (const dok of dokumente) {
    for (const pos of dok.positionen) {
      positionen.push({
        ...pos,
        dokument_typ: dok.dokument_typ,
        aussteller: dok.aussteller,
        quelle: job.originalname,
      });
    }
  }

  const mitKennziffer = positionen.filter((p) => p.kennzahl.length > 0 || p.e_code).length;
  const unsicher = positionen.filter((p) => p.unsicher).length;
  const outTok = roh.usage?.output ?? 0;
  const kpi: Kpi = {
    anzahl_werte: positionen.length,
    mit_kennziffer: mitKennziffer,
    unsicher,
    total_ms: roh.ms,
    ...(!ausCache && outTok > 0 && roh.ms > 0 ? { tokens_pro_sek: Math.round((outTok / roh.ms) * 1000) } : {}),
    warnung: roh.warnung === true || unsicher > 0,
  };

  const result: BelegResult = {
    schema: 'beleg-result/v1',
    dateiname: job.originalname,
    status: 'ok',
    modus: modusFuer(quelle.art),
    fall: job.fall,
    id,
    sha256: sha,
    dokumente,
    positionen,
    kpi,
    markdownDatei: `${id}.md`,
    verarbeitung: {
      engine: 'Kurator',
      ms: roh.ms,
      usage: roh.usage,
      erstellt: new Date().toISOString(),
      ...(ausCache ? { ausCache: true } : {}),
    },
  };

  return { id, result, markdown: roh.markdown };
}
