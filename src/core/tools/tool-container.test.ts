/**
 * ToolContainer-Tests.
 *
 * Mocked Resolver per `forApplication({ resolverOverrides })`, damit wir keine
 * realen LLMs/MCPs/Embedder benötigen.
 *
 * Run: tsx src/core/tools/tool-container.test.ts
 */

import { defineApplication } from '../application.ts';
import type { ApplicationDef } from '../application.ts';
import type { ToolHealth, ToolRef } from './types.ts';
import type { ToolHandle } from './handles.ts';
import { ToolContainer, ToolBootError, type Resolvers } from './tool-container.ts';

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}`, detail ?? ''); }
}

// ── Helpers ────────────────────────────────────────────────────────────

function mockHandle(name: string, kind: ToolHandle['kind'], alive: boolean): ToolHandle {
  const h: ToolHealth = {
    name, kind, configured: alive, alive, latencyMs: 1,
    ...(alive ? {} : { lastError: 'mock-down' }),
  };
  // Minimal shape per kind — only methods used by Container are health().
  const base = { name, kind, health: async () => h };
  switch (kind) {
    case 'llm':
      return { ...base, kind: 'llm', meta: { provider: 'vllm', model: 'mock' }, chatJson: async () => ({}) } as ToolHandle;
    case 'embedder':
      return { ...base, kind: 'embedder', meta: { provider: 'ollama', model: 'mock' }, embed: async () => [] } as ToolHandle;
    case 'rag-index':
      return { ...base, kind: 'rag-index', meta: { containerId: 'mock', vectors: 0 }, retrieve: async () => [], retrieveCascade: async () => [] } as ToolHandle;
    case 'mcp':
      return { ...base, kind: 'mcp', meta: { url: 'mock', toolNames: [] }, call: async () => ({}), listTools: async () => [] } as ToolHandle;
    case 'gitchain':
      return { ...base, kind: 'gitchain', meta: { apiUrl: 'mock', namespace: 'mock', anchorMode: 'on-seal-only' }, ensureContainer: async () => null, cloneOrInit: async () => undefined, commitAndPush: async () => ({ sha: 'mock' }), recordAnchor: async () => undefined } as ToolHandle;
    case 'catalog':
      return { ...base, kind: 'catalog', meta: { containerId: 'mock' }, get: () => ({}) as never } as ToolHandle;
    case 'kv':
      return { ...base, kind: 'kv', meta: { backend: 'redis', url: 'mock' }, query: async () => [], cmd: async () => ({}) } as ToolHandle;
  }
}

function aliveResolvers(downSet: Set<string> = new Set()): Partial<Resolvers> {
  const m = (kind: ToolHandle['kind']) => async (r: { name: string }) =>
    mockHandle(r.name, kind, !downSet.has(r.name));
  return {
    llm: m('llm'),
    embedder: m('embedder'),
    'rag-index': m('rag-index'),
    mcp: m('mcp'),
    gitchain: m('gitchain'),
    catalog: m('catalog'),
    kv: m('kv'),
  };
}

// ── Stub-App mit einem Tool je Kind ────────────────────────────────────

function makeApp(tools: ToolRef[]): ApplicationDef {
  return defineApplication({
    id: 'mock-app-' + Math.random().toString(36).slice(2, 8),
    name: 'Mock',
    description: 'Stub for tool-container tests',
    category: 'other',
    mandantRequired: false,
    workflows: { extraction: 'noop' },
    tools,
  });
}

const allKindsTools: ToolRef[] = [
  { name: 't-llm', kind: 'llm', required: true, roles: ['primary'], config: { provider: 'vllm', model: 'x', jsonMode: 'none' } },
  { name: 't-emb', kind: 'embedder', required: true, roles: ['embed'], config: { provider: 'ollama', model: 'x' } },
  { name: 't-rag', kind: 'rag-index', required: false, roles: ['retrieve'], config: { containerId: 'c1', manifest: 'm', strategy: 'turboquant-cascade', tiers: ['d128'], topK: {} } },
  { name: 't-mcp', kind: 'mcp', required: false, roles: ['rpc'], config: { envUrl: 'X_URL', tools: [] } },
  { name: 't-git', kind: 'gitchain', required: false, roles: ['anchor'], config: { envApi: 'A', envDb: 'D', envRepoRoot: 'R', containerNamespace: 'n', anchorMode: 'on-seal-only' } },
  { name: 't-cat', kind: 'catalog', required: false, roles: ['catalog'], config: { containerId: 'c1', files: {} } },
  { name: 't-kv', kind: 'kv', required: false, roles: ['kv'], config: { backend: 'redis', envUrl: 'R_URL' } },
];

// ── Tests ──────────────────────────────────────────────────────────────

(async () => {
  console.log('\n=== forApplication: boots all 7 kinds with mocked resolvers ===');
  const app = makeApp(allKindsTools);
  const c = await ToolContainer.forApplication(app, {
    resolverOverrides: aliveResolvers(),
    silent: true,
  });
  assert('all 7 tools registered', c.toolNames.length === 7);
  assert('has(t-llm) is true', c.has('t-llm'));
  assert('has(unknown) is false', !c.has('zzz'));
  assert('applicationId set', c.applicationId === app.id);

  console.log('\n=== get / getByRole / getAllByRole ===');
  const llm = c.get('t-llm');
  assert('get returns named handle', (llm as ToolHandle).name === 't-llm');
  const byRole = c.getByRole('primary');
  assert('getByRole returns first match', (byRole as ToolHandle).name === 't-llm');
  const allRoles = c.getAllByRole('retrieve');
  assert('getAllByRole returns array', Array.isArray(allRoles) && allRoles.length === 1);
  const noRole = c.getAllByRole('missing-role');
  assert('getAllByRole returns [] on miss', noRole.length === 0);

  console.log('\n=== get throws on missing ===');
  let threw = false;
  try { c.get('nope'); } catch { threw = true; }
  assert('get(unknown) throws', threw);

  console.log('\n=== getByRole throws on missing ===');
  threw = false;
  try { c.getByRole('nope-role'); } catch { threw = true; }
  assert('getByRole(unknown) throws', threw);

  console.log('\n=== healthAll returns per-tool health ===');
  const h = await c.healthAll();
  assert('healthAll has 7 entries', Object.keys(h).length === 7);
  assert('healthAll(t-llm).alive=true', h['t-llm'].alive === true);

  console.log('\n=== required + down → ToolBootError ===');
  const app2 = makeApp([
    { name: 'req-llm', kind: 'llm', required: true, config: { provider: 'vllm', model: 'x', jsonMode: 'none' } },
  ]);
  let bootErr: unknown = null;
  try {
    await ToolContainer.forApplication(app2, {
      resolverOverrides: aliveResolvers(new Set(['req-llm'])),
      silent: true,
    });
  } catch (e) { bootErr = e; }
  assert('boot error thrown', bootErr instanceof ToolBootError);
  assert('boot error mentions tool name', (bootErr as Error).message.includes('req-llm'));

  console.log('\n=== optional + down → boots ok ===');
  const app3 = makeApp([
    { name: 'opt-llm', kind: 'llm', required: false, config: { provider: 'vllm', model: 'x', jsonMode: 'none' } },
  ]);
  const c3 = await ToolContainer.forApplication(app3, {
    resolverOverrides: aliveResolvers(new Set(['opt-llm'])),
    silent: true,
  });
  assert('optional-down boots', c3.has('opt-llm'));

  console.log('\n=== boot order matches roster order ===');
  const calls: string[] = [];
  const tracking: Partial<Resolvers> = {
    llm: async (r) => { calls.push(r.name); return mockHandle(r.name, 'llm', true); },
    embedder: async (r) => { calls.push(r.name); return mockHandle(r.name, 'embedder', true); },
  };
  const appOrdered = makeApp([
    { name: 'first', kind: 'llm', required: false, config: { provider: 'vllm', model: 'x', jsonMode: 'none' } },
    { name: 'second', kind: 'embedder', required: false, config: { provider: 'ollama', model: 'x' } },
    { name: 'third', kind: 'llm', required: false, config: { provider: 'vllm', model: 'x', jsonMode: 'none' } },
  ]);
  await ToolContainer.forApplication(appOrdered, { resolverOverrides: tracking, silent: true });
  assert('resolution order = declared order', JSON.stringify(calls) === JSON.stringify(['first', 'second', 'third']));

  console.log('\n=== duplicate tool name → ToolBootError ===');
  const appDup = makeApp([
    { name: 'dup', kind: 'llm', required: false, config: { provider: 'vllm', model: 'x', jsonMode: 'none' } },
    { name: 'dup', kind: 'embedder', required: false, config: { provider: 'ollama', model: 'x' } },
  ]);
  let dupErr: unknown = null;
  try {
    await ToolContainer.forApplication(appDup, { resolverOverrides: aliveResolvers(), silent: true });
  } catch (e) { dupErr = e; }
  assert('duplicate detected', dupErr instanceof ToolBootError && (dupErr as Error).message.includes('duplicate'));

  console.log(`\nResult: ${pass} pass, ${fail} fail`);
  if (fail > 0) { console.log('Failures:', failures); process.exit(1); }
})();
