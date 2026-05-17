#!/usr/bin/env tsx
/**
 * retrieve-project-context — Query-Side für den Abrechnung-Container.
 * Lädt das von build-project-context-abrechnung.ts produzierte Cascade-
 * Bundle, embeddet eine Anfrage, gibt top-K Atome mit Preview zurück.
 *
 * Nutzung:
 *   tsx scripts/retrieve-project-context.ts "Splittingtarif Vorsorge"
 *   tsx scripts/retrieve-project-context.ts "Solidaritätszuschlag Berechnung" 5
 *
 * Voraussetzung: Ollama mit `embeddinggemma` erreichbar an OLLAMA_URL.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const OUT_DIR = resolve(REPO_ROOT, process.env.PCTX_OUT ?? 'runs/project-context/abrechnung');

async function main(): Promise<void> {
  const query = process.argv[2];
  const k = Number(process.argv[3] ?? 5);
  if (!query) {
    console.error('usage: tsx scripts/retrieve-project-context.ts "<query>" [k]');
    process.exit(2);
  }

  const indexDir = join(OUT_DIR, 'index');
  const manifestRaw = await readFile(join(indexDir, 'cascade.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw);
  if (manifest.status === 'pending-embeddings') {
    console.error('Container in corpus-only state. Re-run build with Ollama reachable.');
    process.exit(3);
  }

  const { QuantumCascade } = await import('../src/lib/quantum-index.ts');
  const { embedQueries, l2normalize } = await import('../src/lib/gemma-embed.ts');

  const cascade = await QuantumCascade.loadFromManifest(indexDir, manifest, k);
  const atomIds = JSON.parse(await readFile(join(indexDir, 'atom-ids.json'), 'utf8')) as string[];

  console.error(`query: "${query}"   k=${k}   corpus_size=${atomIds.length}`);
  const t0 = Date.now();
  const [rawVec] = await embedQueries([query]);
  const q = l2normalize(Float32Array.from(rawVec));
  const hits = cascade.topK(q, k);
  const ms = Date.now() - t0;

  console.error(`──────────────────────────────────────────────────────`);
  for (const hit of hits) {
    const slug = atomIds[hit.idx] ?? `idx-${hit.idx}`;
    const atomPath = join(OUT_DIR, 'atoms', 'code', `${slug}.md`);
    const text = await readFile(atomPath, 'utf8').catch(() => '');
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text);
    const meta = frontmatter ? frontmatter[1].split('\n').reduce<Record<string,string>>((acc, line) => {
      const [k, ...rest] = line.split(': ');
      if (k && rest.length) acc[k.trim()] = rest.join(': ');
      return acc;
    }, {}) : {};
    const body = text.replace(/^---\n[\s\S]*?\n---\n\n?/, '');
    const preview = body.slice(0, 200).replace(/\n/g, ' ');
    console.error(`  score=${hit.score.toFixed(4)}  ${meta.path ?? '?'}#${meta.symbol ?? '?'}`);
    console.error(`    ${preview}…`);
  }
  console.error(`──────────────────────────────────────────────────────`);
  console.error(`retrieved in ${ms}ms`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
