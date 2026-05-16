/**
 * STURM — Tool-Binding Phase P2: Per-kind Handle Interfaces.
 *
 * Jeder Handle wickelt eine bestehende lib/-Funktion in eine schmale,
 * kind-spezifische API + `health()`-Methode. Handles werden vom
 * `ToolContainer` (siehe `tool-container.ts`) per Resolver instanziert; Stages
 * erreichen sie via `ctx.tools.get(name)` (P4).
 *
 * Wichtig: Handles enthalten KEINE Pipeline-/Stage-Logik — sie sind nur
 * Verpackung um `src/lib/*`. Wer hier neue Methoden hinzufügt, sollte sich
 * fragen, ob das nicht eher in der lib/ leben sollte.
 */

import type { ToolHealth, ToolKind } from './types.ts';

export interface BaseHandle {
  readonly name: string;
  readonly kind: ToolKind;
  health(): Promise<ToolHealth>;
}

// ── LLM ────────────────────────────────────────────────────────────────

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export interface LlmChatOptions {
  /** Optional JSON-Schema für constrained decoding (vLLM/Mistral best effort). */
  schema?: { name?: string; schema: Record<string, unknown>; strict?: boolean } | Record<string, unknown>;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LlmHandle extends BaseHandle {
  kind: 'llm';
  /**
   * Ruft `chatJson` mit dem konfigurierten Provider/Modell auf. Akzeptiert
   * entweder einen String-Prompt oder ein Messages-Array; die Messages werden
   * zu System+User aufgesplittet (vLLM/Mistral haben volle Multi-Turn-Support).
   * Rückgabe: das geparste JSON-Objekt (nicht der gesamte ChatJsonResult).
   */
  chatJson<T = unknown>(prompt: string | ChatMessage[], opts?: LlmChatOptions): Promise<T>;
  readonly meta: { provider: 'vllm' | 'mistral' | 'anthropic' | 'ollama'; model: string };
}

// ── Embedder ───────────────────────────────────────────────────────────

export interface EmbedderHandle extends BaseHandle {
  kind: 'embedder';
  /**
   * Embed einen oder mehrere Texte. Rückgabe: ein 2D-Array (Anzahl × Dim).
   * Bei `dim` wird Matryoshka-Truncation auf die Ziel-Dim (mit L2-Renorm)
   * angewandt — nur sinnvoll für EmbeddingGemma (768→512/256/128).
   */
  embed(text: string | string[], opts?: { dim?: number; signal?: AbortSignal }): Promise<number[][]>;
  readonly meta: { provider: 'ollama' | 'mistral'; model: string };
}

// ── RAG-Index ──────────────────────────────────────────────────────────

export interface RagHit {
  id: string;
  score: number;
  payload?: Record<string, unknown>;
}

export interface RagIndexHandle extends BaseHandle {
  kind: 'rag-index';
  /**
   * Single-Tier-Retrieval. Wenn `query` ein String ist, wird er erst embedded;
   * wenn ein number[], wird der Vektor direkt benutzt (muss zur Native-Dim
   * passen). `tier` wählt den Index-Tier; ohne Angabe wird der Cascade-Mode
   * genutzt.
   */
  retrieve(
    query: string | number[],
    opts?: { topK?: number; tier?: 'd128' | 'd256' | 'd768' | 'fp32'; signal?: AbortSignal },
  ): Promise<RagHit[]>;
  /**
   * Vollständiger Matryoshka×TurboQuant-Cascade-Lauf — coarse → fine → optional
   * fp32-Rerank. Sollte für die meisten Retrieval-Use-Cases der Default-Pfad sein.
   */
  retrieveCascade(query: string, opts?: { topK?: number; signal?: AbortSignal }): Promise<RagHit[]>;
  readonly meta: { containerId: string; vectors: number };
}

// ── MCP ────────────────────────────────────────────────────────────────

export interface McpHandle extends BaseHandle {
  kind: 'mcp';
  call<T = unknown>(
    toolName: string,
    params: Record<string, unknown>,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T>;
  listTools(): Promise<Array<{ name: string; description?: string }>>;
  readonly meta: { url: string; toolNames: readonly string[] };
}

// ── Gitchain ───────────────────────────────────────────────────────────

/**
 * Author-Tupel — die zugrundeliegende `GitChainClient.commitAndPush` Methode
 * erwartet `{ name, email }`; der Handle exposed dasselbe Shape (NICHT den
 * im P2-Plan ursprünglich vermuteten Single-String — die existierende API
 * gewinnt).
 */
export interface GitchainAuthor {
  name: string;
  email: string;
}

/**
 * Anchor-Input spiegelt `GitChainClient.recordAnchor`:
 * (container_id, tag, commit_hash, optional network/tx_hash/block_number).
 * Wir benennen es im Handle in camelCase, mappen aber in der Wrapper-Impl.
 */
export interface GitchainAnchorInput {
  containerId: string;
  /** Tag-Name unter dem dieser Anker registriert wird (z.B. `seal-2026-05-16`). */
  tag: string;
  commitHash: string;
  network?: string;
  txHash?: string;
  blockNumber?: number;
}

export interface GitchainHandle extends BaseHandle {
  kind: 'gitchain';
  /**
   * Sicherstellen, dass der bare-Repo zu `containerId` existiert. Gibt das
   * `Container`-Objekt (oder `null` wenn nicht in der Registry) zurück.
   */
  ensureContainer(containerId: string): Promise<unknown>;
  cloneOrInit(containerId: string, workdir: string): Promise<void>;
  commitAndPush(workdir: string, message: string, author: GitchainAuthor): Promise<{ sha: string }>;
  recordAnchor(input: GitchainAnchorInput): Promise<void>;
  readonly meta: { apiUrl: string; namespace: string; anchorMode: 'per-stage' | 'per-run' | 'on-seal-only' };
}

// ── Catalog ────────────────────────────────────────────────────────────

export interface CatalogHandle extends BaseHandle {
  kind: 'catalog';
  /**
   * Synchroner Zugriff auf gecachte Kataloginhalte. `'atoms'` und `'container'`
   * liefern den jeweiligen JSON-Inhalt; `'nested'` liefert ein Dict
   * `{ <basename ohne .json>: <inhalt> }`.
   */
  get<T = unknown>(key: 'atoms' | 'container' | 'nested'): T;
  readonly meta: { containerId: string };
}

// ── KV ─────────────────────────────────────────────────────────────────

export interface KvHandle extends BaseHandle {
  kind: 'kv';
  /** Postgres-Pfad. Stub in P2 — wirft "not yet implemented". */
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Redis-Pfad. Stub in P2 — wirft "not yet implemented". */
  cmd<T = unknown>(cmd: string, ...args: unknown[]): Promise<T>;
  readonly meta: { backend: 'postgres' | 'redis'; url: string };
}

// ── Union ──────────────────────────────────────────────────────────────

export type ToolHandle =
  | LlmHandle
  | EmbedderHandle
  | RagIndexHandle
  | McpHandle
  | GitchainHandle
  | CatalogHandle
  | KvHandle;
