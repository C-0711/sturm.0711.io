/**
 * Tests for the /api/applications/* CRUD router (file-backed JSON registry).
 * No network — uses an in-memory express app + a temp directory for storage.
 *
 * Run: tsx src/server/applications.test.ts
 */

import express from 'express';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AddressInfo } from 'node:net';
import {
  createApplicationsRouter,
  loadInstanceFile,
  saveInstanceFile,
  type ApplicationInstance,
} from './applications.ts';
import { defineApplication } from '../core/application.ts';
import { registerApplication } from '../core/registry.ts';

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}`, detail ?? ''); }
}
function eq<T>(name: string, actual: T, expected: T) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, ok ? undefined : { actual, expected });
}

interface FetchResult { status: number; body: unknown; raw: string; }
async function req(port: number, method: string, p: string, body?: unknown): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const opts = {
      host: '127.0.0.1', port, path: p, method,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
    };
    const r = http.request(opts, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed: unknown = raw;
        try { parsed = JSON.parse(raw); } catch { /* keep raw */ }
        resolve({ status: res.statusCode || 0, body: parsed, raw });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function main() {
  // ── Setup ────────────────────────────────────────────────────────────
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sturm-applications-test-'));
  // Register a minimal Application def for the router to know about.
  try {
    registerApplication(defineApplication({
      id: 'test-app',
      name: 'Test-Anwendung',
      description: 'Used for the applications.test.ts smoke',
      category: 'other',
      mandantRequired: true,
      workflows: { extraction: 'nonexistent' },
    }));
  } catch (e) {
    // Already registered from prior run in same process; ignore.
  }

  const app = express();
  app.use(express.json());
  app.use('/api/applications', createApplicationsRouter({ dir: tmp }));
  const server = http.createServer(app).listen(0);
  await new Promise<void>((r) => server.on('listening', () => r()));
  const port = (server.address() as AddressInfo).port;

  try {
    console.log('\n=== List with no instances → [] ===');
    {
      const r = await req(port, 'GET', '/api/applications/test-app/instances');
      eq('GET list status', r.status, 200);
      eq('GET list body', r.body, []);
    }

    console.log('\n=== List for unknown app → 404 ===');
    {
      const r = await req(port, 'GET', '/api/applications/does-not-exist/instances');
      eq('unknown-app list status', r.status, 404);
      assert('unknown-app error field present', typeof (r.body as { error?: string }).error === 'string');
    }

    console.log('\n=== Create requires displayName ===');
    {
      const r = await req(port, 'POST', '/api/applications/test-app/instances', { mandant_id: 'x' });
      eq('missing displayName status', r.status, 400);
      assert('mentions displayName', String((r.body as { error: string }).error).includes('displayName'));
    }

    console.log('\n=== Create requires mandant_id when mandantRequired ===');
    {
      const r = await req(port, 'POST', '/api/applications/test-app/instances', { displayName: 'X' });
      eq('missing mandant status', r.status, 400);
      assert('mentions mandant_id', String((r.body as { error: string }).error).includes('mandant_id'));
    }

    console.log('\n=== Create OK → 201 + caseId + workspace dir ===');
    let createdCaseId: string | null = null;
    {
      const r = await req(port, 'POST', '/api/applications/test-app/instances', {
        mandant_id: 'mustermann', displayName: 'Mustermann 2024', veranlagungsjahr: 2024,
      });
      eq('create status', r.status, 201);
      const inst = r.body as ApplicationInstance;
      assert('caseId set', typeof inst.caseId === 'string' && inst.caseId.length > 5);
      eq('appId', inst.appId, 'test-app');
      eq('displayName', inst.displayName, 'Mustermann 2024');
      eq('mandantId', inst.mandantId, 'mustermann');
      eq('veranlagungsjahr', inst.veranlagungsjahr, 2024);
      eq('initial status', inst.status, 'in_bearbeitung');
      eq('runs empty', inst.runs, []);
      assert('caseId has no double year', !/2024-2024-/.test(inst.caseId));
      createdCaseId = inst.caseId;
    }

    console.log('\n=== List shows the new instance ===');
    {
      const r = await req(port, 'GET', '/api/applications/test-app/instances');
      eq('list status', r.status, 200);
      assert('list has 1 item', Array.isArray(r.body) && (r.body as ApplicationInstance[]).length === 1);
    }

    console.log('\n=== GET single ===');
    {
      const r = await req(port, 'GET', `/api/applications/test-app/instances/${createdCaseId}`);
      eq('get status', r.status, 200);
      eq('get caseId', (r.body as ApplicationInstance).caseId, createdCaseId);
    }

    console.log('\n=== GET unknown case → 404 ===');
    {
      const r = await req(port, 'GET', '/api/applications/test-app/instances/no-such-case');
      eq('unknown case status', r.status, 404);
    }

    console.log('\n=== loadInstanceFile / saveInstanceFile round-trip ===');
    {
      const inst = await loadInstanceFile(tmp, 'test-app', createdCaseId!);
      assert('loadInstanceFile returns instance', inst !== null);
      if (inst) {
        inst.status = 'versiegelt';
        inst.sealedAt = new Date().toISOString();
        await saveInstanceFile(tmp, inst);
        const reread = await loadInstanceFile(tmp, 'test-app', createdCaseId!);
        eq('saved status persisted', reread?.status, 'versiegelt');
        assert('updatedAt newer than createdAt', !!reread && reread.updatedAt >= reread.createdAt);
      }
    }

    console.log('\n=== Slug dedup: caseId does not double the year ===');
    {
      const r = await req(port, 'POST', '/api/applications/test-app/instances', {
        mandant_id: 'a', displayName: 'Schmidt 2023', veranlagungsjahr: 2023,
      });
      const inst = r.body as ApplicationInstance;
      assert(
        'caseId has only one 2023 segment',
        (inst.caseId.match(/2023/g) || []).length === 1,
        inst.caseId,
      );
    }

  } finally {
    server.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }

  console.log(`\nResult: ${pass} pass, ${fail} fail`);
  if (fail > 0) {
    console.log('Failures:', failures);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
