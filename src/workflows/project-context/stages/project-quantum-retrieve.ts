/**
 * project-quantum-retrieve — Tool-Stage. Jeder LLM/Agent ruft dies auf, um
 * Top-K Atome zur eigenen Anfrage zu erhalten. Deterministische Cascade-
 * Lookup über das von project-quantum-encode gebaute Index-Bundle.
 *
 * Asymmetrische Prompts (query vs document) MÜSSEN identisch zur
 * EmbeddingGemma-Spec gesetzt werden — Skip kostet 3–7 MTEB-Punkte
 * (siehe Memory-Eintrag gemma-quantum-container).
 */
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { defineStage } from '../../../core/stage.ts';
import { QuantumCascade, type CascadeManifest } from '../../../lib/quantum-index.ts';
import { embedBatch, formatQuery, mrlTruncate, l2normalize } from '../../../lib/gemma-embed.ts';

interface RetrieveIn {
  containerId: string;
  query: string;
  k?: number;
}

interface RetrievedAtom {
  atomId: string;        // slug of atoms/code/<slug>.md
  score: number;
  preview: string;       // first ~200 chars of body
}

interface RetrieveOut {
  hits: RetrievedAtom[];
  ms: number;
}

export const projectQuantumRetrieveStage = defineStage<RetrieveIn, RetrieveOut, never>({
  id: 'project-quantum-retrieve',
  name: 'Cascade Retrieve',
  description: 'top-K Atome aus dem project-context Cascade-Index.',
  hints: {
    inputs: '{ containerId, query, k? }',
    outputs: '{ hits[], ms }',
    acceptsContainers: ['project-context'],
  },
  async run(input, ctx) {
    const k = input.k ?? 8;
    const attach = ctx.results['attach']?.output as { workdir?: string } | undefined;
    const workdir = attach?.workdir;
    if (!workdir) throw new Error('project-quantum-retrieve: no attach.workdir in run results');

    const indexDir = path.join(workdir, 'index');
    const manifest = JSON.parse(await fs.readFile(path.join(indexDir, 'cascade.json'), 'utf8')) as CascadeManifest;
    const cascade = await QuantumCascade.loadFromManifest(indexDir, manifest, k);

    // Encode-stage emits an idx → atom-slug map alongside the cascade. If
    // missing (older container), atomId falls back to `idx-N`.
    const idsPath = path.join(indexDir, 'atom-ids.json');
    const ids = (await fs
      .readFile(idsPath, 'utf8')
      .then((s) => JSON.parse(s) as string[])
      .catch(() => [] as string[]));

    const t0 = Date.now();
    const [rawVec] = await embedBatch([formatQuery(input.query)], { cpuOnly: true, dimensions: 768 });
    const q768 = l2normalize(Float32Array.from(rawVec));
    const topK = cascade.topK(q768, k);
    const ms = Date.now() - t0;

    const atomsDir = path.join(workdir, 'atoms', 'code');
    const hits: RetrievedAtom[] = [];
    for (const hit of topK) {
      const atomId = ids[hit.idx] ?? `idx-${hit.idx}`;
      const atomPath = path.join(atomsDir, `${atomId}.md`);
      const body = await fs.readFile(atomPath, 'utf8').catch(() => '');
      hits.push({ atomId, score: hit.score, preview: body.slice(0, 200) });
    }

    ctx.logger.info('project-quantum-retrieve: done', { ms, k, top: hits[0]?.atomId });
    ctx.emit('atoms.retrieved', { query: input.query, hits });
    return { hits, ms };
  },
});

// Silence the lint on the unused mrlTruncate — wird genutzt sobald der
// Cascade-Reader die 256-d Tier-Truncation hier statt intern erledigt.
void mrlTruncate;
