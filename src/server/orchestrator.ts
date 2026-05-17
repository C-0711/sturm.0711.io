/**
 * STURM Gemma-4 Steuerassistent — Orchestrator-Router.
 *
 * Exposed unter `/api/orchestrator/*`:
 *   - POST /chat   — SSE-stream Token + tool_call + tool_result + done
 *   - GET  /tools  — JSON-Liste der Tool-Schemas
 *
 * Loop:
 *   while (true) {
 *     reply = call vLLM (with tools: [...])
 *     stream tokens to SSE
 *     if reply.finish_reason === 'tool_calls':
 *        for each tool_call:
 *          emit 'tool_call' event
 *          run handler
 *          emit 'tool_result' event
 *          push role:'tool' message
 *        continue
 *     emit 'done' event
 *     return
 *   }
 *
 * Wenn vLLMs OpenAI-tool-Schema fuer Gemma-4 nicht funktioniert, faellt der
 * Loop auf prompt-engineered tool-use zurueck: System-Prompt-Regel + Regex-
 * Parser fuer `<tool_call>name(args)</tool_call>`-Bloecke. Eine Fehlschlag-
 * Detection erfolgt anhand der ersten Response (400 mit "tools"-Fehler vom
 * Server, oder Server-Connection-Reject).
 */

import { Router, type Request, type Response } from 'express';
import {
  ORCHESTRATOR_TOOLS,
  TOOLS_BY_NAME,
  toOpenAiToolsSchema,
  type OrchestratorHandlerCtx,
} from './orchestrator-tools.ts';

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

export interface OrchestratorOptions {
  appId: string;
  vllmUrl: string;
  modelName: string;
  applicationsDir: string;
  runsDir: string;
  /** Optional fuer Tests: injizierbares fetch (Default: globalThis.fetch). */
  fetchImpl?: typeof fetch;
  /** Optional fuer Tests: Root-CWD (Default: process.cwd()). */
  rootCwd?: string;
  /** Optional Override des System-Prompts (z.B. Tests). */
  systemPrompt?: string;
  /** Hard-Cap fuer Loop-Iterationen pro Request (Default: 8). */
  maxIterations?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Bei role=tool: tool_call_id der Original-Anfrage. */
  tool_call_id?: string;
  /** Bei role=assistant: vom LLM ausgeloeste tool_calls. */
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  name?: string;
}

const DEFAULT_SYSTEM_PROMPT = `Du bist der STURM-Steuerassistent. Du fuehrst den Steuerberater durch den
Lebenszyklus eines Einkommensteuerfalls (Anwendung: steuerfall-est).

Verfuegbare Werkzeuge: liste_faelle, fall_status, fall_dokumente, auswertung,
verdaechtige_felder, pflicht_luecken, tool_health, fall_versiegeln,
fall_exportieren, paragraph_lookup.

Verhalten:
- Auf Deutsch antworten.
- Bei Statusfragen: zuerst fall_status aufrufen, dann zusammenfassen.
- Bei Auswertungsfragen: auswertung aufrufen, BMF-Zahlen in EUR formatieren,
  Erstattung positiv, Nachzahlung negativ darstellen.
- Bei Versiegelung/Export: erst pflicht_luecken + verdaechtige_felder pruefen,
  Nutzer fragen ob trotzdem fortfahren.
- Bei §EStG-Fragen: paragraph_lookup nutzen, Paragraph + Drucktext zitieren.
- Keine Modellnamen (z.B. "gemma-4") in den Antworten erwaehnen — du bist
  einfach "STURM-Assistent".

Wenn unklar, was der Nutzer will, kurze Rueckfrage stellen.`;

// ─────────────────────────────────────────────────────────────────────────
// SSE-Helper
// ─────────────────────────────────────────────────────────────────────────

interface SseSink {
  event(name: string, payload: unknown): void;
  end(): void;
  readonly closed: boolean;
}

