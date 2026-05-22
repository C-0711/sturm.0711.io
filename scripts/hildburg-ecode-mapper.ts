/**
 * Hildburg ESt-2023 → eCode-Mapping via Gemma-4-31b tier-2.
 *
 * For each parsed field {label, value}, find the matching eCode from the
 * full BMF ELSTER catalog. Uses:
 *   - Pre-filtering by datentyp (currency/date/string) and value-shape heuristics
 *   - Polar embedding for top-K candidates from the WHOLE catalog (2287 atoms)
 *   - Gemma tier-2 for final pick with kontextPath-awareness
 */
import { readFile, writeFile } from 'node:fs/promises';
import { ExactFp32Index } from '../src/lib/quantum-index.ts';
import { embedQueries } from '../src/lib/gemma-embed.ts';
import { loadContainerAtoms, type AtomMeta } from '../src/verticals/elster-v3/lib/polarquant-tier1.ts';
import { createHash } from 'node:crypto';

interface Field {
  source_section: string;
  label: string;
  value: string;
  legacy_ecode?: string;
  legacy_conf?: number;
}

interface MappedField extends Field {
  resolved_ecode: string | null;
  resolved_anlage?: string;
  resolved_zeile?: string;
  resolved_drucktext?: string;
  resolved_kontextPath?: string;
  resolved_datentyp?: string;
  resolved_strategy: 'tier2-pick' | 'no-match' | 'profile-only-no-ecode';
  resolved_reasoning?: string;
  resolved_ms?: number;
}

const VLLM_URL = 'http://localhost:11435/v1/chat/completions';
const MODEL = 'gemma4-mm';

// Profile context for Hildburg — boosts disambiguation
const PROFILE_CTX = [
  'Steuerpflichtige: Hildburg Haubrich-Koch, geb. 24.11.1935, Rentnerin',
  'Familienstand: Verwitwet seit 12.04.2012 → Alleinveranlagung Person A (kein Ehegatte)',
  'Adresse: Am Schwanenteich 1, 53474 Bad Neuenahr',
  'Einkunftsarten: Versorgungsbezüge (Betriebsrente), gesetzliche Rente, Kapitalerträge',
  'Versicherung: private KV (Debeka), DEVK Haftpflicht',
  'Keine Kinder, keine Werbungskosten, keine Arbeitgeber-LStB (Renteneinkünfte)',
  'Veranlagungs-Jahr 2023, Finanzamt Bad Neuenahr-Ahrweiler',
].join(' | ');

async function gemmaResolve(field: Field, candidates: AtomMeta[]): Promise<{ picked: string | null; reasoning: string; ms: number; tokens_in: number; tokens_out: number }> {
  const t0 = Date.now();
  const candLines = candidates.slice(0, 12).map(c => {
    const paths = (c.kontextPaths || []).join(',') || '-';
    return `- ${c.ecode} [${c.anlage}/Z${c.vordruckzeile || '-'}, ${c.datentyp}, path=${paths}]: ${c.drucktext}`;
  }).join('\n');

  const system = 'Du bist ein deutscher Steuerfachhelfer für ELSTER-Belegcodierung. Du wählst aus den Kandidaten genau den eCode der zum Label und Wert passt. Du erfindest NICHTS.';
  const user = [
    `Profil-Kontext: ${PROFILE_CTX}`,
    '',
    `Feld-Label: "${field.label}"`,
    `Wert: "${field.value}"`,
    '',
    'Kandidaten aus dem ELSTER-Katalog:',
    candLines,
    '',
    'Antwort-Format: EXAKT eine Zeile, NICHTS davor/danach:',
    'ECODE|kurze Begründung',
    '',
    'Wenn KEIN Kandidat passt: NONE|Begründung',
  ].join('\n');

  const resp = await fetch(VLLM_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.0, seed: 42, max_tokens: 150,
    }),
  });
  if (!resp.ok) throw new Error('vLLM ' + resp.status);
  const data = await resp.json() as { choices: Array<{ message: { content: string } }>; usage?: any };
  const completion = data.choices[0]?.message?.content ?? '';

  const m = completion.trim().match(/^(NONE|E\d{7})\s*\|\s*(.+)$/s) || (() => {
    const ec = completion.match(/(NONE|E\d{7})/);
    if (!ec) return null;
    return [completion, ec[1], completion.replace(ec[1], '').replace(/^[^|]*\|/, '').trim()] as any;
  })();

  const ms = Date.now() - t0;
  if (!m) return { picked: null, reasoning: 'parse-failed: ' + completion.slice(0,100), ms, tokens_in: data.usage?.prompt_tokens || 0, tokens_out: data.usage?.completion_tokens || 0 };
  const ec = m[1];
  const valid = new Set(candidates.map(c => c.ecode));
  if (ec === 'NONE') return { picked: null, reasoning: m[2].trim().slice(0,250), ms, tokens_in: data.usage?.prompt_tokens || 0, tokens_out: data.usage?.completion_tokens || 0 };
  if (!valid.has(ec)) return { picked: null, reasoning: 'hallucinated: ' + ec + ' — ' + m[2].trim().slice(0,200), ms, tokens_in: data.usage?.prompt_tokens || 0, tokens_out: data.usage?.completion_tokens || 0 };
  return { picked: ec, reasoning: m[2].trim().slice(0,250), ms, tokens_in: data.usage?.prompt_tokens || 0, tokens_out: data.usage?.completion_tokens || 0 };
}

