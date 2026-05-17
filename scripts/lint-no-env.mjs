#!/usr/bin/env node
// scripts/lint-no-env.mjs — fail CI if stages read process.env.
// Stages must consume tool config via ctx.tools, not env. P10 enforces this.
//
// Override (rare): append `// lint-no-env: allow — <reason>` to the line.

import { readFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';

const ROOTS = ['src/stages', 'src/verticals'];
const EXCLUDE_SUFFIX = ['.test.ts'];
const PATTERN = /process\s*\.\s*env/;
const ALLOW_COMMENT = /\/\/\s*lint-no-env:\s*allow\b/;

async function* walk(dir) {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(p);
    else if (ent.isFile() && p.endsWith('.ts') && !EXCLUDE_SUFFIX.some((s) => p.endsWith(s))) yield p;
  }
}

const offenders = [];
for (const root of ROOTS) {
  try {
    for await (const f of walk(root)) {
      const src = await readFile(f, 'utf-8');
      src.split('\n').forEach((line, i) => {
        if (PATTERN.test(line) && !ALLOW_COMMENT.test(line)) {
          offenders.push(`${f}:${i + 1}: ${line.trim()}`);
        }
      });
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

if (offenders.length) {
  console.error(`lint-no-env: ${offenders.length} forbidden process.env access(es) in stage code:`);
  for (const o of offenders) console.error('  ' + o);
  console.error('\nFix: consume the value via ctx.tools.get(...).meta or ctx.config.');
  console.error('Override (rare): append a "// lint-no-env: allow" comment on that line with a justification.');
  process.exit(1);
}
console.log(`lint-no-env: clean (${ROOTS.join(', ')})`);
