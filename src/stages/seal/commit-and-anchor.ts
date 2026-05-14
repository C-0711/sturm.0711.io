/**
 * seal/commit-and-anchor — schreibt das signierte master.json in den
 * Workspace des Falls und legt einen Anchor-Record an.
 *
 * Anchor v1: file-basiert. Wir schreiben einen Record nach
 *   <workspacePath>/anchors/<isoDate>-<random>.json
 * mit { container_id, tag, commit_hash, network, anchored_at, … }. Wenn
 * später GitChain-Postgres aktiv geschaltet wird, ruft diese Stage statt
 * dessen GitChainClient.recordAnchor(); Contract bleibt identisch.
 *
 * commit_hash ist hier der merkle.root des Snapshots — analog zum Git-
 * Commit-Sha im echten gitchain-Flow.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { defineStage } from '../../core/stage.ts';

export interface CommitAndAnchorInput {
  master: {
    appId: string;
    caseId: string;
    merkle?: { root: string };
    signature?: { alg: string; value: string; keyId: string };
    [k: string]: unknown;
  };
  workspacePath?: string;
}

export interface CommitAndAnchorOutput {
  masterPath: string;
  anchorPath: string;
  anchor: {
    container_id: string;
    tag: string;
    commit_hash: string;
    network: string;
    tx_hash: string | null;
    block_number: number | null;
    anchored_at: string;
  };
}

export interface CommitAndAnchorConfig {
  /** Anchor-Tag. Default 'seal-v1'. */
  tag?: string;
  /** Netzwerk-Identifier. Default 'base-mainnet'. */
  network?: string;
  /** Optional override: explicit project root. */
  rootDir?: string;
}

export const commitAndAnchorStage = defineStage<
  CommitAndAnchorInput,
  CommitAndAnchorOutput,
  CommitAndAnchorConfig
>({
  id: 'seal/commit-and-anchor',
  name: 'Seal · Commit + Anchor',
  description:
    'Schreibt master.signed.json in den Fall-Workspace und legt einen Anchor-Record ' +
    'an (file-basiert in v1; auf GitChain-Postgres umstellbar ohne Contract-Bruch). ' +
    'commit_hash = merkle.root des Snapshots.',
  hints: { inputs: 'master (signiert), workspacePath', outputs: 'masterPath, anchorPath, anchor-row' },
  async run(input, ctx) {
    const cfg = ctx.config ?? {};
    const tag = cfg.tag ?? 'seal-v1';
    const network = cfg.network ?? 'base-mainnet';
    const root = cfg.rootDir ?? process.cwd();
    const master = input.master;
    if (!master || !master.appId || !master.caseId) {
      throw new Error('seal/commit-and-anchor: input.master.{appId,caseId} required');
    }
    const commitHash = master.merkle?.root;
    if (!commitHash) throw new Error('seal/commit-and-anchor: master.merkle.root missing');

    // Ziel: <root>/<workspacePath>/seal/master.json + anchors/<id>.json.
    // Fallback: in den Run-Artefakten, wenn workspacePath fehlt.
    const wsRel = input.workspacePath || path.join('applications', master.appId as string, master.caseId as string);
    const wsAbs = path.isAbsolute(wsRel) ? wsRel : path.join(root, wsRel);
    const sealDir = path.join(wsAbs, 'seal');
    const anchorsDir = path.join(wsAbs, 'anchors');
    await fs.mkdir(sealDir, { recursive: true });
    await fs.mkdir(anchorsDir, { recursive: true });

    const masterPath = path.join(sealDir, 'master.json');
    await fs.writeFile(masterPath, JSON.stringify(master, null, 2), 'utf-8');

    const containerId = `0711:tax_case:ctax:${master.caseId}`;
    const anchor = {
      container_id: containerId,
      tag,
      commit_hash: commitHash,
      network,
      tx_hash: null,
      block_number: null,
      anchored_at: new Date().toISOString(),
    };
    const anchorPath = path.join(
      anchorsDir,
      `${anchor.anchored_at.replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}.json`,
    );
    await fs.writeFile(anchorPath, JSON.stringify(anchor, null, 2), 'utf-8');

    await ctx.artifacts.write('master.json', master);
    await ctx.artifacts.write('anchor.json', anchor);
    ctx.emit('sealed', { masterPath, anchorPath, merkleRoot: commitHash, tag, network });

    return { masterPath, anchorPath, anchor };
  },
});
