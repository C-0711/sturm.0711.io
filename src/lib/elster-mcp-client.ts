/**
 * ELSTER Lane-5 MCP Client.
 *
 * Skeleton modelled after src/lib/bmf-mcp-client.ts. Spricht JSON-RPC über
 * Streamable-HTTP/SSE mit einem ELSTER-Einreichungs-MCP-Server. Der Server
 * ist in v1 noch nicht hochgefahren — der Client erkennt das anhand der
 * fehlenden ELSTER_MCP_URL env var und liefert ein deterministisches
 * `{ erfolg: false, reason: 'mcp-unavailable' }` zurück. Sobald die Lane-5
 * Service-Komponente existiert, reicht es, ELSTER_MCP_URL zu setzen.
 *
 * Tool-Contract (v1):
 *   elster_einreichen(eric_xml: string, fall_metadata: object) →
 *     { erfolg, einreichungs_id, anlage_status[], fehlerprotokoll? }
 */

export interface ElsterMcpClientOptions {
  url?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ElsterEinreichenInput {
  eric_xml: string;
  fall_metadata: {
    appId: string;
    caseId: string;
    mandantId?: string;
    veranlagungsjahr?: number | null;
    /** SHA256-Merkle-Root des versiegelten master.json (Trust-Anchor). */
    merkle_root?: string;
  };
}

export interface ElsterEinreichenErgebnis {
  erfolg: boolean;
  /** ELSTER-seitige Einreichungs-ID (z.B. "EINR-2024-XYZ123"). */
  einreichungs_id?: string;
  anlage_status?: Array<{
    anlage: string;
    accepted: boolean;
    hinweise?: string[];
    fehler?: string[];
  }>;
  fehlerprotokoll?: unknown;
  /** Stub-Mode-Hinweis. Nur gesetzt, wenn der Client den MCP nicht erreichen kann. */
  reason?: 'mcp-unavailable' | 'timeout' | 'mcp-error';
  /** Optional: Roh-Antwort für Debugging (nur in Dev-Mode). */
  raw?: unknown;
}

export class ElsterMcpClient {
  private readonly url: string | undefined;
  private readonly timeoutMs: number;

  constructor(opts: ElsterMcpClientOptions = {}) {
    // Anders als BMF: kein Default-URL — wenn nicht gesetzt, läuft alles im
    // Stub-Mode (Service ist v1 noch nicht hochgefahren).
    this.url = opts.url ?? process.env.ELSTER_MCP_URL;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  isConfigured(): boolean {
    return typeof this.url === 'string' && this.url.length > 0;
  }

  /** Health-Probe — gibt false zurück, wenn nicht konfiguriert oder unreachable. */
  async ping(signal?: AbortSignal): Promise<boolean> {
    if (!this.isConfigured()) return false;
    try {
      const r = await this.rpc<{ tools?: unknown[] }>('tools/list', {}, signal);
      return Array.isArray(r.tools);
    } catch {
      return false;
    }
  }

  /** Einreichung gegen ELSTER. Bei fehlender ELSTER_MCP_URL: Stub-Antwort. */
  async einreichen(
    input: ElsterEinreichenInput,
    signal?: AbortSignal,
  ): Promise<ElsterEinreichenErgebnis> {
    if (!this.isConfigured()) {
      return { erfolg: false, reason: 'mcp-unavailable' };
    }
    try {
      const result = await this.callTool<ElsterEinreichenErgebnis>(
        'elster_einreichen',
        { parameters: input },
        signal,
      );
      return result;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (msg.includes('timeout')) return { erfolg: false, reason: 'timeout' };
      return { erfolg: false, reason: 'mcp-error', raw: msg };
    }
  }

  /** Generischer Tool-Call mit JSON-RPC-Wrapping. */
  async callTool<T>(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const r = await this.rpc<{ content: Array<{ type: string; text: string }>; isError?: boolean }>(
      'tools/call',
      { name, arguments: args },
      signal,
    );
    if (r.isError) throw new Error(`ELSTER-MCP tool ${name} returned isError=true`);
    const txt = r.content?.[0]?.text;
    if (typeof txt !== 'string') throw new Error(`ELSTER-MCP tool ${name}: no content text`);
    return JSON.parse(txt) as T;
  }

  private async rpc<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (!this.url) throw new Error('ELSTER_MCP_URL not configured');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`ELSTER-MCP timeout after ${this.timeoutMs}ms`)), this.timeoutMs);
    const onParentAbort = () => ac.abort(signal?.reason);
    signal?.addEventListener('abort', onParentAbort, { once: true });
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
      });
      if (!res.ok) throw new Error(`ELSTER-MCP HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const body = await res.text();
      const m = body.match(/^data:\s*(.+)$/m);
      if (!m) throw new Error(`ELSTER-MCP: no SSE data frame in response (${body.slice(0, 120)})`);
      const env = JSON.parse(m[1]) as { result?: T; error?: { code: number; message: string } };
      if (env.error) throw new Error(`ELSTER-MCP RPC error ${env.error.code}: ${env.error.message}`);
      if (env.result === undefined) throw new Error('ELSTER-MCP: response has no result');
      return env.result;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onParentAbort);
    }
  }
}
