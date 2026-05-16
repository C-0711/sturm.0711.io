/**
 * Steuerfall-ESt Anwendungs-Definition: Wohlgeformtheit des Tool-Rosters.
 *
 * Run: tsx src/applications/steuerfall-est/steuerfall-est.test.ts
 */

import { buildSteuerfallEstApplication } from './index.ts';
import { resolveTools } from '../../core/application.ts';
import type {
  LlmToolRef,
  GitchainToolRef,
  RagIndexToolRef,
  McpToolRef,
  EmbedderToolRef,
  CatalogToolRef,
  ToolRef,
} from '../../core/tools/types.ts';

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

const def = buildSteuerfallEstApplication();
const tools = resolveTools(def);
const byName = new Map<string, ToolRef>(tools.map((t) => [t.name, t]));

function get<T extends ToolRef>(name: string): T {
  const t = byName.get(name);
  if (!t) throw new Error(`tool ${name} not in roster`);
  return t as T;
}

console.log('\n=== Roster shape ===');
eq('appId', def.id, 'steuerfall-est');
eq('extraction workflow ID', def.workflows.extraction, 'elster-v5_2-rag');
eq('seal workflow ID', def.workflows.seal, 'steuerfall-seal');
eq('category', def.category, 'tax');
eq('mandantRequired', def.mandantRequired, true);
eq('roster length', tools.length, 10);

const expectedOrder = [
  'gemma4-mm', 'claude-haiku', 'mistral-small', 'mistral-ocr',
  'embeddinggemma', 'elster-rag', 'elster-catalog',
  'bmf-lane1', 'elster-lane5', 'gitchain',
];
eq('roster order', tools.map((t) => t.name), expectedOrder);

console.log('\n=== required + alwaysOn flags ===');
// Spec says all rows except elster-lane5 are required.
for (const t of tools) {
  if (t.name === 'elster-lane5') eq(`${t.name}.required`, t.required, false);
  else eq(`${t.name}.required`, t.required, true);
}
// alwaysOn-Set: gemma4-mm, embeddinggemma, elster-rag, gitchain.
const expectedAlwaysOn = new Set(['gemma4-mm', 'embeddinggemma', 'elster-rag', 'gitchain']);
for (const t of tools) {
  const actual = t.alwaysOn === true;
  eq(`${t.name}.alwaysOn`, actual, expectedAlwaysOn.has(t.name));
}

console.log('\n=== Extraction LLM (gemma4-mm) ===');
const gemma = get<LlmToolRef>('gemma4-mm');
eq('gemma kind', gemma.kind, 'llm');
eq('gemma provider', gemma.config.provider, 'vllm');
eq('gemma envBaseUrl', gemma.config.envBaseUrl, 'VLLM_URL');
eq('gemma model', gemma.config.model, 'gemma4-mm');
eq('gemma jsonMode', gemma.config.jsonMode, 'json_schema');
assert('gemma roles include extraction-llm', (gemma.roles ?? []).includes('extraction-llm'));
assert('gemma roles include disambig-llm', (gemma.roles ?? []).includes('disambig-llm'));
eq('gemma alwaysOn', gemma.alwaysOn, true);

console.log('\n=== Klassifikations-Trio ===');
const haiku = get<LlmToolRef>('claude-haiku');
eq('haiku provider', haiku.config.provider, 'anthropic');
eq('haiku model', haiku.config.model, 'claude-haiku-4-5');
eq('haiku jsonMode', haiku.config.jsonMode, 'none');
eq('haiku roles', haiku.roles, ['critic-llm', 'classify-fallback']);

const mistralSmall = get<LlmToolRef>('mistral-small');
eq('mistral-small provider', mistralSmall.config.provider, 'mistral');
eq('mistral-small model', mistralSmall.config.model, 'mistral-small-latest');
eq('mistral-small jsonMode', mistralSmall.config.jsonMode, 'json_object');
eq('mistral-small roles', mistralSmall.roles, ['classify-primary', 'fallback-llm']);

