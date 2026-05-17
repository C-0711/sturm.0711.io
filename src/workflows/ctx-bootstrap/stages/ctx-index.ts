/**
 * ctx-index — Stage 4/5. Embeddings + MRL×TurboQuant Cascade.
 *
 * Schwerstes Stück: erfordert eine erreichbare Ollama-Instanz mit
 * `embeddinggemma`. Bei nicht-erreichbar wirft die Stage und der Container
 * bleibt im pending-State — kann später via ctx-CLI `index` nachgebaut
 * werden.
 */
import { defineStage } from '../../../core/stage.ts';
import { buildIndex, ollamaReachable, type Atom } from '../../../lib/ctx-shared.ts';

interface IndexIn {
  containerId: string;
  outDir: string;
  atoms: Atom[];
}
interface IndexOut {
  nativeDim: number;
  atomCount: number;
  embedMs: number;
  encodeMs: number;
  manifestPath: string;
}

export interface CtxIndexConfig {
  /** Override für Ollama-URL. Default: env OLLAMA_URL || http://localhost:11434. */
  ollamaUrl?: string;
  /** Erzwinge CPU-Embedding (auf H200V Pflicht: vLLM saturiert GPUs). */
  embedCpu?: boolean;
}

export const ctxIndexStage = defineStage<IndexIn, IndexOut, CtxIndexConfig>({
  id: 'ctx-index',
  name: 'Embed + Quantize',
  description: 'EmbeddingGemma 768d + MRL×TurboQuant Cascade (tq256 → tq768 → fp32).',
  hints: {
    inputs: '{ containerId, outDir, atoms[] }',
    outputs: '{ nativeDim, atomCount, embedMs, encodeMs, manifestPath }',
    configExample: '{ "ollamaUrl": "http://localhost:11434", "embedCpu": true }',
  },
  async run(input, ctx) {
    const ollamaUrl = ctx.config.ollamaUrl ?? process.env.OLLAMA_URL ?? 'http://localhost:11434';
    const embedCpu = ctx.config.embedCpu ?? (process.env.EMBED_CPU === '1');

    if (!(await ollamaReachable(ollamaUrl))) {
      throw new Error(
        `ctx-index: Ollama nicht erreichbar an ${ollamaUrl}. ` +
        `Tunnel öffnen oder OLLAMA_URL anpassen.`,
      );
    }

    ctx.emit('embed.start', { atomCount: input.atoms.length, ollamaUrl });
    const result = await buildIndex({
      containerId: input.containerId,
      outDir: input.outDir,
      atoms: input.atoms,
      ollamaUrl,
      embedCpu,
    });

    ctx.logger.info('ctx-index', {
      embedMs: result.embedMs,
      encodeMs: result.encodeMs,
      dim: result.nativeDim,
    });
    ctx.emit('index.built', {
      atomCount: result.atomCount,
      nativeDim: result.nativeDim,
      embedMs: result.embedMs,
      encodeMs: result.encodeMs,
    });
    return result;
  },
});
