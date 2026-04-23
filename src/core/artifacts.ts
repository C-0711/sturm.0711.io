import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import type { ArtifactStore } from './types.ts';

/**
 * Dateibasierter Artefakt-Store pro Run. Layout:
 *   runs/<workflowId>/<runId>/<stageId>/<file>
 *   runs/<workflowId>/<runId>/_input/<file>
 *   runs/<workflowId>/<runId>/_meta.json
 */
export function createArtifactStore(rootDir: string, workflowId: string, runId: string): ArtifactStore {
  const base = path.join(rootDir, workflowId, runId);
  fsSync.mkdirSync(base, { recursive: true });

  function resolve(p: string): string {
    const full = path.join(base, p);
    // Schutz gegen Pfad-Escape
    if (!full.startsWith(base + path.sep) && full !== base) {
      throw new Error(`artifact path escape: ${p}`);
    }
    return full;
  }

  async function ensureParent(full: string) {
    await fs.mkdir(path.dirname(full), { recursive: true });
  }

  return {
    async write(p, data) {
      const full = resolve(p);
      await ensureParent(full);
      const serialized = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      await fs.writeFile(full, serialized, 'utf8');
    },
    async writeBuffer(p, data) {
      const full = resolve(p);
      await ensureParent(full);
      await fs.writeFile(full, data);
    },
    async read<T = unknown>(p: string): Promise<T> {
      const full = resolve(p);
      const raw = await fs.readFile(full, 'utf8');
      try {
        return JSON.parse(raw) as T;
      } catch {
        return raw as unknown as T;
      }
    },
    async readBuffer(p) {
      return fs.readFile(resolve(p));
    },
    async exists(p) {
      try { await fs.access(resolve(p)); return true; } catch { return false; }
    },
    absolutePath(p) {
      return resolve(p);
    },
  };
}
