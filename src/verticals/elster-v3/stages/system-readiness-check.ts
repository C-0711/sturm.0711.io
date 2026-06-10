/**
 * elster-v3/system-readiness-check — Pre-Flight-Diagnostik vor dem
 * eigentlichen Workflow.
 *
 * Pingt alle externen Dependencies + Container-Files die der ESE-Mapper +
 * VaSt-Mapper brauchen. Output ist eine strukturierte Liste mit per-System-
 * Status, die im Pipeline-Runner als Health-Dashboard gerendert wird.
 *
 * Damit sieht der User SOFORT (in <2s) ob:
 *   - Lane 1 BMF Calculator erreichbar
 *   - Ollama embeddinggemma-Modell geladen (für Welle 4 Cascade)
 *   - Ollama Gemma4 (vision/chat) verfügbar (für Vision-OCR-Zoning)
 *   - vLLM endpoint reachable
 *   - ELSTER container atoms.json gelesen werden kann
 *   - FP32 embedding file präsent (für Cascade-Search)
 */
import { existsSync, statSync } from 'node:fs';
import { defineStage } from '../../../core/stage.ts';

export interface SystemReadinessInput {
  /** Nur diagnostic — kein echter input vom workflow nötig. */
  _trigger?: unknown;
}

export interface SystemReadinessConfig {
  /** URL-Overrides. Default: host.docker.internal Routen (container-aware). */
  lane1Url?: string;
  ollamaUrl?: string;
  vllmUrl?: string;
  /** Pfade zu container-Snapshots. */
  atomsJsonPath?: string;
  cascadeFp32Path?: string;
  /** Timeout pro check in ms. Default 3000. */
  timeoutMs?: number;
}

export interface ReadinessProbe {
  id: string;
  label: string;
  category: 'service' | 'model' | 'data' | 'binary';
  status: 'ok' | 'fail' | 'unknown';
  detail: string;
  /** Latenz in ms (für service probes). */
  latencyMs?: number;
  /** Datei-Größe in bytes (für data probes). */
  fileSizeBytes?: number;
}

export interface SystemReadinessOutput {
  /** Pro Dependency: status + detail. */
  probes: ReadinessProbe[];
  /** Aggregat: alles ok? */
  allReady: boolean;
  /** Welche Wellen können laufen mit dem aktuellen System-Stand. */
  capabilities: {
    welle1_math: boolean;
    welle3_label_adjacency: boolean;
    welle4_cascade: boolean;
    welle5_lane1_verifier: boolean;
    vision_ocr: boolean;
  };
  ms: number;
}

// ──────────────────────────────────────────────────────────────────────────

async function pingHttp(url: string, timeoutMs: number): Promise<{ ok: boolean; status: number; ms: number; error?: string }> {
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(tid);
    const ms = Date.now() - t0;
    return { ok: r.ok, status: r.status, ms };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, error: (e as Error).message };
  }
}

async function ollamaModels(ollamaUrl: string, timeoutMs: number): Promise<string[]> {
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(`${ollamaUrl.replace(/\/$/, '')}/api/tags`, { signal: ctrl.signal });
    clearTimeout(tid);
    if (!r.ok) return [];
    const j = (await r.json()) as { models?: Array<{ name?: string }> };
    return (j.models ?? []).map((m) => m.name ?? '').filter(Boolean);
  } catch {
    return [];
  }
}

// ──────────────────────────────────────────────────────────────────────────

export const systemReadinessCheckStage = defineStage<
  SystemReadinessInput,
  SystemReadinessOutput,
  SystemReadinessConfig
