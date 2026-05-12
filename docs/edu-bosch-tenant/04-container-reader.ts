/**
 * Generic container-reader for edu.0711.io.
 *
 * Reads a 0711-gitchain v5.1 container — works for ANY domain (Bosch products,
 * ELSTER tax catalog, ETIM classifications, …). Pulls atoms.json,
 * embeddings.fp32.bin (optional), container.json.
 *
 * Source resolution:
 *   1. Explicit sourceUri override (HTTP URL or file://)
 *   2. Default registry lookup (CONTAINER_REGISTRY env var → JSON map)
 *   3. Local cache path (CACHE_DIR/<containerId>)
 *
 * Place at: src/lib/containers/reader.ts
 */

import { readFile, mkdir, writeFile, access } from "node:fs/promises";
import { constants as FS_CONST } from "node:fs";
import { dirname, join } from "node:path";

// ─── Types ───

export interface ContainerManifest {
  id: string;
  schema_version: number;
  version: string;
  type: string;
  namespace?: string;
  display_name?: string;
  merkle_root: string;
  container_sha256?: string;
  embeddings?: { model: string; provider: string; dim: number; count: number };
  signature?: string | null;
  anchor_chain?: string | null;
  anchor_block_number?: number | null;
  anchor_tx_hash?: string | null;
  stats?: Record<string, unknown>;
}

export interface ContainerAtom {
  atom_id: string;
  container_id: string;
  layer_id: string;
  field_path: string;
  field_name: string;
  value: string;
  value_type: string;
  metadata?: Record<string, unknown>;
  citation_document?: string;
  citation_section?: string;
  trust_level?: string;
  source_type?: string;
}

export interface EmbeddingEntry {
  atomId: string;
  fieldName: string;
  vector: Float32Array;
}

export interface ContainerBundle {
  container: ContainerManifest;
  atoms: ContainerAtom[];
  embeddings?: EmbeddingEntry[];
  byAtomId: Map<string, ContainerAtom>;
}

export interface LoadContainerOptions {
  containerId: string;
  sourceUri?: string; // override registry lookup
  skipEmbeddings?: boolean;
}

// ─── Source-Resolution ───

const CACHE_DIR =
  process.env.CONTAINER_CACHE_DIR ?? "/tmp/0711-container-cache";

function registry(): Record<string, string> {
  const raw = process.env.CONTAINER_REGISTRY;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    console.warn("[container-reader] CONTAINER_REGISTRY env is not valid JSON");
    return {};
  }
}

function resolveSourceUri(containerId: string, override?: string): string {
  if (override) return override;
  const map = registry();
  const fromRegistry = map[containerId];
  if (fromRegistry) return fromRegistry;
  // fallback: local cache
  return `file://${join(CACHE_DIR, containerId)}`;
}

// ─── Loader ───

export async function loadContainer(
  opts: LoadContainerOptions,
): Promise<ContainerBundle> {
  const sourceUri = resolveSourceUri(opts.containerId, opts.sourceUri);
  const isFile = sourceUri.startsWith("file://");
  const base = isFile ? sourceUri.replace(/^file:\/\//, "") : sourceUri;

  const containerJson = await fetchOrRead(`${base}/container.json`);
  const container = JSON.parse(containerJson) as ContainerManifest;

  if (container.id !== opts.containerId) {
    throw new Error(
      `Container-id mismatch: expected ${opts.containerId}, got ${container.id}`,
    );
  }

  const atomsJson = await fetchOrRead(`${base}/atoms.json`);
  const atoms = JSON.parse(atomsJson) as ContainerAtom[];

  const byAtomId = new Map<string, ContainerAtom>();
  for (const a of atoms) byAtomId.set(a.atom_id, a);

  let embeddings: EmbeddingEntry[] | undefined;
  if (!opts.skipEmbeddings && container.embeddings) {
    try {
      const meta = JSON.parse(
        await fetchOrRead(`${base}/embeddings.meta.json`),
      ) as {
        dim: number;
        count: number;
        atoms: Array<{ atom_id: string; field_name: string }>;
      };
      const buf = await fetchOrReadBytes(`${base}/embeddings.fp32.bin`);
      if (buf.byteLength !== meta.count * meta.dim * 4) {
        throw new Error(
          `embedding buffer size mismatch: ${buf.byteLength} != ${meta.count}×${meta.dim}×4`,
        );
      }
      const f32 = new Float32Array(buf.buffer, buf.byteOffset, meta.count * meta.dim);
      embeddings = meta.atoms.map((entry, i) => ({
        atomId: entry.atom_id,
        fieldName: entry.field_name,
        vector: f32.subarray(i * meta.dim, (i + 1) * meta.dim),
      }));
    } catch (err) {
      console.warn(
        `[container-reader] Embeddings not loaded for ${opts.containerId}: ${(err as Error).message}`,
      );
    }
  }

  return { container, atoms, embeddings, byAtomId };
}

// ─── HTTP/Filesystem helper ───

async function fetchOrRead(url: string): Promise<string> {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.text();
  }
  return readFile(url, "utf-8");
}

async function fetchOrReadBytes(url: string): Promise<Buffer> {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return Buffer.from(await res.arrayBuffer());
  }
  return readFile(url);
}

// ─── Categorization ───

export interface CategoryStats {
  pdfs?: number;
  images?: number;
  schematics?: number;
  manuals?: number;
  specs?: number;
  fault_codes?: number;
  features?: number;
  hinweisregeln?: number;
  rules?: number;
  audit_gaps?: number;
  total_atoms: number;
  by_layer: Record<string, number>;
}

