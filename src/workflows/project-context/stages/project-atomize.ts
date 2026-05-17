/**
 * project-atomize — wandelt den Submodul-Snapshot in adressierbare Atome um.
 *
 * Strategy v0 (heuristisch — tree-sitter folgt):
 *   • Markdown:  Split an `^## ` / `^### ` Headings.
 *   • TypeScript/JavaScript:  Split an top-level export / function / class.
 *   • Sonstiges Textfile <100 KB:  ein Atom pro Datei.
 *   • Binär / >100 KB:  überspringen.
 *
 * Jedes Atom landet in `atoms/code/<slug>.md` mit Frontmatter
 * `{path, commit_sha, span, kind}`. Ein konstanter Slug pro
 * (path, symbol) macht den Index reproduzierbar.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { defineStage } from '../../../core/stage.ts';

interface AtomizeIn {
  containerId: string;
  workdir: string;        // from project-attach
  projectSha: string;
}
interface AtomizeOut {
  count: number;
  atomsDir: string;       // absolute path to atoms/code/
  skipped: number;
}

const MAX_FILE_BYTES = 100 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.cache']);

export const projectAtomizeStage = defineStage<AtomizeIn, AtomizeOut, never>({
  id: 'project-atomize',
  name: 'Atomize project tree',
  description: 'Walks project/ at a pinned SHA and splits files into addressable atoms.',
  hints: {
    inputs: '{ workdir, projectSha }',
    outputs: '{ count, atomsDir, skipped }',
  },
  async run(input, ctx) {
    const projectRoot = path.join(input.workdir, 'project');
    const atomsDir = path.join(input.workdir, 'atoms', 'code');
    await fs.rm(atomsDir, { recursive: true, force: true });
    await fs.mkdir(atomsDir, { recursive: true });

    let count = 0;
    let skipped = 0;

    async function walk(dir: string): Promise<void> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(abs);
          continue;
        }
        if (!entry.isFile()) continue;
        const rel = path.relative(projectRoot, abs);
        const stat = await fs.stat(abs);
        if (stat.size > MAX_FILE_BYTES) {
          skipped++;
          continue;
        }
        const buf = await fs.readFile(abs);
        if (looksBinary(buf)) {
          skipped++;
          continue;
        }
        const text = buf.toString('utf8');
        const atoms = splitFile(rel, text);
        for (const atom of atoms) {
          const slug = slugify(`${rel}#${atom.symbol}`);
          const atomPath = path.join(atomsDir, `${slug}.md`);
          const frontmatter = [
            '---',
            `path: ${rel}`,
            `commit_sha: ${input.projectSha}`,
            `kind: ${atom.kind}`,
            `span: ${atom.span.start}-${atom.span.end}`,
            `symbol: ${atom.symbol}`,
            '---',
            '',
            atom.body,
          ].join('\n');
          await fs.writeFile(atomPath, frontmatter);
          count++;
        }
      }
    }

    await walk(projectRoot);
    ctx.logger.info('project-atomize: done', { count, skipped, projectSha: input.projectSha });
    ctx.emit('atoms.materialized', { count, projectSha: input.projectSha });
    return { count, atomsDir, skipped };
  },
});

interface SplitAtom {
  symbol: string;
  kind: 'markdown-section' | 'ts-symbol' | 'file';
  span: { start: number; end: number };
  body: string;
}

function splitFile(relPath: string, text: string): SplitAtom[] {
  if (relPath.endsWith('.md')) return splitMarkdown(text);
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(relPath)) return splitTypescript(text);
  return [{ symbol: '__file__', kind: 'file', span: { start: 0, end: text.length }, body: text }];
}

function splitMarkdown(text: string): SplitAtom[] {
  const lines = text.split('\n');
  const atoms: SplitAtom[] = [];
  let current: { symbol: string; buf: string[]; start: number } | null = null;
  let offset = 0;
  for (const line of lines) {
    const heading = /^#{2,3}\s+(.+)$/.exec(line);
    if (heading) {
      if (current) {
        atoms.push({
          symbol: current.symbol,
          kind: 'markdown-section',
          span: { start: current.start, end: offset },
          body: current.buf.join('\n'),
        });
      }
      current = { symbol: heading[1].trim(), buf: [line], start: offset };
    } else if (current) {
      current.buf.push(line);
    }
    offset += line.length + 1;
  }
  if (current) {
    atoms.push({
      symbol: current.symbol,
      kind: 'markdown-section',
      span: { start: current.start, end: offset },
      body: current.buf.join('\n'),
    });
  }
  if (atoms.length === 0) {
    atoms.push({ symbol: '__file__', kind: 'file', span: { start: 0, end: text.length }, body: text });
  }
  return atoms;
}

function splitTypescript(text: string): SplitAtom[] {
  // Heuristic: top-level export / function / class declarations. Replace with
  // tree-sitter once available — this misses arrow-function consts and method
  // boundaries inside classes, but is good enough for v0 retrieval.
  const re = /^(export\s+(?:async\s+)?(?:function|class|interface|type|const|enum)\s+(\w+)|(?:async\s+)?function\s+(\w+)|class\s+(\w+))/gm;
  const atoms: SplitAtom[] = [];
  const matches = Array.from(text.matchAll(re));
  if (matches.length === 0) {
    return [{ symbol: '__file__', kind: 'file', span: { start: 0, end: text.length }, body: text }];
  }
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const next = matches[i + 1];
    const start = m.index ?? 0;
    const end = next?.index ?? text.length;
    const symbol = m[2] ?? m[3] ?? m[4] ?? `anon-${i}`;
    atoms.push({
      symbol,
      kind: 'ts-symbol',
      span: { start, end },
      body: text.slice(start, end),
    });
  }
  return atoms;
}

function looksBinary(buf: Buffer): boolean {
  const len = Math.min(512, buf.length);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function slugify(s: string): string {
  // path-safe, reversible-ish identifier. Collision-resistant via hash suffix.
  const safe = s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  const hash = createHash('sha1').update(s).digest('hex').slice(0, 8);
  return `${safe}-${hash}`;
}