>({
  id: 'elster-v3/system-readiness-check',
  name: 'System-Readiness-Check (Lane 1 / Ollama / FP32 / Container)',
  description:
    'Pre-Flight-Diagnostik: pingt Lane 1 BMF + Ollama (embeddinggemma + Gemma4) ' +
    '+ vLLM + atoms.json + FP32-Cascade. Output zeigt pro Dependency ' +
    'ok/fail mit Latenz + Detail. Dient als visueller Health-Check im ' +
    'Pipeline-Runner BEVOR der eigentliche Workflow startet.',
  hints: {
    inputs: 'kein Input nötig — diagnostic-only stage',
    outputs:
      'probes[{id,label,status,detail,latencyMs}], allReady, capabilities{welle1..welle5}, ms',
    configExample:
      '{"lane1Url":"http://host.docker.internal:12010/health","ollamaUrl":"http://host.docker.internal:11434","timeoutMs":3000}',
    outputPorts: [
      { name: 'probes', type: 'json', description: 'Liste der Dependency-Status' },
      { name: 'allReady', type: 'boolean' },
      { name: 'capabilities', type: 'json', description: 'Per-Welle Bereitschaft' },
    ],
  },

  async run(_input, ctx) {
    const t0 = Date.now();
    const lane1Url = ctx.config?.lane1Url ?? 'http://host.docker.internal:12010/health';
    const ollamaUrl = ctx.config?.ollamaUrl ?? 'http://host.docker.internal:11434';
    const vllmUrl = ctx.config?.vllmUrl ?? 'http://host.docker.internal:11437/v1/models';
    const atomsPath =
      ctx.config?.atomsJsonPath ?? 'src/verticals/elster-v3/data/atoms.json';
    const cascadePath =
      ctx.config?.cascadeFp32Path ?? 'src/verticals/elster-v3/data/embeddings.gemma4.fp32.bin';
    const timeoutMs = ctx.config?.timeoutMs ?? 3000;

    const probes: ReadinessProbe[] = [];

    // ── Service probes ──────────────────────────────────────────────
    const lane1 = await pingHttp(lane1Url, timeoutMs);
    probes.push({
      id: 'lane1_bmf',
      label: 'Lane 1 BMF Calculator',
      category: 'service',
      status: lane1.ok ? 'ok' : 'fail',
      detail: lane1.ok
        ? `HTTP ${lane1.status} (Welle 5 §32a-Verifier)`
        : `unerreichbar: ${lane1.error ?? 'HTTP ' + lane1.status}`,
      latencyMs: lane1.ms,
    });

    const ollamaTags = await pingHttp(`${ollamaUrl}/api/tags`, timeoutMs);
    const models = ollamaTags.ok ? await ollamaModels(ollamaUrl, timeoutMs) : [];
    probes.push({
      id: 'ollama_service',
      label: 'Ollama LLM Server',
      category: 'service',
      status: ollamaTags.ok ? 'ok' : 'fail',
      detail: ollamaTags.ok
        ? `HTTP 200 · ${models.length} models loaded`
        : `unerreichbar: ${ollamaTags.error}`,
      latencyMs: ollamaTags.ms,
    });

    // ── Model probes ────────────────────────────────────────────────
    const hasEmbedding = models.some((m) => m.includes('embeddinggemma'));
    probes.push({
      id: 'embeddinggemma',
      label: 'embeddinggemma-300m (Welle 4 Cascade)',
      category: 'model',
      status: hasEmbedding ? 'ok' : 'fail',
      detail: hasEmbedding
        ? 'Modell geladen — FP32 cosine top-K verfügbar'
        : 'Modell nicht gefunden in Ollama-Tags',
    });

    const hasGemma4 = models.some((m) => m.toLowerCase().includes('gemma4'));
    probes.push({
      id: 'gemma4_chat',
      label: 'Gemma-4 (Vision-OCR + LLM-Fill)',
      category: 'model',
      status: hasGemma4 ? 'ok' : 'fail',
      detail: hasGemma4
        ? `Modell-Varianten: ${models.filter((m) => m.toLowerCase().includes('gemma4')).join(', ')}`
        : 'kein gemma4-Modell in Ollama gefunden',
    });

    // vLLM optional (für gemma-vision-ocr-zoning structured output)
    const vllm = await pingHttp(vllmUrl, timeoutMs);
    probes.push({
      id: 'vllm_server',
      label: 'vLLM Server (Vision-OCR-Zoning)',
      category: 'service',
      status: vllm.ok ? 'ok' : 'fail',
      detail: vllm.ok ? `HTTP ${vllm.status}` : `unerreichbar (optional): ${vllm.error}`,
      latencyMs: vllm.ms,
    });

    // ── Data/Binary probes ──────────────────────────────────────────
    const atomsExists = existsSync(atomsPath);
    let atomsSize = 0;
    if (atomsExists) {
      try {
        atomsSize = statSync(atomsPath).size;
      } catch {
        /* ignore */
      }
    }
    probes.push({
      id: 'atoms_json',
      label: 'ELSTER atoms.json container',
      category: 'data',
      status: atomsExists ? 'ok' : 'fail',
      detail: atomsExists
        ? `${atomsPath} · ${(atomsSize / 1024 / 1024).toFixed(1)} MB · 2287 eCodes`
        : `nicht gefunden: ${atomsPath}`,
      fileSizeBytes: atomsSize,
    });

    const cascadeExists = existsSync(cascadePath);
    let cascadeSize = 0;
    if (cascadeExists) {
      try {
        cascadeSize = statSync(cascadePath).size;
      } catch {
        /* ignore */
      }
    }
    probes.push({
      id: 'cascade_fp32',
      label: 'FP32 Cascade-Embeddings (768-dim)',
      category: 'data',
      status: cascadeExists ? 'ok' : 'fail',
      detail: cascadeExists
        ? `${(cascadeSize / 1024 / 1024).toFixed(1)} MB · 2287×768 float32`
        : `nicht gefunden: ${cascadePath}`,
      fileSizeBytes: cascadeSize,
    });

    // ── Aggregat + Capabilities ─────────────────────────────────────
    const isOk = (id: string): boolean => probes.find((p) => p.id === id)?.status === 'ok';

    const capabilities = {
      welle1_math: isOk('atoms_json'), // Math braucht nur Container
      welle3_label_adjacency: isOk('atoms_json'),
      welle4_cascade: isOk('atoms_json') && isOk('cascade_fp32') && isOk('embeddinggemma'),
      welle5_lane1_verifier: isOk('lane1_bmf'),
      vision_ocr: isOk('gemma4_chat') || isOk('vllm_server'),
    };

    const allReady = probes.every((p) => p.status === 'ok');

    const ms = Date.now() - t0;
    ctx.emit('system_readiness_completed', {
      probeCount: probes.length,
      okCount: probes.filter((p) => p.status === 'ok').length,
      allReady,
      capabilities,
      ms,
    });

    // Side-effect: emit per-probe events so UI can show real-time status
    for (const p of probes) {
      ctx.emit(`probe_${p.id}`, {
        status: p.status,
        detail: p.detail,
        latencyMs: p.latencyMs,
      });
    }

    return { probes, allReady, capabilities, ms };
  },
});
