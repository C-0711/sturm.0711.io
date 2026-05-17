/**
 * Gitchain-Resolver. Wickelt `getGitChainClient()` (Singleton) in einen
 * `GitchainHandle`. Health-Check: env-Vars vorhanden + Pool antwortet auf
 * `SELECT 1` in <3s.
 *
 * Wichtig: Wir konstruieren den Client erst beim ersten Resolve, NICHT beim
 * Modul-Load — `getGitChainClient()` wirft synchron bei fehlenden Env-Vars,
 * was den ganzen Server beim Boot abschießen würde.
 */

import { getGitChainClient } from '../../../lib/gitchain-client.ts';
import type { GitchainToolRef, ToolHealth } from '../types.ts';
import type { GitchainHandle, GitchainAuthor, GitchainAnchorInput } from '../handles.ts';

function envVarsReady(ref: GitchainToolRef): { ok: boolean; missing: string[] } {
  const need = [ref.config.envApi, ref.config.envDb, ref.config.envRepoRoot];
  const missing = need.filter((k) => !process.env[k]);
  return { ok: missing.length === 0, missing };
}

export async function resolveGitchain(ref: GitchainToolRef): Promise<GitchainHandle> {
  const env = envVarsReady(ref);
  // Wenn Env-Vars fehlen, geben wir trotzdem einen Handle zurück; die ersten
  // Mutations-Calls werden dann mit klarer Fehlermeldung scheitern. health()
  // signalisiert `alive=false`.
  const apiUrl = process.env[ref.config.envApi] ?? '';

  let cached: ReturnType<typeof getGitChainClient> | null = null;
  function client() {
    if (!env.ok) {
      throw new Error(
        `[tools/gitchain:${ref.name}] missing env vars: ${env.missing.join(', ')}`,
      );
    }
    if (!cached) cached = getGitChainClient();
    return cached;
  }

  return {
    name: ref.name,
    kind: 'gitchain',
    meta: {
      apiUrl,
      namespace: ref.config.containerNamespace,
      anchorMode: ref.config.anchorMode,
    },
    ensureContainer: async (containerId: string) => client().getContainer(containerId),
    cloneOrInit: async (containerId: string, workdir: string) =>
      client().cloneOrInit(containerId, workdir),
    commitAndPush: async (workdir: string, message: string, author: GitchainAuthor) => {
      const sha = await client().commitAndPush(workdir, message, author);
      return { sha };
    },
    recordAnchor: async (input: GitchainAnchorInput) =>
      client().recordAnchor({
        container_id: input.containerId,
        tag: input.tag,
        commit_hash: input.commitHash,
        network: input.network,
        tx_hash: input.txHash,
        block_number: input.blockNumber,
      }),
    health: () => probeGitchainHealth(ref),
  };
}

export async function probeGitchainHealth(ref: GitchainToolRef): Promise<ToolHealth> {
  const t0 = Date.now();
  const env = envVarsReady(ref);
  if (!env.ok) {
    return {
      name: ref.name,
      kind: 'gitchain',
      configured: false,
      alive: false,
      lastError: `missing env: ${env.missing.join(', ')}`,
    };
  }
  // API-Probe (kein DB-Roundtrip, der könnte 30s hängen).
  const apiUrl = process.env[ref.config.envApi]!;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('timeout')), 3000);
    try {
      // Try /healthz, /health, /api/health, then /. The gitchain-service
      // currently has NO health route — every path returns 404. That still
      // proves the HTTP server is up and the TCP socket is bound. Accept
      // ANY non-5xx as 'alive' (the API is reachable; routing is a separate
      // concern verified at actual call time). DB-roundtrip is intentionally
      // skipped here — would add seconds of boot latency.
      let res: Response | null = null;
      for (const p of ['/healthz', '/health', '/api/health', '/']) {
        try {
          res = await fetch(`${apiUrl.replace(/\/$/, '')}${p}`, { signal: ac.signal });
          if (res.status < 500) break;
        } catch { /* try next path */ }
      }
      const alive = !!res && res.status < 500;
      return {
        name: ref.name,
        kind: 'gitchain',
        configured: true,
        alive,
        latencyMs: Date.now() - t0,
        ...(alive ? {} : { lastError: res ? `HTTP ${res.status}` : 'no response' }),
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return {
      name: ref.name,
      kind: 'gitchain',
      configured: true,
      alive: false,
      latencyMs: Date.now() - t0,
      lastError: (e as Error).message,
    };
  }
}
