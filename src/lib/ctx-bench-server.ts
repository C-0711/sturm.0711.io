/**
 * ctx-bench-server — SSE-streaming Variante des bench-Skripts für die
 * Browser-UI in ctx-demo.html. Wickelt den Mistral + Ollama Chat-Loop ab
 * und schickt event-pro-Zelle Live-Updates an die Page.
 *
 * Endpoint: POST /api/ctx-bench/run   {containerId, k?, prompts?, models?, skipBaseline?}
 *           → text/event-stream
 */
import type { Request, Response, Router } from 'express';
import { Router as makeRouter } from 'express';
import {
  chat,
  buildBaselineContext,
  buildCtxRetrievedContext,
  type ChatModel,
} from './llm-bench.ts';
import { getContainer } from './ctx-store.ts';

const DEFAULT_PANEL: ChatModel[] = [
  { label: 'mistral-small',  provider: 'mistral', model: 'mistral-small-latest',     contextHint: 32000 },
  { label: 'gemma4-e4b',     provider: 'ollama',  model: 'gemma4:e4b',                contextHint: 8000  },
  { label: 'llama3.1-8b',    provider: 'ollama',  model: 'llama3.1:8b',               contextHint: 8000  },
  { label: 'qwen3-32b',      provider: 'ollama',  model: 'qwen3:32b',                 contextHint: 32000 },
];

const DEFAULT_PROMPTS = [
  { id: 'splittingtarif',         q: 'Wie wurde im finalen Stricker-Fall der Splittingtarif-Vorteil konkret berechnet, und welche Eingabewerte gingen ein?' },
  { id: 'vorsorge-hoechstbetrag', q: 'Welche Schritte hat die §10 Abs. 3/4 EStG Höchstbetragsberechnung in Sektion 2.1.1 der Abrechnung? Nenne die Zwischenwerte.' },
  { id: 'estg-citations',         q: 'Wie funktioniert das kontextPath → §EStG Mapping in src/lib/estg-citations.ts, und welche Fallback-Strategie gibt es?' },
  { id: 'gitchain-bootbug',       q: 'Was war der Boot-Bug in src/lib/gitchain-client.ts und wie wurde er behoben?' },
];

const SYSTEM_PROMPT_BASELINE = 'Du bist ein Senior Software Engineer. Beantworte die Frage prägnant (max 200 Wörter), zitiere konkrete Werte/Codestellen aus dem mitgelieferten Transcript. Wenn du etwas nicht weißt, sag das.';
const SYSTEM_PROMPT_CTX = 'Du bist ein Senior Software Engineer. Beantworte die Frage prägnant (max 200 Wörter) basierend NUR auf den unten gezeigten Atomen aus dem Projekt-Container. Zitiere wenn möglich path#symbol. Wenn die Atome die Antwort nicht enthalten, sag das.';

interface ServerOptions {
  ollamaUrl?: string;
  embedCpu?: boolean;
}

export function createCtxBenchRouter(opts: ServerOptions = {}): Router {
  const router = makeRouter();
  router.get('/panel', (_req, res) => {
    res.json({ models: DEFAULT_PANEL, prompts: DEFAULT_PROMPTS });
  });

  router.post('/run', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      containerId?: string;
      k?: number;
      skipBaseline?: boolean;
      models?: string[];
      prompts?: Array<{ id: string; q: string }>;
    };
    const containerId = String(body.containerId ?? '');
    if (!containerId) { res.status(400).json({ error: 'containerId_required' }); return; }
    const rec = await getContainer(containerId);
    if (!rec)                       { res.status(404).json({ error: 'container_not_found' }); return; }
    if (rec.status !== 'indexed')   { res.status(409).json({ error: 'container_not_indexed' }); return; }

    const k = Math.max(1, Math.min(20, Number(body.k ?? 5)));
    const panel = body.models ? DEFAULT_PANEL.filter((p) => body.models!.includes(p.label)) : DEFAULT_PANEL;
    const prompts = body.prompts && body.prompts.length > 0 ? body.prompts : DEFAULT_PROMPTS;
    const skipBaseline = body.skipBaseline === true;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const emit = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    emit('run_meta', {
      containerId: rec.id, shortId: rec.shortId, atomCount: rec.atomCount,
      models: panel.map((p) => p.label),
      prompts: prompts.map((p) => p.id),
      k, skipBaseline,
    });

    try {
      const baseline = await buildBaselineContext(rec.outDir);
      emit('baseline_loaded', { bytes: baseline.length });

      for (const prompt of prompts) {
        emit('prompt_start', { id: prompt.id, q: prompt.q });

        // retrieve once per prompt
        const t0 = Date.now();
        const ctxRet = await buildCtxRetrievedContext(rec.outDir, prompt.q, k, opts);
        emit('ctx_retrieved', {
          promptId: prompt.id,
          hits: ctxRet.hits.length,
          contextBytes: ctxRet.context.length,
          retrieveMs: Date.now() - t0,
          topHits: ctxRet.hits.slice(0, 3).map((h) => ({ path: h.path, symbol: h.symbol, score: h.score })),
        });

        for (const m of panel) {
          // ── ctx mode
          emit('cell_start', { model: m.label, prompt: prompt.id, mode: 'ctx' });
          const ctxRes = await chat(m, [
            { role: 'system', content: SYSTEM_PROMPT_CTX },
            { role: 'user', content: `${prompt.q}\n\n---\nContext atoms:\n${ctxRet.context}` },
          ], { maxTokens: 400 });
          emit('cell_done', {
            model: m.label, prompt: prompt.id, mode: 'ctx',
            promptTokens: ctxRes.promptTokens,
            completionTokens: ctxRes.completionTokens,
            latencyMs: ctxRes.latencyMs,
            truncated: ctxRes.truncated,
            error: ctxRes.error,
            answer: ctxRes.content,
          });

          if (skipBaseline) continue;

          // ── baseline mode (truncate to fit context window)
          let baseSource = baseline;
          if (m.contextHint) {
            const budgetChars = Math.floor(m.contextHint * 0.6) * 4;
            if (baseSource.length > budgetChars) baseSource = baseSource.slice(0, budgetChars) + '\n\n[...truncated to fit context window]';
          }
          emit('cell_start', { model: m.label, prompt: prompt.id, mode: 'baseline' });
          const baseRes = await chat(m, [
            { role: 'system', content: SYSTEM_PROMPT_BASELINE },
            { role: 'user', content: `${prompt.q}\n\n---\nFull transcript:\n${baseSource}` },
          ], { maxTokens: 400 });
          emit('cell_done', {
            model: m.label, prompt: prompt.id, mode: 'baseline',
            promptTokens: baseRes.promptTokens,
            completionTokens: baseRes.completionTokens,
            latencyMs: baseRes.latencyMs,
            truncated: baseRes.truncated,
            error: baseRes.error,
            answer: baseRes.content,
          });
        }
      }
      emit('run_done', { ts: new Date().toISOString() });
    } catch (e) {
      emit('run_error', { message: (e as Error).message });
    } finally {
      res.end();
    }
  });

  return router;
}
