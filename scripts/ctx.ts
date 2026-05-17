#!/usr/bin/env tsx
/**
 * ctx — drop-in Context-Container-CLI.
 *
 * Workflow:
 *   pbpaste | tsx scripts/ctx.ts new --name abrechnung-refactor
 *   tsx scripts/ctx.ts list
 *   tsx scripts/ctx.ts serve --port 9711
 *   tsx scripts/ctx.ts retrieve abrechnung-refactor-a8c4 "splittingtarif"
 *
 * Erzeugt Container, die andere LLMs/Agenten direkt via HTTP konsumieren
 * können (siehe src/lib/ctx-server.ts für das Endpunkt-Kontract).
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { stdin as input } from 'node:process';
import express from 'express';

import { parseTranscript } from '../src/lib/transcript-parser.ts';
import {
  buildIndex,
  writeAtoms,
  retrieveFromContainer,
  ollamaReachable,
} from '../src/lib/ctx-shared.ts';
import {
  allocateShortId,
  getContainer,
  listContainers,
  upsertContainer,
  storeRoot,
} from '../src/lib/ctx-store.ts';
import { createCtxRouter } from '../src/lib/ctx-server.ts';

interface CommandArgs {
  cmd: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): CommandArgs {
  const [cmd, ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok.startsWith('--')) {
      const key = tok.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) { flags[key] = next; i++; }
      else { flags[key] = true; }
    } else {
      positional.push(tok);
    }
  }
  return { cmd: cmd ?? 'help', positional, flags };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of input) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

async function cmdNew(args: CommandArgs): Promise<void> {
  const name = String(args.flags.name ?? 'untitled');
  const filePath = args.flags.file ? resolve(String(args.flags.file)) : null;
  const embedCpu = (args.flags['embed-cpu'] !== false) && (process.env.EMBED_CPU === '1' || args.flags['embed-cpu'] === true);
  const ollamaUrl = String(args.flags['ollama-url'] ?? process.env.OLLAMA_URL ?? 'http://localhost:11434');

  let raw: string;
  if (filePath) {
    raw = await readFile(filePath, 'utf8');
    console.error(`[ctx] reading ${relative(process.cwd(), filePath)} (${raw.length} bytes)`);
  } else if (!input.isTTY) {
    console.error('[ctx] reading from stdin (Ctrl-D when done)…');
    raw = await readStdin();
  } else {
    console.error('Error: provide input via stdin (pipe in) or --file <path>.');
    process.exit(2);
  }

  if (raw.trim().length === 0) {
    console.error('Error: empty input.');
    process.exit(2);
  }

  const { id, shortId, outDir } = allocateShortId(name);
  await mkdir(outDir, { recursive: true });

  console.error(`[ctx] parsing transcript…`);
  const atoms = parseTranscript(raw, { containerId: id });
  if (atoms.length === 0) {
    console.error('Error: no atoms extracted from input.');
    process.exit(2);
  }
  console.error(`[ctx] ${atoms.length} atoms extracted`);
  await writeAtoms(outDir, atoms, id);

  // Persist raw input for re-build/audit
  await writeFile(`${outDir}/source.txt`, raw);

  // Persist pending record so it's listable even if embed fails
  await upsertContainer({
    id,
    shortId,
    name,
    atomCount: atoms.length,
    nativeDim: null,
    builtAt: new Date().toISOString(),
    status: 'pending',
    outDir,
  });

  console.error(`[ctx] checking Ollama at ${ollamaUrl}…`);
  if (!(await ollamaReachable(ollamaUrl))) {
    console.error(`[ctx] Ollama unreachable — container is corpus-only. Re-run "ctx index ${shortId}" when Ollama is up.`);
    console.error(JSON.stringify({ id, shortId, atomCount: atoms.length, status: 'pending', outDir }, null, 2));
    return;
  }

  console.error(`[ctx] embedding + encoding…`);
  const result = await buildIndex({ containerId: id, outDir, atoms, ollamaUrl, embedCpu });
  await upsertContainer({
    id,
    shortId,
    name,
    atomCount: result.atomCount,
    nativeDim: result.nativeDim,
    builtAt: new Date().toISOString(),
    status: 'indexed',
    outDir,
  });
  console.error(`[ctx] done in ${(result.embedMs + result.encodeMs) / 1000}s  (embed ${result.embedMs}ms + encode ${result.encodeMs}ms)`);
  console.error(JSON.stringify({ id, shortId, atomCount: result.atomCount, nativeDim: result.nativeDim, status: 'indexed' }, null, 2));
}

async function cmdIndex(args: CommandArgs): Promise<void> {
  const target = args.positional[0];
  if (!target) { console.error('usage: ctx index <id|shortId|name>'); process.exit(2); }
  const rec = await getContainer(target);
  if (!rec) { console.error(`not found: ${target}`); process.exit(2); }
  const raw = await readFile(`${rec.outDir}/source.txt`, 'utf8');
  const atoms = parseTranscript(raw, { containerId: rec.id });
  console.error(`[ctx] re-parsed ${atoms.length} atoms; refreshing atom files…`);
  // Wipe stale atom files (parser may produce a different set than last time).
  await rm(`${rec.outDir}/atoms/code`, { recursive: true, force: true });
  await writeAtoms(rec.outDir, atoms, rec.id);

  const ollamaUrl = String(args.flags['ollama-url'] ?? process.env.OLLAMA_URL ?? 'http://localhost:11434');
  const embedCpu = process.env.EMBED_CPU === '1' || args.flags['embed-cpu'] === true;
  const result = await buildIndex({ containerId: rec.id, outDir: rec.outDir, atoms, ollamaUrl, embedCpu });
  await upsertContainer({ ...rec, status: 'indexed', nativeDim: result.nativeDim, atomCount: result.atomCount });
  console.error(`[ctx] indexed ${result.atomCount} atoms in ${(result.embedMs + result.encodeMs) / 1000}s`);
}

async function cmdList(): Promise<void> {
  const all = await listContainers();
  if (all.length === 0) { console.error('(no containers)'); return; }
  console.error(`${'shortId'.padEnd(22)}  ${'name'.padEnd(28)}  ${'atoms'.padStart(5)}  status     built`);
  for (const r of all) {
    console.error(
      `${r.shortId.padEnd(22)}  ${r.name.slice(0, 28).padEnd(28)}  ${String(r.atomCount).padStart(5)}  ${r.status.padEnd(9)}  ${r.builtAt}`,
    );
  }
}

async function cmdRetrieve(args: CommandArgs): Promise<void> {
  const [target, query] = args.positional;
  const k = Number(args.positional[2] ?? args.flags.k ?? 5);
  if (!target || !query) {
    console.error('usage: ctx retrieve <id|shortId|name> "<query>" [k]');
    process.exit(2);
  }
  const rec = await getContainer(target);
  if (!rec) { console.error(`not found: ${target}`); process.exit(2); }
  if (rec.status !== 'indexed') { console.error('container not indexed yet — run "ctx index" first'); process.exit(3); }
  const ollamaUrl = String(args.flags['ollama-url'] ?? process.env.OLLAMA_URL ?? 'http://localhost:11434');
  const embedCpu = process.env.EMBED_CPU === '1' || args.flags['embed-cpu'] === true;
  const hits = await retrieveFromContainer(rec.outDir, query, k, { ollamaUrl, embedCpu });
  for (const h of hits) {
    console.error(`  score=${h.score.toFixed(4)}  ${h.path ?? '?'}#${h.symbol ?? '?'}`);
    console.error(`    ${h.preview}`);
  }
}

async function cmdServe(args: CommandArgs): Promise<void> {
  const port = Number(args.flags.port ?? 9711);
  const ollamaUrl = String(args.flags['ollama-url'] ?? process.env.OLLAMA_URL ?? 'http://localhost:11434');
  const embedCpu = process.env.EMBED_CPU === '1' || args.flags['embed-cpu'] === true;
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/ctx', createCtxRouter({ ollamaUrl, embedCpu }));
  app.get('/', (_req, res) => res.json({
    service: '0711-ctx',
    endpoints: ['/ctx', '/ctx/:id', '/ctx/:id/retrieve', '/ctx/:id/atom/:slug', '/ctx/:id/events'],
    storeRoot: storeRoot(),
  }));
  app.listen(port, () => {
    console.error(`[ctx] serving on http://localhost:${port}`);
    console.error(`[ctx] try: curl -s http://localhost:${port}/ctx`);
  });
}

function help(): void {
  console.error(`ctx — drop-in context container CLI

Commands:
  new --name <slug> [--file <path>]   Build a container from stdin or a file
  list                                List all local containers
  index <id|shortId|name>             (Re-)build the index for a pending container
  retrieve <id> "<query>" [k]         Run a retrieval against an indexed container
  serve [--port 9711]                 Start the HTTP server for cross-LLM access

Env:
  OLLAMA_URL          default http://localhost:11434
  EMBED_CPU=1         force CPU embedding (recommended on H200V)
  CTX_STORE_ROOT      override storage root (default: runs/ctx)
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.cmd) {
    case 'new':      return cmdNew(args);
    case 'list':     return cmdList();
    case 'index':    return cmdIndex(args);
    case 'retrieve': return cmdRetrieve(args);
    case 'serve':    return cmdServe(args);
    case 'help':
    case '-h':
    case '--help':   return help();
    default:
      console.error(`unknown command: ${args.cmd}\n`);
      help();
      process.exit(2);
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
