#!/usr/bin/env node
/**
 * Lane-5 ELSTER MCP Stub-Server.
 *
 * Mini-JSON-RPC-over-HTTP-Endpoint (kompatibel zu `src/lib/elster-mcp-client.ts`)
 * der die ELSTER-Einreichung mockt: keine echte ERiC-Anbindung, statt dessen
 * deterministische Antworten zum Testen der Lane-5-Integration end-to-end.
 *
 * Setzt ELSTER_MCP_URL in der sturm-Umgebung auf `http://host.docker.internal:12015/mcp`
 * (Linux mit extra_hosts) oder `http://localhost:12015/mcp` (Mac dev).
 *
 * Endpoints:
 *   POST /mcp  — JSON-RPC
 *     tools/list  → liste der angebotenen Tools
 *     tools/call elster_einreichen({eric_xml, fall_metadata})
 *                 → { erfolg: true, einreichungs_id: 'STUB-…',
 *                     anlage_status: [{anlage, accepted, hinweise}], ts }
 *
 * Modi:
 *   default        → erfolg: true, deterministische ID basierend auf merkle_root
 *                   oder caseId.
 *   --fail-rate N  → N% der Calls liefern erfolg: false (zum UX-Testen)
 *   --delay-ms N   → künstliche Latenz pro Request (default 200 ms)
 *
 * Aufruf:
 *   node scripts/lane5-mcp-stub.mjs --port 12015 --delay-ms 300
 *
 * Beendigung: SIGINT (Ctrl-C).
 */
import * as http from 'node:http';
import { createHash } from 'node:crypto';

function parseArgs(argv) {
  const out = { port: 12015, delayMs: 200, failRate: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--delay-ms') out.delayMs = Number(argv[++i]);
    else if (a === '--fail-rate') out.failRate = Number(argv[++i]);
  }
  return out;
}

const TOOLS = [
  {
    name: 'elster_einreichen',
    description: 'Reichst eine ERiC-konforme XML-Erklärung bei ELSTER ein und liefert die Einreichungs-ID + Pro-Anlagen-Status zurück.',
    inputSchema: {
      type: 'object',
      required: ['eric_xml', 'fall_metadata'],
      properties: {
        eric_xml: { type: 'string', description: 'ERiC-konforme XML-Erklärung' },
        fall_metadata: {
          type: 'object',
          required: ['appId', 'caseId'],
          properties: {
            appId: { type: 'string' },
            caseId: { type: 'string' },
            mandantId: { type: 'string' },
            veranlagungsjahr: { type: ['integer', 'null'] },
            merkle_root: { type: 'string', description: 'sha256-Merkle des versiegelten Falls (Trust-Anchor)' },
          },
        },
      },
    },
  },
];

function ok(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}
function err(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}
function sseFrame(payload) {
  return `event: message\ndata: ${payload}\n\n`;
}

function deterministicId(metadata) {
  const seed = metadata?.merkle_root || metadata?.caseId || String(Date.now());
  const h = createHash('sha256').update(seed).digest('hex');
  return 'STUB-' + h.slice(0, 12).toUpperCase();
}

function elsterEinreichenStub(params) {
  const { eric_xml, fall_metadata } = params || {};
  const meta = fall_metadata || {};

  if (typeof eric_xml !== 'string' || eric_xml.length === 0) {
    return { erfolg: false, reason: 'mcp-error', message: 'eric_xml empty or missing' };
  }
  // Extract Anlagen-Codes aus dem XML — sehr grob (zähle <E020…/N> und ähnliche)
  const ecodeMatches = Array.from(eric_xml.matchAll(/<(E\d+)\s+anlage="([^"]+)"/g));
  const anlagenSet = new Set(ecodeMatches.map((m) => m[2]));
  const anlage_status = Array.from(anlagenSet).map((a) => ({
    anlage: a,
    accepted: true,
    hinweise: [],
  }));
  if (anlage_status.length === 0) {
    // Kein eCode mit anlage-Attribut gefunden — trotzdem akzeptieren mit
    // einem allgemeinen Eintrag, damit der Aufrufer sieht, dass die Stub
    // arbeitet.
    anlage_status.push({
      anlage: 'ESt1A',
      accepted: true,
      hinweise: ['Stub-Server konnte keine Anlagen-Tags im XML finden — Standard-Annahme.'],
    });
  }
  return {
    erfolg: true,
    einreichungs_id: deterministicId(meta),
    anlage_status,
    ts: new Date().toISOString(),
    stub: { mode: 'deterministic', server: 'lane5-mcp-stub.mjs' },
  };
}

async function handle(reqBody, args) {
  let env;
  try { env = JSON.parse(reqBody); }
  catch { return err(null, -32700, 'Parse error'); }
  const { id, method, params } = env;
  if (method === 'tools/list') {
    return ok(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const { name, arguments: toolArgs } = params || {};
    if (name !== 'elster_einreichen') {
      return ok(id, { isError: true, content: [{ type: 'text', text: `unknown tool: ${name}` }] });
    }
    // --fail-rate roll
    if (args.failRate > 0 && Math.random() * 100 < args.failRate) {
      const out = { erfolg: false, reason: 'mcp-error', message: 'simulated failure (--fail-rate)' };
      return ok(id, { content: [{ type: 'text', text: JSON.stringify(out) }] });
    }
    const inner = elsterEinreichenStub((toolArgs || {}).parameters || toolArgs);
    return ok(id, { content: [{ type: 'text', text: JSON.stringify(inner) }] });
  }
  return err(id ?? null, -32601, `Method not found: ${method}`);
}

const args = parseArgs(process.argv.slice(2));
const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || (req.url !== '/mcp' && req.url !== '/')) {
    res.statusCode = 404;
    res.end('not found');
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString('utf-8');
  const respPayload = await handle(body, args);
  if (args.delayMs > 0) await new Promise((r) => setTimeout(r, args.delayMs));
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.end(sseFrame(respPayload));
});

server.listen(args.port, () => {
  console.log(`Lane-5 ELSTER MCP Stub läuft auf http://localhost:${args.port}/mcp`);
  console.log(`  delay: ${args.delayMs} ms · fail-rate: ${args.failRate}%`);
  console.log('  set ELSTER_MCP_URL=http://localhost:' + args.port + '/mcp in your sturm env.');
});
process.on('SIGINT', () => { console.log('\nshutting down'); server.close(() => process.exit(0)); });
