import { defineStage } from '../core/stage.ts';
import type { FanoutOutput } from './compare-fanout.ts';

export type MergePolicy =
  | 'keep-all'       // pass through fanout shape unchanged
  | 'first-success'  // first branch (insertion order) without error wins
  | 'fastest'        // branch with lowest perBranchMs wins
  | 'pick'           // explicit branchId via config.pickBranch
  | 'vote';          // field-wise majority vote across all branches

export interface MergeConfig {
  policy?: MergePolicy;
  /** Required when policy === 'pick'. */
  pickBranch?: string;
}

export interface VoteFieldReport {
  winner: string;
  votes: Record<string, string[]>;
  agreement: number;
}

export interface MergeOutput {
  policy: MergePolicy;
  /** branchId chosen (null when policy=keep-all or policy=vote). */
  picked: string | null;
  /** Chosen branch output (null when policy=keep-all). For vote: reconstructed nested object. */
  chosen: unknown;
  /** Per-field vote breakdown; only present when policy=vote. */
  voteReport?: Record<string, VoteFieldReport>;
  /** Always echoed for downstream KPI access. */
  fanout: FanoutOutput;
}

function flattenToValues(obj: unknown, out: Record<string, string> = {}, prefix = ''): Record<string, string> {
  if (obj == null) return out;
  if (typeof obj !== 'object') {
    if (prefix) out[prefix] = String(obj);
    return out;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => flattenToValues(v, out, prefix ? `${prefix}[${i}]` : `[${i}]`));
    return out;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object') {
      flattenToValues(v, out, key);
    } else if (v !== undefined && v !== null && v !== '') {
      out[key] = String(v);
    }
  }
  return out;
}

function setByDottedPath(root: Record<string, unknown>, dotted: string, value: string): void {
  // Supports `a.b.c` and `a.b[0].c` paths produced by flattenToValues.
  const tokens: Array<{ key: string; isIndex: boolean }> = [];
  const parts = dotted.split('.');
  for (const part of parts) {
    const re = /([^[\]]+)|\[(\d+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(part)) !== null) {
      if (m[1] !== undefined) tokens.push({ key: m[1], isIndex: false });
      else if (m[2] !== undefined) tokens.push({ key: m[2], isIndex: true });
    }
  }
  let cur: any = root;
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];
    const wantArray = next.isIndex;
    if (t.isIndex) {
      const idx = Number(t.key);
      if (cur[idx] == null) cur[idx] = wantArray ? [] : {};
      cur = cur[idx];
    } else {
      if (cur[t.key] == null) cur[t.key] = wantArray ? [] : {};
      cur = cur[t.key];
    }
  }
  const last = tokens[tokens.length - 1];
  if (last.isIndex) cur[Number(last.key)] = value;
  else cur[last.key] = value;
}

/**
 * compare/merge — collapses fanout output by a policy.
 *
 * Input shape: the entire FanoutOutput from a compare/fanout upstream.
 * Output: under policy=keep-all, `chosen=null` and downstream stages read
 * `fanout.branches.<branchId>` directly; under first-success/fastest/pick,
 * `chosen` is the selected branch's raw output for transparent passthrough.
 * Under policy=vote, `picked=null` and `chosen` is a nested object built from
 * the per-field majority vote; `voteReport` exposes the tally per leaf key.
 */
