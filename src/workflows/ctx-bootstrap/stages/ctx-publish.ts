/**
 * ctx-publish — Stage 5/5. Registriert den fertigen Container im lokalen
 * Store + emittiert den Retrieval-URL den andere LLMs/Agenten nutzen können.
 *
 * Der HTTP-Endpunkt wird vom in src/server.ts gemounteten ctx-Router serviert
 * (siehe src/lib/ctx-server.ts).
 */
import { defineStage } from '../../../core/stage.ts';
import { upsertContainer } from '../../../lib/ctx-store.ts';

interface PublishIn {
  containerId: string;
  shortId: string;
  name: string;
  outDir: string;
  atomCount: number;
  nativeDim: number;
}
interface PublishOut {
  containerId: string;
  shortId: string;
  retrieveUrl: string;
  endpointBase: string;
}

export interface CtxPublishConfig {
  /** Base URL des öffentlich erreichbaren ctx-Servers. Default: same-origin. */
  publicBase?: string;
}

export const ctxPublishStage = defineStage<PublishIn, PublishOut, CtxPublishConfig>({
  id: 'ctx-publish',
  name: 'Publish',
  description: 'Registriert Container + emittiert öffentlichen Retrieval-Endpunkt.',
  hints: {
    inputs: '{ containerId, shortId, name, outDir, atomCount, nativeDim }',
    outputs: '{ containerId, shortId, retrieveUrl, endpointBase }',
  },
  async run(input, ctx) {
    await upsertContainer({
      id: input.containerId,
      shortId: input.shortId,
      name: input.name,
      atomCount: input.atomCount,
      nativeDim: input.nativeDim,
      builtAt: new Date().toISOString(),
      status: 'indexed',
      outDir: input.outDir,
    });

    const base = ctx.config.publicBase ?? '';
    const endpointBase = `${base}/ctx/${input.shortId}`;
    const retrieveUrl = `${endpointBase}/retrieve`;

    ctx.logger.info('ctx-publish', { shortId: input.shortId, retrieveUrl });
    ctx.emit('container.published', {
      containerId: input.containerId,
      shortId: input.shortId,
      retrieveUrl,
      endpointBase,
    });
    return { containerId: input.containerId, shortId: input.shortId, retrieveUrl, endpointBase };
  },
});
