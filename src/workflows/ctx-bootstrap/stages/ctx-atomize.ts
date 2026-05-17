/**
 * ctx-atomize — Stage 3/5. Schreibt jedes Atom als adressierbare
 * markdown-Datei mit Frontmatter unter atoms/code/<slug>.md und emittiert
 * atom-ids.json (idx → slug Map) für die Retrieval-Seite.
 */
import { defineStage } from '../../../core/stage.ts';
import { writeAtoms, type Atom } from '../../../lib/ctx-shared.ts';

interface AtomizeIn {
  containerId: string;
  outDir: string;
  atoms: Atom[];
}
interface AtomizeOut {
  atomsDir: string;
  count: number;
}

export const ctxAtomizeStage = defineStage<AtomizeIn, AtomizeOut, never>({
  id: 'ctx-atomize',
  name: 'Materialize Atoms',
  description: 'atoms/code/<slug>.md mit stable Slugs + Frontmatter.',
  hints: {
    inputs: '{ containerId, outDir, atoms[] }',
    outputs: '{ atomsDir, count }',
  },
  async run(input, ctx) {
    const atomsDir = await writeAtoms(input.outDir, input.atoms, input.containerId);
    ctx.logger.info('ctx-atomize', { atomsDir, count: input.atoms.length });
    ctx.emit('atoms.materialized', { atomsDir, count: input.atoms.length });
    return { atomsDir, count: input.atoms.length };
  },
});
