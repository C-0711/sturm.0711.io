/**
 * STURM — Tool-Binding Phase P1: Type-Level Schema
 *
 * Eine `Anwendung` (Application) deklariert ihren benötigten Werkzeug-Kasten
 * als roster von `ToolRef[]`. Stages erhalten Werkzeuge via
 * `ctx.tools.get(name)` oder `ctx.tools.getByRole(role)` (Implementierung in
 * P2/P4 — hier nur die Typen).
 *
 * Keine Runtime-Logik in dieser Datei: ausschließlich Schemas und
 * type-only Interfaces. Validierung, Health-Probing und Container-Bau passieren
 * in P2.
 */

export type ToolKind =
  | 'llm' | 'embedder' | 'rag-index'
  | 'mcp' | 'gitchain' | 'catalog' | 'kv';

export interface ToolRefBase {
  /** Logischer Name; wird von `ctx.tools.get(name)` benutzt. */
  name: string;
  kind: ToolKind;
  /** Pflicht-Tool → Boot der Anwendung schlägt fehl, wenn nicht erreichbar. */
  required: boolean;
  /** Keepalive + Circuit-Breaker (Implementierung in P3). */
  alwaysOn?: boolean;
  /** Logische Rollen für `ctx.tools.getByRole(role)`. */
  roles?: string[];
}

// ── Discriminated-Union pro `kind` ──────────────────────────────────────

export type LlmToolRef = ToolRefBase & {
  kind: 'llm';
  config: {
    provider: 'vllm' | 'mistral' | 'anthropic' | 'ollama';
    baseUrl?: string;
    /** Resolve order: envBaseUrl → baseUrl → provider default. */
    envBaseUrl?: string;
    model: string;
    defaultTemperature?: number;
    jsonMode: 'json_schema' | 'json_object' | 'none';
  };
};

export type EmbedderToolRef = ToolRefBase & {
  kind: 'embedder';
  config: {
    provider: 'ollama' | 'mistral';
    model: string;
    matryoshka?: number[];
    cpuOnly?: boolean;
  };
};

export type RagIndexToolRef = ToolRefBase & {
  kind: 'rag-index';
  config: {
    containerId: string;
    manifest: string;
    strategy: 'turboquant-cascade';
    tiers: Array<'d128' | 'd256' | 'd768' | 'fp32'>;
    topK: Partial<Record<'d128' | 'd256' | 'd768' | 'fp32', number>>;
  };
};

export type McpToolRef = ToolRefBase & {
  kind: 'mcp';
  config: {
    envUrl: string;
    defaultUrl?: string;
    tools: string[];
    timeoutMs?: number;
  };
};

export type GitchainToolRef = ToolRefBase & {
  kind: 'gitchain';
  config: {
    envApi: string;
    envDb: string;
    envRepoRoot: string;
    containerNamespace: string;
    anchorMode: 'per-stage' | 'per-run' | 'on-seal-only';
  };
};

export type CatalogToolRef = ToolRefBase & {
  kind: 'catalog';
  config: {
    containerId: string;
    files: { atoms?: string; container?: string; nested?: string };
  };
};

export type KvToolRef = ToolRefBase & {
  kind: 'kv';
  config: { backend: 'postgres' | 'redis'; envUrl: string };
};

export type ToolRef =
  | LlmToolRef | EmbedderToolRef | RagIndexToolRef
  | McpToolRef | GitchainToolRef | CatalogToolRef | KvToolRef;

/** Health snapshot — populated by ToolContainer in P2; types ship now. */
export interface ToolHealth {
  name: string;
  kind: ToolKind;
  configured: boolean;
  alive: boolean;
  latencyMs?: number;
  circuit?: 'closed' | 'half-open' | 'open';
  lastError?: string;
}

/** Stage-facing view of the container — implementation is P2/P4. */
export interface ToolContainerView {
  get<T = unknown>(name: string): T;
  getByRole<T = unknown>(role: string): T;
  getAllByRole<T = unknown>(role: string): T[];
  has(name: string): boolean;
}
