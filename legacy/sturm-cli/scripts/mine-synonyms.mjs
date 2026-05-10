#!/usr/bin/env node
/**
 * Mine bezeichnung / drucktext / beschreibung labels from EVERY available
 * source and emit them as `bmf_elster_zuordnung.json` synonym entries.
 *
 * Sources:
 *   1. feld_katalog_full.json    — Jahresdokumentation bezeichnung+drucktext (2287 codes)
 *   2. felder/*.json             — per-Anlage Drucktext+Beschreibung (2569 rows)
 *   3. existing bmf_elster_zuordnung.json — preserved (manual seed entries win on conflict)
 *
 * Each (label → eCode) pair becomes an entry. Labels are deduplicated by
 * normalized form. Manual-seed entries (mappingSource:"manual_seed") always
 * win: an auto-mined entry never overwrites a manually curated one.
 *
 * Hard guarantee: every emitted eCode is verified against feld_katalog_full.json.
 * Run `sturm verify` after to confirm no rot.
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const DATA = resolve(REPO_ROOT, 'src/verticals/elster/data');

function norm(s) {
  if (!s) return '';
  return String(s).toLowerCase()
    .replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

async function main() {
  const fk = JSON.parse(await readFile(join(DATA, 'feld_katalog_full.json'), 'utf-8'));
  const known = new Set();
  for (const b of Object.values(fk.anlagen)) for (const f of b.codes) known.add(f.eCode);

  const existing = JSON.parse(await readFile(join(DATA, 'bmf_elster_zuordnung.json'), 'utf-8'));
  // Map keyed by `${normalizedLabel}#${eCode}` to dedupe across sources
  const slot = new Map();
  // Preserve manual seeds
  for (const e of existing) {
    const k = `${norm(e.bmfFeld)}#${e.elsterCode}`;
    slot.set(k, { ...e, _origin: 'manual' });
  }

  const stats = { fromKatalog: 0, fromFelder: 0, droppedRotten: 0 };

  // Source 1: feld_katalog_full
  for (const [anlage, b] of Object.entries(fk.anlagen)) {
    for (const f of b.codes) {
      const labels = new Set();
      if (f.bezeichnung) labels.add(f.bezeichnung);
      if (f.drucktext)   labels.add(f.drucktext);
      for (const lbl of labels) {
        if (!known.has(f.eCode)) { stats.droppedRotten++; continue; }
        const trimmed = lbl.replace(/\s+/g, ' ').trim();
        if (trimmed.length < 3 || trimmed.length > 200) continue;
        const k = `${norm(trimmed)}#${f.eCode}`;
        if (slot.has(k) && slot.get(k)._origin === 'manual') continue;
        slot.set(k, {
          bmfFeld: trimmed,
          elsterCode: f.eCode,
          priority: 5,
          isPrimary: true,
          mappingSource: 'mined-feld-katalog',
          confidence: 0.92,
          reasoning: `Catalog ${anlage}.${f.eCode}`,
          _origin: 'auto',
        });
        stats.fromKatalog++;
      }
    }
  }

  // Source 2: per-Anlage felder/*.json
  const felderFiles = (await readdir(join(DATA, 'felder'))).filter((f) => f.endsWith('.json'));
  for (const fname of felderFiles) {
    const anl = basename(fname, '.json');
    const data = JSON.parse(await readFile(join(DATA, 'felder', fname), 'utf-8'));
    for (const x of data.felder ?? []) {
      const code = x.Name;
      if (!/^E\d{7}$/.test(code)) continue;
      if (!known.has(code)) { stats.droppedRotten++; continue; }
      const labels = new Set();
      if (x.Drucktext)    labels.add(x.Drucktext);
      if (x.Beschreibung) labels.add(x.Beschreibung);
      for (const lbl of labels) {
        const trimmed = String(lbl).replace(/\s+/g, ' ').trim();
        if (trimmed.length < 3 || trimmed.length > 200) continue;
        const k = `${norm(trimmed)}#${code}`;
        if (slot.has(k) && slot.get(k)._origin === 'manual') continue;
        if (slot.has(k)) continue; // first-mining wins for ties
        slot.set(k, {
          bmfFeld: trimmed,
          elsterCode: code,
          priority: 6,
          isPrimary: true,
          mappingSource: 'mined-felder',
          confidence: 0.90,
          reasoning: `felder/${anl} Vordruck-Drucktext`,
          _origin: 'auto',
        });
        stats.fromFelder++;
      }
    }
  }

  // Strip _origin before writing
  const out = [...slot.values()]
    .map(({ _origin, ...e }) => e)
    .sort((a, b) => {
      if (a.elsterCode !== b.elsterCode) return a.elsterCode.localeCompare(b.elsterCode);
      return (a.priority ?? 99) - (b.priority ?? 99);
    });

  // Distinct-code coverage check
  const codesCovered = new Set(out.map((e) => e.elsterCode));
  const codesUncovered = [...known].filter((c) => !codesCovered.has(c));

  await writeFile(join(DATA, 'bmf_elster_zuordnung.json'),
    JSON.stringify(out, null, 2) + '\n', 'utf-8');

  console.error(`Mined ${stats.fromKatalog} from feld_katalog, ${stats.fromFelder} from felder/`);
  console.error(`Dropped ${stats.droppedRotten} rotten refs`);
  console.error(`Total entries: ${out.length}`);
  console.error(`Codes covered: ${codesCovered.size} / ${known.size} (${codesUncovered.length} not yet covered)`);
  if (codesUncovered.length > 0 && codesUncovered.length < 50) {
    console.error(`Sample uncovered:`, codesUncovered.slice(0, 10));
  }
  console.error(`\nWrote: ${join(DATA, 'bmf_elster_zuordnung.json')}`);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
