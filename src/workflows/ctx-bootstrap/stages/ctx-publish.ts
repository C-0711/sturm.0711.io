/**
 * ctx-publish — Stage 5/5. Registriert den fertigen Container im lokalen
 * Store + emittiert den Retrieval-URL den andere LLMs/Agenten nutzen können.
 *
 * Der HTTP-Endpunkt wird vom in src/server.ts gemounteten ctx-Router serviert
 * (siehe src/lib/ctx-server.ts).
 *
 * Phase C2: materialises a canonical container.json + Ed25519-signed signature.json
 * inside outDir so the container is independently verifiable.
 */
import { defineStage } from '../../../core/stage.ts';
import { upsertContainer } from '../../../lib/ctx-store.ts';
import { writeFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  canonicalize,
  sha256Hex,
  signContainer,
  writeSignatureFile,
} from '../../../lib/sign-container.ts';

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
}

export interface CtxPublishConfig {
  /** Base URL des öffentlich erreichbaren ctx-Servers. Default: same-origin. */
  publicBase?: string;
}

async function tryStat(p: string): Promise<{ size: number; mtime: string } | null> {
  try {
    const st = await stat(p);
    return { size: st.size, mtime: st.mtime.toISOString() };
  } catch {
    return null;
  }
}

export const ctxPublishStage = defineStage<PublishIn, PublishOut, CtxPublishConfig>({
  id: 'ctx-publish',
  name: 'Publish',
  description:
    'Registriert Container + emittiert öffentlichen Retrieval-Endpunkt + Ed25519-Signatur (C2).',
  hints: {
    inputs: '{ containerId, shortId, name, outDir, atomCount, nativeDim }',
    outputs:
      '{ containerId, shortId, retrieveUrl, endpointBase, containerManifestPath, signaturePath, containerSha256, issuerFingerprint }',
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

    // Materialise canonical container.json -----------------------------------
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
      // file digests for tamper-evidence; values null if missing
      artifacts: {
        cascade: indexCascadeStat,
        atomsDir: atomsStat,
        source: sourceStat,
      },
    };

    const containerJsonPath = path.join(input.outDir, 'container.json');
    const canonical = canonicalize(manifest);
    const containerSha256 = sha256Hex(canonical);
    const manifestWithSha = { ...manifest, container_sha256: containerSha256 };
    await writeFile(
      containerJsonPath,
      JSON.stringify(manifestWithSha, null, 2) + '\n',
      'utf8',
    );

    // Sign + persist signature.json ------------------------------------------
    const signature = await signContainer(manifest);
    const signaturePath = await writeSignatureFile(input.outDir, signature);

    ctx.logger.info('ctx-publish', {
      shortId: input.shortId,
      retrieveUrl,
      containerSha256,
      issuerFingerprint: signature.issuer_fingerprint,
    });
    ctx.emit('container.published', {
      containerId: input.containerId,
      shortId: input.shortId,
      retrieveUrl,
      endpointBase,
      containerSha256,
      issuerFingerprint: signature.issuer_fingerprint,
      signaturePath,
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
    };
  },
});
