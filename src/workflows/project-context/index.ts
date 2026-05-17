/**
 * project-context — gitchain quantum container für ein lebendes Projekt.
 *
 * Das Projekt selbst lebt als Git-Submodul im äußeren Container. Atome
 * (Code-Symbole + Notes) werden in `atoms/` materialisiert, der Quantum-
 * Cascade-Index in `index/` aufgebaut. Agent-Turns landen append-only in
 * `events.jsonl` — kein Merge-Konflikt durch Parallelschreiben.
 *
 * Lifecycle:
 *   attach  →  pull-in  →  atomize  →  quantum-encode
 *                                          │
 *                            agent-turn ◀──┴──▶ project-quantum-retrieve (tool)
 *                                          │
 *                                       reconcile → push-out
 *
 * Container-ID-Form: 0711:project:<namespace>:<slug>
 *
 * NICHT in CI/Boot wired — registerProjectContextStages() einmalig
 * aus src/server.ts aufrufen, wenn aktiviert werden soll.
 */
import { registerStage } from '../../core/registry.ts';
import { defineWorkflow } from '../../core/workflow.ts';
import { projectAttachStage } from './stages/project-attach.ts';
import { projectAtomizeStage } from './stages/project-atomize.ts';
import { projectQuantumEncodeStage } from './stages/project-quantum-encode.ts';
import { projectQuantumRetrieveStage } from './stages/project-quantum-retrieve.ts';
import { agentTurnStage } from './stages/agent-turn.ts';
import { projectPushOutStage } from './stages/project-push-out.ts';

export function registerProjectContextStages(): void {
  registerStage(projectAttachStage);
  registerStage(projectAtomizeStage);
  registerStage(projectQuantumEncodeStage);
  registerStage(projectQuantumRetrieveStage);
  registerStage(agentTurnStage);
  registerStage(projectPushOutStage);
}

export const projectContextWorkflow = defineWorkflow({
  id: 'project-context',
  name: 'Projekt-Kontext-Container',
  description:
    'Wrappt ein Projekt-Repo als Submodul im gitchain-Container, baut einen Quantum-Cascade-Index über Code-Atome, ermöglicht parallele Agent-Turns mit append-only Event-Log.',
  input: {
    type: 'json', // { containerId, projectGitUrl, branch?, agentName?, query? }
  },
  stages: {
    attach: {
      uses: 'project-attach',
      name: 'Submodule anlegen',
      description: 'project/ als Submodul des Container-Repos initialisieren',
      inputs: {
        containerId: '${input.containerId}',
        projectGitUrl: '${input.projectGitUrl}',
        branch: '${input.branch}',
      },
    },
    atomize: {
      uses: 'project-atomize',
      name: 'Atomisieren',
      description: 'project/ → atoms/code/*.md, eines pro Symbol/Section',
      inputs: {
        containerId: '${input.containerId}',
        projectSha: '${attach.projectSha}',
      },
    },
    encode: {
      uses: 'project-quantum-encode',
      name: 'Quantum-Encode',
      description:
        'EmbeddingGemma + MRL×TurboQuant über atoms/ → index/cascade.json',
      inputs: {
        containerId: '${input.containerId}',
        atomCount: '${atomize.count}',
      },
    },
    retrieve: {
      uses: 'project-quantum-retrieve',
      name: 'Cascade-Retrieve',
      description: 'Tool-Stage: query → top-K Atome (von Agenten aufgerufen)',
      inputs: {
        containerId: '${input.containerId}',
        query: '${input.query}',
      },
    },
    turn: {
      uses: 'agent-turn',
      name: 'Agent-Turn loggen',
      description: 'Append-only: {ts, agent, model, query, atom_ids} → events.jsonl',
      inputs: {
        containerId: '${input.containerId}',
        agent: '${input.agentName}',
        retrieved: '${retrieve.hits}',
      },
    },
    pushOut: {
      uses: 'project-push-out',
      name: 'Push-Out',
      description: 'Submodul-Changes auf agent/<run-id> beim Projekt-Origin pushen',
      inputs: {
        containerId: '${input.containerId}',
        agent: '${input.agentName}',
        runId: '${input.runId}',
      },
    },
  },
  edges: [
    ['attach', 'atomize'],
    ['atomize', 'encode'],
    ['encode', 'retrieve'],
    ['retrieve', 'turn'],
    ['turn', 'pushOut'],
  ],
  containers: [
    {
      id: '0711:project:context:placeholder',
      displayName: 'Project Context Container',
      description:
        'Selbst-referenzierend — diese Workflow-Instanz schreibt in genau diesen Container.',
      kind: 'project-context',
      readBy: ['retrieve'],
      lockState: 'sealed',
    },
  ],
});
