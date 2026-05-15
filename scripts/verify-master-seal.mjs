#!/usr/bin/env node
/**
 * verify-master-seal.mjs
 *
 * Standalone audit tool for a sealed master.json (from the steuerfall-seal
 * workflow). Zero deps on sturm internals — node:crypto only. Verifies:
 *
 *   1. Merkle: re-compute SHA256(eCode + canonical_json(value)) per leaf,
 *      sort by eCode, fold pairwise (Bitcoin convention: last duplicated on
 *      odd parity), compare to master.merkle.root.
 *   2. Signature: re-canonicalise master with signature=null, HMAC-SHA256
 *      with the supplied key (env STURM_MASTER_HMAC_KEY or argument),
 *      compare to master.signature.value.
 *   3. Shape: schemaVersion === 1, required fields present.
 *
 * Usage:
 *   node scripts/verify-master-seal.mjs <path-to-master.json>
 *   STURM_MASTER_HMAC_KEY=… node scripts/verify-master-seal.mjs path/master.json
 *
 * Exit codes:
 *   0  all checks pass
 *   1  one or more checks fail
 *   2  argument / IO error
 */
import { readFile } from 'node:fs/promises';
import { createHash, createHmac } from 'node:crypto';
import * as path from 'node:path';

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
}

function merkleRoot(leafHashes) {
  if (leafHashes.length === 0) return sha256Hex('');
  let level = leafHashes.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = level[i + 1] ?? a;
      next.push(sha256Hex(Buffer.concat([Buffer.from(a, 'hex'), Buffer.from(b, 'hex')])));
    }
    level = next;
  }
  return level[0];
}

function payloadForSigning(master) {
  const clone = { ...master, signature: null };
  return canonicalJson(clone);
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: verify-master-seal.mjs <path-to-master.json>');
    process.exit(2);
  }
  let master;
  try {
    master = JSON.parse(await readFile(arg, 'utf-8'));
  } catch (e) {
    console.error(`cannot read ${arg}: ${e.message}`);
    process.exit(2);
  }

  let okCount = 0;
  let failCount = 0;
  const check = (name, ok, detail) => {
    const ico = ok ? '✓' : '✗';
    console.log(`  ${ico} ${name}` + (detail ? ` — ${detail}` : ''));
    if (ok) okCount++; else failCount++;
  };

  console.log(`\nVerifying ${path.basename(arg)}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // ── Shape checks ────────────────────────────────────────────────────
  console.log('\nShape');
  check('schemaVersion === 1', master.schemaVersion === 1, `got ${master.schemaVersion}`);
  check('canonical_layer present', master.canonical_layer && typeof master.canonical_layer === 'object');
  check('merkle present', master.merkle && typeof master.merkle === 'object');
  check('signature present', master.signature && typeof master.signature === 'object');
  check('appId + caseId present',
    typeof master.appId === 'string' && master.appId.length > 0 &&
    typeof master.caseId === 'string' && master.caseId.length > 0);

  // ── Merkle re-computation ───────────────────────────────────────────
  console.log('\nMerkle');
  if (master.canonical_layer && master.merkle) {
    const eCodes = Object.keys(master.canonical_layer).sort();
    const leafHashes = eCodes.map((c) => sha256Hex(`${c}${canonicalJson(master.canonical_layer[c])}`));
    const computed = merkleRoot(leafHashes);
    check('leafCount matches', master.merkle.leafCount === eCodes.length,
      `recomputed ${eCodes.length}, declared ${master.merkle.leafCount}`);
    check('merkle.root matches recomputed', master.merkle.root === computed,
      `\n      declared:   ${master.merkle.root}\n      recomputed: ${computed}`);
    if (Array.isArray(master.merkle.sortedECodes)) {
      const orderOk = master.merkle.sortedECodes.length === eCodes.length
        && master.merkle.sortedECodes.every((c, i) => c === eCodes[i]);
      check('sortedECodes matches lexical order', orderOk);
    }
  }

  // ── Signature ───────────────────────────────────────────────────────
  console.log('\nSignature');
  const key = process.env.STURM_MASTER_HMAC_KEY || process.argv[3];
  if (!key) {
    check('signature verification', false, 'no key provided (env STURM_MASTER_HMAC_KEY or 2nd arg)');
  } else if (master.signature) {
    if (master.signature.alg !== 'HMAC-SHA256') {
      check('signature.alg is HMAC-SHA256', false, `got ${master.signature.alg}`);
    } else {
      const expected = createHmac('sha256', key).update(payloadForSigning(master)).digest('base64');
      check('HMAC matches', expected === master.signature.value,
        expected === master.signature.value
          ? `keyId=${master.signature.keyId}`
          : `\n      declared:   ${master.signature.value}\n      recomputed: ${expected}`);
    }
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Result: ${okCount} pass, ${failCount} fail`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
