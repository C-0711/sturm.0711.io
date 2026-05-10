#!/usr/bin/env node
/**
 * Encode ELSTER catalog as a v5.1-shape gitchain container.
 *
 * Output structure (mirrors apps/0711-gitchain v5.1 spec):
 *   container/elster/
 *     container.json            schema_version=5, version="v5.1", merkle_root, signature(=null until promote-worker signs)
 *     atoms.json                 deterministic atom array (CBOR-encoded would be byte-identical via cbor-x)
 *     atoms.cbor                 CBOR-encoded atom array (cbor-x deterministic)
 *     embeddings.fp32.bin        Float32 1024-dim vectors, n × 4096 bytes (NOT TurboQuant-encoded yet — that's
 *                                what `promote-worker` stage 5 does. We persist fp32 here so the same data
 *                                feeds both v3 cascade AND a future promote-worker run.)
 *     embeddings.meta.json       { dim, count, model, provider, atoms[i].atom_id }
 *     citations.json             per-atom audit refs (catalogVersion, sourceFile, line/row)
 *     merkle.json                merkle tree of atom_ids (Layer 3 / determinism)
 *
 * Atom schema (v3-compatible, naming generalized for ELSTER):
 *   {
 *     atom_id: "0711:elster:bmf:jahresdok-2024:v1/atom-elster-0",
 *     container_id: "0711:elster:bmf:jahresdok-2024:v1",
 *     layer_id: "elster",
 *     field_path: "elster.E0200201",   // namespaced — 'elster' instead of 'features'
 *     field_name: "E0200201",
 *     value: "Bruttoarbeitslohn",      // bezeichnung (the catalog has no per-doc values)
 *     value_type: "string",
 *     lang: "de",
 *     citation_document: "Jahresdokumentation_10_2024 1.xml",
 *     citation_section: "ESt1A - Felder",
 *     citation_excerpt: "...",
 *     citation_confidence: 1.0,
 *     citation_method: "official-bmf-catalog",
 *     trust_level: "verified",
 *     source_type: "primary-source",
 *     contributor_id: "bmf-jahresdok-2024-10",
 *     commit_hash: "<sha-of-source-xml>",
 *     // ELSTER-specific extras packed in metadata jsonb-ish
 *     metadata: { anlage, datentyp, pflicht, vordruckzeile, drucktext, formatRegex, kontextPaths }
 *   }
 *
 * Usage:
 *   node scripts/encode-elster-container.mjs                    # uses Ollama bge-m3 at :11434
 *   node scripts/encode-elster-container.mjs --provider embed-service --url http://localhost:18003
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const DATA_V3 = resolve(REPO_ROOT, 'src/verticals/elster-v3/data');

const CONTAINER_ID = '0711:elster:bmf:jahresdok-2024:v1';
const CATALOG_VERSION = 'Jahresdokumentation_10_2024 1.xml';
const LAYER_ID = 'elster';
const SCHEMA_VERSION = 5;
const VERSION_TAG = 'v5.1';

function parseArgs(argv) {
  const flags = { provider: 'reuse', url: null, model: 'bge-m3' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--provider') flags.provider = argv[++i];
    else if (argv[i] === '--url') flags.url = argv[++i];
    else if (argv[i] === '--model') flags.model = argv[++i];
  }
  return flags;
}

async function main() {
  const flags = parseArgs(process.argv);

  // 1) Load source: feld_katalog_full.json (Jahresdokumentation-derived)
  const fk = JSON.parse(await readFile(
    resolve(REPO_ROOT, 'src/verticals/elster/data/feld_katalog_full.json'), 'utf-8'));
  console.error(`Loaded ${fk.totalCodes} eCodes from feld_katalog_full`);

  // 2) Build deterministic atom array — sorted by eCode for byte-identical re-builds
  const atoms = [];
  const allEntries = [];
  for (const [anlage, bucket] of Object.entries(fk.anlagen)) {
    for (const f of bucket.codes) allEntries.push({ anlage, f });
  }
  allEntries.sort((a, b) => a.f.eCode.localeCompare(b.f.eCode));

  // commit_hash = sha256 of catalog source filename + total codes (stable across re-runs)
  const commitHash = createHash('sha256')
    .update(`${CATALOG_VERSION}|${fk.totalCodes}|${fk.anlagenCount}`)
    .digest('hex')
    .slice(0, 12);

  for (let i = 0; i < allEntries.length; i++) {
    const { anlage, f } = allEntries[i];
    atoms.push({
      atom_id: `${CONTAINER_ID}/atom-${LAYER_ID}-${i}`,
      container_id: CONTAINER_ID,
      layer_id: LAYER_ID,
      field_path: `${LAYER_ID}.${f.eCode}`,
      field_name: f.eCode,
      value: f.bezeichnung,
      value_type: 'string',
      lang: 'de',
      citation_document: CATALOG_VERSION,
      citation_section: `${anlage} - Felder`,
      citation_excerpt: (f.drucktext || f.bezeichnung || '').slice(0, 200),
      citation_confidence: 1.0,
      citation_method: 'official-bmf-catalog',
      trust_level: 'verified',
      source_type: 'primary-source',
      contributor_id: 'bmf-jahresdok-2024-10',
      commit_hash: commitHash,
      metadata: {
        anlage,
        datentyp: f.datentyp,
        pflicht: f.pflicht ?? false,
        vordruckzeile: f.vordruckzeile,
        drucktext: f.drucktext,
        formatRegex: f.formatRegex || null,
        formatkennzeichen: f.formatkennzeichen || null,
        maxLaenge: f.maxLaenge,
        minLaenge: f.minLaenge,
        kontextPaths: f.kontextPaths || [],
      },
    });
  }
  console.error(`Built ${atoms.length} deterministic atoms (commit=${commitHash})`);

  // 3) Reuse already-computed bge-m3 embeddings from v2 OR re-embed with embed_service
  let embeddings = [];
  let embModel = '';
  let embProvider = '';
  if (flags.provider === 'reuse') {
    // Use the v2-bundled index — saves recomputing 2270 embeddings
    const { loadBundledIndex } = await import(resolve(REPO_ROOT, 'src/lib/embedding-runtime.ts'));
    const idx = await loadBundledIndex(
      resolve(REPO_ROOT, 'src/verticals/elster/data/ecode_index_ollama_bge-m3.bin'),
      resolve(REPO_ROOT, 'src/verticals/elster/data/ecode_index_ollama_bge-m3.meta.json'),
    );
    const byCode = new Map(idx.entries.map((e) => [e.id, e.vector]));
    embModel = idx.model;
    embProvider = idx.provider;
    let coveredCount = 0;
    for (const a of atoms) {
      const v = byCode.get(a.field_name);
      if (v) { embeddings.push(v); coveredCount++; }
      else embeddings.push(new Float32Array(idx.dim));
    }
    console.error(`Reused v2 embeddings: ${coveredCount}/${atoms.length} covered (rest zero-vec)`);
  } else if (flags.provider === 'embed-service') {
    const url = flags.url ?? 'http://localhost:18003';
    embModel = flags.model;
    embProvider = 'embed-service';
    console.error(`Re-embedding ${atoms.length} atoms via ${url} (this takes ~7 min)…`);
    for (let i = 0; i < atoms.length; i++) {
      const a = atoms[i];
      const text = [
        `ELSTER-Code: ${a.field_name}`,
        `Anlage: ${a.metadata.anlage}`,
        `Bezeichnung: ${a.value}`,
        `Datentyp: ${a.metadata.datentyp}`,
        a.metadata.drucktext ? `Drucktext: ${a.metadata.drucktext}` : '',
      ].filter(Boolean).join('\n');
      const res = await fetch(`${url}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`embed_service ${res.status}`);
      const d = await res.json();
      embeddings.push(new Float32Array(d.embedding ?? d.embeddings?.[0]));
      if (i % 200 === 0) console.error(`  ${i}/${atoms.length}`);
    }
  }

  // 4) Compute merkle root over atom_ids — Layer 3 determinism check
  const leafHashes = atoms.map((a) =>
    createHash('sha256').update(a.atom_id + '|' + a.value).digest()
  );
  let level = leafHashes;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] ?? left;
      next.push(createHash('sha256').update(Buffer.concat([left, right])).digest());
    }
    level = next;
  }
  const merkleRoot = level[0].toString('hex');

  // 5) Compute container.sha256 over the atom array bytes
  const atomsJson = JSON.stringify(atoms, null, 0);
  const containerSha = createHash('sha256').update(atomsJson, 'utf-8').digest('hex');

  // 6) Build container.json (v5.1 shape, signature null until promote-worker signs)
  const container = {
    id: CONTAINER_ID,
    schema_version: SCHEMA_VERSION,
    version: VERSION_TAG,
    type: 'catalog',
    namespace: 'elster',
    identifier: 'jahresdok-2024',
    display_name: 'ELSTER Jahresdokumentation 2024 (10/2024)',
    description: `${atoms.length} eCodes across ${fk.anlagenCount} Anlagen, sourced from official BMF Jahresdokumentation_10_2024.xml.`,
    catalog_version: CATALOG_VERSION,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    stats: {
      atoms_total: atoms.length,
      anlagen_count: fk.anlagenCount,
      pflicht_codes: atoms.filter((a) => a.metadata.pflicht === true).length,
      datentyp_distribution: atoms.reduce((acc, a) => {
        const t = a.metadata.datentyp ?? 'string';
        acc[t] = (acc[t] ?? 0) + 1;
        return acc;
      }, {}),
    },
    merkle_root: merkleRoot,
    container_sha256: containerSha,
    embeddings: { model: embModel, provider: embProvider, dim: 1024, count: embeddings.length },
    signature: null,            // populated by promote-worker stage 8
    anchor_block_number: null,  // populated by promote-worker stage 9 / 10 (Base mainnet)
    anchor_tx_hash: null,
    anchor_chain: null,
    issuer_fingerprint: null,
  };

  // 7) Write everything under v3/data/
  await mkdir(DATA_V3, { recursive: true });
  await writeFile(join(DATA_V3, 'container.json'),
    JSON.stringify(container, null, 2) + '\n', 'utf-8');
  await writeFile(join(DATA_V3, 'atoms.json'),
    JSON.stringify(atoms, null, 2) + '\n', 'utf-8');

  // Embeddings binary blob + meta
  const dim = embeddings[0]?.length ?? 1024;
  const blob = new Float32Array(embeddings.length * dim);
  for (let i = 0; i < embeddings.length; i++) blob.set(embeddings[i], i * dim);
  await writeFile(join(DATA_V3, 'embeddings.fp32.bin'),
    Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength));
  await writeFile(join(DATA_V3, 'embeddings.meta.json'), JSON.stringify({
    dim,
    count: embeddings.length,
    model: embModel,
    provider: embProvider,
    atoms: atoms.map((a) => ({ atom_id: a.atom_id, field_name: a.field_name })),
  }, null, 2) + '\n', 'utf-8');

  // Merkle export
  await writeFile(join(DATA_V3, 'merkle.json'), JSON.stringify({
    algorithm: 'sha256',
    leaf_count: atoms.length,
    merkle_root: merkleRoot,
    leaves: atoms.map((a, i) => ({
      atom_id: a.atom_id,
      leaf_hash: leafHashes[i].toString('hex'),
    })),
  }, null, 2) + '\n', 'utf-8');

  console.error(`\n=== Container encoded ===`);
  console.error(`  container_id:  ${CONTAINER_ID}`);
  console.error(`  atoms:         ${atoms.length}`);
  console.error(`  merkle_root:   ${merkleRoot}`);
  console.error(`  container_sha: ${containerSha}`);
  console.error(`  embeddings:    ${embeddings.length} × ${dim} (${embModel}, ${embProvider})`);
  console.error(`  bytes:         ${blob.byteLength} (fp32, pre-PolarQuant)`);
  console.error(`\nWritten to: ${DATA_V3}`);
  console.error(`\nNext step (anchor on Base mainnet):`);
  console.error(`  ssh h200v 'cd /home/christoph.bertsch/0711/0711-gitchain && \\`);
  console.error(`    pnpm --filter @0711/promote-worker run cli enqueue ${CONTAINER_ID}'`);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
