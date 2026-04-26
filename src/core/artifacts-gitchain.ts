import * as path from 'node:path';
import { createArtifactStore } from './artifacts.ts';
import { getGitChainClient } from '../lib/gitchain-client.ts';
import type { ArtifactStore } from './types.ts';

export interface GitChainArtifactStore extends ArtifactStore {
  readonly containerId: string;
  commitStage(stageId: string, summary: string): Promise<string>;
  finalCommit(state: 'ok' | 'error' | 'partial'): Promise<string>;
  bindMandant(mandantId: string, tenantId: string): Promise<void>;
}

const GIT_AUTHOR = { name: 'STURM Engine', email: 'sturm@0711.io' };

export async function createGitChainArtifactStore(
  runsDir: string,
  workflowId: string,
  runId: string,
): Promise<GitChainArtifactStore> {
  const namespace = process.env['GITCHAIN_DEFAULT_NAMESPACE'] ?? 'ctax';
  const tenantId = process.env['GITCHAIN_DEFAULT_TENANT'] ?? 'ctax-0711';
  const identifier = `sturm-${runId}`;
  const containerId = `0711:workspace:${namespace}:${identifier}`;
  const workdir = path.join(runsDir, workflowId, runId);

  const client = getGitChainClient();

  await client.createContainer({
    type: 'workspace',
    namespace,
    identifier,
    tenant_id: tenantId,
    display_name: `STURM ${workflowId} / ${runId}`,
    description: `Workflow-Run: ${workflowId}`,
    visibility: 'private',
    relations: { workflowId, runId, startedAt: new Date().toISOString() },
  });

  // fs store is created first (mkdirSync in createArtifactStore), then git is layered on top
  const base = createArtifactStore(runsDir, workflowId, runId);
  await client.cloneOrInit(containerId, workdir);

  const commitAndUpdate = async (message: string): Promise<string> => {
    const sha = await client.commitAndPush(workdir, message, GIT_AUTHOR);
    if (sha) await client.updateLatestCommit(containerId, sha).catch(() => undefined);
    return sha;
  };

  return {
    ...base,
    containerId,

    async commitStage(stageId: string, summary: string): Promise<string> {
      return commitAndUpdate(`[${stageId}] ${summary}`);
    },

    async finalCommit(state: 'ok' | 'error' | 'partial'): Promise<string> {
      return commitAndUpdate(`run/${state}: ${workflowId} ${runId}`);
    },

    async bindMandant(mandantId: string, tenantId: string): Promise<void> {
      await client.setMandantId(containerId, mandantId, tenantId);
      const mandantContainerId = `0711:mandant:ctax:${mandantId}`;
      const exists = await client.getContainer(mandantContainerId);
      if (exists) {
        await client.addCitation(containerId, mandantContainerId, 'uses');
      }
    },
  };
}
