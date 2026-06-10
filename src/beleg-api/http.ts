/**
 * Beleg-API — HTTP-Intake (ELSTER, Fall-fähig).
 *
 *   POST /beleg        multipart; Fall via Header X-Fall / Formfeld `fall`
 *   POST /beleg/raw    roher Body; X-Dateiname + X-Fall
 *   GET  /beleg/:id            Status + BelegResult (über alle Fälle gesucht)
 *   GET  /beleg/:id/json|md    fertige Ausgabe
 *   GET  /mastercase?fall=…    baut + schreibt + liefert mastercase_<Fall>.json
 *   GET  /faelle               Übersicht der Fälle
 *   GET  /health
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BelegConfig } from './config.ts';
import { belegId, bereinige } from './ids.ts';
import { fallSlug } from './schreiber.ts';
import { schreibeMasterCase } from './mastercase.ts';

/** Intake-Ordnername: Anzeigename erhalten ("Fall 1" bleibt "Fall 1"),
 *  nur Pfad-Trenner / Traversal entschärfen. */
function intakeOrdner(fall: string): string {
  return (fall || '').split(/[\\/]+/).join('_').split('..').join('_').trim();
}

async function legeInPosteingang(c: BelegConfig, fall: string, dateiname: string, buf: Buffer): Promise<string> {
  const sub = intakeOrdner(fall) || c.defaultFall;
  const dir = path.join(c.posteingang, sub);
  await fs.mkdir(dir, { recursive: true });
  const ziel = path.join(dir, dateiname);
  const tmp = `${ziel}.tmp`;
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, ziel);
  return sub;
}

