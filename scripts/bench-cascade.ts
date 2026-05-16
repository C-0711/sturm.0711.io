import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { QuantumCascade } from '../src/lib/quantum-index.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const dataDir = path.join(REPO, 'src/verticals/elster-v3/data');

const manifest = JSON.parse(await readFile(path.join(dataDir, 'embeddings.gemma4.cascade.json'), 'utf-8'));
const cascade = await QuantumCascade.loadFromManifest(dataDir, manifest, 50);
console.log('Cascade:', cascade.describe());

const d = manifest.nativeDim ?? 768;
const phrases = 30;
const queries: Float32Array[] = [];
for (let p = 0; p < phrases; p++) {
  const q = new Float32Array(d);
  for (let i = 0; i < d; i++) q[i] = Math.random() - 0.5;
  let n2 = 0;
  for (let i = 0; i < d; i++) n2 += q[i] * q[i];
  const inv = 1 / Math.sqrt(n2);
  for (let i = 0; i < d; i++) q[i] *= inv;
  queries.push(q);
}

// Warm-up — first call builds xHat cache for every tier
const tWarm = Date.now();
cascade.topK(queries[0], 10);
console.log(`Warm-up (cache build first call): ${Date.now() - tWarm} ms`);

const t0 = Date.now();
for (const q of queries) cascade.topK(q, 10);
const total = Date.now() - t0;
console.log(`30 phrases × cascade.topK(k=10): ${total} ms  (${(total/phrases).toFixed(1)} ms/phrase)`);

// Run again to confirm cache is warm
const t1 = Date.now();
for (const q of queries) cascade.topK(q, 10);
const total2 = Date.now() - t1;
console.log(`30 phrases (warm rerun): ${total2} ms  (${(total2/phrases).toFixed(1)} ms/phrase)`);
