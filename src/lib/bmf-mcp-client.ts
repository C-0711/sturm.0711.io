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
 *  werden bevorzugt aus `normalizedNumber` (JS-number, single source of
 *  truth) formatiert; fallback ist `normalized` (Integer-Cents) → "12345,67"
 *  und zuletzt der Roh-`value`. Strings bleiben unverändert. Felder ohne
 *  Value werden ausgelassen.
 *  Felder mit `trust === 'suspicious'` werden gefiltert — sie wären sonst
 *  Halluzinationen wie "456" für Bezeichnung/Betrag/Summe-Platzhalter, die
 *  in BMF-Mappings (z.B. pv_beitraege ← E0202604) gegen die echten Werte
 *  gewinnen (first_present-Aggregation). */
export function canonicalLayerToElsterFelder(
  canonical: Record<string, {
    value: string;
    normalized: string | null;
    /** Pre-parsed JS-number for numeric datentyps (currency etc.). Single
     *  source of arithmetic truth — wenn gesetzt, bevorzugt vor `normalized`
     *  (Integer-Cents-Round-Trip) und vor `value` (deutsche Locale-Strings). */
    normalizedNumber?: number;
    datentyp: 'string' | 'date' | 'currency';
    trust?: 'high' | 'medium' | 'low' | 'suspicious';
    origin?: string;
  }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [eCode, cv] of Object.entries(canonical)) {
    // Trust-Filter: NUR LLM-Halluzinationen droppen, nicht REGEX-Treffer.
    // Phase5-merge markiert REGEX_100% als 'suspicious' wenn zeile_anchored
    // false ist (z.B. Markdown-Table-Format "| $^5$ Bruttoarbeitslohn |" wird
    // vom Anker-Check nicht erkannt). Solche Werte sind aber echt — Quelle
    // ist gesicherter OCR-Text-Match. Strict no-fallback: nur LLM_*
    // suspicious-Treffer raus, REGEX_* + BMF_RECHNER bleiben drin.
    if (cv.trust === 'suspicious' && cv.origin && /^LLM/i.test(cv.origin)) continue;
    // BMF MCP versucht numerische eCode-Werte in float() zu parsen, würde
    // dabei aber an "Schrott-Strings" (": Kontoführungsgebühren", lange
    // Labels) crashen. ABER: bestimmte string-eCodes triggern Tarif-Logik —
    // ESSENTIELL z.B.:
    //   • E0101201 "Zusammenveranlagung" → Splittingtarif aktivieren
    //   • E0100402 Religion → Kirchensteuer-Berechnung
    //   • E0100081/82 IDNr → Personen-Identifikation
    // Ohne diese fällt BMF auf Grundtarif zurück → Stricker rechnet 11.876 €
    // ESt statt korrekt 6.958 € (Erstattung wird zu Nachzahlung 4.854 €).
    // Heuristik: sauberer String-Wert (alphanumeric-start, <=80 chars,
    // kein führender Doppelpunkt) → durchlassen. Schrott bleibt draußen.
    if (cv.datentyp !== 'currency' && cv.datentyp !== 'date') {
      const s = String(cv.value ?? '').trim();
      if (!s) continue;
      if (s.length > 80) continue;
      if (/^[:,;.\-]/.test(s)) continue; // führendes Schrott-Zeichen
      if (!/^[A-Za-z0-9ÄÖÜäöüß]/.test(s)) continue; // muss mit Wort/Zahl starten
      out[eCode] = s;
      continue;
    }
    if (cv.datentyp === 'currency') {
      // Bevorzugt normalizedNumber (single source of arithmetic truth) →
      // keine zweite Locale-Parsing-Runde nötig.
      if (typeof cv.normalizedNumber === 'number' && Number.isFinite(cv.normalizedNumber)) {
        out[eCode] = formatEuroDe(cv.normalizedNumber);
      } else if (cv.normalized && /^-?\d+$/.test(cv.normalized)) {
        // integer-cents → "x,xx" (Vorzeichen behalten)
        const cents = parseInt(cv.normalized, 10);
        out[eCode] = formatEuroDe(cents / 100);
      } else if (cv.value) {
        out[eCode] = cv.value;
      }
    } else if (cv.value) {
      // date — durchreichen (BMF kann das verarbeiten)
      out[eCode] = cv.value;
    }
  }
  return out;
}

/** Format a JS number as German Euro notation `"x,xx"` (no thousand
 *  separators — MCP expects locale-bare). Preserves sign and rounds to 2
 *  decimal places. */
function formatEuroDe(n: number): string {
  const neg = n < 0;
  const abs = Math.abs(n);
  // Round to cents to avoid 1.234567 → "1,23456700"-style noise.
  const cents = Math.round(abs * 100);
  const euros = Math.floor(cents / 100);
  const restCents = cents % 100;
  return `${neg ? '-' : ''}${euros},${String(restCents).padStart(2, '0')}`;
}
