/**
 * ctx-parse — Stage 2/5. Wandelt das rohe Transcript in Atome um.
 * Erkennt OpenAI/Claude JSON-Exporte, markdown-Turns mit User/Assistant-
 * Markern, oder behandelt plain text als single-prompt.
 */
import { defineStage } from '../../../core/stage.ts';
import { readFile } from 'node:fs/promises';
import { parseTranscript } from '../../../lib/transcript-parser.ts';
import type { Atom } from '../../../lib/ctx-shared.ts';

interface ParseIn {
  containerId: string;
  outDir: string;
}
interface ParseOut {
  atoms: Atom[];
  count: number;
  kinds: Record<string, number>;
}

export const ctxParseStage = defineStage<ParseIn, ParseOut, never>({
  id: 'ctx-parse',
  name: 'Parse Transcript',
  description: 'Split nach Turns + Code-Blöcken — keine Konversation geht verloren.',
  hints: {
    inputs: '{ containerId, outDir }',
    outputs: '{ atoms[], count, kinds }',
  },
  async run(input, ctx) {
    const raw = await readFile(`${input.outDir}/source.txt`, 'utf8');
    const atoms = parseTranscript(raw, { containerId: input.containerId });
    if (atoms.length === 0) throw new Error('ctx-parse: 0 atoms extracted');

    const kinds: Record<string, number> = {};
    for (const a of atoms) kinds[a.kind] = (kinds[a.kind] ?? 0) + 1;

    ctx.logger.info('ctx-parse', { count: atoms.length, kinds });
    ctx.emit('atoms.parsed', { count: atoms.length, kinds });
    return { atoms, count: atoms.length, kinds };
  },
});
