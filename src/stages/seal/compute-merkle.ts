/**
 * seal/compute-merkle — deterministischer SHA256-Merkle-Tree über die
 * eCode → canonical_value-Einträge des master-Snapshots.
 *
 * Leaf-Format (sortiert nach eCode):
 *   sha256(   eCode + '\x1F' + canonical_json(value)   )
 *
 * Binary-Tree: paarweise concat + sha256; bei ungerader Anzahl wird das
 * letzte Element verdoppelt (Bitcoin-Konvention).
 *
 * Output: merkle_root (hex) + leaf_count + sortierte eCode-Liste. Wird in
 * master.merkle eingefügt von der nächsten Stage.
 */
import { createHash } from 'node:crypto';
import { defineStage } from '../../core/stage.ts';
import type { MasterSnapshot } from './collect-snapshot.ts';

export interface ComputeMerkleInput {
  master: MasterSnapshot;
}

export interface ComputeMerkleOutput {
  master: MasterSnapshot & {
    merkle: {
      root: string;
      leafCount: number;
      algorithm: 'sha256';
      leafSchema: 'sha256(eCode + 0x1F + canonical_json(value))';
      sortedECodes: string[];
    };
  };
}

function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson((v as Record<string, unknown>)[k])).join(',') + '}';
}

function sha256Hex(buf: Buffer | string): string {
  const h = createHash('sha256');
  h.update(buf);
  return h.digest('hex');
}

function merkleRoot(leafHashes: string[]): string {
  if (leafHashes.length === 0) return sha256Hex('');
  let level = leafHashes.slice();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = level[i + 1] ?? a; // verdoppele letztes bei ungerader Anzahl
      next.push(sha256Hex(Buffer.concat([Buffer.from(a, 'hex'), Buffer.from(b, 'hex')])));
    }
    level = next;
  }
  return level[0];
}

export const computeMerkleStage = defineStage<
  ComputeMerkleInput,
  ComputeMerkleOutput,
  Record<string, never>
>({
  id: 'seal/compute-merkle',
  name: 'Seal · Compute Merkle',
  description:
    'SHA256-Merkle-Tree über die sortierten eCode-Leaves des master-Snapshots. ' +
    'Leaf = sha256(eCode + 0x1F + canonical_json(value)). Output: merkle.root ' +
    '+ leafCount, in master.merkle gemergt.',
  hints: { inputs: 'master', outputs: 'master (mit merkle-Block ergänzt)' },
  async run(input, ctx) {
    const master = input.master;
    if (!master || typeof master !== 'object') {
      throw new Error('seal/compute-merkle: input.master required');
    }
    const eCodes = Object.keys(master.canonical_layer).sort();
    const leafHashes = eCodes.map((c) => sha256Hex(`${c}${canonicalJson(master.canonical_layer[c])}`));
    const root = merkleRoot(leafHashes);
    const enriched = {
      ...master,
      merkle: {
        root,
        leafCount: eCodes.length,
        algorithm: 'sha256' as const,
        leafSchema: 'sha256(eCode + 0x1F + canonical_json(value))' as const,
        sortedECodes: eCodes,
      },
    };
    await ctx.artifacts.write('master.with-merkle.json', enriched);
    ctx.emit('merkle_computed', { root, leafCount: eCodes.length });
    return { master: enriched };
  },
});
