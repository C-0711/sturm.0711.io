/**
 * Reads the v5.1-shape ELSTER gitchain container from
 * src/verticals/elster-v3/data/. Provides:
 *   - container metadata (id, version, merkle_root, anchor info)
 *   - atom catalog (2287 ELSTER eCodes as v3-compatible atoms)
 *   - bge-m3 embedding index (1024-dim, fp32 binary blob)
 *
 * This module is the v3 analog of v2's elster-katalog.ts, but the atoms come
 * from a content-addressed container (with merkle root) instead of from
 * preprocessed JSON dumps. When the container is anchored on Base mainnet,
 * the canonical layer's `producedAgainst` field can cite the on-chain tx.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IndexEntry } from '../../../lib/embedding-runtime.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'data');

export interface ElsterAtom {
  atom_id: string;
  container_id: string;
  layer_id: string;
  field_path: string;            // 'elster.E0200201'
  field_name: string;            // 'E0200201'
  value: string;                 // bezeichnung
  value_type: string;
  lang: string;
  citation_document: string;
  citation_section: string;
  citation_excerpt: string;
  citation_confidence: number;
  citation_method: string;
  trust_level: string;
  source_type: string;
  contributor_id: string;
  commit_hash: string;
  metadata: {
    anlage: string;
    datentyp: string;
    pflicht: boolean;
    vordruckzeile: string;
    drucktext: string;
    formatRegex: string | null;
    formatkennzeichen: string | null;
    maxLaenge: number | null;
    minLaenge: number | null;
    kontextPaths: string[];
  };
}

export interface ElsterContainer {
  id: string;
  schema_version: number;
  version: string;
  type: string;
  namespace: string;
  identifier: string;
  display_name: string;
  description: string;
  catalog_version: string;
  created_at: string;
  updated_at: string;
  stats: {
    atoms_total: number;
    anlagen_count: number;
    pflicht_codes: number;
    datentyp_distribution: Record<string, number>;
  };
  merkle_root: string;
  container_sha256: string;
  embeddings: { model: string; provider: string; dim: number; count: number };
  signature: string | null;
  anchor_block_number: number | null;
  anchor_tx_hash: string | null;
  anchor_chain: string | null;
  issuer_fingerprint: string | null;
}

export interface ElsterV3Bundle {
  container: ElsterContainer;
  atoms: ElsterAtom[];
  byCode: Map<string, ElsterAtom>;
  byAnlage: Map<string, ElsterAtom[]>;
  embeddings: IndexEntry[];     // one per atom in the same order
  embeddingDim: number;
}

let cache: Promise<ElsterV3Bundle> | null = null;

export async function loadV3Bundle(): Promise<ElsterV3Bundle> {
  if (cache) return cache;
  cache = (async () => {
    const container = JSON.parse(await readFile(join(DATA, 'container.json'), 'utf-8')) as ElsterContainer;
    const atoms = JSON.parse(await readFile(join(DATA, 'atoms.json'), 'utf-8')) as ElsterAtom[];
    const meta = JSON.parse(await readFile(join(DATA, 'embeddings.meta.json'), 'utf-8')) as {
      dim: number; count: number; model: string; provider: string;
      atoms: Array<{ atom_id: string; field_name: string }>;
    };
    const buf = await readFile(join(DATA, 'embeddings.fp32.bin'));
    if (buf.length !== meta.count * meta.dim * 4) {
      throw new Error(`embeddings.fp32.bin size ${buf.length} ≠ ${meta.count}×${meta.dim}×4`);
    }
    const f32 = new Float32Array(buf.buffer, buf.byteOffset, meta.count * meta.dim);
    const embeddings: IndexEntry[] = atoms.map((a, i) => ({
      id: a.field_name,
      vector: f32.subarray(i * meta.dim, (i + 1) * meta.dim),
      meta: { atom_id: a.atom_id, anlage: a.metadata.anlage },
    }));
    const byCode = new Map(atoms.map((a) => [a.field_name, a]));
    const byAnlage = new Map<string, ElsterAtom[]>();
    for (const a of atoms) {
      const list = byAnlage.get(a.metadata.anlage) ?? [];
      list.push(a);
      byAnlage.set(a.metadata.anlage, list);
    }
    return { container, atoms, byCode, byAnlage, embeddings, embeddingDim: meta.dim };
  })();
  return cache;
}

/** "Produced-against" reference embedded in canonical layer for audit. */
export function producedAgainstRef(container: ElsterContainer): {
  containerId: string; merkleRoot: string; sha256: string;
  anchored: boolean; anchorTx: string | null; anchorBlock: number | null;
} {
  return {
    containerId: container.id,
    merkleRoot: container.merkle_root,
    sha256: container.container_sha256,
    anchored: !!container.anchor_tx_hash,
    anchorTx: container.anchor_tx_hash,
    anchorBlock: container.anchor_block_number,
  };
}
