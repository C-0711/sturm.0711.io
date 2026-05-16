/**
 * P6 — Tool-Binding consumer test for bmf-rechner-compute.
 *
 * Verifies that the stage prefers `ctx.tools.getByRole('steuerrechner')` over
 * the direct `BmfMcpClient` fallback. We inject a stub `McpHandle` via a
 * minimal `ToolContainerView`, run the stage, and assert that:
 *
 *   - `stub.call('berechne_vollstaendige_steuer_v2', …)` was invoked exactly once
 *   - the canonical_layer was extended with the BMF-computed eCodes
 *
 * Run: tsx src/verticals/elster-v3/stages/p6-mcp-tools.test.ts
 */

import { bmfRechnerComputeStage, type BmfRechnerComputeConfig } from './bmf-rechner-compute.ts';
import type { McpHandle } from '../../../core/tools/handles.ts';
import type { ArtifactStore, StageContext, StageLogger } from '../../../core/types.ts';
import type { ToolContainerView, ToolHealth } from '../../../core/tools/types.ts';
import type { BmfSteuerErgebnis } from '../../../lib/bmf-mcp-client.ts';
import type { CanonicalValue } from './phase5-merge.ts';

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}`, detail ?? ''); }
}

// ── Test doubles ─────────────────────────────────────────────────────────

interface RecordedCall {
  toolName: string;
  params: Record<string, unknown>;
  opts?: { timeoutMs?: number; signal?: AbortSignal };
}

function makeStubMcp(response: BmfSteuerErgebnis): {
  handle: McpHandle;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const handle: McpHandle = {
    name: 'bmf-lane1',
    kind: 'mcp',
    meta: { url: 'stub://bmf', toolNames: ['berechne_vollstaendige_steuer_v2'] },
    async call<T = unknown>(
      toolName: string,
      params: Record<string, unknown>,
      opts?: { timeoutMs?: number; signal?: AbortSignal },
    ): Promise<T> {
      calls.push({ toolName, params, opts });
      return response as unknown as T;
    },
    async listTools() {
      return [{ name: 'berechne_vollstaendige_steuer_v2' }];
    },
    async health(): Promise<ToolHealth> {
      return { name: 'bmf-lane1', kind: 'mcp', configured: true, alive: true };
    },
  };
  return { handle, calls };
}

function makeStubContainer(roleMap: Record<string, McpHandle>, nameMap: Record<string, McpHandle>): ToolContainerView {
  return {
    get<T = unknown>(name: string): T {
      const h = nameMap[name];
      if (!h) throw new Error(`stub container: no tool '${name}'`);
      return h as unknown as T;
    },
    getByRole<T = unknown>(role: string): T {
      const h = roleMap[role];
      if (!h) throw new Error(`stub container: no tool with role '${role}'`);
      return h as unknown as T;
    },
    getAllByRole<T = unknown>(role: string): T[] {
      const h = roleMap[role];
      return (h ? [h] : []) as unknown as T[];
    },
    has(name: string): boolean {
      return nameMap[name] !== undefined;
    },
  };
}

function makeStubArtifacts(): ArtifactStore {
  return {
    async write(_p, _d) { /* noop */ },
    async writeBuffer(_p, _d) { /* noop */ },
    async read<T = unknown>(_p: string): Promise<T> { throw new Error('not used'); },
    async readBuffer(_p: string): Promise<Buffer> { throw new Error('not used'); },
    async exists(_p) { return false; },
    absolutePath(p) { return `/tmp/${p}`; },
  };
}

function makeStubLogger(): StageLogger {
  return {
    debug() {}, info() {}, warn() {}, error() {},
  };
}

function makeStubCtx<C = unknown>(tools: ToolContainerView, config: C = {} as C): StageContext<C> {
  return {
    runId: 'test-run-p6',
    workflowId: 'test-wf',
    stageId: 'elster-v5_2/bmf-rechner-compute',
    config,
    logger: makeStubLogger(),
    artifacts: makeStubArtifacts(),
    emit() {},
    signal: new AbortController().signal,
    results: {},
    tools,
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────

function makeMinimalCanonicalLayer(): Record<string, CanonicalValue> {
  // 5+ entries to clear the low-coverage warning gate.
  const mk = (eCode: string, value: string): CanonicalValue => ({
    eCode,
    value,
    normalized: value,
    origin: 'REGEX_100%',
    anlage: 'N',
    drucktext: 'test',
    vordruckzeile: '',
    datentyp: 'currency',
    kontextPath: null,
    trust: 'high',
    trust_reasons: ['test'],
  });
  return {
    E0200204: mk('E0200204', '5000000'),
    E0200201: mk('E0200201', '100000'),
    E0200205: mk('E0200205', '50000'),
    E0200301: mk('E0200301', '25000'),
    E0200401: mk('E0200401', '15000'),
  };
}

function makeFakeBmfResponse(): BmfSteuerErgebnis {
  return {
    erfolg: true,
    daten: {
      fall_id: 'fall-stub-001',
      steuerjahr: 2024,
      zve: 48000,
      einkommensteuer: 9876,
      solidaritaetszuschlag: 543,
      gesamtsteuer: 10419,
      berechnungsdetails: {
        steuer_berechnung: {
          steuerzone: 'Zone 3',
          formel_verwendet: '§ 32a Abs. 1 Nr. 3 EStG',
          bmf_referenz: 'Jahresdok 2024 §32a',
        },
      },
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== bmf-rechner-compute prefers ctx.tools.getByRole("steuerrechner") ===');
  {
    const { handle: stub, calls } = makeStubMcp(makeFakeBmfResponse());
    const tools = makeStubContainer(
      { steuerrechner: stub },
      { 'bmf-lane1': stub },
    );
    const ctx = makeStubCtx<BmfRechnerComputeConfig>(tools, {});

    const out = await bmfRechnerComputeStage.run!(
      { canonical_layer: makeMinimalCanonicalLayer() },
      ctx,
    );

    assert('stub MCP was called exactly once', calls.length === 1, `actual: ${calls.length}`);
    assert(
      'call targeted "berechne_vollstaendige_steuer_v2"',
      calls[0]?.toolName === 'berechne_vollstaendige_steuer_v2',
      calls[0]?.toolName,
    );
    assert(
      'params include erklaerungsjahr',
      typeof (calls[0]?.params as { erklaerungsjahr?: number })?.erklaerungsjahr === 'number',
    );
    assert(
      'params include elster_felder map',
      typeof (calls[0]?.params as { elster_felder?: unknown })?.elster_felder === 'object',
    );
    assert(
      'ctx.signal forwarded via opts',
      calls[0]?.opts?.signal !== undefined,
    );

    // Output assertions
    assert('output has computed_layer', typeof out.computed_layer === 'object');
    assert('computed_layer contains zvE eCode E0107101', !!out.computed_layer['E0107101']);
    assert('computed_layer contains ESt eCode E0107201', !!out.computed_layer['E0107201']);
    assert('canonical_layer extended with BMF values', !!out.canonical_layer['E0107101']);
    assert('fall_id propagated from MCP response', out.stats.fall_id === 'fall-stub-001');
    assert('stats.computed_out >= 4', out.stats.computed_out >= 4, `got ${out.stats.computed_out}`);
    assert('mcp_raw populated', out.mcp_raw?.erfolg === true);
    assert('xml_payload emitted', typeof out.xml_payload === 'string' && out.xml_payload.length > 0);
  }

  console.log('\n=== fallback to direct BmfMcpClient when ctx.tools.has("bmf-lane1") is false ===');
  {
    // Empty container — `.has('bmf-lane1')` returns false, so the stage falls
    // back to `new BmfMcpClient()`. We can't reach a real MCP here, so the
    // stage's graceful-degradation path kicks in and we assert that:
    //   (a) no crash, (b) stats.error is populated, (c) empty computed_layer.
    const tools = makeStubContainer({}, {});
    const ctx = makeStubCtx<BmfRechnerComputeConfig>(tools, {});
    // Make sure no env var hijacks the URL towards a real port:
    const savedUrl = process.env.BMF_MCP_URL;
    process.env.BMF_MCP_URL = 'http://127.0.0.1:1/mcp'; // refused → quick fail
    try {
      const out = await bmfRechnerComputeStage.run!(
        { canonical_layer: makeMinimalCanonicalLayer() },
        ctx,
      );
      assert('fallback path returns without throwing', true);
      assert('fallback marks stats.error', typeof out.stats.error === 'string');
      assert('fallback computed_layer empty', Object.keys(out.computed_layer).length === 0);
    } finally {
      if (savedUrl === undefined) delete process.env.BMF_MCP_URL;
      else process.env.BMF_MCP_URL = savedUrl;
    }
  }

  console.log('');
  console.log(`Total: ${pass + fail} | Passed: ${pass} | Failed: ${fail}`);
  if (fail > 0) {
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
