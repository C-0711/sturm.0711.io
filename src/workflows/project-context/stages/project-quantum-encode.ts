/**
 * project-quantum-encode — baut den MRL×TurboQuant-Cascade-Index über atoms/.
 *
 * Wiederverwendet das Encoding-Skript aus dem ELSTER-Container
 * (scripts/encode-gemma-quantum-container.ts), parametrisiert auf das
 * project-context atoms/-Verzeichnis. Output landet im Container-Workdir
 * unter index/:
 *   - cascade.json
 *   - embeddings.fp32.bin
 *   - embeddings.tq-d256-b3.bin
 *   - embeddings.tq-d768-b3.bin
 *
 * Voraussetzung: Ollama mit `embeddinggemma` Modell erreichbar
 * (lokal via SSH-Tunnel zu :11434 — siehe Memory-Eintrag h200v).
 * EMBED_CPU=1 wird hart gesetzt, damit GPU-OOM (vLLM saturiert) vermieden wird.
 *
 * Hinweis: das produktive Encoding-Skript zu nutzen erfordert zur Zeit
 * eine kleine Refaktorierung (Atom-Quelle als Argument). Bis dahin
 * ist diese Stage ein SHIM — sie ruft das Skript via `node` mit einer
 * Env-Variable PCTX_ATOMS_DIR, die das Skript auswerten muss.
 * TODO: Atom-Quelle als CLI-Arg im Skript akzeptieren.
 */
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { defineStage } from '../../../core/stage.ts';

interface EncodeIn {
  containerId: string;
  workdir: string;        // injected via stage results, not from upstream stage inputs map
  atomCount: number;
}
interface EncodeOut {
  manifestPath: string;
  ms: number;
  vectorCount: number;
}

export const projectQuantumEncodeStage = defineStage<EncodeIn, EncodeOut, never>({
  id: 'project-quantum-encode',
  name: 'Quantum Encode (project)',
  description: 'EmbeddingGemma + MRL×TurboQuant Cascade über atoms/code/.',
  hints: {
    inputs: '{ workdir, atomCount }',
    outputs: '{ manifestPath, ms, vectorCount }',
    configExample: '{}',
  },
  async run(input, ctx) {
    const attach = ctx.results['attach']?.output as { workdir?: string } | undefined;
    const workdir = input.workdir ?? attach?.workdir;
    if (!workdir) throw new Error('project-quantum-encode: workdir not found in attach result');

    const atomsDir = path.join(workdir, 'atoms', 'code');
    const indexDir = path.join(workdir, 'index');
    await fs.mkdir(indexDir, { recursive: true });

    const scriptPath = path.resolve(process.cwd(), 'scripts/encode-gemma-quantum-container.ts');
    const t0 = Date.now();

    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        'tsx',
        [scriptPath],
        {
          env: {
            ...process.env,
            EMBED_CPU: '1',
            PCTX_ATOMS_DIR: atomsDir,
            PCTX_INDEX_DIR: indexDir,
            PCTX_CONTAINER_ID: input.containerId,
          },
          stdio: 'inherit',
        },
      );
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`encode exited ${code}`))));
    });

    const manifestPath = path.join(indexDir, 'cascade.json');
    const ms = Date.now() - t0;
    ctx.logger.info('project-quantum-encode: done', { ms, atomCount: input.atomCount });
    ctx.emit('index.built', { manifestPath, vectorCount: input.atomCount, ms });
    return { manifestPath, ms, vectorCount: input.atomCount };
  },
});