function makeSseSink(res: Response): SseSink {
  let closed = false;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  // Force flush — without this, helmet-wrapped responses sometimes buffer
  // SSE events until the response ends, defeating the streaming contract.
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  // Send an initial comment event so the client sees the connection
  // immediately (curl --max-time will at least show this byte).
  try { res.write(': sturm-orchestrator open\n\n'); } catch { /* tolerant */ }
  res.on('close', () => { closed = true; });
  return {
    event(name, payload) {
      if (closed) return;
      const data = JSON.stringify(payload);
      res.write(`event: ${name}\ndata: ${data}\n\n`);
    },
    end() {
      if (closed) return;
      closed = true;
      try { res.end(); } catch { /* tolerant */ }
    },
    get closed() { return closed; },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// vLLM-Calls
// ─────────────────────────────────────────────────────────────────────────

interface VllmReply {
  finishReason: 'stop' | 'tool_calls' | 'length' | 'unknown';
  content: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  raw?: unknown;
}

/** Ein einzelner Call an vLLM /v1/chat/completions mit Streaming.
 *  Token-Chunks werden ueber `onToken` rausgereicht. */
async function callVllmStreaming(
  opts: {
    vllmUrl: string;
    modelName: string;
    messages: ChatMessage[];
    tools: ReturnType<typeof toOpenAiToolsSchema> | null;
    fetchImpl: typeof fetch;
    onToken: (delta: string) => void;
    signal?: AbortSignal;
  },
): Promise<VllmReply> {
  const body: Record<string, unknown> = {
    model: opts.modelName,
    messages: opts.messages.map((m) => {
      // OpenAI-Schema: assistant kann tool_calls haben, tool muss tool_call_id haben
      const out: Record<string, unknown> = { role: m.role, content: m.content };
      if (m.tool_calls) out.tool_calls = m.tool_calls;
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
      if (m.name) out.name = m.name;
      return out;
    }),
    stream: true,
    temperature: 0.2,
    max_tokens: 1024,
  };
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
    body.tool_choice = 'auto';
  }
  const res = await opts.fetchImpl(`${opts.vllmUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new VllmHttpError(res.status, txt);
  }
  if (!res.body) throw new Error('vLLM: leere Response-Body');

  let content = '';
  let finishReason: VllmReply['finishReason'] = 'unknown';
  const toolCallsByIdx = new Map<number, { id: string; name: string; arguments: string }>();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // OpenAI-SSE: pro Zeile `data: {...}` oder `data: [DONE]`. Bloecke
    // durch leere Zeile getrennt — wir splitten am Zeilenumbruch.
    let nlIdx;
    while ((nlIdx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nlIdx).trim();
      buf = buf.slice(nlIdx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let chunk: {
        choices?: Array<{
          delta?: { content?: string; tool_calls?: Array<{
            index: number; id?: string; type?: string;
            function?: { name?: string; arguments?: string };
          }> };
          finish_reason?: string;
        }>;
      };
      try { chunk = JSON.parse(payload); } catch { continue; }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        content += delta;
        opts.onToken(delta);
      }
      const tcDeltas = choice.delta?.tool_calls;
      if (Array.isArray(tcDeltas)) {
        for (const tc of tcDeltas) {
          const cur = toolCallsByIdx.get(tc.index) ?? { id: '', name: '', arguments: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.arguments += tc.function.arguments;
          toolCallsByIdx.set(tc.index, cur);
        }
      }
      if (choice.finish_reason) {
        const fr = choice.finish_reason;
        if (fr === 'stop' || fr === 'tool_calls' || fr === 'length') finishReason = fr;
        else finishReason = 'unknown';
      }
    }
  }
  const toolCalls = Array.from(toolCallsByIdx.values()).filter((tc) => tc.name.length > 0);
  if (toolCalls.length > 0 && finishReason !== 'tool_calls') finishReason = 'tool_calls';
  return { finishReason, content, toolCalls };
}

class VllmHttpError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`vLLM HTTP ${status}: ${body.slice(0, 240)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Prompt-engineered Fallback (kein vLLM-tool-use)
// ─────────────────────────────────────────────────────────────────────────

const TOOL_CALL_RE = /<tool_call>\s*([a-zA-Z_][\w]*)\s*\(([\s\S]*?)\)\s*<\/tool_call>/;

function buildFallbackSystemPrompt(baseSystem: string): string {
  const toolList = ORCHESTRATOR_TOOLS.map(
    (t) => `  - ${t.name}: ${t.description}`,
  ).join('\n');
  return `${baseSystem}

WERKZEUG-NUTZUNG (Fallback-Modus):
Um ein Werkzeug aufzurufen, gib EXAKT diesen Block aus und halte dann an:
<tool_call>name({"arg1":"value"})</tool_call>

Verfuegbare Werkzeuge:
${toolList}

Das System fuehrt das Werkzeug aus und gibt dir das Ergebnis als naechste Nachricht.
Sobald du genug Information hast, antworte normal (ohne <tool_call>).`;
}

function parseFallbackToolCall(text: string): { name: string; arguments: string } | null {
  const m = TOOL_CALL_RE.exec(text);
  if (!m) return null;
  const name = m[1];
  const argsStr = m[2].trim();
  // Args kann JSON-Objekt sein oder leer
  let argJson = argsStr;
  if (argsStr.length === 0) argJson = '{}';
  try {
    JSON.parse(argJson);
  } catch {
    // Wenn nicht parseable, wrappe als string in einem generischen Feld.
    argJson = JSON.stringify({ raw: argsStr });
  }
  return { name, arguments: argJson };
}

// ─────────────────────────────────────────────────────────────────────────
// Chat-Loop
// ─────────────────────────────────────────────────────────────────────────

export async function runChatLoop(
  opts: OrchestratorOptions,
  initialMessages: ChatMessage[],
  caseIdHint: string | undefined,
  sse: SseSink,
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const rootCwd = opts.rootCwd ?? process.cwd();
  const maxIterations = opts.maxIterations ?? 8;
  const handlerCtx: OrchestratorHandlerCtx = {
    appId: opts.appId,
    applicationsDir: opts.applicationsDir,
    runsDir: opts.runsDir,
    rootCwd,
    caseIdHint,
  };

  const systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const fallbackSystem = buildFallbackSystemPrompt(systemPrompt);

  // Wenn der erste User-Turn keinen system enthaelt, prepend wir den.
  const messages: ChatMessage[] = [];
  if (!initialMessages.some((m) => m.role === 'system')) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  for (const m of initialMessages) messages.push({ ...m });

  const tools = toOpenAiToolsSchema();
  // Many vLLM deployments don't start with --enable-auto-tool-choice. The
  // OpenAI `tools` schema then returns 400 on the very first request. Set
  // STURM_ORCHESTRATOR_FORCE_FALLBACK=1 to skip the failing probe and go
  // straight to the prompt-engineered fallback. Default off; we let the
  // catch-block detect-and-flip on the first error otherwise.
  let useFallback = process.env['STURM_ORCHESTRATOR_FORCE_FALLBACK'] === '1'; // lint-no-env: allow — runtime feature flag, not a tool binding
  if (useFallback) {
    sse.event('mode', { mode: 'fallback-prompt-tools', reason: 'forced via STURM_ORCHESTRATOR_FORCE_FALLBACK' });
  }
  const tStart = Date.now();

  for (let iter = 0; iter < maxIterations; iter++) {
    if (sse.closed) return;
    let reply: VllmReply;
    try {
      // Bei Fallback-Modus: ersetze den ersten system durch den fallback-prompt.
      const effectiveMessages = useFallback
        ? messages.map((m, idx) => (idx === 0 && m.role === 'system') ? { ...m, content: fallbackSystem } : m)
        : messages;
      reply = await callVllmStreaming({
        vllmUrl: opts.vllmUrl,
        modelName: opts.modelName,
        messages: effectiveMessages,
        tools: useFallback ? null : tools,
        fetchImpl,
        onToken: (delta) => sse.event('token', { delta }),
      });
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      console.error(`[orchestrator] vLLM call failed (iter ${iter}, useFallback=${useFallback}):`, msg.slice(0, 200));
      if (e instanceof VllmHttpError && !useFallback) {
        // Any vLLM HTTP error during the FIRST tools-enabled call → assume
        // tool-use unsupported, switch to prompt-engineered fallback. (Was
        // gated on /tool|tools|function/i.test(body) but some vLLM versions
        // return a generic 400 without those words; broaden the trigger.)
        sse.event('mode', { mode: 'fallback-prompt-tools', reason: e.body.slice(0, 120) });
        useFallback = true;
        continue;
      }
      sse.event('error', { message: msg });
      sse.event('done', { finishReason: 'error', totalMs: Date.now() - tStart });
      sse.end();
      return;
    }

    if (useFallback) {
      // Im Fallback-Modus: parse das Output nach `<tool_call>…</tool_call>`.
      const tc = parseFallbackToolCall(reply.content);
      if (!tc) {
        sse.event('done', { finishReason: 'stop', totalMs: Date.now() - tStart });
        sse.end();
        return;
      }
      const tool = TOOLS_BY_NAME.get(tc.name);
      sse.event('tool_call', { name: tc.name, args: safeParseArgs(tc.arguments) });
      if (!tool) {
        const result = { error: `Unbekanntes Werkzeug: ${tc.name}` };
        sse.event('tool_result', { name: tc.name, result, durationMs: 0 });
        messages.push({ role: 'assistant', content: reply.content });
        messages.push({ role: 'user', content: `Werkzeug-Ergebnis: ${JSON.stringify(result)}` });
        continue;
      }
      const t0 = Date.now();
      let result;
      try {
        result = await tool.handler(safeParseArgs(tc.arguments), handlerCtx);
      } catch (e) {
        result = { error: `Werkzeug ${tc.name} fehlgeschlagen: ${(e as Error).message}` };
      }
      const durationMs = Date.now() - t0;
      sse.event('tool_result', { name: tc.name, result, durationMs });
      messages.push({ role: 'assistant', content: reply.content });
      messages.push({ role: 'user', content: `Werkzeug-Ergebnis (${tc.name}): ${JSON.stringify(result)}` });
      continue;
    }

    // OpenAI-tool-use-Pfad
    if (reply.finishReason === 'tool_calls' && reply.toolCalls.length > 0) {
      // Push assistant-message mit tool_calls — wichtig fuer den naechsten Roundtrip.
      messages.push({
        role: 'assistant',
        content: reply.content,
        tool_calls: reply.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });
      for (const tc of reply.toolCalls) {
        const tool = TOOLS_BY_NAME.get(tc.name);
        const args = safeParseArgs(tc.arguments);
        sse.event('tool_call', { name: tc.name, args, id: tc.id });
        if (!tool) {
          const errResult = { error: `Unbekanntes Werkzeug: ${tc.name}` };
          sse.event('tool_result', { name: tc.name, result: errResult, durationMs: 0, id: tc.id });
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(errResult),
          });
          continue;
        }
        const t0 = Date.now();
        let result;
        try {
          result = await tool.handler(args, handlerCtx);
        } catch (e) {
          result = { error: `Werkzeug ${tc.name} fehlgeschlagen: ${(e as Error).message}` };
        }
        const durationMs = Date.now() - t0;
        sse.event('tool_result', { name: tc.name, result, durationMs, id: tc.id });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(result),
        });
      }
      continue;
    }

    // Kein Tool-Call → Ende.
    sse.event('done', { finishReason: reply.finishReason, totalMs: Date.now() - tStart });
    sse.end();
    return;
  }

  // Max-Iterations erreicht
  sse.event('done', { finishReason: 'max_iterations', totalMs: Date.now() - tStart });
  sse.end();
}

