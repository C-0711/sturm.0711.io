/**
 * ctx-bootstrap — Workflow der den ctx-Workflow zeigt.
 *
 * Drop-in: Visitor pasted einen ersten Context-Window (ChatGPT/Claude/Gemini
 * Transcript, plain prompt, oder ein JSON-Export) und der Workflow baut
 * daraus einen für andere LLMs konsumierbaren Container.
 *
 * Live-Demo unter /ctx-demo.html — die UI dort visualisiert den DAG-Lauf
 * via SSE und bietet anschließend ein Retrieval-Playground für genau diesen
 * frisch gebauten Container.
 */
import { registerStage } from '../../core/registry.ts';
import { defineWorkflow } from '../../core/workflow.ts';
import { ctxIngestStage } from './stages/ctx-ingest.ts';
import { ctxParseStage } from './stages/ctx-parse.ts';
import { ctxAtomizeStage } from './stages/ctx-atomize.ts';
import { ctxIndexStage } from './stages/ctx-index.ts';
import { ctxPublishStage } from './stages/ctx-publish.ts';

export function registerCtxBootstrapStages(): void {
  registerStage(ctxIngestStage);
  registerStage(ctxParseStage);
  registerStage(ctxAtomizeStage);
  registerStage(ctxIndexStage);
  registerStage(ctxPublishStage);
}

export const ctxBootstrapWorkflow = defineWorkflow({
  id: 'ctx-bootstrap',
  name: 'Context Container Bootstrap',
  description:
    'Erzeugt aus dem ersten Context-Window eines LLM-Chats einen für andere LLMs/Agenten konsumierbaren Quantum-Container — Drop-in, kein Code-Schreiben nötig.',
  input: {
    type: 'json', // { raw: string, name?: string }
  },
  stages: {
    ingest: {
      uses: 'ctx-ingest',
      name: 'Ingest',
      description: 'Container-ID allokieren + Source persistieren',
      inputs: {
        raw: '${input.raw}',
        name: '${input.name}',
      },
    },
    parse: {
      uses: 'ctx-parse',
      name: 'Parse',
      description: 'Transcript → Turns + Code-Blöcke',
      inputs: {
        containerId: '${ingest.containerId}',
        outDir: '${ingest.outDir}',
      },
    },
    atomize: {
      uses: 'ctx-atomize',
      name: 'Atomize',
      description: 'atoms/code/<slug>.md schreiben',
      inputs: {
        containerId: '${ingest.containerId}',
        outDir: '${ingest.outDir}',
        atoms: '${parse.atoms}',
      },
    },
    index: {
      uses: 'ctx-index',
      name: 'Embed + Quantize',
      description: 'EmbeddingGemma + MRL×TurboQuant Cascade',
      inputs: {
        containerId: '${ingest.containerId}',
        outDir: '${ingest.outDir}',
        atoms: '${parse.atoms}',
      },
    },
    publish: {
      uses: 'ctx-publish',
      name: 'Publish',
      description: 'Im Store registrieren + Retrieval-URL emittieren',
      inputs: {
        containerId: '${ingest.containerId}',
        shortId: '${ingest.shortId}',
        name: '${ingest.name}',
        outDir: '${ingest.outDir}',
        atomCount: '${index.atomCount}',
        nativeDim: '${index.nativeDim}',
      },
    },
  },
  edges: [
    ['ingest', 'parse'],
    ['parse', 'atomize'],
    ['atomize', 'index'],
    ['index', 'publish'],
  ],
});
