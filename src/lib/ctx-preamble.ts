/**
 * ctx-preamble — generate ready-to-paste system-prompt snippets for any LLM (B6).
 *
 * `GET /ctx/:id/preamble?surface=<chatgpt|claude|cursor|gemini|curl>` returns:
 *   {
 *     surface: "chatgpt",
 *     system_prompt: "...",
 *     curl_example: "...",
 *     openapi_url: "...",
 *     retrieve_url: "...",
 *   }
 *
 * Without `?surface=`, returns a default "generic" preamble suitable as
 * a base system prompt for any LLM that supports HTTP tool-calls.
 */
import type { CtxRecord } from './ctx-store.ts';

export type PreambleSurface = 'generic' | 'chatgpt' | 'claude' | 'cursor' | 'gemini' | 'curl';

const SUPPORTED: PreambleSurface[] = ['generic', 'chatgpt', 'claude', 'cursor', 'gemini', 'curl'];

export function isSupportedSurface(s: string): s is PreambleSurface {
  return (SUPPORTED as string[]).includes(s);
}

export interface PreambleResponse {
  surface: PreambleSurface;
  container_id: string;
  container_name: string;
  atom_count: number;
  retrieve_url: string;
  openapi_url: string;
  system_prompt: string;
  curl_example: string;
  /** Surface-specific config snippet (e.g. .cursorrules, MCP config JSON). */
  config_snippet?: string;
}

interface BuildOpts {
  rec: CtxRecord;
  baseUrl: string; // e.g. https://sturm.0711.io
  surface: PreambleSurface;
}

const GENERIC_PROMPT = (rec: CtxRecord, retrieveUrl: string) =>
  `You have access to a retrieval tool called \`ctx\` that returns top-K
context atoms from this project's container "${rec.name}".
Before answering project-specific questions, query the container:

  POST ${retrieveUrl}
  Content-Type: application/json
  { "query": "<your search>", "k": 5 }

Each returned hit contains: { slug, score, preview, path, symbol }.
Treat returned atoms as authoritative for project-specific questions.
The container holds ${rec.atomCount} atom(s), built ${rec.builtAt}.`;

const CHATGPT_PROMPT = (rec: CtxRecord, retrieveUrl: string) =>
  `You are a project-aware assistant for "${rec.name}".

When the user asks a project-specific question, call the \`ctx_retrieve\`
action with their query (k=5 by default). The action wraps:
  POST ${retrieveUrl}

Always cite the returned slugs in your reply. If no hits are returned
(empty array), state explicitly that the container has no information
on this topic rather than making something up.

Container: ${rec.id} · ${rec.atomCount} atoms · built ${rec.builtAt}`;

const CLAUDE_PROMPT = (rec: CtxRecord, retrieveUrl: string) =>
  `You have access to the \`ctx\` MCP server (configured separately).
Before answering questions about "${rec.name}", call:

  ctx.retrieve(containerId="${rec.id}", query="<...>", k=5)

Cite returned slugs in your reply. The container has ${rec.atomCount} atom(s).
For raw atom content: ctx.atom(containerId, slug).`;

const CURSOR_RULES = (rec: CtxRecord, retrieveUrl: string) =>
  `# 0711 CTX — ${rec.name}
You have access to project context via the \`ctx\` MCP server.

Before answering questions specific to this project, query:
  ctx.retrieve("${rec.id}", "<query>", 5)

Cite hits by slug in your response. If no hits, say so explicitly.

MCP config (add to ~/.config/cursor/mcp.json):
{
  "mcpServers": {
    "ctx": {
      "command": "npx",
      "args": ["-y", "@0711/mcp-server-ctx", "${rec.id}"]
    }
  }
}`;

const GEMINI_PROMPT = (rec: CtxRecord, retrieveUrl: string) =>
  `You have access to the \`ctx\` extension. To query the "${rec.name}"
container with ${rec.atomCount} atoms, call:

  /ctx retrieve "${rec.id}" "<query>" 5

Cite returned slugs. Built ${rec.builtAt}.`;

const CURL_PROMPT = (rec: CtxRecord, retrieveUrl: string) =>
  `# Retrieve top-5 hits from ${rec.name} (${rec.atomCount} atoms):
curl -X POST ${retrieveUrl} \\
  -H "Content-Type: application/json" \\
  -d '{"query": "your query here", "k": 5}'

# List all containers:
curl ${retrieveUrl.replace(/\/ctx\/[^/]+\/retrieve$/, '/ctx')}

# Get container metadata:
curl ${retrieveUrl.replace(/\/retrieve$/, '')}

# Tail event log:
curl ${retrieveUrl.replace(/\/retrieve$/, '/events')}`;

function curlExample(rec: CtxRecord, retrieveUrl: string): string {
  return `curl -X POST ${retrieveUrl} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $STURM_CTX_TOKEN" \\
  -d '{"query": "welcher embedder wird benutzt", "k": 5}'`;
}

function cursorConfig(rec: CtxRecord): string {
  return JSON.stringify({
    mcpServers: {
      ctx: {
        command: 'npx',
        args: ['-y', '@0711/mcp-server-ctx', rec.id],
      },
    },
  }, null, 2);
}

function claudeMcpConfig(rec: CtxRecord): string {
  return JSON.stringify({
    mcpServers: {
      [`ctx-${rec.shortId}`]: {
        command: 'npx',
        args: ['-y', '@0711/mcp-server-ctx', rec.id],
      },
    },
  }, null, 2);
}

export function buildPreamble(opts: BuildOpts): PreambleResponse {
  const { rec, baseUrl, surface } = opts;
  const retrieveUrl = `${baseUrl}/ctx/${rec.id}/retrieve`;
  const openapiUrl = `${baseUrl}/ctx/openapi.json`;

  let systemPrompt = '';
  let configSnippet: string | undefined;

  switch (surface) {
    case 'chatgpt':
      systemPrompt = CHATGPT_PROMPT(rec, retrieveUrl);
      break;
    case 'claude':
      systemPrompt = CLAUDE_PROMPT(rec, retrieveUrl);
      configSnippet = claudeMcpConfig(rec);
      break;
    case 'cursor':
      systemPrompt = CURSOR_RULES(rec, retrieveUrl);
      configSnippet = cursorConfig(rec);
      break;
    case 'gemini':
      systemPrompt = GEMINI_PROMPT(rec, retrieveUrl);
      break;
    case 'curl':
      systemPrompt = CURL_PROMPT(rec, retrieveUrl);
      break;
    case 'generic':
    default:
      systemPrompt = GENERIC_PROMPT(rec, retrieveUrl);
  }

  return {
    surface,
    container_id: rec.id,
    container_name: rec.name,
    atom_count: rec.atomCount,
    retrieve_url: retrieveUrl,
    openapi_url: openapiUrl,
    system_prompt: systemPrompt,
    curl_example: curlExample(rec, retrieveUrl),
    config_snippet: configSnippet,
  };
}

/** Derive the public base URL from a request (honors X-Forwarded-*). */
export function baseUrlFromReq(req: { protocol: string; get: (h: string) => string | undefined; headers: Record<string, unknown> }): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
  const host = (req.headers['x-forwarded-host'] as string) || req.get('host') || 'localhost:7800';
  return `${proto}://${host}`;
}
