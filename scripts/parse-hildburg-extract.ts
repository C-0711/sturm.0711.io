/**
 * Parse Hildburg ESt-2023 extract dump into a clean field list.
 * The dump has 4 sections:
 *   1. 'Unsichere Zuordnung'        — [label, value, ecode, certainty, conf]
 *   2. 'Erkannt fließt in den Fall' — [label, value, ecode, certainty, conf]
 *   3. 'Erkannt Info-only'           — [label, value, slug] (no ecode)
 *   4. 'Sonstiges'                   — [slug, value, label] tuples
 */
import { readFile, writeFile } from 'node:fs/promises';

const raw = await readFile('/tmp/hildburg-est-2023-extract.txt', 'utf-8');
const lines = raw.split('\n').map(l => l.trim());

interface Field {
  source_section: 'unsicher' | 'erkannt' | 'info' | 'sonstiges';
  label: string;
  value: string;
  legacy_ecode?: string;
  legacy_certainty?: string;
  legacy_conf?: number;
}

const fields: Field[] = [];
let mode: Field['source_section'] = 'unsicher';
let i = 0;

// Helper to peek ahead
const isECode = (s: string) => /^E\d{7}$/.test(s);
const isCert = (s: string) => s === 'exakt' || s === 'wahrsch.';
const isConf = (s: string) => /^0\.\d{2}$/.test(s);

while (i < lines.length) {
  const l = lines[i];
  // Section markers
  if (l.startsWith('Unsichere Zuordnung')) { mode = 'unsicher'; i++; continue; }
  if (l.startsWith('Erkannt · fließt in den Fall')) { mode = 'erkannt'; i++; continue; }
  if (l.startsWith('Erkannt · Info-only')) { mode = 'info'; i++; continue; }
  if (l === 'Sonstiges') { mode = 'sonstiges'; i++; continue; }
  if (l === 'Im STURM-Workspace öffnen →') { i++; continue; }
  if (l === '' || l === 'Source: External' || l === '---' || /^\d+$/.test(l) && l.length <= 2) { i++; continue; }
  if (l === '59') { i++; continue; }

  if (mode === 'sonstiges') {
    // Pattern: slug \n value \n label \n (empty)
    if (l.startsWith('HK_Sonstiges')) {
      const slug = l;
      const value = lines[i+1] || '';
      const label = lines[i+2] || '';
      if (value && label) fields.push({ source_section: 'sonstiges', label, value });
      i += 3;
      continue;
    }
    // Skip stray lines in sonstiges section before first HK_
    i++;
    continue;
  }

  if (mode === 'info') {
    // Pattern: label \n value \n slug (where slug starts with 'beleg.' or 'person.')
    const label = l;
    const value = lines[i+1] || '';
    const maybeSlug = lines[i+2] || '';
    if (maybeSlug.startsWith('beleg.') || maybeSlug.startsWith('person.')) {
      fields.push({ source_section: 'info', label, value });
      i += 3;
      continue;
    }
    // Or it's free-form key/value pairs (Datum/IBAN/Spenden/etc.)
    if (value && !isECode(value) && !value.startsWith('HK_')) {
      fields.push({ source_section: 'info', label, value });
      i += 2;
      continue;
    }
    i++;
    continue;
  }

  // mode unsicher or erkannt: pattern label \n value \n ecode \n cert \n conf
  const label = l;
  const value = lines[i+1] || '';
  const ec = lines[i+2] || '';
  const cert = lines[i+3] || '';
  const conf = lines[i+4] || '';
  if (isECode(ec) && isCert(cert) && isConf(conf)) {
    fields.push({
      source_section: mode,
      label,
      value,
      legacy_ecode: ec,
      legacy_certainty: cert,
      legacy_conf: parseFloat(conf),
    });
    i += 5;
    continue;
  }
  i++;
}

// Dedup info-section: skip if label already exists in fields
const seen = new Set<string>();
const uniq = fields.filter(f => {
  const key = f.label + '|' + f.value;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

console.log('parsed', uniq.length, 'fields');
const counts = uniq.reduce((acc, f) => { acc[f.source_section] = (acc[f.source_section] || 0) + 1; return acc; }, {} as Record<string, number>);
console.log('by section:', counts);
console.log();
console.log('=== Sample ===');
uniq.slice(0, 5).forEach(f => console.log(JSON.stringify(f)));
console.log('...');
uniq.slice(-5).forEach(f => console.log(JSON.stringify(f)));

await writeFile('/tmp/hildburg-fields.json', JSON.stringify(uniq, null, 2));
console.log('\n→ /tmp/hildburg-fields.json');
