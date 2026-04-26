/**
 * Smoke-Test für GitChainClient.
 * Benötigt: GITCHAIN_DATABASE_URL, GITCHAIN_REPO_ROOT
 * Aufruf: npm test
 */
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { GitChainClient } from './gitchain-client.ts';

const DATABASE_URL = process.env['GITCHAIN_DATABASE_URL'] ?? 'postgresql://gitchain:gitchain_password_2026@localhost:5433/gitchain';
const REPO_ROOT = process.env['GITCHAIN_REPO_ROOT'] ?? '/home/christoph.bertsch/gitchain-repos';
const API_URL = process.env['GITCHAIN_API_URL'] ?? 'http://localhost:3361';

const TEST_NAMESPACE = 'ctax';
const TEST_IDENTIFIER = `smoke-test-${Date.now()}`;
const TEST_CONTAINER_ID = `0711:workspace:${TEST_NAMESPACE}:${TEST_IDENTIFIER}`;

async function run() {
  const client = new GitChainClient({ databaseUrl: DATABASE_URL, repoRoot: REPO_ROOT, apiUrl: API_URL });
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sturm-test-'));

  try {
    console.log(`[test] container: ${TEST_CONTAINER_ID}`);
    console.log(`[test] workdir:   ${tmpDir}`);

    // 1. Container anlegen
    const container = await client.createContainer({
      type: 'workspace',
      namespace: TEST_NAMESPACE,
      identifier: TEST_IDENTIFIER,
      display_name: `Smoke Test ${TEST_IDENTIFIER}`,
      visibility: 'private',
      relations: { test: true },
    });
    console.log(`[test] container created: ${container.id}`);

    // 2. Git initialisieren
    await client.cloneOrInit(TEST_CONTAINER_ID, tmpDir);
    console.log('[test] git initialized');

    // 3. Datei schreiben + commit
    await fs.writeFile(path.join(tmpDir, 'smoke.json'), JSON.stringify({ ok: true, ts: Date.now() }, null, 2));
    const sha1 = await client.commitAndPush(tmpDir, '[smoke] test commit', { name: 'Test', email: 'test@0711.io' });
    console.log(`[test] commit 1: ${sha1}`);

    // 4. Weitere Datei + commit
    await fs.writeFile(path.join(tmpDir, 'second.txt'), 'second file\n');
    const sha2 = await client.commitAndPush(tmpDir, '[smoke] second commit', { name: 'Test', email: 'test@0711.io' });
    console.log(`[test] commit 2: ${sha2}`);

    // 5. latest_commit in DB setzen
    await client.updateLatestCommit(TEST_CONTAINER_ID, sha2);

    // 6. Aus DB lesen und prüfen
    const fromDb = await client.getContainer(TEST_CONTAINER_ID);
    if (!fromDb) throw new Error('container not found in DB');
    if (fromDb.latest_commit !== sha2) {
      throw new Error(`latest_commit mismatch: expected ${sha2}, got ${fromDb.latest_commit}`);
    }
    console.log(`[test] DB verified: latest_commit = ${fromDb.latest_commit}`);

    // 7. findContainersByMandant (kein mandant_id gesetzt → leere Liste)
    const list = await client.findContainersByMandant('nonexistent-mandant');
    console.log(`[test] findContainersByMandant (empty): ${list.length} results`);

    console.log('\n[test] ALL CHECKS PASSED');

  } finally {
    // Cleanup: DB-Eintrag und bare repo entfernen
    try {
      await client['pool'].query('DELETE FROM registry.containers WHERE id = $1', [TEST_CONTAINER_ID]);
      console.log('[test] cleanup: DB row deleted');
    } catch { /* ignore */ }
    try {
      const barePath = path.join(REPO_ROOT, 'workspace', TEST_NAMESPACE, `${TEST_IDENTIFIER}.git`);
      await fs.rm(barePath, { recursive: true, force: true });
      console.log('[test] cleanup: bare repo deleted');
    } catch { /* ignore */ }
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
      console.log('[test] cleanup: workdir deleted');
    } catch { /* ignore */ }
    await client.close();
  }
}

run().catch(err => {
  console.error('[test] FAILED:', err);
  process.exit(1);
});
