/**
 * ctx-publish — Stage 5/5. Registriert den fertigen Container im lokalen
 * Store + commits everything into a per-container .git repo via gitchain-service,
 * + emittiert den Retrieval-URL den andere LLMs/Agenten nutzen können.
 *
 * Der HTTP-Endpunkt wird vom in src/server.ts gemounteten ctx-Router serviert
 * (siehe src/lib/ctx-server.ts).
 *
 * Phase B9: every ctx container gets its own .git via gitchain-service
 * (MANDATORY per MC standing order 2026-05-24). The bare repo lives at
 *   $GITCHAIN_REPO_ROOT/context/0711/<short-id>.git
 * and contains:
 *   .0711/container.json   (canonical manifest, sha256 stamped)
 *   .0711/signature.json   (Ed25519 issuer signature, C2)
 *   .0711/events.jsonl     (append-only audit log, B7)
 *   data/atoms/            (per-atom JSON)
 *   data/source.txt        (original transcript)
 *   data/index/cascade.json
 *   README.md
 *
 * If GITCHAIN_DATABASE_URL or GITCHAIN_REPO_ROOT is not set, the stage
 * falls back to local-filesystem-only mode and logs a WARNING — this
 * lets dev/test boxes run without the full gitchain stack, but production
 * deployments MUST have both env vars wired.
 */
import { defineStage } from '../../../core/stage.ts';
import { upsertContainer } from '../../../lib/ctx-store.ts';
import { writeFile, readFile, mkdir, stat, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  canonicalize,
  sha256Hex,
  signContainer,
  writeSignatureFile,
} from '../../../lib/sign-container.ts';
import { getGitChainClient } from '../../../lib/gitchain-client.ts';

interface PublishIn {
  containerId: string;
  shortId: string;
  name: string;
  outDir: string;
  atomCount: number;
  nativeDim: number;
}
interface PublishOut {
  containerId: string;
  shortId: string;
  retrieveUrl: string;
  endpointBase: string;
  containerManifestPath: string;
  signaturePath: string;
  containerSha256: string;
  issuerFingerprint: string;
  gitRepoUrl?: string;
  gitCommitSha?: string;
  gitchainCompliant: boolean;
}

export interface CtxPublishConfig {
  /** Base URL des öffentlich erreichbaren ctx-Servers. Default: same-origin. */
  publicBase?: string;
  /**
   * When true, refuse to publish a container if gitchain-service is unreachable.
   * Default false (filesystem-fallback with WARN). Production should set true.
   */
  requireGitchain?: boolean;
}

async function tryStat(p: string): Promise<{ size: number; mtime: string } | null> {
  try {
    const st = await stat(p);
    return { size: st.size, mtime: st.mtime.toISOString() };
  } catch {
    return null;
  }
}

function buildReadme(input: PublishIn, sha: string, fingerprint: string, retrieveUrl: string): string {
  return `# ${input.name}

**Container:** \`${input.containerId}\`
**Short ID:** \`${input.shortId}\`
**Kind:** ctx-bootstrap
**Atom count:** ${input.atomCount}
**Embedding dim:** ${input.nativeDim}

## Verification

- Canonical sha256: \`${sha}\`
- Issuer (did:0711:sturm) fingerprint: \`${fingerprint}\`
- Retrieve endpoint: \`${retrieveUrl}\`

\`\`\`bash
curl ${retrieveUrl.replace('/retrieve', '/signature')} | jq
tsx scripts/verify-ctx.ts <containerDir>
\`\`\`

## Files

| File | Purpose |
|---|---|
| \`.0711/container.json\` | Canonical manifest (sha256-stamped) |
| \`.0711/signature.json\` | Ed25519 issuer signature (C2) |
| \`.0711/events.jsonl\` | Append-only audit log (B7) |
| \`data/atoms/\` | Per-atom JSON files |
| \`data/index/cascade.json\` | Embedding index |
| \`data/source.txt\` | Original transcript |

Built by Fleet Admiral Bombas 💣⚓ · STURM ctx-bootstrap pipeline.
`;
}

