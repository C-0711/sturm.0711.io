/**
 * BMF Lane-1 MCP Client.
 *
 * Spricht JSON-RPC über Streamable-HTTP/SSE mit dem `ctaxv1-lane1-bmf`
 * MCP-Server (default tunnel → localhost:12010). Der Server akzeptiert
 * eCodes direkt als Input (`elster_felder: {"E0200204": "50000,00"}`)
 * und liefert die vollständige Steuerberechnung mit Formel-Trace + §-Bezug.
 *
 * Connectivity:
 *   ssh -L 12010:localhost:12010 192.168.145.10
 *
 * Env-Override: BMF_MCP_URL (Default `http://localhost:12010/mcp`)
 */

export interface BmfMcpClientOptions {
  url?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface BmfSteuerInput {
  /** Veranlagungsjahr (z.B. 2024). */
  erklaerungsjahr: number;
  /** Deklarierte eCodes als deutsche String-Werte (Wire-Format der Anlage).
   *  Beträge: "1.234,56" oder "1234,56" — MCP normalisiert intern. */
  elster_felder: Record<string, string>;
  /** Optional: zusätzliche Steuerpflichtigen-Profile (z.B. veranlagungsart). */
  [k: string]: unknown;
}

export interface BmfSteuerErgebnis {
  erfolg: boolean;
  daten: {
    fall_id: string;
    steuerjahr: number;
    zve: number;
    einkommensteuer: number;
    solidaritaetszuschlag: number;
    gesamtsteuer: number;
    grenzsteuersatz?: number;
    durchschnittssteuersatz?: number;
    berechnungsdetails?: {
      steuer_berechnung?: {
        steuerzone?: string;
        formel_verwendet?: string;
        bmf_referenz?: string;
      };
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };
  fehler?: unknown;
}

export class BmfMcpClient {
  private readonly url: string;
  private readonly timeoutMs: number;

  constructor(opts: BmfMcpClientOptions = {}) {
    this.url = opts.url ?? process.env.BMF_MCP_URL ?? 'http://localhost:12010/mcp';
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /** Health-Probe. Wirft bei Down. Schnell (<1s). */
  async ping(signal?: AbortSignal): Promise<void> {
    const r = await this.rpc('tools/list', {}, signal);
    if (!Array.isArray((r as { tools?: unknown[] }).tools)) {
      throw new Error('BMF-MCP unexpected tools/list shape');
    }
  }

  /** Listet alle 40 Rechner-Tools mit Namen + Schema. */
  async listTools(signal?: AbortSignal): Promise<Array<{ name: string; description?: string }>> {
    const r = await this.rpc<{ tools: Array<{ name: string; description?: string }> }>(
      'tools/list',
      {},
      signal,
    );
    return r.tools;
  }

  /** Vollständige Steuerberechnung — canonical entrypoint. eCode-In, Audit-Out. */
  async berechneVollstaendigeSteuerV2(
    input: BmfSteuerInput,
    signal?: AbortSignal,
  ): Promise<BmfSteuerErgebnis> {
    return this.callTool<BmfSteuerErgebnis>(
      'berechne_vollstaendige_steuer_v2',
      { parameters: input },
      signal,
    );
  }

  /** Generischer Tool-Call mit JSON-RPC-Wrapping. */
  async callTool<T>(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const r = await this.rpc<{ content: Array<{ type: string; text: string }>; isError?: boolean }>(
      'tools/call',
      { name, arguments: args },
      signal,
    );
    if (r.isError) {
      throw new Error(`BMF-MCP tool ${name} returned isError=true`);
    }
    const txt = r.content?.[0]?.text;
    if (typeof txt !== 'string') {
      throw new Error(`BMF-MCP tool ${name}: no content text`);
    }
    return JSON.parse(txt) as T;
  }

  /** Low-level JSON-RPC mit SSE-Response-Parse. MCP liefert genau EINEN
   *  data:-Frame pro Call, danach Stream-Ende. */
  private async rpc<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`BMF-MCP timeout after ${this.timeoutMs}ms`)), this.timeoutMs);
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
      if (!res.ok) {
        throw new Error(`BMF-MCP HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      const body = await res.text();
      // SSE-Frame: "event: message\ndata: {...}\n\n" — wir extrahieren das erste data:
      const m = body.match(/^data:\s*(.+)$/m);
      if (!m) throw new Error(`BMF-MCP: no SSE data frame in response (${body.slice(0, 120)})`);
      const env = JSON.parse(m[1]) as { result?: T; error?: { code: number; message: string } };
      if (env.error) throw new Error(`BMF-MCP RPC error ${env.error.code}: ${env.error.message}`);
      if (env.result === undefined) throw new Error('BMF-MCP: response has no result');
      return env.result;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onParentAbort);
    }
  }
}

/** Map a sturm canonical_layer (eCode → CanonicalValue) into the MCP's
 *  `elster_felder` format (eCode → German-notation string). Currency-eCodes
 *  werden aus `normalized` (Integer-Cents) zurück in "12345,67" gewandelt,
 *  Strings bleiben unverändert. Felder ohne value werden ausgelassen. */
export function canonicalLayerToElsterFelder(
  canonical: Record<string, { value: string; normalized: string | null; datentyp: 'string' | 'date' | 'currency' }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [eCode, cv] of Object.entries(canonical)) {
    if (cv.datentyp === 'currency' && cv.normalized && /^-?\d+$/.test(cv.normalized)) {
      // integer-cents → "x,xx" (Vorzeichen behalten)
      const cents = parseInt(cv.normalized, 10);
      const neg = cents < 0;
      const abs = Math.abs(cents);
      const euros = Math.floor(abs / 100);
      const restCents = abs % 100;
      out[eCode] = `${neg ? '-' : ''}${euros},${String(restCents).padStart(2, '0')}`;
    } else if (cv.value) {
      out[eCode] = cv.value;
    }
  }
  return out;
}
