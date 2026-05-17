/**
 * seal/commit-and-anchor — commits the sealed workspace into its gitchain
 * container and records the anchor in registry.anchors. Stage-pure: only
 * disk write is the gitchain checkout (managed by the client).
 *
 * Flow:
 *   1. Ensure the container exists in registry.containers (idempotent).
 *   2. cloneOrInit the workspace as a git checkout of the bare repo.
 *   3. Materialize the signed master.json into <wsAbs>/seal/master.json
 *      (this is the only direct fs write — gitchain commits on-disk files).
 *   4. commitAndPush via gitchain → returns the git commit sha.
 *   5. recordAnchor in registry.anchors (commit_hash = git sha; merkle root
 *      is preserved separately in master.json for content-addressing).
 *   6. Audit-trail artefacts written via ctx.artifacts (master + anchor JSON).
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { defineStage } from '../../core/stage.ts';
import { getGitChainClient } from '../../lib/gitchain-client.ts';

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
    /** Git commit SHA from gitchain — null when anchor was skipped (best-effort failure). */
    commit_hash: string | null;
    network: string;
    tx_hash: string | null;
    block_number: number | null;
    anchored_at: string;
    /** Set when the gitchain anchor was skipped due to registry/DB unavailability. */
    anchor_warning?: string | null;
  };
  /** Convenience aliases used by downstream consumers (P8+). */
  containerId: string;
  /** null when gitchain anchor was best-effort-skipped. */
  commitSha: string | null;
  merkleRoot: string;
  sealedAt: string;
}

export interface CommitAndAnchorConfig {
  /** Anchor tag prefix. Default 'seal-v1'. */
  tag?: string;
  /** Network identifier recorded with the anchor. Default 'base-mainnet'. */
  network?: string;
  /** Optional override: explicit project root for resolving relative workspacePath. */
  rootDir?: string;
  /**
   * gitchain container type. Default 'tax_case'. Configurable so the same
   * stage can seal non-tax workflows once they exist.
   */
  containerType?: string;
  /**
   * gitchain namespace. Default 'ctax'.
   */
  containerNamespace?: string;
}

export const commitAndAnchorStage = defineStage<
  CommitAndAnchorInput,
  CommitAndAnchorOutput,
  CommitAndAnchorConfig
>({
  id: 'seal/commit-and-anchor',
  name: 'Seal · Commit + Anchor',
  description:
    'Versiegelt den Fall-Workspace: ensureContainer → cloneOrInit → commitAndPush → recordAnchor. ' +
    'commit_hash = echter Git-Sha aus dem gitchain-Commit; merkle.root liegt im master.json.',
  hints: { inputs: 'master (signiert), workspacePath', outputs: 'containerId, commitSha, anchor-row' },
  async run(input, ctx) {
    const cfg = ctx.config ?? {};
    const tag = cfg.tag ?? 'seal-v1';
    const network = cfg.network ?? 'base-mainnet';
    // rootDir is intentionally configurable to keep the stage decoupled from
    // process.cwd(); when omitted we fall back to cwd because the legacy
    // workflow wiring still passes relative workspacePath strings.
    const root = cfg.rootDir ?? process.cwd();
    const containerType = cfg.containerType ?? 'tax_case';
    const containerNamespace = cfg.containerNamespace ?? 'ctax';

    const master = input.master;
    if (!master || !master.appId || !master.caseId) {
      throw new Error('seal/commit-and-anchor: input.master.{appId,caseId} required');
    }
    const merkleRoot = master.merkle?.root;
    if (!merkleRoot) throw new Error('seal/commit-and-anchor: master.merkle.root missing');

    const appId = String(master.appId);
    const caseId = String(master.caseId);

    // Resolve workspace path: relative paths resolve against config.rootDir.
    const wsRel = input.workspacePath || path.join('applications', appId, caseId);
    const wsAbs = path.isAbsolute(wsRel) ? wsRel : path.join(root, wsRel);
    const sealDir = path.join(wsAbs, 'seal');
    await fs.mkdir(sealDir, { recursive: true });

    const containerId = `0711:${containerType}:${containerNamespace}:${caseId}`;

    // Materialize master.json onto disk first (independent of gitchain).
    // This is the one legitimate non-artifact disk write — the gitchain
    // checkout IS the source of truth, ctx.artifacts is the run-scoped
    // audit copy.
    const masterPath = path.join(sealDir, 'master.json');
    await fs.writeFile(masterPath, JSON.stringify(master, null, 2), 'utf-8');

    const sealedAt = new Date().toISOString();
    const anchorTag = `${tag}-${sealedAt.replace(/[:.]/g, '-')}`;
    let commitSha: string | null = null;
    let anchorWarning: string | null = null;

    // --- gitchain: best-effort. If the registry DB / API is unreachable,
    // log a warning + complete the seal locally. The seal master is still
    // signed + on disk; downstream export/audit can proceed. A reconciler
    // (future) can re-attempt the gitchain anchor once the DB is back.
    try {
      const gc = getGitChainClient();
      // createContainer is idempotent (returns existing on conflict).
      await gc.createContainer({
        type: containerType,
        namespace: containerNamespace,
        identifier: caseId,
        display_name: `Steuerfall ${appId}/${caseId}`,
        description: `Versiegelter Steuerfall (${appId})`,
        visibility: 'private',
        relations: { appId, caseId },
      });
      await gc.cloneOrInit(containerId, wsAbs);
      const authorName = process.env['STURM_GIT_AUTHOR_NAME'] ?? 'sturm-sealer'; // lint-no-env: allow — git author identity is process-level, not a tool binding
      const authorEmail = process.env['STURM_GIT_AUTHOR_EMAIL'] ?? 'seal@0711.io'; // lint-no-env: allow — git author identity is process-level, not a tool binding
      commitSha = await gc.commitAndPush(
        wsAbs,
        `seal: ${appId}/${caseId} merkle=${merkleRoot.slice(0, 12)}`,
        { name: authorName, email: authorEmail },
      );
      await gc.recordAnchor({
        container_id: containerId,
        tag: anchorTag,
        commit_hash: commitSha,
        network,
        // tx_hash / block_number remain undefined until on-chain emit lands.
      });
    } catch (err) {
      anchorWarning = err instanceof Error ? err.message : String(err);
      ctx.logger.warn(
        `gitchain anchor failed (best-effort): ${anchorWarning}. ` +
          `Seal master.json is on disk; downstream export can proceed.`,
      );
      ctx.emit('anchor_skipped', { reason: anchorWarning, containerId });
    }

    const anchor: CommitAndAnchorOutput['anchor'] = {
      container_id: containerId,
      tag: anchorTag,
      commit_hash: commitSha,
      network,
      tx_hash: null,
      block_number: null,
      anchored_at: sealedAt,
      anchor_warning: anchorWarning,
    };

    // Audit-trail artefacts. Pure ctx.artifacts.write — no direct fs here.
    await ctx.artifacts.write('seal/master.json', master);
    await ctx.artifacts.write('seal/anchor.json', anchor);

    // anchorPath retained in the output contract for backwards compat; it
    // points at the audit-trail artifact (relative path in the run store).
    const anchorPath = 'seal/anchor.json';

    ctx.emit('sealed', {
      containerId,
      commitSha,
      merkleRoot,
      tag: anchorTag,
      network,
      masterPath,
    });

    return {
      masterPath,
      anchorPath,
      anchor,
      containerId,
      commitSha,
      merkleRoot,
      sealedAt,
    };
  },
});
