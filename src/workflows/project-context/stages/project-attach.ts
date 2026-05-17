/**
 * project-attach — initialisiert den äußeren gitchain-Container und fügt
 * das Projekt-Repo als Submodul unter `project/` ein.
 *
 * Idempotent: existiert Submodul bereits, wird nur die HEAD-SHA zurückgegeben.
 * Nicht-destruktiv: schreibt nur in tmp/<runId>/workspace, niemals direkt
 *   in einen vorhandenen Working-Tree des Nutzers.
 */
import simpleGit from 'simple-git';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { defineStage } from '../../../core/stage.ts';
import { getGitChainClient } from '../../../lib/gitchain-client.ts';

interface AttachIn {
  containerId: string;        // 0711:project:<ns>:<slug>
  projectGitUrl: string;      // remote URL of the inner project repo
  branch?: string;            // default: main
}

interface AttachOut {
  containerId: string;
  workdir: string;            // absolute path to the run's working tree
  projectSha: string;         // commit pinned in the submodule
  newSubmodule: boolean;
}

export const projectAttachStage = defineStage<AttachIn, AttachOut, never>({
  id: 'project-attach',
  name: 'Project Attach (Submodul)',
  description:
    'Klont den gitchain-Container und legt project/ als Submodul auf das Projekt-Repo an.',
  hints: {
    inputs: '{ containerId, projectGitUrl, branch? }',
    outputs: '{ workdir, projectSha, newSubmodule }',
  },
  async run(input, ctx) {
    const branch = input.branch ?? 'main';
    const client = getGitChainClient();

    const workdir = path.join(os.tmpdir(), `sturm-pctx-${ctx.runId}`);
    await fs.mkdir(workdir, { recursive: true });
    ctx.logger.info('project-attach: clone container', { containerId: input.containerId, workdir });

    await client.cloneOrInit(input.containerId, workdir);
    const git = simpleGit(workdir);

    const projectPath = path.join(workdir, 'project');
    const submoduleExists = await fs
      .stat(path.join(projectPath, '.git'))
      .then(() => true)
      .catch(() => false);

    if (!submoduleExists) {
      ctx.logger.info('project-attach: adding submodule', { url: input.projectGitUrl, branch });
      await git.subModule(['add', '-b', branch, input.projectGitUrl, 'project']);
      await client.commitAndPush(
        workdir,
        `[attach] project submodule ${input.projectGitUrl}@${branch}`,
        { name: 'STURM Engine', email: 'sturm@0711.io' },
      );
    } else {
      ctx.logger.info('project-attach: submodule already present, fast-forward only');
      await git.subModule(['update', '--init', '--remote', 'project']);
    }

    const inner = simpleGit(projectPath);
    const projectSha = (await inner.revparse(['HEAD'])).trim();

    ctx.emit('container.attached', { containerId: input.containerId, projectSha });
    return { containerId: input.containerId, workdir, projectSha, newSubmodule: !submoduleExists };
  },
});
