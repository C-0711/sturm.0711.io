/**
 * @0711/quantum-container-loader — universal loader for QCP-compliant
 * Quantum Containers. Sturm-side reference implementation.
 *
 * The loader takes a `container-set.json` (a locked triple of container
 * versions) and returns verified local paths + parsed manifests for the
 * three containers used by elster-v4:
 *
 *   catalog  — atoms.json + metadata
 *   encoder  — fp32 + 4 TQ-tier cascade
 *   context  — disambig hints (LLM-Disambig only)
 *
 * Cross-container consistency is enforced at load time:
 *   - encoder.built_with.catalog_id_ref     ==  catalog.id
 *   - encoder.built_with.catalog_atoms_sha256 == sha256(catalog data/atoms.json)
 *   - context.data.catalog_id_ref           ==  catalog.id
 *
 * If any check fails, the loader throws — no workflow runs against
 * inconsistent containers.
 *
 * See:
 *   github.com/C-0711/Quantum-Container/docs/QCP.md  (protocol)
 *   github.com/C-0711/Quantum-Container/docs/ARCHITECTURE.md (8 pillars)
 *   github.com/C-0711/Quantum-Container-Elster (reference containers)
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';

export interface ContainerEnvelope {
  id: string;
  schema_version: number;
  version: string;
  type: 'catalog' | 'product' | 'mandant' | 'case' | 'encoder' | 'context' | 'agent' | 'memory';
  namespace: string;
  identifier: string;
  display_name?: string;
  description?: string;
  created_at: string;
  lockState: 'draft' | 'sealed' | 'anchored' | 'retired';
  retired?: boolean;
  merkle_root?: string;
  container_sha256?: string;
  signature?: string | null;
  issuer_fingerprint?: string | null;
  anchor_chain?: string | null;
  anchor_block_number?: number | null;
  anchor_tx_hash?: string | null;
  qcp_version?: string;
}

export interface ContainerManifest extends ContainerEnvelope {
  data?: Record<string, unknown>;
  artifacts?: Record<string, { sha256: string; bytes: number }>;
  built_with?: {
    recipe?: string;
    recipe_version?: string;
    blueprint_tag?: string;
    catalog_id_ref?: string;
    catalog_atoms_sha256?: string;
  };
}

export interface ContainerSet {
  /** Schema marker for forward-compat. */
  schemaVersion: 1;
  /** Where the containers live on the local FS (relative to this set file's parent). */
  baseDir: string;
  catalog: { type: 'catalog'; version: string };
  encoder: { type: 'encoder'; version: string };
  context: { type: 'context'; version: string };
}

export interface LoadedDomain {
  set: ContainerSet;
  catalog: { manifest: ContainerManifest; localPath: string; atomsPath: string };
  encoder: {
    manifest: ContainerManifest;
    localPath: string;
    fp32Path: string;
    tierPaths: Record<string, string>;
    projectionSeedPath: string;
    cascadeManifestPath: string;
    metaPath: string;
  };
  context: { manifest: ContainerManifest; localPath: string; entriesPath: string };
}

async function sha256OfFile(p: string): Promise<string> {
  return createHash('sha256').update(await readFile(p)).digest('hex');
}

async function loadManifest(containerDir: string): Promise<ContainerManifest> {
  const path = join(containerDir, 'container.json');
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as ContainerManifest;
  } catch (e) {
    throw new Error(`QC_MANIFEST_UNREADABLE: ${path}: ${(e as Error).message}`);
  }
}

async function verifyArtifacts(
  containerDir: string,
  manifest: ContainerManifest,
): Promise<void> {
  if (!manifest.artifacts) return;
  for (const [relPath, info] of Object.entries(manifest.artifacts)) {
    if (info.bytes === -1) continue;
    const full = join(containerDir, relPath);
    let actual: string;
    try {
      actual = await sha256OfFile(full);
    } catch (e) {
      throw new Error(`QC_ARTIFACT_MISSING: ${manifest.id}@${manifest.version} → ${relPath}`);
    }
    if (actual !== info.sha256) {
      throw new Error(
        `QC_ARTIFACT_HASH_MISMATCH: ${manifest.id}@${manifest.version} → ${relPath}: expected ${info.sha256.slice(0,16)}… got ${actual.slice(0,16)}…`,
      );
    }
  }
}

function findTierFiles(encoderManifest: ContainerManifest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(encoderManifest.artifacts ?? {})) {
    const m = /tq-d(\d+)-b(\d+)\.bin$/.exec(name);
    if (m) out[`d${m[1]}_b${m[2]}`] = name; // value is the relative path string
  }
  return out;
}