async function existiert(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

/** Sucht `<id><suffix>` in allen Fall-Unterordnern von baseDir. */
async function findeInFaellen(baseDir: string, id: string, suffix: string): Promise<string | null> {
  let subs: import('node:fs').Dirent[];
  try { subs = await fs.readdir(baseDir, { withFileTypes: true }); } catch { return null; }
  for (const s of subs) {
    if (!s.isDirectory()) continue;
    const p = path.join(baseDir, s.name, `${id}${suffix}`);
    if (await existiert(p)) return p;
  }
  return null;
}

export function baueHttpApp(c: BelegConfig) {
  const app = express();
  app.use(helmet());
  app.disable('x-powered-by');

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/health' || !c.token) return next();
    if ((req.header('authorization') ?? '') === `Bearer ${c.token}`) return next();
    res.status(401).json({ fehler: 'unauthorisiert' });
  });
  app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: c.maxMb * 1024 * 1024 } });

  app.get('/health', async (_req, res) => {
    res.json({
      status: 'ok',
      dienst: 'beleg-api',
      engine: 'Kurator',
      wartet: await zaehleRekursiv(c.posteingang, () => true),
      fertig: await zaehleRekursiv(c.ausgang, (n) => n.endsWith('.json') && !n.startsWith('mastercase_')),
      fehler: await zaehleRekursiv(c.fehler, (n) => n.endsWith('.fehler.json')),
    });
  });

  app.post('/beleg', upload.any(), async (req: Request, res: Response) => {
    const f = ((req.files as Express.Multer.File[] | undefined) ?? [])[0];
    if (!f) { res.status(400).json({ fehler: 'keine_datei' }); return; }
    try {
      const fall = (req.header('x-fall') ?? (req.body?.fall as string | undefined) ?? c.defaultFall).trim() || c.defaultFall;
      const id = belegId(f.buffer, f.originalname, req.header('x-beleg-id') || (req.body?.id as string | undefined) || undefined);
      const sub = await legeInPosteingang(c, fall, `${id}${path.extname(f.originalname)}`, f.buffer);
      res.status(202).json(antwort(id, f.originalname, fall, sub));
    } catch (e) {
      res.status(500).json({ fehler: 'intake_fehlgeschlagen', message: (e as Error).message });
    }
  });

  app.post('/beleg/raw', express.raw({ type: '*/*', limit: `${c.maxMb}mb` }), async (req: Request, res: Response) => {
    const buf = req.body as Buffer;
    if (!buf || !buf.length) { res.status(400).json({ fehler: 'leerer_body' }); return; }
    const originalname = req.header('x-dateiname') || 'beleg.bin';
    try {
      const fall = (req.header('x-fall') ?? c.defaultFall).trim() || c.defaultFall;
      const id = belegId(buf, originalname, req.header('x-beleg-id') || undefined);
      const sub = await legeInPosteingang(c, fall, `${id}${path.extname(originalname)}`, buf);
      res.status(202).json(antwort(id, originalname, fall, sub));
    } catch (e) {
      res.status(500).json({ fehler: 'intake_fehlgeschlagen', message: (e as Error).message });
    }
  });

  app.get('/beleg/:id', async (req: Request, res: Response) => {
    const id = bereinige(req.params.id);
    const jsonPfad = await findeInFaellen(c.ausgang, id, '.json');
    if (jsonPfad) {
      res.json({
        status: 'fertig', id, result: JSON.parse(await fs.readFile(jsonPfad, 'utf-8')),
        links: { json: `/beleg/${id}/json`, md: `/beleg/${id}/md` },
      });
      return;
    }
    const fehlerPfad = await findeInFaellen(c.fehler, id, '.fehler.json');
    if (fehlerPfad) {
      res.status(422).json({ status: 'fehler', id, diagnose: JSON.parse(await fs.readFile(fehlerPfad, 'utf-8')) });
      return;
    }
    res.status(404).json({ status: 'unbekannt', id });
  });

  app.get('/beleg/:id/json', async (req: Request, res: Response) => {
    const p = await findeInFaellen(c.ausgang, bereinige(req.params.id), '.json');
    if (!p) { res.status(404).json({ fehler: 'nicht_fertig', id: req.params.id }); return; }
    res.type('application/json').send(await fs.readFile(p, 'utf-8'));
  });

  app.get('/beleg/:id/md', async (req: Request, res: Response) => {
    const p = await findeInFaellen(c.ausgang, bereinige(req.params.id), '.md');
    if (!p) { res.status(404).json({ fehler: 'nicht_fertig', id: req.params.id }); return; }
    res.type('text/markdown').send(await fs.readFile(p, 'utf-8'));
  });

  /** Master-Case bauen + schreiben + liefern (frisch zum Fall-Stand). */
  app.get('/mastercase', async (req: Request, res: Response) => {
    const fall = (String(req.query?.fall ?? '').trim()) || c.defaultFall;
    try {
      const mc = await schreibeMasterCase(c, fall);
      if (!mc) { res.status(404).json({ fehler: 'keine_belege', fall }); return; }
      res.json(mc.mastercase);
    } catch (e) {
      res.status(500).json({ fehler: 'mastercase_fehlgeschlagen', message: (e as Error).message });
    }
  });

  app.get('/faelle', async (_req: Request, res: Response) => {
    let subs: import('node:fs').Dirent[];
    try { subs = await fs.readdir(c.ausgang, { withFileTypes: true }); } catch { res.json({ faelle: [] }); return; }
    const faelle = [];
    for (const su of subs) {
      if (!su.isDirectory()) continue;
      const names = await fs.readdir(path.join(c.ausgang, su.name)).catch(() => [] as string[]);
      faelle.push({
        ordner: su.name,
        belege: names.filter((n) => n.endsWith('.json') && !n.startsWith('mastercase_')).length,
        mastercase: names.some((n) => n.startsWith('mastercase_')),
      });
    }
    res.json({ faelle });
  });

  return app;
}

async function zaehleRekursiv(base: string, pred: (name: string) => boolean): Promise<number> {
  let n = 0;
  let entries: import('node:fs').Dirent[];
  try { entries = await fs.readdir(base, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (e.isFile()) { if (pred(e.name)) n++; }
    else if (e.isDirectory()) {
      const inner = await fs.readdir(path.join(base, e.name)).catch(() => [] as string[]);
      n += inner.filter(pred).length;
    }
  }
  return n;
}

function antwort(id: string, originalname: string, fall: string, sub: string) {
  return {
    angenommen: true, id, originalname, fall, status: 'wartet',
    ausgang: { json: `${fallSlug(fall)}/${id}.json`, md: `${fallSlug(fall)}/${id}.md` },
    abfrage: `/beleg/${id}`,
    eingang: `posteingang/${sub}/`,
  };
}
