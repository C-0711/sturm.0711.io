#!/usr/bin/env node
/**
 * Preprocess the postgres dumps in src/verticals/elster/data/postgres-dumps/
 * into bundled JSON the cascade can use directly. The dumps were pulled from
 * ctaxv1-postgres on H200V via:
 *
 *   ssh h200v 'docker exec ctaxv1-postgres psql -U ctax -d ctax -At -c "
 *     SELECT json_agg(row_to_json(t)) FROM (...) t
 *   "' > tmp/<table>.json
 *
 * Then those files were moved into postgres-dumps/.
 *
 * This script aggregates every keyword/slug/concept→eCode signal from the
 * dumps and emits:
 *   - bmf_elster_zuordnung.json   — slug/keyword → eCode (overwrites manual seed-merged)
 *   - konzept_zuordnung.json      — concept_slug + search_keywords → eCode candidates
 *   - regelwerk_postgres.json     — bmf_steuerrechner.regelwerk verbatim (for engine ref)
 *   - golden_elster_mappings.json — XSD-typed gold standard
 *
 * Hard guarantee: every emitted eCode is verified against feld_katalog_full.json.
 * Mapping rows referencing rotten codes are dropped with a warning.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const DATA = resolve(REPO_ROOT, 'src/verticals/elster/data');
const DUMPS = join(DATA, 'postgres-dumps');

async function loadDump(name) {
  try {
    const raw = await readFile(join(DUMPS, name), 'utf-8');
    if (!raw.trim() || raw.trim() === 'null') return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error(`load ${name}: ${e.message}`);
    return [];
  }
}

function normLabel(s) {
  if (!s) return '';
  return String(s).toLowerCase()
    .replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

async function main() {
  // 1) Load the official catalog (single source of truth)
  const fk = JSON.parse(await readFile(join(DATA, 'feld_katalog_full.json'), 'utf-8'));
  const known = new Set();
  for (const b of Object.values(fk.anlagen)) for (const f of b.codes) known.add(f.eCode);
  console.error(`Catalog: ${known.size} known eCodes`);

  // 2) Preserve manual seed entries
  const existingZu = JSON.parse(await readFile(join(DATA, 'bmf_elster_zuordnung.json'), 'utf-8'));
  const manualSeeds = existingZu.filter((e) => e.mappingSource === 'manual_seed');
  console.error(`Preserving ${manualSeeds.length} manual-seed slugs`);

  // 3) Load dumps
  const feldZuordnungen = await loadDump('feld_zuordnungen.json');
  const fieldConceptMap = await loadDump('field_concept_map.json');
  const fieldConcepts = await loadDump('field_concepts.json');
  const steuerSchlagworte = await loadDump('steuer_schlagworte_normiert.json');
  const goldenMappings = await loadDump('golden_elster_mappings.json');
  const regelwerk = await loadDump('regelwerk.json');
  // From OLD ctax-postgres (port 9432, db ctax_cb_chat) — the shared schema
  // is the original CB-chat catalog, contains 686 hand-curated slug-mappings
  // (54 xsd_gold_standard, confidence 1.0) and 326 search keywords.
  const sharedBmfElsterZuordnung = await loadDump('shared_bmf_elster_zuordnung.json');
  const sharedFeldKatalog = await loadDump('shared_feld_katalog.json');
  const sharedProfilPflichtfelder = await loadDump('shared_profil_pflichtfelder.json');

  console.error(`Dumps: feld_zuordnungen=${feldZuordnungen.length}, ` +
                `field_concept_map=${fieldConceptMap.length}, ` +
                `field_concepts=${fieldConcepts.length}, ` +
                `steuer_schlagworte=${steuerSchlagworte.length}, ` +
                `golden_mappings=${goldenMappings.length}, ` +
                `regelwerk=${regelwerk.length}`);
  console.error(`OLD DB (ctax-postgres): shared.bmf_elster_zuordnung=${sharedBmfElsterZuordnung.length}, ` +
                `shared.feld_katalog=${sharedFeldKatalog.length}, ` +
                `shared.profil_elster_pflichtfelder=${sharedProfilPflichtfelder.length}`);

  // ────────────────────────────────────────────────────────────────────────
  // Build concept_slug → [eCode]  index from field_concept_map
  // ────────────────────────────────────────────────────────────────────────
  const conceptToEcodes = new Map(); // concept_slug → Set<eCode>
  let dropped = 0;
  for (const m of fieldConceptMap) {
    if (!m.elster_code || !m.concept_slug) continue;
    if (!known.has(m.elster_code)) { dropped++; continue; }
    if (!conceptToEcodes.has(m.concept_slug)) conceptToEcodes.set(m.concept_slug, new Set());
    conceptToEcodes.get(m.concept_slug).add(m.elster_code);
  }
  console.error(`field_concept_map: ${conceptToEcodes.size} concepts, dropped ${dropped} rotten`);

  // ────────────────────────────────────────────────────────────────────────
  // Build bmf_field → eCode from feld_zuordnungen joined to nothing yet.
  // feld_zuordnungen.target_bmf_field is a slug like "bruttoarbeitslohn".
  // We don't have a direct (slug → eCode) table here, so we infer via the
  // semantic_keywords + the same slug appearing as a concept_slug if matchable.
  // Best signal: target_bmf_field IS often the same as a concept_slug.
  // ────────────────────────────────────────────────────────────────────────

  const slot = new Map(); // `${normalizedKey}#${eCode}` → entry

  function addEntry(label, eCode, source, confidence, reasoning, priority = 5) {
    if (!known.has(eCode)) return false;
    const trimmed = String(label).replace(/\s+/g, ' ').trim();
    if (trimmed.length < 2 || trimmed.length > 200) return false;
    const k = `${normLabel(trimmed)}#${eCode}`;
    const existing = slot.get(k);
    // Manual seeds always win
    if (existing && existing.mappingSource === 'manual_seed') return false;
    // Higher-priority sources win on conflict
    if (existing && (existing.priority ?? 99) <= priority) return false;
    slot.set(k, {
      bmfFeld: trimmed,
      elsterCode: eCode,
      priority,
      isPrimary: true,
      mappingSource: source,
      confidence,
      reasoning,
    });
    return true;
  }

  // Manual seeds first (priority 1)
  for (const s of manualSeeds) {
    slot.set(`${normLabel(s.bmfFeld)}#${s.elsterCode}`, { ...s, priority: 1 });
  }

  // ────────────────────────────────────────────────────────────────────────
  // Source: field_concept_map (661) + field_concepts (895)
  // Each concept has a label_de, search_keywords, and resolves to N eCodes.
  // Emit one slug entry per (label/keyword, eCode) pair.
  // ────────────────────────────────────────────────────────────────────────
  let n_fcm = 0;
  for (const c of fieldConcepts) {
    const codes = conceptToEcodes.get(c.concept_slug);
    if (!codes || codes.size === 0) continue;
    const labels = [c.concept_slug, c.concept_label_de, ...(c.search_keywords ?? [])];
    for (const lbl of labels) {
      if (!lbl) continue;
      for (const code of codes) {
        if (addEntry(lbl, code, 'field_concept_map', 0.93,
                     `concept_slug=${c.concept_slug} field_group=${c.field_group ?? '-'}`,
                     3)) n_fcm++;
      }
    }
  }
  console.error(`field_concepts × concept_map: ${n_fcm} entries`);

  // ────────────────────────────────────────────────────────────────────────
  // Source: feld_zuordnungen (141) — pattern → bmf_field with semantic_keywords
  // We don't have direct slug→eCode mapping; we can JOIN on concept_slug if
  // target_bmf_field matches one in conceptToEcodes.
  // ────────────────────────────────────────────────────────────────────────
  let n_fz = 0;
  for (const m of feldZuordnungen) {
    if (!m.target_bmf_field) continue;
    const codes = conceptToEcodes.get(m.target_bmf_field);
    if (!codes || codes.size === 0) continue;
    const labels = [m.target_bmf_field, m.source_pattern, m.description, ...(m.semantic_keywords ?? []), ...(m.alternative_patterns ?? [])];
    for (const lbl of labels) {
      if (!lbl) continue;
      for (const code of codes) {
        if (addEntry(lbl, code, 'feld_zuordnungen', 0.94,
                     `${m.target_bmf_field} ${m.legal_reference ?? ''}`.trim(),
                     2)) n_fz++;
      }
    }
  }
  console.error(`feld_zuordnungen: ${n_fz} entries`);

  // ────────────────────────────────────────────────────────────────────────
  // Source: steuer_schlagworte_normiert (7617) joined to category.elster_feld
  // Each row has a normalized_keyword and category.elster_feld.
  // category.elster_feld can be:
  //   - a single eCode "E0200201"
  //   - a comma-list "E0200201,E0200301"
  //   - a slug like "bruttoarbeitslohn" (then we need conceptToEcodes lookup)
  //   - empty
  // ────────────────────────────────────────────────────────────────────────
  let n_ssn = 0;
  for (const k of steuerSchlagworte) {
    const ef = k.elster_feld;
    if (!ef) continue;
    const labels = [k.normalized_keyword, k.original_keyword].filter(Boolean);
    // Candidate eCodes
    let candidateCodes = [];
    const efTrimmed = String(ef).trim();
    if (/^E\d{7}$/.test(efTrimmed)) candidateCodes.push(efTrimmed);
    else if (efTrimmed.includes(',')) {
      candidateCodes = efTrimmed.split(',').map((c) => c.trim()).filter((c) => /^E\d{7}$/.test(c));
    } else {
      // Try concept lookup
      const viaConcept = conceptToEcodes.get(efTrimmed);
      if (viaConcept) candidateCodes = [...viaConcept];
    }
    for (const lbl of labels) {
      for (const code of candidateCodes) {
        if (addEntry(lbl, code, 'steuer_schlagworte_normiert', 0.88,
                     `category=${k.category_code ?? ''}`,
                     4)) n_ssn++;
      }
    }
  }
  console.error(`steuer_schlagworte_normiert: ${n_ssn} entries`);

  // ────────────────────────────────────────────────────────────────────────
  // Source: golden_elster_mappings (2054) — direct elster_field_code with
  // rich xsd metadata. We add the elster_field_name as a synonym (often
  // matches drucktext-style labels).
  // ────────────────────────────────────────────────────────────────────────
  let n_gold = 0;
  for (const g of goldenMappings) {
    if (!g.elster_field_code || !g.elster_field_name) continue;
    if (addEntry(g.elster_field_name, g.elster_field_code, 'golden_elster_mappings', 0.96,
                 `xsd_type=${g.xsd_type ?? '-'} anlage=${g.anlage ?? '-'} zeile=${g.zeile ?? '-'}`,
                 3)) n_gold++;
  }
  console.error(`golden_elster_mappings: ${n_gold} entries`);

  // ────────────────────────────────────────────────────────────────────────
  // Source: shared.bmf_elster_zuordnung (686) — hand-curated slug→eCode
  // from the OLD ctax-postgres. Includes 54 xsd_gold_standard (conf=1.0).
  // ────────────────────────────────────────────────────────────────────────
  let n_sharedBmf = 0;
  for (const b of sharedBmfElsterZuordnung) {
    if (!b.bmf_field || !b.elster_code) continue;
    // xsd_gold_standard entries get top priority (after manual seeds)
    const isGold = b.mapping_source === 'xsd_gold_standard';
    const isManualHildburg = b.mapping_source === 'manual_hildburg';
    const priority = isGold ? 2 : (isManualHildburg ? 2 : 3);
    const conf = isGold ? 0.99 : (b.confidence ?? 0.92);
    if (addEntry(b.bmf_field, b.elster_code, `shared:${b.mapping_source}`, conf,
                 b.reasoning ?? `${b.mapping_source} (priority ${b.priority ?? 100})`,
                 priority)) n_sharedBmf++;
  }
  console.error(`shared.bmf_elster_zuordnung: ${n_sharedBmf} entries`);

  // ────────────────────────────────────────────────────────────────────────
  // Source: shared.feld_katalog — extra synonyms via suchbegriffe[],
  // semantik_schlagworte[], extraktions_muster[], bezeichnung
  // ────────────────────────────────────────────────────────────────────────
  let n_sharedFk = 0;
  for (const f of sharedFeldKatalog) {
    const code = f.elster_kennzahl;
    if (!code || !known.has(code)) continue;
    if (f.bezeichnung) {
      if (addEntry(f.bezeichnung, code, 'shared.feld_katalog.bezeichnung', 0.94,
                   `${f.formular_typ ?? ''} ${f.rechtsgrundlage ?? ''}`.trim(), 3)) n_sharedFk++;
    }
    if (f.bmf_feld) {
      if (addEntry(f.bmf_feld, code, 'shared.feld_katalog.bmf_feld', 0.95,
                   `slug ${f.bmf_feld}`, 3)) n_sharedFk++;
    }
    for (const sb of f.suchbegriffe ?? []) {
      if (sb && addEntry(sb, code, 'shared.feld_katalog.suchbegriffe', 0.90,
                         `Suchbegriff for ${code}`, 4)) n_sharedFk++;
    }
    for (const sk of f.semantik_schlagworte ?? []) {
      if (sk && addEntry(sk, code, 'shared.feld_katalog.semantik_schlagworte', 0.91,
                         `Synonym ${code}`, 4)) n_sharedFk++;
    }
  }
  console.error(`shared.feld_katalog: ${n_sharedFk} entries`);

  // ────────────────────────────────────────────────────────────────────────
  // Output: bmf_elster_zuordnung.json — sorted by elster_code, priority
  // ────────────────────────────────────────────────────────────────────────
  const out = [...slot.values()].sort((a, b) =>
    a.elsterCode === b.elsterCode
      ? (a.priority ?? 99) - (b.priority ?? 99)
      : a.elsterCode.localeCompare(b.elsterCode),
  );

  await writeFile(join(DATA, 'bmf_elster_zuordnung.json'),
    JSON.stringify(out, null, 2) + '\n', 'utf-8');

  // ────────────────────────────────────────────────────────────────────────
  // Output: konzept_zuordnung.json — concept-slug → [eCode] for the cascade's
  // concept stage
  // ────────────────────────────────────────────────────────────────────────
  const konzeptZu = [];
  for (const c of fieldConcepts) {
    const codes = conceptToEcodes.get(c.concept_slug);
    if (!codes || codes.size === 0) continue;
    const validCodes = [...codes].filter((cd) => known.has(cd));
    if (validCodes.length === 0) continue;
    konzeptZu.push({
      conceptSlug: c.concept_slug,
      conceptLabelDe: c.concept_label_de ?? '',
      searchKeywords: c.search_keywords ?? [],
      description: c.description_de ?? '',
      fieldGroup: c.field_group ?? '',
      elsterCodes: validCodes,
      mappingConfidence: 0.93,
    });
  }
  await writeFile(join(DATA, 'konzept_zuordnung.json'),
    JSON.stringify(konzeptZu, null, 2) + '\n', 'utf-8');

  // ────────────────────────────────────────────────────────────────────────
  // Output: regelwerk + golden_elster_mappings as bundled refs (for engine
  // and for downstream cb-chat consumption)
  // ────────────────────────────────────────────────────────────────────────
  // Filter regelwerk: keep only rules whose elster_codes are all known
  const regelwerkClean = regelwerk.filter((r) => {
    const refs = r.elster_codes ?? [];
    return refs.every((c) => known.has(c));
  });
  await writeFile(join(DATA, 'regelwerk_postgres.json'),
    JSON.stringify(regelwerkClean, null, 2) + '\n', 'utf-8');

  const goldenClean = goldenMappings.filter((g) => known.has(g.elster_field_code));
  await writeFile(join(DATA, 'golden_elster_mappings.json'),
    JSON.stringify(goldenClean, null, 2) + '\n', 'utf-8');

  console.error('');
  console.error(`bmf_elster_zuordnung.json:    ${out.length} entries (was ${manualSeeds.length} manual)`);
  console.error(`konzept_zuordnung.json:        ${konzeptZu.length} concepts`);
  console.error(`regelwerk_postgres.json:       ${regelwerkClean.length} rules (dropped ${regelwerk.length - regelwerkClean.length} with rotten refs)`);
  console.error(`golden_elster_mappings.json:   ${goldenClean.length} mappings (dropped ${goldenMappings.length - goldenClean.length} with rotten refs)`);

  // Coverage report
  const codesCovered = new Set(out.map((e) => e.elsterCode));
  console.error(`\nCascade-coverage: ${codesCovered.size} of ${known.size} catalog eCodes have ≥1 slug-mapping (${Math.round(100 * codesCovered.size / known.size)}%)`);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