/** Load a Quantum-Container "set" (catalog + encoder + context triple). */
export async function loadDomain(setPath: string): Promise<LoadedDomain> {
  const setAbs = resolvePath(setPath);
  let set: ContainerSet;
  try {
    set = JSON.parse(await readFile(setAbs, 'utf-8')) as ContainerSet;
  } catch (e) {
    throw new Error(`QC_SET_UNREADABLE: ${setAbs}: ${(e as Error).message}`);
  }
  if (set.schemaVersion !== 1) {
    throw new Error(`QC_SET_SCHEMA_UNSUPPORTED: schemaVersion=${set.schemaVersion}, expected 1`);
  }

  const setDir = resolvePath(setAbs, '..');
  const baseDir = resolvePath(setDir, set.baseDir);
  const catalogDir = join(baseDir, 'catalog', set.catalog.version);
  const encoderDir = join(baseDir, 'encoder', set.encoder.version);
  const contextDir = join(baseDir, 'context', set.context.version);

  // 1. Manifests
  const [catalogManifest, encoderManifest, contextManifest] = await Promise.all([
    loadManifest(catalogDir),
    loadManifest(encoderDir),
    loadManifest(contextDir),
  ]);

  // 2. Type assertions
  if (catalogManifest.type !== 'catalog')
    throw new Error(`QC_TYPE_MISMATCH: expected type=catalog, got ${catalogManifest.type}`);
  if (encoderManifest.type !== 'encoder')
    throw new Error(`QC_TYPE_MISMATCH: expected type=encoder, got ${encoderManifest.type}`);
  if (contextManifest.type !== 'context')
    throw new Error(`QC_TYPE_MISMATCH: expected type=context, got ${contextManifest.type}`);

  // 3. Cross-container consistency
  const encCatalogRef = encoderManifest.built_with?.catalog_id_ref;
  if (encCatalogRef && encCatalogRef !== catalogManifest.id) {
    throw new Error(
      `QC_CROSS_REF_MISMATCH: encoder.built_with.catalog_id_ref=${encCatalogRef} but catalog.id=${catalogManifest.id}`,
    );
  }

  const ctxCatalogRef = (contextManifest.data as { catalog_id_ref?: string } | undefined)?.catalog_id_ref;
  if (ctxCatalogRef && ctxCatalogRef !== catalogManifest.id) {
    throw new Error(
      `QC_CROSS_REF_MISMATCH: context.data.catalog_id_ref=${ctxCatalogRef} but catalog.id=${catalogManifest.id}`,
    );
  }

  // 4. atoms.json sha — must match what encoder was built against
  const atomsRel = 'data/atoms.json';
  const atomsPath = join(catalogDir, atomsRel);
  const atomsSha = await sha256OfFile(atomsPath);
  const declared = catalogManifest.artifacts?.[atomsRel]?.sha256;
  if (declared && declared !== atomsSha) {
    throw new Error(
      `QC_ARTIFACT_HASH_MISMATCH: catalog atoms.json drifted from manifest (${declared.slice(0,16)}… vs ${atomsSha.slice(0,16)}…)`,
    );
  }
  const expectedByEncoder = encoderManifest.built_with?.catalog_atoms_sha256;
  if (expectedByEncoder && expectedByEncoder !== atomsSha) {
    throw new Error(
      `QC_CROSS_REF_MISMATCH: encoder was built against atoms.json sha ${expectedByEncoder.slice(0,16)}… but loaded catalog has ${atomsSha.slice(0,16)}…`,
    );
  }

  // 5. Verify every artifact in each container
  await Promise.all([
    verifyArtifacts(catalogDir, catalogManifest),
    verifyArtifacts(encoderDir, encoderManifest),
    verifyArtifacts(contextDir, contextManifest),
  ]);

  // 6. Compose result
  const tiers = findTierFiles(encoderManifest);
  const tierPaths: Record<string, string> = {};
  for (const [k, rel] of Object.entries(tiers)) tierPaths[k] = join(encoderDir, rel);

  return {
    set,
    catalog: { manifest: catalogManifest, localPath: catalogDir, atomsPath },
    encoder: {
      manifest: encoderManifest,
      localPath: encoderDir,
      fp32Path: join(encoderDir, 'data/embeddings.gemma4.fp32.bin'),
      tierPaths,
      projectionSeedPath: join(encoderDir, 'data/embeddings.gemma4.projection_seed.bin'),
      cascadeManifestPath: join(encoderDir, 'data/embeddings.gemma4.cascade.json'),
      metaPath: join(encoderDir, 'data/embeddings.gemma4.meta.json'),
    },
    context: {
      manifest: contextManifest,
      localPath: contextDir,
      entriesPath: join(contextDir, 'data/citation-excerpts.json'),
    },
  };
}

/**
 * Process-wide cached load. Most callers want this — `loadDomain` is
 * pure and re-verifies sha256s on every call.
 */
let cachedDomain: LoadedDomain | null = null;
let cachedSetPath: string | null = null;

export async function getLoadedDomain(setPath: string): Promise<LoadedDomain> {
  const abs = resolvePath(setPath);
  if (cachedDomain && cachedSetPath === abs) return cachedDomain;
  const fresh = await loadDomain(abs);
  cachedDomain = fresh;
  cachedSetPath = abs;
  return fresh;
}