async function main() {
  const t0 = Date.now();
  const fields: Field[] = JSON.parse(await readFile('/tmp/hildburg-fields.json', 'utf-8'));
  const { atomsByIdx } = await loadContainerAtoms('src/verticals/elster-v3/data/atoms.json');
  const index = await ExactFp32Index.load('src/verticals/elster-v3/data/embeddings.gemma4.fp32.bin', 768);
  console.log('Loaded', atomsByIdx.length, 'atoms,', fields.length, 'fields to map\n');

  const out: MappedField[] = [];
  for (const [i, f] of fields.entries()) {
    process.stdout.write(`[${i+1}/${fields.length}] ${f.label.slice(0,40).padEnd(40)} = ${f.value.slice(0,25).padEnd(25)} → `);

    // Build embedding query
    const query = `${f.label} | Wert: ${f.value}`;
    const [embed] = await embedQueries([query], 'http://localhost:11434');
    const allIdx = Array.from({ length: atomsByIdx.length }, (_, k) => k);
    const hits = index.rerank(embed, allIdx, 30);

    // Pre-filter by datentyp heuristic
    const isCurrency = /^[\d.]+,\d{2}$/.test(f.value) || /^\d+$/.test(f.value);
    const isDate = /\d{2}\.\d{2}\.\d{4}/.test(f.value);
    const isString = !isCurrency && !isDate;

    let candidates = hits.map(h => atomsByIdx[h.idx]).filter(Boolean);
    // soft filter: prefer matching datentyp but don't exclude entirely
    const matchingType = candidates.filter(a => {
      if (isCurrency) return a.datentyp === 'currency';
      if (isDate) return a.datentyp === 'date';
      return a.datentyp === 'string';
    });
    if (matchingType.length >= 5) candidates = matchingType;

    const result = await gemmaResolve(f, candidates);
    const mapped: MappedField = { ...f, resolved_ecode: result.picked, resolved_strategy: result.picked ? 'tier2-pick' : 'no-match', resolved_reasoning: result.reasoning, resolved_ms: result.ms };
    if (result.picked) {
      const atom = candidates.find(a => a.ecode === result.picked);
      if (atom) {
        mapped.resolved_anlage = atom.anlage;
        mapped.resolved_zeile = atom.vordruckzeile || undefined;
        mapped.resolved_drucktext = atom.drucktext;
        mapped.resolved_kontextPath = (atom.kontextPaths || []).join(',');
        mapped.resolved_datentyp = atom.datentyp;
      }
    }
    out.push(mapped);
    if (result.picked) {
      console.log(`✓ ${result.picked} [${mapped.resolved_anlage}/Z${mapped.resolved_zeile}] (${result.ms}ms)`);
    } else {
      console.log(`∅ no-match (${result.ms}ms) — ${result.reasoning.slice(0,40)}`);
    }
  }

  const elapsed = Date.now() - t0;
  await writeFile('/tmp/hildburg-mapped.json', JSON.stringify(out, null, 2));

  // Stats
  const hits = out.filter(o => o.resolved_ecode).length;
  const matchesLegacy = out.filter(o => o.resolved_ecode && o.legacy_ecode && o.resolved_ecode === o.legacy_ecode).length;
  const differsFromLegacy = out.filter(o => o.resolved_ecode && o.legacy_ecode && o.resolved_ecode !== o.legacy_ecode).length;
  const newlyFound = out.filter(o => o.resolved_ecode && !o.legacy_ecode).length;
  const noMatch = out.filter(o => !o.resolved_ecode).length;

  console.log(`\n=== STATS ===`);
  console.log(`Total fields:         ${out.length}`);
  console.log(`Resolved (hit):       ${hits}`);
  console.log(`Match legacy eCode:   ${matchesLegacy}`);
  console.log(`Differs from legacy:  ${differsFromLegacy}`);
  console.log(`Newly mapped:         ${newlyFound}`);
  console.log(`No match:             ${noMatch}`);
  console.log(`Total time:           ${(elapsed/1000).toFixed(1)}s`);
  console.log(`\nFull → /tmp/hildburg-mapped.json`);
}
main().catch(e => { console.error(e); process.exit(1); });