export const compareMergeStage = defineStage<FanoutOutput, MergeOutput, MergeConfig>({
  id: 'compare/merge',
  name: 'Merge — collapse fanout by policy',
  description:
    'Collapses a compare/fanout output. Policies: keep-all (passthrough), ' +
    'first-success, fastest, pick (explicit branchId), vote (field-wise majority).',
  hints: {
    inputs: 'branches, perBranchMs, errors, ms — from an upstream compare/fanout',
    outputs: 'policy, picked|null, chosen|null, fanout, voteReport? (only for policy=vote)',
    configExample: '{"policy": "keep-all"}  // or "first-success" | "fastest" | "vote" | {"policy":"pick","pickBranch":"X"}',
    inputPorts: [
      { name: 'branches', type: 'branches', description: 'From compare/fanout' },
    ],
    outputPorts: [
      { name: 'chosen', type: 'any', description: 'Selected branch output, null for keep-all' },
      { name: 'fanout', type: 'branches', description: 'Echoed for downstream KPI' },
    ],
  },

  async run(input, ctx) {
    if (!input || typeof input !== 'object' || !('branches' in input)) {
      throw new Error('compare/merge: input must be a compare/fanout output');
    }
    const policy: MergePolicy = ctx.config?.policy ?? 'keep-all';
    const fanout = input;
    const branchIds = Object.keys(fanout.branches);

    let picked: string | null = null;
    let chosen: unknown = null;
    let voteReport: Record<string, VoteFieldReport> | undefined;

    switch (policy) {
      case 'keep-all':
        break;
      case 'first-success':
        for (const id of branchIds) {
          if (!fanout.errors[id]) { picked = id; break; }
        }
        chosen = picked ? fanout.branches[picked] : null;
        break;
      case 'fastest': {
        let best: { id: string; ms: number } | null = null;
        for (const id of branchIds) {
          if (fanout.errors[id]) continue;
          const ms = fanout.perBranchMs[id] ?? Infinity;
          if (!best || ms < best.ms) best = { id, ms };
        }
        picked = best?.id ?? null;
        chosen = picked ? fanout.branches[picked] : null;
        break;
      }
      case 'pick': {
        const want = ctx.config?.pickBranch;
        if (!want) throw new Error('compare/merge: policy=pick requires config.pickBranch');
        if (!(want in fanout.branches)) {
          throw new Error(`compare/merge: pickBranch "${want}" not in fanout.branches`);
        }
        picked = want;
        chosen = fanout.branches[want];
        break;
      }
      case 'vote': {
        // Ignore failed branches entirely.
        const eligible = branchIds.filter((id) => !fanout.errors[id]);
        const perBranchFlat: Record<string, Record<string, string>> = {};
        const allKeys = new Set<string>();
        for (const id of eligible) {
          const flat = flattenToValues(fanout.branches[id]);
          perBranchFlat[id] = flat;
          for (const k of Object.keys(flat)) allKeys.add(k);
        }
        voteReport = {};
        const reconstructed: Record<string, unknown> = {};
        for (const key of allKeys) {
          const votes: Record<string, string[]> = {};
          let presentCount = 0;
          for (const id of eligible) {
            const v = perBranchFlat[id]?.[key];
            if (v === undefined) continue;
            presentCount += 1;
            (votes[v] ??= []).push(id);
          }
          // Determine the winner: most votes; ties broken by the value coming
          // from the fastest branch (lowest perBranchMs among the tied value's voters).
          let winner: string | null = null;
          let winnerCount = -1;
          let winnerFastestMs = Infinity;
          for (const [value, voters] of Object.entries(votes)) {
            const count = voters.length;
            const fastestMs = voters.reduce((acc, id) => {
              const ms = fanout.perBranchMs[id] ?? Infinity;
              return ms < acc ? ms : acc;
            }, Infinity);
            if (count > winnerCount || (count === winnerCount && fastestMs < winnerFastestMs)) {
              winner = value;
              winnerCount = count;
              winnerFastestMs = fastestMs;
            }
          }
          if (winner === null) continue;
          const agreement = presentCount === 0 ? 0 : winnerCount / presentCount;
          voteReport[key] = { winner, votes, agreement };
          setByDottedPath(reconstructed, key, winner);
        }
        picked = null;
        chosen = reconstructed;
        break;
      }
    }

    ctx.emit('merge_done', { policy, picked });
    return { policy, picked, chosen, fanout, ...(voteReport ? { voteReport } : {}) };
  },
});
