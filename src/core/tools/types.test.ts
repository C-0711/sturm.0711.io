/**
 * Type-level smoke tests for `ToolRef` discriminated union.
 *
 * Wir bauen pro `kind` einen Wert. Wenn das Modul compile-fehlerfrei lädt,
 * sind die Typen wohlgeformt. Zusätzlich prüft `narrow` zur Laufzeit, dass
 * der Discriminator innerhalb eines `switch` korrekt verengt.
 *
 * Run: tsx src/core/tools/types.test.ts
 */

import type {
  ToolRef,
  LlmToolRef,
  EmbedderToolRef,
  RagIndexToolRef,
  McpToolRef,
  GitchainToolRef,
  CatalogToolRef,
  KvToolRef,
  ToolHealth,
  ToolContainerView,
} from './types.ts';

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}`, detail ?? ''); }
}

// ── Construct one ToolRef per kind ─────────────────────────────────────

const llm: LlmToolRef = {
  name: 'gemma4-mm',
  kind: 'llm',
  required: true,
  alwaysOn: true,
  roles: ['extraction-llm'],
  config: {
    provider: 'vllm',
    envBaseUrl: 'VLLM_URL',
    model: 'gemma4-mm',
    jsonMode: 'json_schema',
  },
};

const embedder: EmbedderToolRef = {
  name: 'embeddinggemma',
  kind: 'embedder',
  required: true,
  alwaysOn: true,
  roles: ['embed'],
  config: {
    provider: 'ollama',
    model: 'embeddinggemma',
    matryoshka: [128, 256, 512, 768],
    cpuOnly: true,
  },
};

const rag: RagIndexToolRef = {
  name: 'elster-rag',
  kind: 'rag-index',
  required: true,
  alwaysOn: true,
  roles: ['retrieve'],
  config: {
    containerId: '0711:elster:gemma4-tq:embeddings:v1',
    manifest: 'src/verticals/elster-v3/data/embeddings.gemma4.cascade.json',
    strategy: 'turboquant-cascade',
    tiers: ['d128', 'd256', 'd768', 'fp32'],
    topK: { d128: 512, d256: 128, d768: 32, fp32: 8 },
  },
};

const mcp: McpToolRef = {
  name: 'bmf-lane1',
  kind: 'mcp',
  required: true,
  roles: ['steuerrechner'],
  config: {
    envUrl: 'BMF_MCP_URL',
    defaultUrl: 'http://localhost:12010/mcp',
    tools: ['berechne_vollstaendige_steuer_v2'],
  },
};

const gitchain: GitchainToolRef = {
  name: 'gitchain',
  kind: 'gitchain',
  required: true,
  alwaysOn: true,
  roles: ['anchor'],
  config: {
    envApi: 'GITCHAIN_API_URL',
    envDb: 'GITCHAIN_DATABASE_URL',
    envRepoRoot: 'GITCHAIN_REPO_ROOT',
    containerNamespace: 'ctax',
    anchorMode: 'on-seal-only',
  },
};

const catalog: CatalogToolRef = {
  name: 'elster-catalog',
  kind: 'catalog',
  required: true,
  roles: ['catalog'],
  config: {
    containerId: '0711:elster:bmf:jahresdok-2024:v1',
    files: {
      atoms: 'src/verticals/elster-v3/data/atoms.json',
      container: 'src/verticals/elster-v3/data/container.json',
      nested: 'src/verticals/elster-v3/data/nested_schemas',
    },
  },
};

const kv: KvToolRef = {
  name: 'state-kv',
  kind: 'kv',
  required: false,
  config: { backend: 'postgres', envUrl: 'KV_DATABASE_URL' },
};

const all: ToolRef[] = [llm, embedder, rag, mcp, gitchain, catalog, kv];

// ── Discriminator narrowing ────────────────────────────────────────────

function narrowKey(ref: ToolRef): string {
  switch (ref.kind) {
    case 'llm':       return `llm:${ref.config.provider}:${ref.config.model}`;
    case 'embedder':  return `emb:${ref.config.provider}:${ref.config.model}`;
    case 'rag-index': return `rag:${ref.config.containerId}`;
    case 'mcp':       return `mcp:${ref.config.envUrl}`;
    case 'gitchain':  return `git:${ref.config.containerNamespace}:${ref.config.anchorMode}`;
    case 'catalog':   return `cat:${ref.config.containerId}`;
    case 'kv':        return `kv:${ref.config.backend}`;
  }
}

console.log('\n=== ToolRef per-kind construction + narrow() ===');
assert('union has 7 elements', all.length === 7);
assert('llm narrow',       narrowKey(llm)      === 'llm:vllm:gemma4-mm');
assert('embedder narrow',  narrowKey(embedder) === 'emb:ollama:embeddinggemma');
assert('rag narrow',       narrowKey(rag)      === 'rag:0711:elster:gemma4-tq:embeddings:v1');
assert('mcp narrow',       narrowKey(mcp)      === 'mcp:BMF_MCP_URL');
assert('gitchain narrow',  narrowKey(gitchain) === 'git:ctax:on-seal-only');
assert('catalog narrow',   narrowKey(catalog)  === 'cat:0711:elster:bmf:jahresdok-2024:v1');
assert('kv narrow',        narrowKey(kv)       === 'kv:postgres');

// Verify ToolHealth + ToolContainerView shape compile
const health: ToolHealth = {
  name: 'gemma4-mm', kind: 'llm', configured: true, alive: true, latencyMs: 17, circuit: 'closed',
};
assert('ToolHealth constructs', health.name === 'gemma4-mm' && health.circuit === 'closed');

// Structural check that the ToolContainerView interface compiles with a stub.
const stubContainer: ToolContainerView = {
  get: <T = unknown>(_n: string): T => ({} as T),
  getByRole: <T = unknown>(_r: string): T => ({} as T),
  getAllByRole: <T = unknown>(_r: string): T[] => [] as T[],
  has: (_n: string) => false,
};
assert('ToolContainerView has() returns boolean', typeof stubContainer.has('x') === 'boolean');

console.log(`\nResult: ${pass} pass, ${fail} fail`);
if (fail > 0) {
  console.log('Failures:', failures);
  process.exit(1);
}
