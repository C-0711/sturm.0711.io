/**
 * Beleg-API — Konfiguration (env-getrieben).
 *
 * Vollständig eigenständig: liest NUR `BELEG_*`- und `ANTHROPIC_API_KEY`-Env,
 * berührt keine STURM-Server-/Application-Config. Alle Pfade landen
 * standardmäßig unter `<repo>/beleg-api-data/` und sind gitignored.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
/** Repo-Wurzel: src/beleg-api → src → repo. */
const REPO_ROOT = path.resolve(HIER, '..', '..');

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}
function int(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v == null || v.trim() === '') return fallback;
  return !['0', 'false', 'nein', 'off'].includes(v.trim().toLowerCase());
}

export interface BelegConfig {
  /** Basis-Verzeichnis aller Lauf-Ordner. */
  root: string;
  /** Drop-Ordner: hier landen neue Dateien (per Datei-Drop oder HTTP-Intake). */
  posteingang: string;
  /** Claim-Ordner: Datei in Bearbeitung (atomar hierher umbenannt = Lock). */
  verarbeitung: string;
  /** Ausgabe-Ordner: `<id>.json` + `<id>.md`. Die Firma lauscht hier. */
  ausgang: string;
  /** Fehler-Ordner: Original + `<id>.fehler.json`. */
  fehler: string;
  /** Archiv-Ordner: erfolgreich verarbeitete Originale (wenn archivieren=true). */
  archiv: string;

  /** Anthropic-Key für den Kurator. Pflicht. */
  anthropicKey: string;
  /** Modell-ID des Kurators (intern; im Log erscheint "Kurator"). */
  modell: string;
  /** Max. Dateigröße in MB (Anthropic-PDF-Limit: 32 MB). */
  maxMb: number;
  /** Wie viele Belege gleichzeitig kuratiert werden. */
  parallel: number;
  /** Poll-Intervall des Ordner-Wächters in ms. */
  pollMs: number;
  /** Original nach Erfolg ins Archiv legen (true) oder löschen (false). */
  archivieren: boolean;

  /** HTTP-Intake aktiv? (false → reiner Ordner-Betrieb). */
  httpAktiv: boolean;
  /** Port des HTTP-Intake. */
  port: number;
  /** Optionaler Bearer-Token-Schutz für das HTTP-Intake ('' → offen). */
  token: string;

  /** Pfad zur ELSTER-Kennzahlen-SSoT (elster_kennzahlen.json). */
  kennzahlenPfad: string;
  /** Fall, dem ein Beleg ohne explizite Zuordnung zugeschlagen wird. */
  defaultFall: string;
  /** Master-Case nach jedem fertigen Beleg automatisch neu schreiben. */
  mastercaseAuto: boolean;
  /** Cache-Ordner für Kurator-Ergebnisse (keyed by sha256). */
  cache: string;
  /** Cache aktiv? (true → Duplikate werden ohne erneuten Opus-Call bedient). */
  cacheAktiv: boolean;
}

export function ladeConfig(): BelegConfig {
  const root = str('BELEG_ROOT', path.join(REPO_ROOT, 'beleg-api-data'));
  const unter = (name: string, sub: string) => str(name, path.join(root, sub));
  return {
    root,
    posteingang: unter('BELEG_POSTEINGANG', 'posteingang'),
    verarbeitung: unter('BELEG_VERARBEITUNG', 'verarbeitung'),
    ausgang: unter('BELEG_AUSGANG', 'ausgang'),
    fehler: unter('BELEG_FEHLER', 'fehler'),
    archiv: unter('BELEG_ARCHIV', 'archiv'),

    anthropicKey: str('ANTHROPIC_API_KEY', ''),
    modell: str('BELEG_MODELL', 'claude-opus-4-8'),
    maxMb: int('BELEG_MAX_MB', 32),
    parallel: int('BELEG_PARALLEL', 3),
    pollMs: int('BELEG_POLL_MS', 1500),
    archivieren: bool('BELEG_ARCHIVIEREN', true),

    httpAktiv: bool('BELEG_HTTP', true),
    port: int('BELEG_PORT', 7810),
    token: str('BELEG_TOKEN', ''),

    kennzahlenPfad: str(
      'BELEG_KENNZAHLEN_PATH',
      path.join(REPO_ROOT, 'src/verticals/elster/data/postgres-dumps/elster_kennzahlen.json'),
    ),
    defaultFall: str('BELEG_DEFAULT_FALL', 'Fall 1'),
    mastercaseAuto: bool('BELEG_MASTERCASE_AUTO', true),
    cache: unter('BELEG_CACHE_DIR', 'cache'),
    cacheAktiv: bool('BELEG_CACHE', true),
  };
}

/** Alle Ordner, die beim Start existieren müssen. */
export function alleOrdner(c: BelegConfig): string[] {
  return [c.posteingang, c.verarbeitung, c.ausgang, c.fehler, c.archiv, c.cache];
}
