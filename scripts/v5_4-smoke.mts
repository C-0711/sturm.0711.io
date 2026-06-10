import { registerAllStages } from '../src/stages/index.ts';
import { registerAllWorkflows } from '../src/workflows/index.ts';
import { getWorkflow } from '../src/core/registry.ts';
registerAllStages();
registerAllWorkflows();
const w = getWorkflow('elster-v5_4');
if (!w) { console.error('FAIL: elster-v5_4 not registered'); process.exit(1); }
console.log('OK: elster-v5_4 registered');
console.log('  stages:', Object.keys(w.stages));
const skipExprs = Object.entries(w.stages).filter(([_, s]) => (s as any).skipWhen).map(([id, s]) => `${id}: ${(s as any).skipWhen}`);
console.log('  skipWhen-routed:', skipExprs.length);
skipExprs.forEach(e => console.log('   -', e));
console.log('  edges:', w.edges?.length);
