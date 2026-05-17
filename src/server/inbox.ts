/**
 * Workspace-Inbox-Persistenz für hochgeladene Belege.
 *
 * Pro Fall: applications/<appId>/<caseId>/inbox/
 *   ├── <ISO-ts>_<safe-filename>     — die echte Datei
 *   └── _manifest.json               — kanonische Liste aller Belege
 *
 * Das Manifest ist single source of truth. ApplicationInstance.documents
 * spiegelt es als read-cache. Wenn jemals gitchain-Postgres reaktiviert
 * wird, lässt sich das Manifest 1:1 nach `registry.documents` migrieren.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { CaseDocument } from './applications.ts';

// Per-Case-Mutex: serialisiert Manifest-Reads + -Writes für denselben Fall.
// Concurrent-Uploads im Bulk-Endpoint würden sonst race-conditions im
// _manifest.json verursachen (zwei Worker lesen das leere Manifest, jeder
// schreibt seinen einen Eintrag zurück → einer überschreibt den anderen).
const caseLocks = new Map<string, Promise<unknown>>();
function withCaseLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = caseLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // Cleanup: lock entfernen wenn diese Operation fertig ist und niemand
  // anderes mehr in der Queue hängt (gleicher Promise-Ref).
  caseLocks.set(key, next.finally(() => {
    if (caseLocks.get(key) === next) caseLocks.delete(key);
  }));
  return next;
}

export interface InboxManifest {
  version: 1;
  caseId: string;
  appId: string;
  documents: CaseDocument[];
  updatedAt: string;
}

function safeFilenamePart(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'file';
}

function isoSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/** Absoluter Pfad zum inbox-Ordner eines Falls. */
export function inboxDirFor(rootCwd: string, instance: { workspacePath: string }): string {
  const ws = path.isAbsolute(instance.workspacePath)
    ? instance.workspacePath
    : path.join(rootCwd, instance.workspacePath);
  return path.join(ws, 'inbox');
}

export function manifestPath(rootCwd: string, instance: { workspacePath: string }): string {
  return path.join(inboxDirFor(rootCwd, instance), '_manifest.json');
}

export async function readManifest(
  rootCwd: string,
  instance: { workspacePath: string; appId: string; caseId: string },
): Promise<InboxManifest> {
  try {
    const raw = await fs.readFile(manifestPath(rootCwd, instance), 'utf-8');
    return JSON.parse(raw) as InboxManifest;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    return {
      version: 1,
      caseId: instance.caseId,
      appId: instance.appId,
      documents: [],
      updatedAt: new Date().toISOString(),
    };
  }
}

export async function writeManifest(
  rootCwd: string,
  instance: { workspacePath: string; appId: string; caseId: string },
  m: InboxManifest,
): Promise<void> {
  m.updatedAt = new Date().toISOString();
  await fs.mkdir(inboxDirFor(rootCwd, instance), { recursive: true });
  await fs.writeFile(manifestPath(rootCwd, instance), JSON.stringify(m, null, 2), 'utf-8');
}

/**
 * Persistiert eine hochgeladene Datei in den Inbox-Ordner und schreibt
 * einen CaseDocument-Eintrag ins Manifest fort.
 *
 * Rückgabewert: das fertige CaseDocument (sha256 + inboxPath sind dann
 * bekannt). Die caller-Seite kann es zusätzlich in instance.documents
 * spiegeln.
 *
 * Idempotenz: wenn dieselbe Datei (gleicher sha256) schon im Manifest ist,
 * wird der vorhandene Eintrag zurückgegeben — keine zweite Kopie.
 */
export async function persistUploadToInbox(
  rootCwd: string,
  instance: { workspacePath: string; appId: string; caseId: string },
  upload: {
    tempPath: string;       // multer's path (req.file.path)
    originalname: string;
    size: number;
    mimetype: string;
  },
  runId: string,
): Promise<CaseDocument> {
  // Datei + sha256 außerhalb des Locks lesen (I/O-parallel ok)
  const buf = await fs.readFile(upload.tempPath);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const targetName = `${isoSlug()}_${safeFilenamePart(upload.originalname)}`;
  const inboxAbs = inboxDirFor(rootCwd, instance);
  await fs.mkdir(inboxAbs, { recursive: true });
  const targetAbs = path.join(inboxAbs, targetName);

  const lockKey = `${instance.appId}|${instance.caseId}`;
  return withCaseLock(lockKey, async () => {
    const m = await readManifest(rootCwd, instance);
    // Idempotenz: wenn schon im Manifest, alten Eintrag updaten.
    const existingIdx = m.documents.findIndex((d) => d.sha256 === sha256);
    if (existingIdx >= 0) {
      const existing = m.documents[existingIdx];
      existing.runId = runId;
      await writeManifest(rootCwd, instance, m);
      return existing;
    }
    // Datei in Inbox schreiben (innerhalb des Locks, damit das Manifest
    // konsistent bleibt — bei einem Crash mittendrin gibt es zwar eine
    // verwaiste Datei, aber keinen toten Manifest-Eintrag).
    await fs.writeFile(targetAbs, buf);
    const doc: CaseDocument = {
      runId,
      filename: upload.originalname,
      inboxPath: path.join('inbox', targetName),
      sha256,
      size: upload.size,
      uploadedAt: new Date().toISOString(),
      mimeType: upload.mimetype,
    };
    m.documents.push(doc);
    await writeManifest(rootCwd, instance, m);
    return doc;
  });
}

/**
 * Aktualisiert den anlagen+fieldsExtracted-Eintrag eines Dokuments im
 * Manifest, nachdem der zugehörige Workflow-Run beendet ist.
 */
export async function recordDocumentRunCompletion(
  rootCwd: string,
  instance: { workspacePath: string; appId: string; caseId: string },
  runId: string,
  details: {
    anlagen?: string[];
    fieldsExtracted?: number;
    trustBreakdown?: { high: number; medium: number; suspicious: number; low: number };
  },
): Promise<void> {
  const lockKey = `${instance.appId}|${instance.caseId}`;
  await withCaseLock(lockKey, async () => {
    const m = await readManifest(rootCwd, instance);
    const doc = m.documents.find((d) => d.runId === runId);
    if (!doc) return;
    if (details.anlagen) doc.anlagen = details.anlagen;
    if (typeof details.fieldsExtracted === 'number') doc.fieldsExtracted = details.fieldsExtracted;
    if (details.trustBreakdown) doc.trustBreakdown = details.trustBreakdown;
    await writeManifest(rootCwd, instance, m);
  });
}

/**
 * Berechnet die Trust-Verteilung (high/medium/suspicious/low) aus einem
 * canonical_layer-Objekt. Felder ohne `trust` werden als `medium`
 * gezählt — das matcht das Default-Verhalten der Stages, die `trust` nur
 * für sicher klassifizierte Werte setzen.
 */
export function computeTrustBreakdown(
  layer: Record<string, unknown> | null | undefined,
): { high: number; medium: number; suspicious: number; low: number } {
  const out = { high: 0, medium: 0, suspicious: 0, low: 0 };
  if (!layer || typeof layer !== 'object') return out;
  for (const v of Object.values(layer)) {
    const t = ((v as { trust?: string } | null | undefined)?.trust ?? 'medium') as keyof typeof out;
    if (t in out) out[t]++;
  }
  return out;
}