export const ctxPublishStage = defineStage<PublishIn, PublishOut, CtxPublishConfig>({
  id: 'ctx-publish',
  name: 'Publish',
  description:
    'Registriert Container + emittiert öffentlichen Retrieval-Endpunkt + Ed25519-Signatur (C2) + per-container .git via gitchain-service (B9).',
  hints: {
    inputs: '{ containerId, shortId, name, outDir, atomCount, nativeDim }',
    outputs:
      '{ containerId, shortId, retrieveUrl, endpointBase, containerManifestPath, signaturePath, containerSha256, issuerFingerprint, gitRepoUrl?, gitCommitSha?, gitchainCompliant }',
  },
  async run(input, ctx) {
    const builtAt = new Date().toISOString();

    await upsertContainer({
      id: input.containerId,
      shortId: input.shortId,
      name: input.name,
      atomCount: input.atomCount,
      nativeDim: input.nativeDim,
      builtAt,
      status: 'indexed',
      outDir: input.outDir,
    });

    const base = ctx.config.publicBase ?? '';
    const endpointBase = `${base}/ctx/${input.shortId}`;
    const retrieveUrl = `${endpointBase}/retrieve`;

    // Materialise canonical container.json ------------------------------------
    const indexCascadeStat = await tryStat(path.join(input.outDir, 'index', 'cascade.json'));
    const atomsStat = await tryStat(path.join(input.outDir, 'atoms'));
    const sourceStat = await tryStat(path.join(input.outDir, 'source.txt'));

    const manifest: Record<string, unknown> = {
      schema: '0711.ctx.container.v1',
      id: input.containerId,
      shortId: input.shortId,
      name: input.name,
      kind: 'ctx-bootstrap',
      builtAt,
      atomCount: input.atomCount,
      nativeDim: input.nativeDim,
      retrieveUrl,
      endpointBase,
      artifacts: {
        cascade: indexCascadeStat,
        atomsDir: atomsStat,
        source: sourceStat,
      },
    };

    const containerSha256 = sha256Hex(canonicalize(manifest));
    const manifestWithSha = { ...manifest, container_sha256: containerSha256 };

    // Always write to outDir first (events.jsonl audit log lives there already)
    const containerJsonPath = path.join(input.outDir, 'container.json');
    await writeFile(
      containerJsonPath,
      JSON.stringify(manifestWithSha, null, 2) + '\n',
      'utf8',
    );
    const signature = await signContainer(manifest);
    const signaturePath = await writeSignatureFile(input.outDir, signature);

    // ─── B9: per-container .git via gitchain-service ───────────────────────
    // Layout in the bare repo:
    //   .0711/container.json
    //   .0711/signature.json
    //   .0711/events.jsonl    (will be copied if exists in outDir)
    //   data/atoms/
    //   data/index/
    //   data/source.txt
    //   README.md
    let gitRepoUrl: string | undefined;
    let gitCommitSha: string | undefined;
    let gitchainCompliant = false;
    const requireGitchain = ctx.config.requireGitchain ?? false;

    try {
      const client = getGitChainClient();

      // Use 'context' type per gitchain convention (other types: product, enrichment, tax_case, mandant)
      const created = await client.createContainer({
        type: 'context',
        namespace: '0711',
        identifier: input.shortId,
        display_name: input.name,
        description: `ctx-bootstrap container · ${input.atomCount} atoms · ${input.nativeDim}-dim`,
        visibility: 'private',
        relations: {
          containerId: input.containerId,
          retrieveUrl,
          issuer_fingerprint: signature.issuer_fingerprint,
        },
      });

      const workdir = path.join(tmpdir(), `ctx-publish-${input.shortId}-${Date.now()}`);
      await mkdir(workdir, { recursive: true });
      await client.cloneOrInit(created.id, workdir);

      // Lay out the per-container repo content
      await mkdir(path.join(workdir, '.0711'), { recursive: true });
      await mkdir(path.join(workdir, 'data'), { recursive: true });
      await writeFile(
        path.join(workdir, '.0711', 'container.json'),
        JSON.stringify(manifestWithSha, null, 2) + '\n',
        'utf8',
      );
      await writeFile(
        path.join(workdir, '.0711', 'signature.json'),
        JSON.stringify(signature, null, 2) + '\n',
        'utf8',
      );
      // Copy events.jsonl if it exists (B7 audit log)
      const eventsSrc = path.join(input.outDir, 'events.jsonl');
      if ((await tryStat(eventsSrc))) {
        await cp(eventsSrc, path.join(workdir, '.0711', 'events.jsonl'));
      }
      // Copy data payload (atoms/, index/, source.txt)
      for (const child of ['atoms', 'index', 'source.txt']) {
        const src = path.join(input.outDir, child);
        const exists = await tryStat(src);
        if (!exists) continue;
        await cp(src, path.join(workdir, 'data', child), { recursive: true });
      }
      await writeFile(
        path.join(workdir, 'README.md'),
        buildReadme(input, containerSha256, signature.issuer_fingerprint, retrieveUrl),
        'utf8',
      );

      const commitMessage = `init: ${input.containerId}\n\natoms=${input.atomCount} dim=${input.nativeDim} sha=${containerSha256.slice(0, 12)}`;
      gitCommitSha = await client.commitAndPush(workdir, commitMessage, {
        name: 'Fleet Admiral Bombas',
        email: 'bombas@0711.io',
      });
      await client.updateLatestCommit(created.id, gitCommitSha);

      gitRepoUrl = created.git_url;
      gitchainCompliant = true;

      ctx.logger.info('ctx-publish: gitchain commit OK', {
        shortId: input.shortId,
        gitRepoUrl,
        gitCommitSha,
      });
    } catch (err) {
      const msg = (err as Error).message || String(err);
      if (requireGitchain) {
        ctx.logger.info('ctx-publish: gitchain required but failed — refusing publish', { error: msg });
        throw new Error(`gitchain_required_but_failed: ${msg}`);
      }
      // Filesystem-fallback: container.json + signature.json still on disk,
      // but no per-container .git. Flagged in the emitted event so monitoring
      // can detect non-compliant publishes.
      ctx.logger.info('ctx-publish: gitchain unreachable, filesystem-fallback active', {
        error: msg,
        warn: 'Per MC standing order (2026-05-24), every container MUST have its own .git. This publish is non-compliant.',
      });
    }

    ctx.logger.info('ctx-publish', {
      shortId: input.shortId,
      retrieveUrl,
      containerSha256,
      issuerFingerprint: signature.issuer_fingerprint,
      gitchainCompliant,
    });
    ctx.emit('container.published', {
      containerId: input.containerId,
      shortId: input.shortId,
      retrieveUrl,
      endpointBase,
      containerSha256,
      issuerFingerprint: signature.issuer_fingerprint,
      signaturePath,
      gitRepoUrl,
      gitCommitSha,
      gitchainCompliant,
    });

    return {
      containerId: input.containerId,
      shortId: input.shortId,
      retrieveUrl,
      endpointBase,
      containerManifestPath: containerJsonPath,
      signaturePath,
      containerSha256,
      issuerFingerprint: signature.issuer_fingerprint,
      gitRepoUrl,
      gitCommitSha,
      gitchainCompliant,
    };
  },
});
