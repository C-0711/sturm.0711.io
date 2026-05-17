#!/usr/bin/env tsx
/**
 * bench-ctx-savings — End-to-End-Experiment für Token-Savings durch ctx.
 *
 * Pro (Model × Prompt) Paar:
 *   1) baseline:  System-Prompt + ganze source.txt + Frage
 *   2) ctx:       System-Prompt + top-K retrieved atoms + Frage
 *
 * Misst prompt_tokens, completion_tokens, latency. Emittiert Markdown-Report.
 *
 * Nutzung:
 *   EMBED_CPU=1 tsx scripts/bench-ctx-savings.ts <containerShortId>
 *
 * Optional flags:
 *   --k 5                 retrieval top-K (default 5)
 *   --baseline-truncate   ganzes Transcript clippen falls > 60% Modell-Context (default an)
 *   --skip-baseline       nur ctx-Pfad laufen (für Modelle mit kleinem Context)
 *   --models a,b,c        spezifische Model-IDs aus dem Default-Panel
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getContainer } from '../src/lib/ctx-store.ts';
import {
  chat,
  buildBaselineContext,
  buildCtxRetrievedContext,
  type ChatModel,
  type ChatResult,
} from '../src/lib/llm-bench.ts';

const REPO_ROOT = resolve(process.cwd());

// 4-LLM panel: spans cloud + local, small + large, two families.
const PANEL: ChatModel[] = [
  { label: 'mistral-small',  provider: 'mistral', model: 'mistral-small-latest',     contextHint: 32000 },
  { label: 'gemma4-e4b',     provider: 'ollama',  model: 'gemma4:e4b',                contextHint: 8000  },
  { label: 'llama3.1-8b',    provider: 'ollama',  model: 'llama3.1:8b',               contextHint: 8000  },
  { label: 'qwen3-32b',      provider: 'ollama',  model: 'qwen3:32b',                 contextHint: 32000 },
];

// 4 questions grounded in the abrechnung transcript content. Chosen to hit
// distinct semantic regions of the corpus so retrieval has work to do.
const PROMPTS = [
  {
    id: 'splittingtarif',
    q: 'Wie wurde im finalen Stricker-Fall der Splittingtarif-Vorteil konkret berechnet, und welche Eingabewerte gingen ein?',
  },
  {
    id: 'vorsorge-hoechstbetrag',
    q: 'Welche Schritte hat die §10 Abs. 3/4 EStG Höchstbetragsberechnung in Sektion 2.1.1 der Abrechnung? Nenne die Zwischenwerte.',
  },
  {
    id: 'estg-citations',
    q: 'Wie funktioniert das kontextPath → §EStG Mapping in src/lib/estg-citations.ts, und welche Fallback-Strategie gibt es?',
  },
  {
    id: 'gitchain-bootbug',
    q: 'Was war der Boot-Bug in src/lib/gitchain-client.ts und wie wurde er behoben?',
  },
];

const SYSTEM_PROMPT_BASELINE =
  'Du bist ein Senior Software Engineer. Beantworte die Frage prägnant (max 200 Wörter), zitiere konkrete Werte/Codestellen aus dem mitgelieferten Transcript. Wenn du etwas nicht weißt, sag das.';

const SYSTEM_PROMPT_CTX =
  'Du bist ein Senior Software Engineer. Beantworte die Frage prägnant (max 200 Wörter) basierend NUR auf den unten gezeigten Atomen aus dem Projekt-Container. Zitiere wenn möglich path#symbol. Wenn die Atome die Antwort nicht enthalten, sag das.';

interface Row {
  model: string;
  prompt: string;
  mode: 'baseline' | 'ctx';
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  truncated: boolean;
  answer: string;
  error?: string;
}

function parseArgs(): { containerId: string; k: number; skipBaseline: boolean; models: string[] | null; baselineTruncate: boolean } {
  const args = process.argv.slice(2);
  let containerId: string | null = null;
  let k = 5;
  let skipBaseline = false;
  let baselineTruncate = true;
  let models: string[] | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--k')                    { k = Number(args[++i]); }
    else if (a === '--skip-baseline')   { skipBaseline = true; }
    else if (a === '--no-truncate')     { baselineTruncate = false; }
    else if (a === '--models')          { models = args[++i].split(','); }
    else if (!a.startsWith('--'))       { containerId = a; }
  }
  if (!containerId) {
    console.error('usage: tsx scripts/bench-ctx-savings.ts <containerShortId> [--k 5] [--skip-baseline] [--models a,b]');
    process.exit(2);
  }
  return { containerId, k, skipBaseline, models, baselineTruncate };
}

async function main(): Promise<void> {
  const { containerId, k, skipBaseline, models, baselineTruncate } = parseArgs();
  const rec = await getContainer(containerId);
  if (!rec) { console.error(`container not found: ${containerId}`); process.exit(2); }
  if (rec.status !== 'indexed') { console.error('container not indexed'); process.exit(3); }

  const panel = models ? PANEL.filter((p) => models.includes(p.label)) : PANEL;
  if (panel.length === 0) { console.error('no models match filter'); process.exit(2); }

  console.error(`=== Bench: ${rec.shortId} ===`);
  console.error(`  atoms:     ${rec.atomCount}`);
  console.error(`  outDir:    ${rec.outDir}`);
  console.error(`  panel:     ${panel.map((p) => p.label).join(', ')}`);
  console.error(`  prompts:   ${PROMPTS.length}`);
  console.error(`  retrieval: k=${k}`);
  console.error(`  baseline:  ${skipBaseline ? 'SKIPPED' : (baselineTruncate ? 'truncate to ~60% ctx window' : 'full transcript')}`);
  console.error('');

  const baseline = await buildBaselineContext(rec.outDir);
  const baselineBytes = baseline.length;
  // Rough heuristic: 4 chars per token.
  const baselineTokenEstimate = Math.ceil(baselineBytes / 4);
  console.error(`  baseline source: ${baselineBytes.toLocaleString()} bytes (~${baselineTokenEstimate.toLocaleString()} est. tokens)`);
  console.error('');

  const rows: Row[] = [];

  for (const prompt of PROMPTS) {
    console.error(`── prompt: ${prompt.id} ────────────────────────────────────`);
    console.error(`   Q: ${prompt.q}`);

    // ctx retrieval is identical for all models, do it once
    const ctxRet = await buildCtxRetrievedContext(rec.outDir, prompt.q, k, {
      ollamaUrl: process.env.OLLAMA_URL ?? 'http://localhost:11434',
      embedCpu: true,
    });
    const ctxBytes = ctxRet.context.length;
    console.error(`   retrieved ${ctxRet.hits.length} atoms (${ctxBytes.toLocaleString()} bytes, ~${Math.ceil(ctxBytes/4).toLocaleString()} est. tokens)`);

    for (const m of panel) {
      // ── ctx mode
      console.error(`   [ctx]      ${m.label.padEnd(18)} …`);
      const ctxRes = await chat(m, [
        { role: 'system', content: SYSTEM_PROMPT_CTX },
        { role: 'user', content: `${prompt.q}\n\n---\nContext atoms:\n${ctxRet.context}` },
      ], { maxTokens: 400 });
      rows.push(toRow(m, prompt.id, 'ctx', ctxRes));
      logRow(ctxRes, 'ctx');

      // ── baseline mode (full transcript)
      if (skipBaseline) {
        continue;
      }
      // Truncate baseline to ~60% of the model's context window if needed.
      let baseSource = baseline;
      if (baselineTruncate && m.contextHint) {
        const budgetTokens = Math.floor(m.contextHint * 0.6);
        const budgetChars = budgetTokens * 4;
        if (baseSource.length > budgetChars) {
          baseSource = baseSource.slice(0, budgetChars) + '\n\n[...truncated to fit context window]';
        }
      }
      console.error(`   [baseline] ${m.label.padEnd(18)} …`);
      const baseRes = await chat(m, [
        { role: 'system', content: SYSTEM_PROMPT_BASELINE },
        { role: 'user', content: `${prompt.q}\n\n---\nFull transcript:\n${baseSource}` },
      ], { maxTokens: 400 });
      rows.push(toRow(m, prompt.id, 'baseline', baseRes));
      logRow(baseRes, 'baseline');
    }
    console.error('');
  }

  // ── Aggregate + report ─────────────────────────────────────────────
  const report = renderReport(rec, panel, rows, k);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = join(REPO_ROOT, 'reports', `ctx-bench-${ts}`);
  await mkdir(outDir, { recursive: true });
  const reportPath = join(outDir, 'report.md');
  const rowsPath = join(outDir, 'rows.json');
  await writeFile(reportPath, report);
  await writeFile(rowsPath, JSON.stringify(rows, null, 2));

  console.error('');
  console.error('─────────────────────────────────────────────────────');
  console.error(`  report: ${reportPath}`);
  console.error(`  rows:   ${rowsPath}`);
  console.error('─────────────────────────────────────────────────────');

  process.stdout.write(report);
}

function toRow(m: ChatModel, prompt: string, mode: 'baseline' | 'ctx', r: ChatResult): Row {
  return {
    model: m.label,
    prompt,
    mode,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    totalTokens: r.totalTokens,
    latencyMs: r.latencyMs,
    truncated: r.truncated,
    answer: r.content,
    error: r.error,
  };
}

function logRow(r: ChatResult, mode: string): void {
  if (r.error) {
    console.error(`                                    ERROR: ${r.error.slice(0, 120)}`);
    return;
  }
  console.error(`                                    prompt_tok=${r.promptTokens.toString().padStart(6)}  out_tok=${r.completionTokens.toString().padStart(4)}  ${r.latencyMs}ms${r.truncated ? '  ⚠ truncated' : ''}`);
}

function renderReport(rec: { shortId: string; atomCount: number; outDir: string }, panel: ChatModel[], rows: Row[], k: number): string {
  const lines: string[] = [];
  lines.push(`# ctx Token-Savings Bench — ${rec.shortId}`);
  lines.push('');
  lines.push(`- **Container**: \`${rec.shortId}\` · ${rec.atomCount} atoms`);
  lines.push(`- **Panel**: ${panel.map((p) => `\`${p.label}\` (${p.provider})`).join(', ')}`);
  lines.push(`- **Prompts**: ${PROMPTS.length} · **k**: ${k} · **timestamp**: ${new Date().toISOString()}`);
  lines.push('');

  // ── Aggregate savings table per (model × prompt) ───────────────────
  lines.push('## Token savings — prompt_tokens (input)');
  lines.push('');
  lines.push('| model | prompt | baseline | ctx | savings | % |');
  lines.push('|---|---|---:|---:|---:|---:|');
  for (const m of panel) {
    for (const p of PROMPTS) {
      const b = rows.find((r) => r.model === m.label && r.prompt === p.id && r.mode === 'baseline');
      const c = rows.find((r) => r.model === m.label && r.prompt === p.id && r.mode === 'ctx');
      if (!c) continue;
      const bp = b?.promptTokens ?? 0;
      const cp = c.promptTokens;
      const sav = bp - cp;
      const pct = bp > 0 ? `${((sav / bp) * 100).toFixed(1)}%` : '—';
      lines.push(`| \`${m.label}\` | ${p.id} | ${bp.toLocaleString() || '—'} | ${cp.toLocaleString()} | ${sav.toLocaleString()} | ${pct} |`);
    }
  }
  lines.push('');

  // ── Per-model summary ──────────────────────────────────────────────
  lines.push('## Per-model totals');
  lines.push('');
  lines.push('| model | baseline total | ctx total | savings | mean ctx latency |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const m of panel) {
    const baselineRows = rows.filter((r) => r.model === m.label && r.mode === 'baseline');
    const ctxRows = rows.filter((r) => r.model === m.label && r.mode === 'ctx');
    const baseTot = baselineRows.reduce((s, r) => s + r.promptTokens, 0);
    const ctxTot = ctxRows.reduce((s, r) => s + r.promptTokens, 0);
    const sav = baseTot - ctxTot;
    const meanCtxLat = ctxRows.length > 0 ? Math.round(ctxRows.reduce((s, r) => s + r.latencyMs, 0) / ctxRows.length) : 0;
    const pct = baseTot > 0 ? `${((sav / baseTot) * 100).toFixed(1)}%` : '—';
    lines.push(`| \`${m.label}\` | ${baseTot.toLocaleString() || '—'} | ${ctxTot.toLocaleString()} | ${sav.toLocaleString()} (${pct}) | ${meanCtxLat}ms |`);
  }
  lines.push('');

  // ── Per-prompt answers side-by-side (excerpted) ─────────────────────
  lines.push('## Answers');
  lines.push('');
  for (const p of PROMPTS) {
    lines.push(`### ${p.id} — "${p.q}"`);
    lines.push('');
    for (const m of panel) {
      const b = rows.find((r) => r.model === m.label && r.prompt === p.id && r.mode === 'baseline');
      const c = rows.find((r) => r.model === m.label && r.prompt === p.id && r.mode === 'ctx');
      lines.push(`#### \`${m.label}\``);
      lines.push('');
      if (c) {
        const status = c.error ? `❌ ${c.error}` : `${c.promptTokens} in / ${c.completionTokens} out · ${c.latencyMs}ms`;
        lines.push(`**ctx** (${status}):`);
        lines.push('');
        lines.push('> ' + (c.error ? '' : (c.answer || '_(empty)_').replace(/\n/g, '\n> ')));
        lines.push('');
      }
      if (b) {
        const status = b.error ? `❌ ${b.error}` : `${b.promptTokens} in / ${b.completionTokens} out · ${b.latencyMs}ms${b.truncated ? ' ⚠truncated' : ''}`;
        lines.push(`**baseline** (${status}):`);
        lines.push('');
        lines.push('> ' + (b.error ? '' : (b.answer || '_(empty)_').replace(/\n/g, '\n> ')));
        lines.push('');
      }
    }
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