export function categorizeAtoms(atoms: ContainerAtom[]): CategoryStats {
  const stats: CategoryStats = {
    total_atoms: atoms.length,
    by_layer: {},
  };

  for (const a of atoms) {
    stats.by_layer[a.layer_id] = (stats.by_layer[a.layer_id] ?? 0) + 1;

    const m = a.metadata as Record<string, string> | undefined;
    const kind = (m?.kind ?? a.layer_id ?? "").toLowerCase();
    const cite = (a.citation_section ?? "").toLowerCase();

    if (kind.includes("pdf") || cite.includes("pdf")) bump(stats, "pdfs");
    if (kind.includes("image") || cite.includes("image")) bump(stats, "images");
    if (kind.includes("schematic") || kind.includes("wiring"))
      bump(stats, "schematics");
    if (kind.includes("manual") || cite.includes("manual"))
      bump(stats, "manuals");
    if (kind.includes("spec") || kind.includes("datasheet"))
      bump(stats, "specs");
    if (kind.includes("fault") || kind.includes("error_code"))
      bump(stats, "fault_codes");
    if (kind.includes("feature")) bump(stats, "features");
    if (a.layer_id === "hinweisregel") bump(stats, "hinweisregeln");
    if (kind.includes("rule")) bump(stats, "rules");

    if (!a.citation_document || a.citation_document === "")
      bump(stats, "audit_gaps");
  }

  return stats;
}

function bump<K extends string>(o: Record<K, number | undefined>, key: K) {
  o[key] = (o[key] ?? 0) + 1;
}

// ─── Audience-Detection ───

export interface AudienceSuggestion {
  audience: string;
  confidence: number;
  evidence_kinds: string[];
  rationale: string;
}

const AUDIENCE_RULES: Array<{
  audience: string;
  trigger: (s: CategoryStats) => { confidence: number; reasons: string[] } | null;
}> = [
  {
    audience: "installer",
    trigger: (s) => {
      const reasons: string[] = [];
      let conf = 0;
      if ((s.manuals ?? 0) > 0) {
        conf += 0.4;
        reasons.push(`${s.manuals} manuals`);
      }
      if ((s.schematics ?? 0) >= 3) {
        conf += 0.4;
        reasons.push(`${s.schematics} schematics`);
      }
      if ((s.specs ?? 0) > 0) {
        conf += 0.1;
        reasons.push(`${s.specs} spec atoms`);
      }
      return conf > 0.5
        ? { confidence: Math.min(conf, 0.99), reasons }
        : null;
    },
  },
  {
    audience: "electrician",
    trigger: (s) => {
      if ((s.schematics ?? 0) >= 5) {
        return {
          confidence: 0.85,
          reasons: [`${s.schematics} schematics including wiring`],
        };
      }
      return null;
    },
  },
  {
    audience: "service_tech",
    trigger: (s) => {
      if ((s.fault_codes ?? 0) > 0 || (s.manuals ?? 0) > 0) {
        const c = (s.fault_codes ?? 0) > 0 ? 0.9 : 0.6;
        return {
          confidence: c,
          reasons: [`${s.fault_codes ?? 0} fault codes, ${s.manuals ?? 0} service manuals`],
        };
      }
      return null;
    },
  },
  {
    audience: "salesperson",
    trigger: (s) => {
      if ((s.specs ?? 0) >= 5 || (s.pdfs ?? 0) >= 3) {
        return {
          confidence: 0.8,
          reasons: [`${s.specs ?? 0} specs, ${s.pdfs ?? 0} PDFs (datasheets/brochures)`],
        };
      }
      return null;
    },
  },
  {
    audience: "end_customer",
    trigger: (s) => {
      if ((s.manuals ?? 0) > 0 && (s.images ?? 0) > 5) {
        return {
          confidence: 0.7,
          reasons: [`Manuals + product imagery suitable for onboarding`],
        };
      }
      return null;
    },
  },
  {
    audience: "compliance_officer",
    trigger: (s) => {
      if ((s.hinweisregeln ?? 0) > 0 || (s.rules ?? 0) > 0) {
        return {
          confidence: 0.92,
          reasons: [
            `${s.hinweisregeln ?? 0} regulatory rules, ${s.rules ?? 0} business rules`,
          ],
        };
      }
      return null;
    },
  },
];

export function detectAudiences(
  _atoms: ContainerAtom[],
  stats: CategoryStats,
): AudienceSuggestion[] {
  const out: AudienceSuggestion[] = [];
  for (const rule of AUDIENCE_RULES) {
    const result = rule.trigger(stats);
    if (!result) continue;
    out.push({
      audience: rule.audience,
      confidence: result.confidence,
      evidence_kinds: result.reasons,
      rationale: result.reasons.join("; "),
    });
  }
  out.sort((a, b) => b.confidence - a.confidence);
  return out;
}

// ─── Cache-Utility ───

export async function ensureCachedLocally(
  containerId: string,
  sourceUri: string,
): Promise<string> {
  const cacheDir = join(CACHE_DIR, containerId);
  try {
    await access(join(cacheDir, "container.json"), FS_CONST.R_OK);
    return cacheDir;
  } catch {
    // not cached yet
  }
  await mkdir(cacheDir, { recursive: true });
  for (const name of [
    "container.json",
    "atoms.json",
    "embeddings.fp32.bin",
    "embeddings.meta.json",
    "merkle.json",
  ]) {
    try {
      const content = await fetchOrReadBytes(`${sourceUri}/${name}`);
      await writeFile(join(cacheDir, name), content);
    } catch {
      // optional files (embeddings/merkle) may not exist for all containers
    }
  }
  return cacheDir;
}
