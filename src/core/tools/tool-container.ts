/**
 * STURM — Tool-Binding Phase P2: ToolContainer.
 *
 * Pro Anwendung wird ein `ToolContainer` gebaut, der das `ToolRef[]`-Roster
 * in instanziierte, callable `ToolHandle`s übersetzt. Stages erhalten den
 * Container in P4 via `ctx.tools`.
 *
 * Boot-Schritte (siehe `forApplication`):
 *   1. `resolveTools(app)` liefert das effektive Roster.
 *   2. Jeder Ref wird sequenziell durch seinen kind-spezifischen Resolver
 *      gejagt (Reihenfolge im Boot-Log preserved).
 *   3. `health()` parallel über `Promise.allSettled`.
 *   4. Wenn ein required-Tool `alive=false`, wirft `ToolBootError`.
 *   5. roleIndex aus `ref.roles` aufbauen.
 *   6. Roster-Tabelle auf stdout drucken.
 */

import type { ApplicationDef } from '../application.ts';
import { resolveTools } from '../application.ts';
import { listApplications } from '../registry.ts';
import type { ToolContainerView, ToolHealth, ToolRef } from './types.ts';
import type { ToolHandle } from './handles.ts';

import { resolveLlm } from './resolvers/llm.ts';
import { resolveEmbedder } from './resolvers/embedder.ts';
import { resolveRagIndex } from './resolvers/rag-index.ts';
import { resolveMcp } from './resolvers/mcp.ts';
import { resolveGitchain } from './resolvers/gitchain.ts';
import { resolveCatalog } from './resolvers/catalog.ts';
import { resolveKv } from './resolvers/kv.ts';
import { ToolBootError } from './circuit-error.ts';

export { ToolBootError };

// ── Resolver-Tabelle (DI-friendly) ─────────────────────────────────────

export interface Resolvers {
  llm: (r: ToolRef & { kind: 'llm' }) => Promise<ToolHandle>;
  embedder: (r: ToolRef & { kind: 'embedder' }) => Promise<ToolHandle>;
  'rag-index': (r: ToolRef & { kind: 'rag-index' }) => Promise<ToolHandle>;
  mcp: (r: ToolRef & { kind: 'mcp' }) => Promise<ToolHandle>;
  gitchain: (r: ToolRef & { kind: 'gitchain' }) => Promise<ToolHandle>;
  catalog: (r: ToolRef & { kind: 'catalog' }) => Promise<ToolHandle>;
  kv: (r: ToolRef & { kind: 'kv' }) => Promise<ToolHandle>;
}

const DEFAULT_RESOLVERS: Resolvers = {
  llm: resolveLlm,
  embedder: resolveEmbedder,
  'rag-index': resolveRagIndex,
  mcp: resolveMcp,
  gitchain: resolveGitchain,
  catalog: resolveCatalog,
  kv: resolveKv,
};

// ── Container ──────────────────────────────────────────────────────────

export class ToolContainer implements ToolContainerView {
  private constructor(
    public readonly applicationId: string,
    private readonly handles: ReadonlyMap<string, ToolHandle>,
    private readonly roleIndex: ReadonlyMap<string, ToolHandle[]>,
  ) {}

