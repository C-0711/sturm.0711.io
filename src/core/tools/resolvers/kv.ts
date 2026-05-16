/**
 * KV-Resolver (Stub). Postgres + Redis kommen erst, wenn ein Stage es
 * wirklich braucht. Bis dahin liefert der Resolver einen gültigen Handle, der
 * `query`/`cmd` mit "not yet implemented" wirft — Containern mit `kv` Tools
 * scheitert nicht der Boot.
 *
 * `health()` testet nur die env-Variable; eine echte Connection-Probe würde
 * pg/redis-Driver erfordern (vermeiden wir solange keine Konsumenten existieren).
 */

import type { KvToolRef, ToolHealth } from '../types.ts';
import type { KvHandle } from '../handles.ts';

export async function resolveKv(ref: KvToolRef): Promise<KvHandle> {
  const url = process.env[ref.config.envUrl] ?? '';

  return {
    name: ref.name,
    kind: 'kv',
    meta: { backend: ref.config.backend, url: url || '(unset)' },
    query: async () => {
      throw new Error(`[kv:${ref.name}] query() not yet implemented (P2 stub)`);
    },
    cmd: async () => {
      throw new Error(`[kv:${ref.name}] cmd() not yet implemented (P2 stub)`);
    },
    health: () => probeKvHealth(ref),
  };
}

export async function probeKvHealth(ref: KvToolRef): Promise<ToolHealth> {
  const url = process.env[ref.config.envUrl];
  const configured = !!url;
  return {
    name: ref.name,
    kind: 'kv',
    configured,
    alive: configured, // P2-Stub: vorhandene URL = "alive". Echte Probe in P3+.
    ...(configured ? {} : { lastError: `env ${ref.config.envUrl} unset` }),
  };
}
