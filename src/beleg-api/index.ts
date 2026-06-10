/**
 * Beleg-API — Hintergrund-Daemon (ELSTER-Steuerbelege).
 *
 * Eigenständiger Prozess. Berührt die STURM-Engine NICHT (liest nur die
 * ELSTER-Kennzahlen-SSoT als Datei). Ablauf:
 *
 *   posteingang/<Fall>/datei  ─┐
 *   POST /beleg (X-Fall)      ─┴─▶ Wächter ─▶ Prozessor (Kurator/Opus 4.8 +
 *                                  Katalog-Resolver) ─▶ ausgang/<Fall>/<id>.json
 *                                  ─▶ Master-Case: ausgang/<Fall>/mastercase_<Fall>.json
 *
 * Start:  npm run beleg-api    (tsx src/beleg-api/index.ts)
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Server } from 'node:http';
import { alleOrdner, ladeConfig } from './config.ts';
import { startWache, WacheHandle } from './wache.ts';
import { baueHttpApp } from './http.ts';
import { verarbeiteBeleg } from './prozessor.ts';
import { schreibeErfolg, schreibeFehler } from './schreiber.ts';
import { schreibeMasterCase } from './mastercase.ts';
import { ElsterKatalog } from './katalog.ts';
import { belegId, bereinige } from './ids.ts';
import { BelegFehler, BelegJob } from './typen.ts';

async function main(): Promise<void> {
  const c = ladeConfig();

  if (!c.anthropicKey) {
    console.error('[beleg] FATAL: ANTHROPIC_API_KEY ist nicht gesetzt — der Kurator kann nicht arbeiten.');
    process.exit(1);
  }

  for (const dir of alleOrdner(c)) await fs.mkdir(dir, { recursive: true });

  const katalog = new ElsterKatalog(c.kennzahlenPfad);
  if (katalog.geladen === 0) {
    console.warn(`[beleg] WARNUNG: ELSTER-SSoT leer/nicht gefunden (${c.kennzahlenPfad}) — e_codes bleiben unaufgelöst.`);
  }

  // Ein Beleg von Anfang bis Ende. Wirft nie nach außen; Fehler landen in fehler/.
  const verarbeite = async (job: BelegJob): Promise<void> => {
    const claimDir = path.dirname(job.claimPfad);
    try {
      const { id, result, markdown } = await verarbeiteBeleg(c, job, katalog);
      const { json } = await schreibeErfolg(c, result, markdown, job.claimPfad);
      const marker = result.verarbeitung.ausCache ? '↺ cache' : '✓';
      console.log(
        `[beleg] ${marker} ${id} [${job.fall}] ${result.dokumente.length} Dok / ${result.kpi.anzahl_werte} Werte ` +
        `(${result.kpi.mit_kennziffer} m. Kz, ${result.kpi.unsicher} unsicher, ${result.verarbeitung.ms}ms) → ${path.basename(json)}`,
      );
      if (c.mastercaseAuto) {
        const mc = await schreibeMasterCase(c, job.fall).catch((e) => {
          console.error(`[beleg] master-case ${job.fall} fehlgeschlagen: ${(e as Error).message}`);
          return null;
        });
        if (mc) {
          const m = mc.mastercase;
          console.log(
            `[beleg] ⊕ master [${job.fall}]: ${Object.keys(m.jahre).length} Jahr(e), ` +
            `${m.vergleich.length} Änderungen, ${m.fehlende_belege.length} fehlende → ${path.basename(mc.datei)}`,
          );
        }
      }
    } catch (e) {
      const code = e instanceof BelegFehler ? e.code : 'unbekannt';
      const message = (e as Error).message;
      const id = await besteId(job);
      await schreibeFehler(c, job.fall, id, job.originalname, job.claimPfad, { code, message }).catch((w) =>
        console.error(`[beleg] konnte Fehler nicht persistieren: ${(w as Error).message}`),
      );
      console.error(`[beleg] ✗ [${job.fall}] ${job.originalname}: ${code} — ${message}`);
    } finally {
      await fs.rm(claimDir, { recursive: true, force: true }).catch(() => {});
    }
  };

  const wache: WacheHandle = startWache(c, verarbeite);

  let server: Server | undefined;
  if (c.httpAktiv) {
    server = baueHttpApp(c).listen(c.port, () => {
      console.log(`[beleg] HTTP-Intake auf :${c.port}  (POST /beleg, GET /beleg/:id, GET /mastercase?fall=…, GET /health)`);
    });
  }

  banner(c, katalog.geladen);

  const herunterfahren = (sig: string) => {
    console.log(`[beleg] ${sig} — fahre herunter …`);
    wache.stop();
    if (server) server.close();
    setTimeout(() => process.exit(0), 200).unref();
  };
  process.on('SIGINT', () => herunterfahren('SIGINT'));
  process.on('SIGTERM', () => herunterfahren('SIGTERM'));
}

/** Best-effort-ID für die Fehlerablage: aus Inhalt hashen, sonst aus Namen. */
async function besteId(job: BelegJob): Promise<string> {
  try {
    const buf = await fs.readFile(job.claimPfad);
    return belegId(buf, job.originalname);
  } catch {
    return bereinige(path.basename(job.originalname, path.extname(job.originalname)));
  }
}

function banner(c: ReturnType<typeof ladeConfig>, ssotN: number): void {
  console.log('[beleg] ──────────────────────────────────────────────');
  console.log('[beleg] Beleg-API läuft (Hintergrund-Daemon, ELSTER)');
  console.log(`[beleg]   posteingang : ${c.posteingang}   (Unterordner = Fall)`);
  console.log(`[beleg]   ausgang     : ${c.ausgang}  ← hier lauschen (<Fall>/<id>.json + mastercase_<Fall>.json)`);
  console.log(`[beleg]   fehler      : ${c.fehler}`);
  console.log(`[beleg]   SSoT        : ${ssotN} Kennzahlen geladen`);
  console.log(`[beleg]   parallel=${c.parallel}  poll=${c.pollMs}ms  maxMb=${c.maxMb}  defaultFall="${c.defaultFall}"  masterAuto=${c.mastercaseAuto}  cache=${c.cacheAktiv}`);
  console.log(`[beleg]   engine=Kurator  http=${c.httpAktiv ? `:${c.port}` : 'aus'}  auth=${c.token ? 'an' : 'offen'}`);
  console.log('[beleg] ──────────────────────────────────────────────');
}

main().catch((e) => {
  console.error('[beleg] FATAL beim Start:', e);
  process.exit(1);
});