  static async forApplication(
    app: ApplicationDef,
    opts: { resolverOverrides?: Partial<Resolvers>; silent?: boolean } = {},
  ): Promise<ToolContainer> {
    const resolvers: Resolvers = { ...DEFAULT_RESOLVERS, ...opts.resolverOverrides };
    const refs = resolveTools(app);

    // Schritt 2 — sequentiell auflösen, damit Boot-Log deterministisch ist.
    const handles: ToolHandle[] = [];
    for (const ref of refs) {
      const resolver = resolvers[ref.kind] as (r: ToolRef) => Promise<ToolHandle>;
      if (!resolver) {
        throw new ToolBootError(
          app.id,
          ref.name,
          `no resolver for kind '${ref.kind}'`,
        );
      }
      try {
        const h = await resolver(ref);
        handles.push(h);
      } catch (e) {
        // Resolver-Fehler IST tödlich — wir können den Handle nicht bauen.
        throw new ToolBootError(
          app.id,
          ref.name,
          `resolver for '${ref.name}' (${ref.kind}) failed: ${(e as Error).message}`,
        );
      }
    }

    // Schritt 3 — parallel health-check.
    const healthResults = await Promise.allSettled(handles.map((h) => h.health()));
    const healths: ToolHealth[] = healthResults.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      const ref = refs[i];
      return {
        name: ref.name,
        kind: ref.kind,
        configured: false,
        alive: false,
        lastError: `health() threw: ${(r.reason as Error).message}`,
      };
    });

    // Schritt 4 — required + nicht alive → boom.
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      const hh = healths[i];
      if (ref.required && !hh.alive) {
        throw new ToolBootError(
          app.id,
          ref.name,
          `required tool '${ref.name}' (${ref.kind}) unreachable: ${hh.lastError ?? 'no detail'}`,
          hh,
        );
      }
    }

    // Schritt 5 — Maps bauen.
    const byName = new Map<string, ToolHandle>();
    const byRole = new Map<string, ToolHandle[]>();
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      const handle = handles[i];
      if (byName.has(ref.name)) {
        throw new ToolBootError(
          app.id,
          ref.name,
          `duplicate tool name '${ref.name}'`,
        );
      }
      byName.set(ref.name, handle);
      for (const role of ref.roles ?? []) {
        const arr = byRole.get(role) ?? [];
        arr.push(handle);
        byRole.set(role, arr);
      }
    }

    // Schritt 6 — Roster-Tabelle drucken.
    if (!opts.silent) printRoster(app.id, refs, healths);

    return new ToolContainer(app.id, byName, byRole);
  }

  static async bootAll(
    opts: { silent?: boolean; resolverOverrides?: Partial<Resolvers> } = {},
  ): Promise<Map<string, ToolContainer>> {
    const out = new Map<string, ToolContainer>();
    for (const app of listApplications()) {
      const c = await ToolContainer.forApplication(app, opts);
      out.set(app.id, c);
      _containers.set(app.id, c);
    }
    return out;
  }

  get<T = ToolHandle>(name: string): T {
    const h = this.handles.get(name);
    if (!h) {
      throw new Error(
        `[tools:${this.applicationId}] no tool '${name}' (available: ${this.toolNames.join(', ')})`,
      );
    }
    return h as unknown as T;
  }

  getByRole<T = ToolHandle>(role: string): T {
    const arr = this.roleIndex.get(role);
    if (!arr || arr.length === 0) {
      throw new Error(
        `[tools:${this.applicationId}] no tool with role '${role}'`,
      );
    }
    return arr[0] as unknown as T;
  }

  getAllByRole<T = ToolHandle>(role: string): T[] {
    return (this.roleIndex.get(role) ?? []) as unknown as T[];
  }

  has(name: string): boolean {
    return this.handles.has(name);
  }

  async healthAll(): Promise<Record<string, ToolHealth>> {
    const names = Array.from(this.handles.keys());
    const results = await Promise.allSettled(names.map((n) => this.handles.get(n)!.health()));
    const out: Record<string, ToolHealth> = {};
    for (let i = 0; i < names.length; i++) {
      const n = names[i];
      const r = results[i];
      const handle = this.handles.get(n)!;
      out[n] = r.status === 'fulfilled' ? r.value : {
        name: n,
        kind: handle.kind,
        configured: false,
        alive: false,
        lastError: `health() threw: ${(r.reason as Error).message}`,
      };
    }
    return out;
  }

  async shutdown(): Promise<void> {
    // P2: no per-handle dispose API. P3+ kann hier circuit-breaker timers etc.
    // schließen. No-op halten, damit Caller den Hook schon nutzen können.
  }

  get toolNames(): readonly string[] {
    return Array.from(this.handles.keys());
  }
}

// ── Modul-Scope-Registry für getToolContainer() ────────────────────────

const _containers = new Map<string, ToolContainer>();

export function getToolContainer(appId: string): ToolContainer | undefined {
  return _containers.get(appId);
}

/** Nur für Tests. */
export function _resetToolContainers(): void {
  _containers.clear();
}

// ── Roster-Tabelle ─────────────────────────────────────────────────────

function printRoster(appId: string, refs: ToolRef[], healths: ToolHealth[]): void {
  const lines: string[] = [];
  lines.push(`[tools:${appId}] roster (${refs.length} Werkzeug${refs.length === 1 ? '' : 'e'})`);
  // Column widths
  const nameW = Math.max(4, ...refs.map((r) => r.name.length));
  const kindW = Math.max(4, ...refs.map((r) => r.kind.length));
  for (let i = 0; i < refs.length; i++) {
    const r = refs[i];
    const h = healths[i];
    const marker = h.alive ? '●' : h.configured ? '✕' : '○';
    const latency = h.latencyMs !== undefined ? `${String(h.latencyMs).padStart(4)}ms` : '   - ms';
    const roles = (r.roles ?? []).join(',') || '-';
    const detail = !h.alive && h.lastError ? `  ${h.lastError}` : '';
    lines.push(
      `  ${marker} ${r.name.padEnd(nameW)}  ${r.kind.padEnd(kindW)}  ${latency}  ${roles}${detail}`,
    );
  }
  console.log(lines.join('\n'));
}
