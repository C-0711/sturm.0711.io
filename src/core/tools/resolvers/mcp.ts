/**
 * MCP-Resolver. Dispatcht nach Tool-Name auf die existierenden Spezial-Clients:
 *   - 'bmf-lane1' / 'bmf-*'  → BmfMcpClient
 *   - 'elster-*' / 'lane5-*' → ElsterMcpClient
 *
 * Ein generischer JSON-RPC-Fallback ist Future-Work; der `ToolBootError`
 * für unbekannte MCP-Namen ist deutlich und schnell zu fixen.
 */

import { BmfMcpClient } from '../../../lib/bmf-mcp-client.ts';
import { ElsterMcpClient } from '../../../lib/elster-mcp-client.ts';
import type { McpToolRef, ToolHealth } from '../types.ts';
import type { McpHandle } from '../handles.ts';

function resolveUrl(ref: McpToolRef): string | undefined {
  const fromEnv = process.env[ref.config.envUrl];
  if (fromEnv) return fromEnv;
  return ref.config.defaultUrl;
}

type Kind = 'bmf' | 'elster';

function classify(ref: McpToolRef): Kind | null {
  const n = ref.name.toLowerCase();
  if (n.startsWith('bmf')) return 'bmf';
  if (n.startsWith('elster') || n.startsWith('lane5')) return 'elster';
  // Fallback: nach den Tool-Namen raten.
  if (ref.config.tools.some((t) => t.includes('elster'))) return 'elster';
  if (ref.config.tools.some((t) => t.includes('steuer') || t.includes('berechne'))) return 'bmf';
  return null;
}

export async function resolveMcp(ref: McpToolRef): Promise<McpHandle> {
  const url = resolveUrl(ref) ?? '';
  const kind = classify(ref);

  if (kind === 'bmf') {
    const client = new BmfMcpClient({
      url: url || undefined,
      timeoutMs: ref.config.timeoutMs,
    });
    return {
      name: ref.name,
      kind: 'mcp',
      meta: { url: url || '(unset)', toolNames: ref.config.tools },
      call: async <T = unknown>(
        toolName: string,
        params: Record<string, unknown>,
        opts?: { timeoutMs?: number; signal?: AbortSignal },
      ): Promise<T> => {
        return client.callTool<T>(toolName, { parameters: params }, opts?.signal);
      },
      listTools: async () => client.listTools(),
      health: () => probeMcpHealth(ref),
    };
  }

  if (kind === 'elster') {
    const client = new ElsterMcpClient({
      url: url || undefined,
      timeoutMs: ref.config.timeoutMs,
    });
    return {
      name: ref.name,
      kind: 'mcp',
      meta: { url: url || '(unset)', toolNames: ref.config.tools },
      call: async <T = unknown>(
        toolName: string,
        params: Record<string, unknown>,
        opts?: { timeoutMs?: number; signal?: AbortSignal },
      ): Promise<T> => {
        return client.callTool<T>(toolName, { parameters: params }, opts?.signal);
      },
      listTools: async () => {
        // ElsterMcpClient exposed kein listTools — wir geben den deklarierten
        // statischen Roster zurück. Konsistent mit der UI-Sicht.
        return ref.config.tools.map((name) => ({ name }));
      },
      health: () => probeMcpHealth(ref),
    };
  }

  throw new Error(
    `[tools/mcp] cannot classify MCP '${ref.name}': name must start with 'bmf', 'elster', or 'lane5' (P2 limitation)`,
  );
}

export async function probeMcpHealth(ref: McpToolRef): Promise<ToolHealth> {
  const t0 = Date.now();
  const url = resolveUrl(ref);
  const configured = !!url;
  if (!configured) {
    return {
      name: ref.name,
      kind: 'mcp',
      configured: false,
      alive: false,
      lastError: `env ${ref.config.envUrl} unset + no defaultUrl`,
    };
  }
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('timeout')), 3000);
    try {
      const res = await fetch(url!, {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      return {
        name: ref.name,
        kind: 'mcp',
        configured: true,
        alive: res.ok,
        latencyMs: Date.now() - t0,
        ...(res.ok ? {} : { lastError: `HTTP ${res.status}` }),
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return {
      name: ref.name,
      kind: 'mcp',
      configured: true,
      alive: false,
      latencyMs: Date.now() - t0,
      lastError: (e as Error).message,
    };
  }
}
