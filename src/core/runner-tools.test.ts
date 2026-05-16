/**
 * Tests for P4: ctx.tools injection in the runner.
 *
 *  - Run without `appId`         → NullToolContainer in ctx.tools
 *  - Run with unknown `appId`    → NullToolContainer + warn-once on stderr
 *  - Run with booted `appId`     → that container is injected
 *  - Stage calls .get on Null    → helpful error thrown
 *
 * Run: tsx src/core/runner-tools.test.ts
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { defineStage } from './stage.ts';
import { defineWorkflow } from './workflow.ts';
import { registerStage } from './registry.ts';
import { runWorkflow } from './runner.ts';
import { NullToolContainer } from './tools/null-container.ts';
import type { StageContext } from './types.ts';
import type { ToolContainerView } from './tools/types.ts';

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}`, detail ?? ''); }
}

// ── Probe-Stage that captures ctx.tools ───────────────────────────────────

interface ProbeOut { tools: ToolContainerView; }
const probeCaptures: ProbeOut[] = [];

const probeStage = defineStage<unknown, ProbeOut, unknown>({
  id: 'p4-probe-tools',
  name: 'P4 Probe (tools)',
  async run(_input, ctx: StageContext): Promise<ProbeOut> {
    probeCaptures.push({ tools: ctx.tools });
    return { tools: ctx.tools };
  },
});
registerStage(probeStage);

const probeWorkflow = defineWorkflow({
  id: 'p4-probe-wf',
  name: 'P4 Probe Workflow',
  description: 'minimal 1-stage probe for ctx.tools injection',
  input: { type: 'json' },
  stages: { probe: { uses: 'p4-probe-tools' } },
  edges: [],
});

async function main() {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sturm-p4-runner-'));

  console.log('\n=== runner: no appId → NullToolContainer ===');
  {
    probeCaptures.length = 0;
    const run = runWorkflow(probeWorkflow, { runsDir, input: {} });
    const result = await run.result;
    assert('run completed ok', result.state === 'ok');
    assert('probe captured one ctx', probeCaptures.length === 1);
    assert('ctx.tools is NullToolContainer', probeCaptures[0].tools instanceof NullToolContainer);
    assert('ctx.tools.has() returns false', probeCaptures[0].tools.has('anything') === false);
  }

  console.log('\n=== runner: appId with no booted container → NullToolContainer + warn ===');
  {
    probeCaptures.length = 0;
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      const run = runWorkflow(probeWorkflow, { runsDir, input: {}, appId: 'totally-not-booted-app' });
      const result = await run.result;
      assert('run completed ok', result.state === 'ok');
      assert('ctx.tools is NullToolContainer', probeCaptures[0].tools instanceof NullToolContainer);
      assert(
        'warn message mentions appId',
        warnings.some(w => w.includes('totally-not-booted-app') && w.includes('NullToolContainer')),
        warnings,
      );
    } finally {
      console.warn = origWarn;
    }
  }

  console.log('\n=== stage calling ctx.tools.get on NullContainer throws helpful error ===');
  {
    const c = probeCaptures[probeCaptures.length - 1].tools;
    let threw = false;
    let msg = '';
    try {
      c.get('bmf-lane1');
    } catch (e) {
      threw = true;
      msg = (e as Error).message;
    }
    assert('threw', threw);
    assert('error mentions tool name', msg.includes('bmf-lane1'));
    assert('error mentions Anwendung context', msg.includes('no Anwendung context'));
  }

  await fs.rm(runsDir, { recursive: true, force: true });

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
