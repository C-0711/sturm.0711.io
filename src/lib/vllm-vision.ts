/**
 * vllm-vision — wrapper around vLLM /v1/chat/completions for multi-image +
 * JSON-schema-constrained calls (Gemma-4 multimodal pattern).
 *
 * Verwendung in v6 phase3VisionFill: PNG-Seiten + Feldkarten-Text +
 * JSON-Schema → strukturiertes Objekt.
 *
 * Wichtig: Gemma-4 honoriert `description` im JSON-Schema NICHT.
 * Semantik gehört in `textInstructions` (siehe v6-Spike).
 */
import { readFile } from 'node:fs/promises';

export interface VllmVisionOptions {
  /** vLLM /v1 base URL. Example: 'http://host.docker.internal:11435' */
  vllmUrl: string;
  /** Served model name. Example: 'gemma4-mm' */
  model: string;
  /** Absolute paths to image files (PNG/JPG). vLLM limits to 4 per call for Gemma-4. */
  imagePaths: string[];
  /** Plain-text instructions for the model (field map, rules, format hints). */
  textInstructions: string;
  /** JSON schema for constrained decoding. `description` fields are NOT honored
   *  by Gemma-4 — put semantics in textInstructions. */
  jsonSchema: {
    name: string;
    schema: Record<string, unknown>;
    strict: boolean;
  };
  /** Max completion tokens. Default 2500. */
  maxTokens?: number;
  /** Sampling temperature. Default 0 (deterministic). */
  temperature?: number;
  /** Per-call timeout in ms. Default 60_000. */
  timeoutMs?: number;
  /** Caller abort signal (e.g. ctx.signal from a stage). */
  signal?: AbortSignal;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

export interface VllmVisionResult<T = Record<string, string | null>> {
  /** The JSON object parsed from the model's response (schema-validated by vLLM). */
  parsed: T;
  /** OpenAI finish_reason: 'stop' | 'length' | 'content_filter' | etc. */
  finishReason: string;
  /** vLLM-reported prompt tokens (includes image tokens). */
  promptTokens: number;
  /** Completion tokens generated. */
  completionTokens: number;
  /** Total wallclock of the call (network + inference). */
  wallclockMs: number;
}

export type VllmVisionErrorStage =
  | 'request'
  | 'http'
  | 'parse'
  | 'timeout'
  | 'aborted';

export class VllmVisionError extends Error {
  constructor(
    public readonly stage: VllmVisionErrorStage,
    message: string,
    public readonly httpStatus?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'VllmVisionError';
  }
}

// vLLM `--limit-mm-per-prompt image=10` (Bombas/CB raised 2026-05-18 von 4
// auf 10 für Multi-Doc-Bundles wie VAST). Falls deine vLLM-Instanz nur 4
// erlaubt → caller muss explizit splitten (siehe gemma-vision-ocr-zoning).
const MAX_IMAGES_GEMMA4 = 10;
const DEFAULT_MAX_TOKENS = 2500;
const DEFAULT_TEMPERATURE = 0;
const DEFAULT_TIMEOUT_MS = 60_000;

interface OpenAiChatResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | null };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

export async function callVllmVision<T = Record<string, string | null>>(
  opts: VllmVisionOptions,
): Promise<VllmVisionResult<T>> {
  // 1. Validate image count
  if (!Array.isArray(opts.imagePaths) || opts.imagePaths.length < 1) {
    throw new VllmVisionError(
      'request',
      'callVllmVision: imagePaths must contain at least 1 image',
    );
  }
  if (opts.imagePaths.length > MAX_IMAGES_GEMMA4) {
    throw new VllmVisionError(
      'request',
      `callVllmVision: imagePaths has ${opts.imagePaths.length} entries; Gemma-4 vLLM limit is ${MAX_IMAGES_GEMMA4} per call`,
    );
  }

  // 2. Read + base64-encode each image
  let imageContents: Array<{ type: 'image_url'; image_url: { url: string } }>;
  try {
    imageContents = await Promise.all(
      opts.imagePaths.map(async (p) => {
        const buf = await readFile(p);
        const b64 = Buffer.from(buf).toString('base64');
        return {
          type: 'image_url' as const,
          image_url: { url: `data:image/png;base64,${b64}` },
        };
      }),
    );
  } catch (err) {
    throw new VllmVisionError(
      'request',
      `callVllmVision: failed to read image file: ${(err as Error).message}`,
    );
  }

  // 3. Build OpenAI multi-content user message
  const userMessage = {
    role: 'user' as const,
    content: [
      ...imageContents,
      { type: 'text' as const, text: opts.textInstructions },
    ],
  };

  // 4. Compose request body
  const body = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
    stream: false,
    messages: [userMessage],
    response_format: {
      type: 'json_schema',
      json_schema: opts.jsonSchema,
    },
  };

  // 5. Wire AbortController: timeout + caller signal
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onCallerAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) {
      clearTimeout(timer);
      throw new VllmVisionError('aborted', 'callVllmVision: aborted by caller before dispatch');
    }
    opts.signal.addEventListener('abort', onCallerAbort, { once: true });
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${opts.vllmUrl.replace(/\/+$/, '')}/v1/chat/completions`;

  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onCallerAbort);
    if (timedOut) {
      throw new VllmVisionError(
        'timeout',
        `callVllmVision: request timed out after ${timeoutMs}ms`,
      );
    }
    if (opts.signal?.aborted) {
      throw new VllmVisionError('aborted', 'callVllmVision: aborted by caller');
    }
    throw new VllmVisionError(
      'request',
      `callVllmVision: fetch failed: ${(err as Error).message}`,
    );
  }
  clearTimeout(timer);
  opts.signal?.removeEventListener('abort', onCallerAbort);

  const wallclockMs = Date.now() - t0;

  // 6. HTTP error handling
  if (!res.ok) {
    let errBody = '';
    try {
      errBody = await res.text();
    } catch {
      /* ignore */
    }
    throw new VllmVisionError(
      'http',
      `callVllmVision: HTTP ${res.status} from vLLM`,
      res.status,
      errBody,
    );
  }

  // 7. Parse OpenAI response shape
  let payload: OpenAiChatResponse;
  let rawText = '';
  try {
    rawText = await res.text();
    payload = JSON.parse(rawText) as OpenAiChatResponse;
  } catch (err) {
    throw new VllmVisionError(
      'parse',
      `callVllmVision: response body is not valid JSON: ${(err as Error).message}`,
      undefined,
      rawText,
    );
  }

  const choice = payload.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== 'string' || content.length === 0) {
    throw new VllmVisionError(
      'parse',
      'callVllmVision: response has no choices[0].message.content',
      undefined,
      rawText,
    );
  }

  let parsed: T;
  try {
    parsed = JSON.parse(content) as T;
  } catch (err) {
    throw new VllmVisionError(
      'parse',
      `callVllmVision: message content is not valid JSON: ${(err as Error).message}`,
      undefined,
      content,
    );
  }

  return {
    parsed,
    finishReason: choice?.finish_reason ?? 'unknown',
    promptTokens: payload.usage?.prompt_tokens ?? 0,
    completionTokens: payload.usage?.completion_tokens ?? 0,
    wallclockMs,
  };
}
