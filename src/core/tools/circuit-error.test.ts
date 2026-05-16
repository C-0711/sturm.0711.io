/**
 * Shape tests for `CircuitOpenError` and `ToolBootError`.
 *
 * Run: tsx src/core/tools/circuit-error.test.ts
 */

import { CircuitOpenError, ToolBootError } from './circuit-error.ts';

let pass = 0, fail = 0;
const failures: string[] = [];
function assert(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}`, detail ?? ''); }
}

console.log('\n=== CircuitOpenError ===');
{
  const err = new CircuitOpenError('bmf-lane1');
  assert('is Error instance', err instanceof Error);
  assert('is CircuitOpenError instance', err instanceof CircuitOpenError);
  assert('has correct name', err.name === 'CircuitOpenError');
  assert('exposes toolName', err.toolName === 'bmf-lane1');
  assert('message mentions tool', err.message.includes('bmf-lane1'));
  assert('lastError undefined when not given', err.lastError === undefined);
}

{
  const err = new CircuitOpenError('bmf-lane1', 'ECONNREFUSED');
  assert('lastError preserved', err.lastError === 'ECONNREFUSED');
  assert('message contains lastError', err.message.includes('ECONNREFUSED'));
}

console.log('\n=== ToolBootError ===');
{
  const err = new ToolBootError('elster-v3', 'bmf-lane1', 'no MCP_URL configured');
  assert('is Error instance', err instanceof Error);
  assert('is ToolBootError instance', err instanceof ToolBootError);
  assert('has correct name', err.name === 'ToolBootError');
  assert('exposes appId', err.appId === 'elster-v3');
  assert('exposes toolName', err.toolName === 'bmf-lane1');
  assert('message contains all parts',
    err.message.includes('elster-v3') &&
    err.message.includes('bmf-lane1') &&
    err.message.includes('no MCP_URL configured'),
  );
}

console.log(`\nResult: ${pass} pass, ${fail} fail`);
if (fail > 0) {
  console.log('Failures:', failures);
  process.exit(1);
}