function safeParseArgs(raw: string): Record<string, unknown> {
  if (!raw || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Non-streaming chat loop — POST /chat-sync
// ─────────────────────────────────────────────────────────────────────────

/** vLLM /v1/chat/completions with stream: false. Returns the whole reply. */
async function callVllmSync(
  opts: { vllmUrl: string; modelName: string; messages: ChatMessage[]; fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<{ content: string; finishReason: string }> {
  const body = {
    model: opts.modelName,
    messages: opts.messages.map((m) => {
      const o: Record<string, unknown> = { role: m.role, content: m.content };
      if (m.tool_call_id) o.tool_call_id = m.tool_call_id;
      if (m.name) o.name = m.name;
      return o;
    }),
    stream: false,
    temperature: 0.2,
    max_tokens: 1024,
  };
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`${opts.vllmUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`vLLM HTTP ${res.status}: ${txt.slice(0, 300)}`);
  }
  const json = await res.json() as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  };
  const c = json.choices?.[0];
  return { content: c?.message?.content ?? '', finishReason: c?.finish_reason ?? 'stop' };
}

export interface SyncChatStep {
  kind: 'tool_call';
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  ms: number;
}

export interface SyncChatResult {
  reply: string;                   // final assistant text
  iterations: number;
  steps: SyncChatStep[];
  totalMs: number;
  mode: 'fallback-prompt-tools';   // always prompt-engineered (no OpenAI tools schema)
}

export async function runChatLoopSync(
  opts: OrchestratorOptions,
  initialMessages: ChatMessage[],
  caseIdHint: string | undefined,
): Promise<SyncChatResult> {
  return runChatLoopSyncWithProgress(opts, initialMessages, caseIdHint, null);
}

/**
 * Variante mit Progress-Callback. Identisch zu `runChatLoopSync`, ruft aber
 * vor und nach jedem Tool-Call den `send`-Callback auf — gedacht fuer
 * `/chat-stream`, das die gleichen Schritte als SSE-Events ausgibt. Wenn
 * `send` null ist, verhaelt sich die Funktion exakt wie `runChatLoopSync`.
 */
export type ProgressSend = (event: string, payload: unknown) => void;

export async function runChatLoopSyncWithProgress(
  opts: OrchestratorOptions,
  initialMessages: ChatMessage[],
  caseIdHint: string | undefined,
  send: ProgressSend | null,
): Promise<SyncChatResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const rootCwd = opts.rootCwd ?? process.cwd();
  const maxIterations = opts.maxIterations ?? 6;
  const handlerCtx: OrchestratorHandlerCtx = {
    appId: opts.appId,
    applicationsDir: opts.applicationsDir,
    runsDir: opts.runsDir,
    rootCwd,
    caseIdHint,
  };
  const systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const fallbackSystem = buildFallbackSystemPrompt(systemPrompt);

  const messages: ChatMessage[] = [];
  if (!initialMessages.some((m) => m.role === 'system')) {
    messages.push({ role: 'system', content: fallbackSystem });
  } else {
    // Replace the user's system with the fallback one (which adds tool syntax).
    messages.push(...initialMessages.map((m, i) => i === 0 && m.role === 'system' ? { ...m, content: fallbackSystem } : m));
    for (let i = 1; i < initialMessages.length; i++) messages.push({ ...initialMessages[i] });
  }
  if (!initialMessages.some((m) => m.role === 'system')) {
    for (const m of initialMessages) messages.push({ ...m });
  }

  const steps: SyncChatStep[] = [];
  const tStart = Date.now();
  let lastContent = '';

  for (let iter = 0; iter < maxIterations; iter++) {
    const reply = await callVllmSync({
      vllmUrl: opts.vllmUrl,
      modelName: opts.modelName,
      messages,
      fetchImpl,
    });
    lastContent = reply.content;
    const tc = parseFallbackToolCall(reply.content);
    if (!tc) {
      // No tool call → final answer.
      return {
        reply: reply.content.trim(),
        iterations: iter + 1,
        steps,
        totalMs: Date.now() - tStart,
        mode: 'fallback-prompt-tools',
      };
    }
    // Execute the tool.
    const tool = TOOLS_BY_NAME.get(tc.name);
    const args = safeParseArgs(tc.arguments);
    if (send) send('tool_call', { name: tc.name, args });
    const tCall = Date.now();
    let result: unknown;
    if (!tool) {
      result = { error: `Unbekanntes Werkzeug: ${tc.name}` };
    } else {
      try {
        result = await tool.handler(args, handlerCtx);
      } catch (e) {
        result = { error: (e as Error).message };
      }
    }
    const ms = Date.now() - tCall;
    if (send) send('tool_result', { name: tc.name, result, ms });
    steps.push({ kind: 'tool_call', name: tc.name, args, result, ms });
    // Append assistant message (with the raw tool_call syntax) + a "tool result" hint.
    messages.push({ role: 'assistant', content: reply.content });
    messages.push({
      role: 'user',
      content: `<tool_result name="${tc.name}">${JSON.stringify(result)}</tool_result>\n\nBitte berücksichtige dieses Ergebnis und antworte dem Nutzer.`,
    });
  }
  // Max iterations hit — return the last content as the reply.
  return {
    reply: lastContent.trim() || '(keine Antwort innerhalb der Iterations-Grenze)',
    iterations: maxIterations,
    steps,
    totalMs: Date.now() - tStart,
    mode: 'fallback-prompt-tools',
  };
}

/** Splits `text` into chunks of at most `maxLen` chars, preferring whitespace
 *  boundaries so the typewriter feel doesn't break mid-word. */
function chunkText(text: string, maxLen: number): string[] {
  if (!text || text.length === 0) return [];
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + maxLen, text.length);
    if (end < text.length) {
      // Try to break at last whitespace within [i+maxLen/2, end]
      const slice = text.slice(i, end);
      const wsIdx = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf('\n'));
      if (wsIdx > Math.floor(maxLen / 2)) end = i + wsIdx + 1;
    }
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}

// ─────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────

export function createOrchestratorRouter(opts: OrchestratorOptions): Router {
  const router = Router();

  router.get('/tools', (_req, res) => {
    res.json({
      appId: opts.appId,
      model: opts.modelName,
      tools: ORCHESTRATOR_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
  });

  router.post('/chat', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      caseId?: string;
      messages?: ChatMessage[];
      appId?: string;
    };
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (messages.length === 0) {
      return res.status(400).json({ error: 'messages (Array) erforderlich' });
    }
    // Wenn appId im Body anders ist als der gemountete Router: 400 (Sicherheit).
    if (body.appId && body.appId !== opts.appId) {
      return res.status(400).json({ error: `appId mismatch: erwartet ${opts.appId}` });
    }
    const sse = makeSseSink(res);
    req.on('close', () => sse.end());
    try {
      await runChatLoop(opts, messages, body.caseId, sse);
    } catch (e) {
      sse.event('error', { message: (e as Error).message });
      sse.event('done', { finishReason: 'error', totalMs: 0 });
      sse.end();
    }
  });

  // ── Non-streaming chat — simpler contract, easier to debug ───────────
  // POST { messages, caseId? } → 200 JSON {
  //   reply: string, tool_calls: [{name, args, result, ms}], totalMs, iterations
  // }
  // Internally: runs the prompt-engineered tool-use loop with stream:false
  // on every vLLM call. No SSE flush ambiguity. Use this from the UI when
  // streaming UX isn't required (or when /chat hangs in your env).
  router.post('/chat-sync', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      caseId?: string;
      messages?: ChatMessage[];
      appId?: string;
    };
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (messages.length === 0) {
      return res.status(400).json({ error: 'messages (Array) erforderlich' });
    }
    if (body.appId && body.appId !== opts.appId) {
      return res.status(400).json({ error: `appId mismatch: erwartet ${opts.appId}` });
    }
    try {
      const result = await runChatLoopSync(opts, messages, body.caseId);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── Streaming chat — discrete SSE events on top of chat-sync ────────
  // Same loop as /chat-sync, but emits SSE events as steps complete server-
  // side:
  //   event: tool_call   per tc BEFORE the handler runs (name, args)
  //   event: tool_result per tc AFTER the handler returns (name, result, ms)
  //   event: token_chunk per ~64-char slice of the final reply
  //                      (40 ms spacing for smooth typewriter feel)
  //   event: done        at end with { iterations, totalMs, mode }
  //   event: error       on failure
  // This avoids re-introducing the helmet+SSE flush bug from real vLLM
  // streaming — chunks are split server-side, not pulled from vLLM stream.
  router.post('/chat-stream', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      caseId?: string;
      messages?: ChatMessage[];
      appId?: string;
    };
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (messages.length === 0) {
      return res.status(400).json({ error: 'messages (Array) erforderlich' });
    }
    if (body.appId && body.appId !== opts.appId) {
      return res.status(400).json({ error: `appId mismatch: erwartet ${opts.appId}` });
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    try { res.write(': sturm-orchestrator open\n\n'); } catch { /* tolerant */ }

    let clientClosed = false;
    req.on('close', () => { clientClosed = true; });
    const send: ProgressSend = (name, payload) => {
      if (clientClosed) return;
      try { res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`); }
      catch { /* tolerant */ }
    };

    try {
      const result = await runChatLoopSyncWithProgress(opts, messages, body.caseId, send);
      // Stream the final reply as token_chunk events for smooth UX.
      const chunks = chunkText(result.reply, 64);
      for (const delta of chunks) {
        if (clientClosed) break;
        send('token_chunk', { delta });
        await new Promise((r) => setTimeout(r, 40));
      }
      send('done', { iterations: result.iterations, totalMs: result.totalMs, mode: result.mode });
    } catch (e) {
      send('error', { message: (e as Error).message });
      send('done', { iterations: 0, totalMs: 0, mode: 'error' });
    } finally {
      try { res.end(); } catch { /* tolerant */ }
    }
  });

  return router;
}

// Re-export fuer Tests / externe Konsumenten
export { ORCHESTRATOR_TOOLS, TOOLS_BY_NAME };
