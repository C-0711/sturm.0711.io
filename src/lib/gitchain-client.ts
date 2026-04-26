import { Pool } from 'pg';
import simpleGit from 'simple-git';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface Container {
  id: string;
  type: string;
  namespace: string;
  identifier: string;
  git_url: string;
  display_name?: string;
  description?: string;
  latest_tag?: string;
  latest_commit?: string;
  visibility: string;
  mandant_id?: string;
  tenant_id?: string;
  relations?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface CreateContainerInput {
  type: string;
  namespace: string;
  identifier: string;
  mandant_id?: string;
  tenant_id?: string;
  display_name: string;
  description?: string;
  visibility?: 'private' | 'public' | 'tenant';
  relations?: Record<string, unknown>;
}

export class GitChainClient {
  private pool: Pool;
  private repoRoot: string;
  private apiUrl: string;

  constructor(opts: { databaseUrl: string; repoRoot: string; apiUrl: string }) {
    this.pool = new Pool({ connectionString: opts.databaseUrl });
    this.repoRoot = opts.repoRoot;
    this.apiUrl = opts.apiUrl;
  }

  private makeId(type: string, namespace: string, identifier: string): string {
    return `0711:${type}:${namespace}:${identifier}`;
  }

  private makeGitUrl(type: string, namespace: string, identifier: string): string {
    return `${this.apiUrl}/git/${type}/${namespace}/${identifier}.git`;
  }

  private bareRepoPath(type: string, namespace: string, identifier: string): string {
    return path.join(this.repoRoot, type, namespace, `${identifier}.git`);
  }

  async getContainer(id: string): Promise<Container | null> {
    const res = await this.pool.query<Container>(
      'SELECT * FROM registry.containers WHERE id = $1',
      [id],
    );
    return res.rows[0] ?? null;
  }

  async createContainer(input: CreateContainerInput): Promise<Container> {
    const id = this.makeId(input.type, input.namespace, input.identifier);
    const gitUrl = this.makeGitUrl(input.type, input.namespace, input.identifier);

    const existing = await this.getContainer(id);
    if (existing) return existing;

    const res = await this.pool.query<Container>(
      `INSERT INTO registry.containers
        (id, type, namespace, identifier, git_url, display_name, description, visibility, mandant_id, tenant_id, relations, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())
       RETURNING *`,
      [
        id,
        input.type,
        input.namespace,
        input.identifier,
        gitUrl,
        input.display_name,
        input.description ?? null,
        input.visibility ?? 'private',
        input.mandant_id ?? null,
        input.tenant_id ?? null,
        JSON.stringify(input.relations ?? {}),
      ],
    );
    return res.rows[0];
  }

  async updateLatestCommit(id: string, sha: string): Promise<void> {
    await this.pool.query(
      'UPDATE registry.containers SET latest_commit = $1, updated_at = NOW() WHERE id = $2',
      [sha, id],
    );
  }

  async addCitation(source_id: string, target_id: string, relationship: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO registry.citations (source_id, target_id, relationship)
       VALUES ($1,$2,$3)
       ON CONFLICT (source_id, target_id, relationship) DO NOTHING`,
      [source_id, target_id, relationship],
    );
  }

  async findContainersByMandant(mandant_id: string, type?: string): Promise<Container[]> {
    const args: unknown[] = [mandant_id];
    const typeFilter = type ? ' AND type = $2' : '';
    if (type) args.push(type);
    const res = await this.pool.query<Container>(
      `SELECT * FROM registry.containers WHERE mandant_id = $1${typeFilter} ORDER BY created_at DESC`,
      args,
    );
    return res.rows;
  }

  // --------------- Git operations ---------------

  private async ensureBareRepo(type: string, namespace: string, identifier: string): Promise<string> {
    const barePath = this.bareRepoPath(type, namespace, identifier);
    await fs.mkdir(barePath, { recursive: true });
    if (!fsSync.existsSync(path.join(barePath, 'HEAD'))) {
      await simpleGit(barePath).raw(['init', '--bare', '--initial-branch=main']);
    }
    return barePath;
  }

  async cloneOrInit(containerId: string, workdir: string): Promise<void> {
    // Parse 0711:<type>:<namespace>:<identifier>
    const [, type, namespace, identifier] = containerId.split(':');
    if (!type || !namespace || !identifier) {
      throw new Error(`invalid containerId: ${containerId}`);
    }

    const barePath = await this.ensureBareRepo(type, namespace, identifier);
    const git = simpleGit(workdir);

    const isRepo = await git.checkIsRepo().catch(() => false);
    if (isRepo) return;

    await git.raw(['init', '-b', 'main']);
    await git.addRemote('origin', barePath);

    // Seed with an empty commit so 'main' branch exists on the bare remote
    await git.raw([
      'commit', '--allow-empty', '-m', 'init: STURM workspace',
      '--author', 'STURM Engine <sturm@0711.io>',
    ]);
    await git.push(['origin', 'main']);
  }

  async commitAndPush(
    workdir: string,
    message: string,
    author: { name: string; email: string },
  ): Promise<string> {
    const git = simpleGit(workdir);
    await git.add('-A');

    const status = await git.status();
    if (status.files.length === 0) {
      // Nothing to commit — return current HEAD
      return (await git.revparse(['HEAD'])).trim();
    }

    await git.commit(message, { '--author': `${author.name} <${author.email}>` });
    const sha = (await git.revparse(['HEAD'])).trim();
    await git.push(['origin', 'main']);
    return sha;
  }

  async setMandantId(workspaceId: string, mandantId: string, tenantId: string): Promise<void> {
    await this.pool.query(
      'UPDATE registry.containers SET mandant_id = $1, tenant_id = $2, updated_at = NOW() WHERE id = $3',
      [mandantId, tenantId, workspaceId],
    );
  }

  async promoteWorkspaceToTaxCase(input: {
    workspace_id: string;
    tax_case_identifier: string;
    mandant_id: string;
    veranlagungsjahr: number;
    steuerart: 'ESt' | 'USt' | 'GewSt' | 'KSt' | 'LSt';
    display_name: string;
    finanzamt?: string;
    artifacts_to_merge?: string[];
  }): Promise<{ tax_case_id: string; created: boolean; commit_sha: string }> {
    const namespace = 'ctax';
    const taxCaseId = this.makeId('tax_case', namespace, input.tax_case_identifier);
    const filesToMerge = input.artifacts_to_merge ?? ['data/extraktion.json', 'data/elster.json'];

    const existing = await this.getContainer(taxCaseId);
    const created = !existing;

    const workspace = await this.getContainer(input.workspace_id);
    if (!workspace) throw new Error(`workspace not found: ${input.workspace_id}`);

    if (created) {
      await this.pool.query(
        `INSERT INTO registry.containers
          (id, type, namespace, identifier, git_url, display_name, visibility, mandant_id, tenant_id, relations, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())`,
        [
          taxCaseId,
          'tax_case',
          namespace,
          input.tax_case_identifier,
          this.makeGitUrl('tax_case', namespace, input.tax_case_identifier),
          input.display_name,
          'private',
          input.mandant_id,
          workspace.tenant_id ?? null,
          JSON.stringify({
            veranlagungsjahr: input.veranlagungsjahr,
            steuerart: input.steuerart,
            status: 'in_bearbeitung',
            mandant_container_id: `0711:mandant:${namespace}:${input.mandant_id}`,
            finanzamt: input.finanzamt ?? null,
          }),
        ],
      );
      await this.ensureBareRepo('tax_case', namespace, input.tax_case_identifier);
    }

    const [, wsType, wsNamespace, wsIdentifier] = input.workspace_id.split(':');
    const wsBare = this.bareRepoPath(wsType, wsNamespace, wsIdentifier);
    const tcBare = this.bareRepoPath('tax_case', namespace, input.tax_case_identifier);

    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sturm-promote-'));
    const tmpWorkspace = path.join(tmpRoot, 'ws');
    const tmpTaxCase = path.join(tmpRoot, 'tc');

    try {
      // Clone workspace bare repo to read artifacts
      await simpleGit(tmpRoot).clone(wsBare, tmpWorkspace, ['--local']);

      // Init tax_case workdir and fetch existing state when re-using
      await fs.mkdir(tmpTaxCase);
      const tcGit = simpleGit(tmpTaxCase);
      await tcGit.raw(['init', '-b', 'main']);
      await tcGit.addRemote('origin', tcBare);
      if (!created) {
        await tcGit.fetch(['origin', 'main']);
        await tcGit.raw(['reset', '--hard', 'origin/main']);
      }

      // Copy artifacts — last state wins, missing files are skipped
      for (const filePath of filesToMerge) {
        const src = path.join(tmpWorkspace, filePath);
        const dst = path.join(tmpTaxCase, filePath);
        try {
          await fs.mkdir(path.dirname(dst), { recursive: true });
          await fs.copyFile(src, dst);
        } catch {
          // File absent in workspace — skip
        }
      }

      const sha = await this.commitAndPush(
        tmpTaxCase,
        `[promote] from workspace ${input.workspace_id}`,
        { name: 'STURM Engine', email: 'sturm@0711.io' },
      );

      await this.addCitation(taxCaseId, input.workspace_id, 'derived_from');
      await this.updateLatestCommit(taxCaseId, sha);

      return { tax_case_id: taxCaseId, created, commit_sha: sha };

    } catch (err) {
      if (created) {
        await this.pool.query('DELETE FROM registry.containers WHERE id = $1', [taxCaseId]).catch(() => undefined);
        await fs.rm(tcBare, { recursive: true, force: true }).catch(() => undefined);
      }
      throw err;
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async recordAnchor(input: {
    container_id: string;
    tag: string;
    commit_hash: string;
    network?: string;
    tx_hash?: string;
    block_number?: number;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO registry.anchors (container_id, tag, commit_hash, network, tx_hash, block_number, anchored_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (container_id, tag) DO NOTHING`,
      [
        input.container_id,
        input.tag,
        input.commit_hash,
        input.network ?? 'base-mainnet',
        input.tx_hash ?? null,
        input.block_number ?? null,
      ],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// Singleton for process lifetime
let _instance: GitChainClient | null = null;

export function getGitChainClient(): GitChainClient {
  if (_instance) return _instance;

  const databaseUrl = process.env['GITCHAIN_DATABASE_URL'];
  const repoRoot = process.env['GITCHAIN_REPO_ROOT'];
  const apiUrl = process.env['GITCHAIN_API_URL'] ?? 'http://localhost:3361';

  if (!databaseUrl) throw new Error('GITCHAIN_DATABASE_URL is required');
  if (!repoRoot) throw new Error('GITCHAIN_REPO_ROOT is required');

  _instance = new GitChainClient({ databaseUrl, repoRoot, apiUrl });
  return _instance;
}
