/**
 * llm-resolver tests — Health-Probe-Shape per Provider.
 * Wir mocken `globalThis.fetch` (vllm/ollama-Pfad) und env-Vars (cloud-Pfade).
 *
 * Run: tsx src/core/tools/resolvers/llm.test.ts
 */

import { resolveLlm, probeLlmHealth } from './llm.ts';
import type { LlmToolRef } from '../types.ts';

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}`, detail ?? ''); }
}

const origFetch = globalThis.fetch;
const origMistralKey = process.env.MISTRAL_API_KEY;
const origAnthropicKey = process.env.ANTHROPIC_API_KEY;
const origVllmUrl = process.env.VLLM_URL;
const origOllamaUrl = process.env.OLLAMA_URL;

function setFetch(impl: (url: string) => Promise<Response>): void {
  // @ts-expect-error mock
  globalThis.fetch = impl;
}
function restore(): void {
  globalThis.fetch = origFetch;
  process.env.MISTRAL_API_KEY = origMistralKey;
  process.env.ANTHROPIC_API_KEY = origAnthropicKey;
  process.env.VLLM_URL = origVllmUrl;
  process.env.OLLAMA_URL = origOllamaUrl;
}

(async () => {
  console.log('\n=== resolveLlm returns handle with meta + chatJson ===');
  const ref: LlmToolRef = {
    name: 'gemma4-mm', kind: 'llm', required: false,
    config: { provider: 'vllm', envBaseUrl: 'VLLM_URL', model: 'gemma4-mm', jsonMode: 'json_schema' },
  };
  const h = await resolveLlm(ref);
  assert('handle.name', h.name === 'gemma4-mm');
  assert('handle.kind', h.kind === 'llm');
  assert('handle.meta.provider', h.meta.provider === 'vllm');
  assert('handle.meta.model', h.meta.model === 'gemma4-mm');
  assert('handle.chatJson is fn', typeof h.chatJson === 'function');

  console.log('\n=== probeLlmHealth(vllm) — alive when /v1/models 200 ===');
  setFetch(async () => new Response('{}', { status: 200 }));
  const hh = await probeLlmHealth(ref, 'http://vllm.mock');
  assert('vllm alive=true', hh.alive === true);
  assert('vllm configured=true', hh.configured === true);
  assert('vllm latencyMs set', typeof hh.latencyMs === 'number');

  console.log('\n=== probeLlmHealth(vllm) — !alive when 500 ===');
  setFetch(async () => new Response('err', { status: 500 }));
  const hh2 = await probeLlmHealth(ref, 'http://vllm.mock');
  assert('vllm alive=false', hh2.alive === false);
  assert('vllm has lastError', !!hh2.lastError);

  console.log('\n=== probeLlmHealth(ollama) — calls /api/tags ===');
  let calledUrl = '';
  setFetch(async (url: string) => { calledUrl = url; return new Response('{}', { status: 200 }); });
  const ollamaRef: LlmToolRef = {
    name: 'ollama-mock', kind: 'llm', required: false,
    config: { provider: 'ollama', model: 'gemma4', jsonMode: 'none' },
  };
  const hh3 = await probeLlmHealth(ollamaRef, 'http://ollama.mock');
  assert('ollama probed /api/tags', calledUrl.endsWith('/api/tags'));
  assert('ollama alive=true', hh3.alive === true);

  console.log('\n=== probeLlmHealth(mistral) — key presence only ===');
  process.env.MISTRAL_API_KEY = 'sk-mock';
  const mref: LlmToolRef = {
    name: 'mistral', kind: 'llm', required: false,
    config: { provider: 'mistral', model: 'm-s', jsonMode: 'json_object' },
  };
  setFetch(async () => { throw new Error('should not be called for cloud presence-check'); });
  const hh4 = await probeLlmHealth(mref);
  assert('mistral alive when key set', hh4.alive === true);
  delete process.env.MISTRAL_API_KEY;
  const hh5 = await probeLlmHealth(mref);
  assert('mistral !alive when key missing', hh5.alive === false);
  assert('mistral missing-key error', !!hh5.lastError);

  console.log('\n=== probeLlmHealth(anthropic) — key presence only ===');
  process.env.ANTHROPIC_API_KEY = 'sk-mock';
  const aref: LlmToolRef = {
    name: 'claude', kind: 'llm', required: false,
    config: { provider: 'anthropic', model: 'claude-haiku-4-5', jsonMode: 'none' },
  };
  const hh6 = await probeLlmHealth(aref);
  assert('anthropic alive when key set', hh6.alive === true);
  delete process.env.ANTHROPIC_API_KEY;
  const hh7 = await probeLlmHealth(aref);
  assert('anthropic !alive when key missing', hh7.alive === false);

  console.log('\n=== probeLlmHealth(vllm) — !configured when no baseUrl ===');
  setFetch(async () => { throw new Error('should not run'); });
  const noUrlRef: LlmToolRef = {
    name: 'vllm-no-url', kind: 'llm', required: false,
    config: { provider: 'vllm', envBaseUrl: 'NEVER_SET_XXX', model: 'x', jsonMode: 'none' },
  };
  const hh8 = await probeLlmHealth(noUrlRef, undefined);
  assert('vllm !configured w/o url', hh8.configured === false && hh8.alive === false);

  restore();
  console.log(`\nResult: ${pass} pass, ${fail} fail`);
  if (fail > 0) { console.log('Failures:', failures); process.exit(1); }
})();
