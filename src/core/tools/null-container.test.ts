/**
 * Tests for NullToolContainer — the placeholder injected into ctx.tools
 * for standalone workflow runs (no Anwendung context).
 *
 * Run: tsx src/core/tools/null-container.test.ts
 */

import { NullToolContainer } from './null-container.ts';

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}`, detail ?? ''); }
}

async function main() {
  console.log('\n=== NullToolContainer.get() ===');
  {
    const c = new NullToolContainer();
    let threw = false;
    let msg = '';
    try {
      c.get('bmf-lane1');
    } catch (e) {
      threw = true;
      msg = (e as Error).message;
    }
    assert('throws', threw);
    assert('mentions tool name', msg.includes('bmf-lane1'));
    assert('mentions "no Anwendung context"', msg.includes('no Anwendung context'));
  }

  console.log('\n=== NullToolContainer.getByRole() ===');
  {
    const c = new NullToolContainer();
    let threw = false;
    let msg = '';
    try {
      c.getByRole('llm-primary');
    } catch (e) {
      threw = true;
      msg = (e as Error).message;
    }
    assert('throws', threw);
    assert('mentions role name', msg.includes('llm-primary'));
    assert('mentions "no Anwendung context"', msg.includes('no Anwendung context'));
  }

  console.log('\n=== NullToolContainer.has() ===');
  {
    const c = new NullToolContainer();
    assert('has() returns false for any tool', c.has('anything') === false);
    assert('has() returns false for empty string', c.has('') === false);
  }

  console.log('\n=== NullToolContainer.getAllByRole() ===');
  {
    const c = new NullToolContainer();
    const arr = c.getAllByRole('any-role');
    assert('returns empty array', Array.isArray(arr) && arr.length === 0);
  }

  console.log('\n=== NullToolContainer.healthAll() ===');
  {
    const c = new NullToolContainer();
    const h = await c.healthAll();
    assert('returns empty object', Object.keys(h).length === 0);
  }

  console.log('\n=== NullToolContainer surface ===');
  {
    const c = new NullToolContainer();
    assert('applicationId is "(none)"', c.applicationId === '(none)');
    assert('toolNames is empty', c.toolNames.length === 0);
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
