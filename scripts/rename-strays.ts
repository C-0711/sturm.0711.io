/**
 * scripts/rename-strays.ts — Phase F.2 / Task 7
 *
 * Lists artifacts (run dirs, container manifests) whose names violate the
 * versioning policy in docs/architecture/versioning.md. Dry-run only:
 * NEVER modifies state. Use `--json` for CI consumption.
 *
 * Run:   tsx scripts/rename-strays.ts            # human output
 *        tsx scripts/rename-strays.ts --json     # machine output
 *
 * Exit codes:
 *   0 — all artifacts conform to the policy
 *   1 — strays found (CI gate)
 *   2 — invocation error
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { argv, exit, cwd } from 'node:process';

const WORKFLOW_RE = /^[a-z][a-z0-9-]*-v[0-9]+$|^hello-ocr$/;
const STAGE_RE = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;
const CONTAINER_INSTANCE_RE =
  /^0711:[a-z][a-z0-9-]*:[a-z][a-z0-9-]*:[a-z0-9-]+:v[0-9]+$/;

interface Stray {
  kind: 'run-dir' | 'container-manifest' | 'stage-id' | 'workflow-id';
  path: string;
  name: string;
  proposed?: string;
  reason: string;
}

const strays: Stray[] = [];

async function main(): Promise<void> {
  const json = argv.includes('--json');
  const root = cwd();

  await scanRunsDir(join(root, 'runs'));
  await scanContainersDir(join(root, 'containers'));
  await scanContainersDir(join(root, 'artifacts'));
  await scanContainersDir(join(root, 'dist', 'containers'));

  if (json) {
    console.log(JSON.stringify({ strays, count: strays.length }, null, 2));
  } else {
    if (strays.length === 0) {
      console.log('\n✓ no strays — all artifacts conform to the versioning policy.\n');
    } else {
      console.log(`\n✗ ${strays.length} stray artifact(s) found:\n`);
      for (const s of strays) {
        console.log(`  [${s.kind}] ${s.path}`);
        console.log(`    name:     ${s.name}`);
        console.log(`    reason:   ${s.reason}`);
        if (s.proposed) {
          console.log(`    proposed: ${s.proposed}`);
        }
        console.log('');
      }
      console.log(
        'Note: this is a dry run. Nothing was modified. Apply the\n' +
          'rename proposals manually (or wire a follow-up script that gates on\n' +
          '`--apply` once the proposals are reviewed).\n',
      );
    }
  }

  exit(strays.length === 0 ? 0 : 1);
}

async function scanRunsDir(runs: string): Promise<void> {
  if (!(await dirExists(runs))) return;
  const wfDirs = await readdir(runs, { withFileTypes: true });
  for (const wf of wfDirs) {
    if (!wf.isDirectory()) continue;
    if (!WORKFLOW_RE.test(wf.name)) {
      strays.push({
        kind: 'workflow-id',
        path: join(runs, wf.name),
        name: wf.name,
        proposed: proposeWorkflowName(wf.name),
        reason: `does not match ^<vertical>-<role>-v{N}$`,
      });
    }
  }
}

async function scanContainersDir(dir: string): Promise<void> {
  if (!(await dirExists(dir))) return;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const manifestPath = join(dir, e.name, 'manifest.json');
    if (!(await fileExists(manifestPath))) continue;
    const manifest = await safeReadJson(manifestPath);
    if (!manifest) continue;
    const id = typeof manifest.id === 'string' ? manifest.id : null;
    if (!id) {
      strays.push({
        kind: 'container-manifest',
        path: manifestPath,
        name: '<missing>',
        reason: 'manifest.id missing or not a string',
      });
      continue;
    }
    if (!CONTAINER_INSTANCE_RE.test(id)) {
      strays.push({
        kind: 'container-manifest',
        path: manifestPath,
        name: id,
        proposed: proposeContainerId(id),
        reason: `does not match ^0711:<vertical>:<source>:<doc-id>:v{N}$`,
      });
    }
  }
}

function proposeWorkflowName(name: string): string {
  if (/^elster$/i.test(name)) return 'elster-v1';
  if (/^elster.?multi$/i.test(name) || /^elster.?v3.?multi$/i.test(name)) return 'belege-bundle-v1';
  if (/^elster.?v3$/i.test(name)) return 'elster-v1';
  // generic: lowercase, replace spaces, append -v1
  const slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
  if (/-v[0-9]+$/.test(slug)) return slug;
  return `${slug}-v1`;
}

function proposeContainerId(id: string): string {
  // strip parens / spaces / non-conforming chars
  const cleaned = id
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[()]/g, '')
    .replace(/[^a-z0-9:-]/g, '-');
  // ensure 5-segment shape; pad with 'unknown' if missing
  const parts = cleaned.split(':');
  while (parts.length < 5) parts.push('unknown');
  if (!/v[0-9]+$/.test(parts[4]!)) parts[4] = 'v1';
  if (parts[0] !== '0711') parts[0] = '0711';
  return parts.slice(0, 5).join(':');
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

async function safeReadJson(p: string): Promise<{ id?: unknown } | null> {
  try {
    const raw = await readFile(p, 'utf-8');
    return JSON.parse(raw) as { id?: unknown };
  } catch {
    return null;
  }
}

main().catch((err: unknown) => {
  console.error('fatal:', err);
  exit(2);
});
