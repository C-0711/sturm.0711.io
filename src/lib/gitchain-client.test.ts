/**
 * Smoke-Test für GitChainClient.
 * Benötigt: GITCHAIN_DATABASE_URL, GITCHAIN_REPO_ROOT
 * Aufruf: npm test
 */
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import simpleGit from 'simple-git';
import { GitChainClient } from './gitchain-client.ts';

const DATABASE_URL = process.env['GITCHAIN_DATABASE_URL'] ?? 'postgresql://gitchain:gitchain_password_2026@localhost:5433/gitchain';
const REPO_ROOT = process.env['GITCHAIN_REPO_ROOT'] ?? '/home/christoph.bertsch/gitchain-repos';
const API_URL = process.env['GITCHAIN_API_URL'] ?? 'http://localhost:3361';

const TEST_NAMESPACE = 'ctax';
const TEST_IDENTIFIER = `smoke-test-${Date.now()}`;
const TEST_CONTAINER_ID = `0711:workspace:${TEST_NAMESPACE}:${TEST_IDENTIFIER}`;

const MANDANT_ID = 'stricker-rainer-ute';
const MANDANT_CONTAINER_ID = `0711:mandant:${TEST_NAMESPACE}:${MANDANT_ID}`;
const TAX_CASE_IDENTIFIER = 'stricker-est-2024-test';
const TAX_CASE_ID = `0711:tax_case:${TEST_NAMESPACE}:${TAX_CASE_IDENTIFIER}`;

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

    // ── Phase 2 ──────────────────────────────────────────────────────────────

    // 8. Write artifact files to workspace (simulate STURM stage output)
    await fs.mkdir(path.join(tmpDir, 'data'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'data', 'extraktion.json'),
      JSON.stringify({ test: true, source: TEST_CONTAINER_ID }, null, 2),
    );
    await fs.writeFile(
      path.join(tmpDir, 'data', 'elster.json'),
      JSON.stringify({ elster: true, vj: 2024 }, null, 2),
    );
    const sha3 = await client.commitAndPush(tmpDir, '[smoke] artifact files', { name: 'Test', email: 'test@0711.io' });
    await client.updateLatestCommit(TEST_CONTAINER_ID, sha3);
    console.log(`[test] phase2: artifact commit: ${sha3}`);

    // 9. bindMandant: set mandant_id on workspace + citation if mandant exists
    await client.setMandantId(TEST_CONTAINER_ID, MANDANT_ID, 'ctax-0711');
    const mandantExists = await client.getContainer(MANDANT_CONTAINER_ID);
    if (mandantExists) {
      await client.addCitation(TEST_CONTAINER_ID, MANDANT_CONTAINER_ID, 'uses');
      console.log(`[test] phase2: citation workspace → uses → mandant added`);
    } else {
      console.log(`[test] phase2: mandant ${MANDANT_CONTAINER_ID} not found — citation skipped`);
    }

    // 10. Verify mandant_id was set in DB
    const wsAfterBind = await client.getContainer(TEST_CONTAINER_ID);
    if (wsAfterBind?.mandant_id !== MANDANT_ID) {
      throw new Error(`mandant_id mismatch: expected ${MANDANT_ID}, got ${wsAfterBind?.mandant_id}`);
    }
    console.log(`[test] phase2: DB mandant_id = ${wsAfterBind.mandant_id} ✓`);

    // 11. promoteWorkspaceToTaxCase
    const promote = await client.promoteWorkspaceToTaxCase({
      workspace_id: TEST_CONTAINER_ID,
      tax_case_identifier: TAX_CASE_IDENTIFIER,
      mandant_id: MANDANT_ID,
      veranlagungsjahr: 2024,
      steuerart: 'ESt',
      display_name: 'Stricker ESt 2024 (Smoke Test)',
    });
    console.log(`[test] phase2: promote → ${promote.tax_case_id}, created=${promote.created}, sha=${promote.commit_sha}`);
    if (promote.tax_case_id !== TAX_CASE_ID) {
      throw new Error(`tax_case_id mismatch: expected ${TAX_CASE_ID}, got ${promote.tax_case_id}`);
    }
    if (!promote.created) throw new Error('expected created=true for new tax_case');

    // 12. Verify tax_case in DB
    const taxCase = await client.getContainer(TAX_CASE_ID);
    if (!taxCase) throw new Error(`tax_case not found in DB: ${TAX_CASE_ID}`);
    console.log(`[test] phase2: tax_case in DB: ${taxCase.id}, latest_commit=${taxCase.latest_commit}`);

    // 13. Clone tax_case repo and verify artifact files
    const tmpVerify = await fs.mkdtemp(path.join(os.tmpdir(), 'sturm-verify-'));
    try {
      const tcBare = path.join(REPO_ROOT, 'tax_case', TEST_NAMESPACE, `${TAX_CASE_IDENTIFIER}.git`);
      await simpleGit(os.tmpdir()).clone(tcBare, tmpVerify, ['--local']);
      const extraktion = JSON.parse(await fs.readFile(path.join(tmpVerify, 'data', 'extraktion.json'), 'utf8'));
      if (!extraktion.test) throw new Error('extraktion.json not found or invalid in tax_case repo');
      const elster = JSON.parse(await fs.readFile(path.join(tmpVerify, 'data', 'elster.json'), 'utf8'));
      if (!elster.elster) throw new Error('elster.json not found or invalid in tax_case repo');
      console.log('[test] phase2: tax_case repo contains extraktion.json + elster.json ✓');
    } finally {
      await fs.rm(tmpVerify, { recursive: true, force: true }).catch(() => undefined);
    }

    // 14. Verify citation tax_case → derived_from → workspace
    const citationRows = await client['pool'].query<{ source_id: string; target_id: string; relationship: string }>(
      'SELECT source_id, target_id, relationship FROM registry.citations WHERE source_id = $1 AND target_id = $2 AND relationship = $3',
      [TAX_CASE_ID, TEST_CONTAINER_ID, 'derived_from'],
    );
    if (citationRows.rows.length === 0) throw new Error('citation tax_case → derived_from → workspace not found');
    console.log('[test] phase2: citation tax_case → derived_from → workspace ✓');

    console.log('\n[test] ALL CHECKS PASSED (Phase 1 + Phase 2)');

  } finally {
    // Cleanup citations before containers (no cascade)
    try {
      await client['pool'].query(
        'DELETE FROM registry.citations WHERE source_id IN ($1,$2) OR target_id IN ($1,$2)',
        [TEST_CONTAINER_ID, TAX_CASE_ID],
      );
      console.log('[test] cleanup: citations deleted');
    } catch { /* ignore */ }
    // Cleanup DB rows
    try {
      await client['pool'].query('DELETE FROM registry.containers WHERE id = $1', [TAX_CASE_ID]);
      console.log('[test] cleanup: tax_case DB row deleted');
    } catch { /* ignore */ }
    try {
      await client['pool'].query('DELETE FROM registry.containers WHERE id = $1', [TEST_CONTAINER_ID]);
      console.log('[test] cleanup: workspace DB row deleted');
    } catch { /* ignore */ }
    // Cleanup bare repos
    try {
      const tcBare = path.join(REPO_ROOT, 'tax_case', TEST_NAMESPACE, `${TAX_CASE_IDENTIFIER}.git`);
      await fs.rm(tcBare, { recursive: true, force: true });
      console.log('[test] cleanup: tax_case bare repo deleted');
    } catch { /* ignore */ }
    try {
      const wsBare = path.join(REPO_ROOT, 'workspace', TEST_NAMESPACE, `${TEST_IDENTIFIER}.git`);
      await fs.rm(wsBare, { recursive: true, force: true });
      console.log('[test] cleanup: workspace bare repo deleted');
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
