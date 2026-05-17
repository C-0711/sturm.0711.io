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
import {
  computeTrustBreakdown,
  persistUploadToInbox,
  readManifest,
  recordDocumentRunCompletion,
} from './inbox.ts';
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

    // ── computeTrustBreakdown: synthetic canonical_layer fixture ───────
    console.log('\n=== computeTrustBreakdown counts trust tiers ===');
    {
      const layer = {
        E1: { trust: 'high' },
        E2: { trust: 'high' },
        E3: { trust: 'medium' },
        E4: { trust: 'suspicious' },
        E5: { trust: 'low' },
        E6: { /* no trust → counts as medium */ },
        E7: { trust: 'unknown' /* unknown tier → ignored, see comment */ },
      };
      const tb = computeTrustBreakdown(layer);
      eq('high count', tb.high, 2);
      // E3 (medium) + E6 (default-to-medium) = 2, E7 unknown tier dropped
      eq('medium count', tb.medium, 2);
      eq('suspicious count', tb.suspicious, 1);
      eq('low count', tb.low, 1);
    }

    console.log('\n=== computeTrustBreakdown handles null/empty input ===');
    {
      eq('null layer', computeTrustBreakdown(null), { high: 0, medium: 0, suspicious: 0, low: 0 });
      eq('empty layer', computeTrustBreakdown({}), { high: 0, medium: 0, suspicious: 0, low: 0 });
    }

    // ── recordDocumentRunCompletion writes trustBreakdown ──────────────
    console.log('\n=== recordDocumentRunCompletion persists trustBreakdown ===');
    {
      // Set up a temp workspace for a synthetic case.
      const wsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sturm-inbox-test-'));
      const inst = {
        appId: 'tb-test',
        caseId: 'tb-case',
        workspacePath: wsRoot,
      };
      // Seed a fake upload by writing a temp file we can pass through
      // persistUploadToInbox (it copies the bytes + writes the manifest).
      const tempUpload = path.join(wsRoot, 'fake.pdf');
      await fs.writeFile(tempUpload, 'pdf-bytes');
      const doc = await persistUploadToInbox(wsRoot, inst, {
        tempPath: tempUpload,
        originalname: 'fake.pdf',
        size: 9,
        mimetype: 'application/pdf',
      }, 'run-xyz');
      assert('persistUploadToInbox returns runId match', doc.runId === 'run-xyz');

      await recordDocumentRunCompletion(wsRoot, inst, 'run-xyz', {
        anlagen: ['KAP'],
        fieldsExtracted: 105,
        trustBreakdown: { high: 36, medium: 46, suspicious: 17, low: 2 },
      });

      const m = await readManifest(wsRoot, inst);
      assert('manifest has 1 doc', m.documents.length === 1);
      const d = m.documents[0];
      eq('anlagen persisted', d.anlagen, ['KAP']);
      eq('fieldsExtracted persisted', d.fieldsExtracted, 105);
      eq('trustBreakdown persisted', d.trustBreakdown, {
        high: 36, medium: 46, suspicious: 17, low: 2,
      });

      // Backward-compat: a call without trustBreakdown must NOT erase the
      // existing breakdown — only set-if-provided semantics.
      await recordDocumentRunCompletion(wsRoot, inst, 'run-xyz', {
        fieldsExtracted: 106,
      });
      const m2 = await readManifest(wsRoot, inst);
      eq('trustBreakdown retained after partial update', m2.documents[0].trustBreakdown, {
        high: 36, medium: 46, suspicious: 17, low: 2,
      });
      eq('fieldsExtracted updated', m2.documents[0].fieldsExtracted, 106);

      await fs.rm(wsRoot, { recursive: true, force: true });
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
