/**
 * Beleg-API — Ordner-Wächter (Fall-fähig).
 *
 * Poll-basiert (robust über Bind-Mounts, keine Extra-Dependency). Routing:
 *   posteingang/<datei>          → Fall = Default (BELEG_DEFAULT_FALL)
 *   posteingang/<Fall>/<datei>   → Fall = <Fall>   (Unterordner = Auftrag)
 *
 * Pro Tick: stabile Dateien (Größe über 2 Ticks unverändert, > 0) atomar nach
 * verarbeitung/<token>/<name> umbenennen (= Claim/Lock) und an `verarbeite`
 * übergeben (max. `parallel` gleichzeitig). Der Fall wird als `.fall`-Sidecar
 * im Claim-Ordner hinterlegt, damit Crash-Recovery den Anzeigenamen behält.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BelegConfig } from './config.ts';
import { BelegJob } from './typen.ts';

const SKIP_SUFFIX = ['.tmp', '.part', '.partial', '.crdownload', '.download'];

export interface WacheHandle { stop(): void; }

interface Kandidat { srcPath: string; name: string; fall: string; }

export function startWache(
  c: BelegConfig,
  verarbeite: (job: BelegJob) => Promise<void>,
): WacheHandle {
  const groessen = new Map<string, number>(); // srcPath → zuletzt gesehene Größe
  let aktiv = 0;
  let läuft = false;
  let counter = 0;
  const stamp = Date.now();

  const starteJob = (job: BelegJob) => {
    aktiv++;
    void verarbeite(job)
      .catch((e) => console.error(`[beleg] verarbeite warf unerwartet: ${(e as Error).message}`))
      .finally(() => { aktiv--; });
  };

  function skip(name: string): boolean {
    if (name.startsWith('.')) return true;
    return SKIP_SUFFIX.some((s) => name.toLowerCase().endsWith(s));
  }

  async function sammleKandidaten(): Promise<Kandidat[]> {
    const out: Kandidat[] = [];
    let entries: import('node:fs').Dirent[];
    try { entries = await fs.readdir(c.posteingang, { withFileTypes: true }); }
    catch { return out; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isFile()) {
        if (!skip(e.name)) out.push({ srcPath: path.join(c.posteingang, e.name), name: e.name, fall: c.defaultFall });
      } else if (e.isDirectory()) {
        const sub = path.join(c.posteingang, e.name);
        let inner: import('node:fs').Dirent[];
        try { inner = await fs.readdir(sub, { withFileTypes: true }); } catch { continue; }
        for (const f of inner) {
          if (f.isFile() && !skip(f.name)) out.push({ srcPath: path.join(sub, f.name), name: f.name, fall: e.name });
        }
      }
    }
    return out;
  }

  async function claim(k: Kandidat): Promise<BelegJob | null> {
    const token = `${stamp}-${counter++}`;
    const dir = path.join(c.verarbeitung, token);
    try {
      await fs.mkdir(dir, { recursive: true });
      const ziel = path.join(dir, k.name);
      await fs.rename(k.srcPath, ziel);
      await fs.writeFile(path.join(dir, '.fall'), k.fall, 'utf-8').catch(() => {});
      return { claimPfad: ziel, originalname: k.name, fall: k.fall };
    } catch {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      return null;
    }
  }

  async function tick(): Promise<void> {
    if (läuft) return;
    läuft = true;
    try {
      const kandidaten = await sammleKandidaten();
      const gesehen = new Set<string>();
      for (const k of kandidaten) {
        gesehen.add(k.srcPath);
        if (aktiv >= c.parallel) break;
        let size: number;
        try { size = (await fs.stat(k.srcPath)).size; } catch { continue; }
        const prev = groessen.get(k.srcPath);
        groessen.set(k.srcPath, size);
        if (prev === undefined || prev !== size || size === 0) continue; // erst bei stabiler Größe
        const job = await claim(k);
        groessen.delete(k.srcPath);
        if (job) starteJob(job);
      }
      for (const key of groessen.keys()) if (!gesehen.has(key)) groessen.delete(key);
    } finally {
      läuft = false;
    }
  }

  void recover(c, starteJob);
  void tick();
  const timer = setInterval(() => void tick(), c.pollMs);
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => clearInterval(timer) };
}

async function recover(c: BelegConfig, starteJob: (job: BelegJob) => void): Promise<void> {
  let tokens: import('node:fs').Dirent[];
  try { tokens = await fs.readdir(c.verarbeitung, { withFileTypes: true }); }
  catch { return; }
  for (const t of tokens) {
    if (!t.isDirectory()) continue;
    const dir = path.join(c.verarbeitung, t.name);
    let fall = c.defaultFall;
    try { fall = (await fs.readFile(path.join(dir, '.fall'), 'utf-8')).trim() || c.defaultFall; } catch { /* default */ }
    let inner: string[];
    try { inner = await fs.readdir(dir); } catch { continue; }
    for (const name of inner) {
      if (name === '.fall') continue;
      console.log(`[beleg] recovery: reihe liegengebliebenen Claim erneut ein: ${name} (Fall ${fall})`);
      starteJob({ claimPfad: path.join(dir, name), originalname: name, fall });
    }
  }
}
