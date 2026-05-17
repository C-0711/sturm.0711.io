/**
 * ctx-ingest — Stage 1/5. Empfängt den rohen "ersten Context-Window"-Drop,
 * weist eine Container-ID zu und persistiert das Source-Material.
 */
import { defineStage } from '../../../core/stage.ts';
import { writeFile, mkdir } from 'node:fs/promises';
import { allocateShortId } from '../../../lib/ctx-store.ts';

interface IngestIn {
  raw: string;
  name?: string;
}
interface IngestOut {
  containerId: string;
  shortId: string;
  name: string;
  outDir: string;
  rawBytes: number;
}

export const ctxIngestStage = defineStage<IngestIn, IngestOut, never>({
  id: 'ctx-ingest',
  name: 'Ingest',
  description: 'Allokiert Container-ID + speichert Source-Transcript.',
  hints: {
    inputs: '{ raw: string, name?: string }',
    outputs: '{ containerId, shortId, name, outDir, rawBytes }',
  },
  async run(input, ctx) {
    const raw = String(input.raw ?? '').trim();
    if (raw.length === 0) throw new Error('ctx-ingest: empty input');

    const name = (input.name ?? 'untitled').slice(0, 64);
    const { id, shortId, outDir } = allocateShortId(name);
    await mkdir(outDir, { recursive: true });
    await writeFile(`${outDir}/source.txt`, raw);

    ctx.logger.info('ctx-ingest', { shortId, bytes: raw.length });
    ctx.emit('ctx.allocated', { containerId: id, shortId, outDir });
    return { containerId: id, shortId, name, outDir, rawBytes: raw.length };
  },
});
