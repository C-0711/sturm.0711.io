import { defineStage } from '../core/stage.ts';

export interface Lane1BmfComputeInput {
  elsterFelder: Record<string, string>;
  erklaerungsjahr: number;
}

export interface Lane1BmfComputeOutput {
  ok: boolean;
  daten?: Record<string, unknown>;
  error?: unknown;
  ms: number;
  ecodes_sent: number;
}

const BMF_MCP_URL = process.env.BMF_MCP_URL ?? 'http://host.docker.internal:12010/mcp';
const TOOL_NAME = 'berechne_vollstaendige_steuer_v2';

/**
 * Ruft Lane-1 BMF-Calculator MCP via JSON-RPC.
 * Container macht eCode→canonical_field-Mapping selbst (Single Source of Truth:
 * lane1_bmf_calculator.module_mappings).
 *
 * Antwort kommt als SSE (`event: message\ndata: <json>`), die einzelne data-Zeile
 * wird extrahiert.
 */
export const lane1BmfComputeStage = defineStage<Lane1BmfComputeInput, Lane1BmfComputeOutput>({
  id: 'lane1-bmf-compute',
  name: 'Lane-1 BMF-Compute',
  description: `MCP-Call ${TOOL_NAME} → vollständige Steuerberechnung mit §-konformen Modulen`,

  async run(input, _ctx) {
    const { elsterFelder, erklaerungsjahr } = input;
    const t0 = Date.now();

    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: TOOL_NAME,
        arguments: {
          parameters: { erklaerungsjahr, elster_felder: elsterFelder },
        },
      },
    };

    const res = await fetch(BMF_MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    const ms = Date.now() - t0;
    const ecodesSent = Object.keys(elsterFelder).length;

    if (!res.ok) {
      return { ok: false, error: `lane-1 ${res.status}: ${raw.slice(0, 400)}`, ms, ecodes_sent: ecodesSent };
    }

    // SSE strip
    const sseMatch = raw.match(/^data:\s*(.+)$/m);
    const payloadRaw = sseMatch ? sseMatch[1] : raw;
    let payload: any;
    try {
      payload = JSON.parse(payloadRaw);
    } catch (e) {
      return { ok: false, error: `parse-fail: ${(e as Error).message}`, ms, ecodes_sent: ecodesSent };
    }
    if (payload.error) {
      return { ok: false, error: payload.error, ms, ecodes_sent: ecodesSent };
    }
    const content = payload?.result?.content ?? [];
    for (const c of content) {
      if (c?.type === 'text') {
        try {
          const inner = JSON.parse(c.text);
          if (inner?.erfolg && inner.daten) {
            return { ok: true, daten: inner.daten, ms, ecodes_sent: ecodesSent };
          }
          return { ok: false, error: inner, ms, ecodes_sent: ecodesSent };
        } catch (e) {
          return { ok: false, error: `inner-parse-fail: ${(e as Error).message}`, ms, ecodes_sent: ecodesSent };
        }
      }
    }
    return { ok: false, error: 'kein text-content in MCP-response', ms, ecodes_sent: ecodesSent };
  },
});
