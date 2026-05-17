/**
 * project-push-out — schiebt Submodul-Changes auf einen Agent-Branch beim
 * Projekt-Origin. Bewusst NIE auf main, immer auf `agent/<run-id>` —
 * PR-Merge ist menschen-gated.
 *
 * Außerdem: committet im äußeren Container den neuen Submodul-Pointer +
 * den um diesen Agent-Turn gewachsenen events.jsonl. Trust-Wurzel ist
 * der äußere Container-Commit; anchor läuft separat via src/stages/seal/.
 */
import simpleGit from 'simple-git';
import * as path from 'node:path';
import { defineStage } from '../../../core/stage.ts';
import { getGitChainClient } from '../../../lib/gitchain-client.ts';

interface PushIn {
  containerId: string;
  agent: string;
  runId?: string;
}
interface PushOut {
  containerSha: string;
  projectBranch: string;
  projectSha: string;
  pushed: boolean;
}

export const projectPushOutStage = defineStage<PushIn, PushOut, never>({
  id: 'project-push-out',
  name: 'Push-Out',
  description: 'agent/<run-id> beim Projekt-Origin, Container-Commit mit neuem Submodul-Pointer.',
  hints: {
    inputs: '{ agent, runId? }',
    outputs: '{ containerSha, projectBranch, projectSha, pushed }',
  },
  async run(input, ctx) {
    const attach = ctx.results['attach']?.output as { workdir?: string } | undefined;
    if (!attach?.workdir) throw new Error('project-push-out: no attach.workdir');
    const workdir = attach.workdir;
    const runId = input.runId ?? ctx.runId;
    const projectBranch = `agent/${input.agent}-${runId.slice(0, 8)}`;

    const innerPath = path.join(workdir, 'project');
    const inner = simpleGit(innerPath);

    const status = await inner.status();
    let pushed = false;
    if (status.files.length > 0) {
      ctx.logger.info('project-push-out: inner changes detected', { files: status.files.length });
      await inner.checkoutLocalBranch(projectBranch).catch(async () => {
        await inner.checkout(projectBranch);
      });
      await inner.add('-A');
      await inner.commit(`[agent ${input.agent}] turn ${runId}`, {
        '--author': `${input.agent} <agent@0711.io>`,
      });
      await inner.push(['origin', projectBranch, '--set-upstream']);
      pushed = true;
    } else {
      ctx.logger.info('project-push-out: no inner changes, skipping project push');
    }

    const projectSha = (await inner.revparse(['HEAD'])).trim();

    const client = getGitChainClient();
    const containerSha = await client.commitAndPush(
      workdir,
      `[turn] ${input.agent} run=${runId} project=${projectSha.slice(0, 8)}`,
      { name: 'STURM Engine', email: 'sturm@0711.io' },
    );
    await client.updateLatestCommit(input.containerId, containerSha);

    ctx.emit('container.pushed', { containerSha, projectBranch, projectSha, pushed });
    return { containerSha, projectBranch, projectSha, pushed };
  },
});