const mistralOcr = get<LlmToolRef>('mistral-ocr');
eq('mistral-ocr model', mistralOcr.config.model, 'mistral-ocr-latest');
eq('mistral-ocr roles', mistralOcr.roles, ['ocr-primary']);

console.log('\n=== Embedder ===');
const emb = get<EmbedderToolRef>('embeddinggemma');
eq('emb provider', emb.config.provider, 'ollama');
eq('emb model', emb.config.model, 'embeddinggemma');
eq('emb matryoshka', emb.config.matryoshka, [128, 256, 512, 768]);
eq('emb cpuOnly', emb.config.cpuOnly, true);

console.log('\n=== RAG ===');
const ragRef = get<RagIndexToolRef>('elster-rag');
eq('rag containerId', ragRef.config.containerId, '0711:elster:gemma4-tq:embeddings:v1');
eq('rag manifest', ragRef.config.manifest, 'src/verticals/elster-v3/data/embeddings.gemma4.cascade.json');
eq('rag strategy', ragRef.config.strategy, 'turboquant-cascade');
eq('rag tiers', ragRef.config.tiers, ['d128', 'd256', 'd768', 'fp32']);
eq('rag topK', ragRef.config.topK, { d128: 512, d256: 128, d768: 32, fp32: 8 });

console.log('\n=== Catalog ===');
const cat = get<CatalogToolRef>('elster-catalog');
eq('catalog containerId', cat.config.containerId, '0711:elster:bmf:jahresdok-2024:v1');
eq('catalog files.atoms', cat.config.files.atoms, 'src/verticals/elster-v3/data/atoms.json');
eq('catalog files.container', cat.config.files.container, 'src/verticals/elster-v3/data/container.json');
eq('catalog files.nested', cat.config.files.nested, 'src/verticals/elster-v3/data/nested_schemas');

console.log('\n=== MCPs ===');
const lane1 = get<McpToolRef>('bmf-lane1');
eq('lane1 envUrl', lane1.config.envUrl, 'BMF_MCP_URL');
eq('lane1 defaultUrl', lane1.config.defaultUrl, 'http://localhost:12010/mcp');
eq('lane1 tools', lane1.config.tools, ['berechne_vollstaendige_steuer_v2']);
eq('lane1 roles', lane1.roles, ['steuerrechner']);

const lane5 = get<McpToolRef>('elster-lane5');
eq('lane5 envUrl', lane5.config.envUrl, 'ELSTER_MCP_URL');
eq('lane5 tools', lane5.config.tools, ['elster_einreichen']);
eq('lane5 roles', lane5.roles, ['einreichung']);
eq('lane5 required', lane5.required, false);

console.log('\n=== Gitchain ===');
const gc = get<GitchainToolRef>('gitchain');
eq('gitchain envApi', gc.config.envApi, 'GITCHAIN_API_URL');
eq('gitchain envDb', gc.config.envDb, 'GITCHAIN_DATABASE_URL');
eq('gitchain envRepoRoot', gc.config.envRepoRoot, 'GITCHAIN_REPO_ROOT');
eq('gitchain namespace', gc.config.containerNamespace, 'ctax');
eq('gitchain anchorMode on-seal-only', gc.config.anchorMode, 'on-seal-only');
eq('gitchain roles', gc.roles, ['anchor']);
eq('gitchain alwaysOn', gc.alwaysOn, true);

console.log('\n=== Backwards-compat: mcps + rag fields still present ===');
assert('legacy mcps still present', !!def.mcps && Object.keys(def.mcps).length === 2);
assert('legacy rag still present', !!def.rag);
eq('legacy rag containerId', def.rag!.containerId, '0711:elster:bmf:jahresdok-2024:v1');

console.log(`\nResult: ${pass} pass, ${fail} fail`);
if (fail > 0) {
  console.log('Failures:', failures);
  process.exit(1);
}
