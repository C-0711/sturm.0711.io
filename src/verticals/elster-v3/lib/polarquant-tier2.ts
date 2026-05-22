/**
 * PolarQuant Tier-2 LLM-Disambiguator via local vLLM (Gemma-4-31b on H200).
 * v3: kontextPath-as-primary-filter, deterministic candidate annotations,
 *     beitragstragung + LStB-Bezug + versichererTyp from BelegContext.
 */
import { createHash } from 'node:crypto';
import type { AtomMeta, Section, BelegContext } from './polarquant-tier1.ts';

export interface Tier2Audit {
  model: string;
  served_model_name: string;
  endpoint: string;
  sampling: { temperature: number; seed: number; max_tokens: number };
  prompt_sha256: string;
  prompt: string;
  completion: string;
  tokens_in: number;
  tokens_out: number;
  ms: number;
}
export interface Tier2Result {
  picked_ecode: string | null;
  reasoning: string;
  audit: Tier2Audit;
}

const VLLM_URL = 'http://localhost:11435/v1/chat/completions';
const MODEL = 'gemma4-mm';
const MODEL_ROOT = 'google/gemma-4-31b-it';
const SAMPLING = { temperature: 0.0, seed: 42, max_tokens: 200 } as const;

function lstbBezug(drucktext: string): boolean {
  return /Nr\.?\s*2[3-7][abc]?|Lohnsteuerbeschein/i.test(drucktext);
}

function buildPrompt(
  section: Section,
  candidates: Array<{ atom: AtomMeta; score: number }>,
  belegCtx: BelegContext,
): { system: string; user: string; rankedCandidates: Array<{ atom: AtomMeta; score: number; kontext: string; pathMatch: boolean }> } {
  const beitragsartMatch = section.body.match(/Beitragsart\s*\|\s*([^|\n]+)/);
  const beitragsart = beitragsartMatch ? beitragsartMatch[1].trim() : section.heading;
  const preferred = new Set(belegCtx.preferredKontextPaths || []);

  // Rank: kontextPath-match-first, then by polar score.
  const ranked = candidates.map(c => {
    const kontext = (c.atom.kontextPaths || []).join(', ') || '-';
    const pathMatch = (c.atom.kontextPaths || []).some(p => preferred.has(p));
    return { atom: c.atom, score: c.score, kontext, pathMatch };
  }).sort((a, b) => {
    if (a.pathMatch !== b.pathMatch) return a.pathMatch ? -1 : 1;
    return b.score - a.score;
  });

  const system = 'Du bist ein deutscher Steuerfachhelfer für ELSTER-Belegcodierung. Du wählst aus den Kandidaten genau den passendsten aus, basierend auf dem ELSTER-XSD-kontextPath. Du erfindest NICHTS und gibst KEINE Zeilen- oder Anlage-Info zurück, nur den eCode und Begründung.';

  const candLines = ranked.slice(0, 15).map(r => {
    const flag = r.pathMatch ? '✓ kontextPath-Match' : '✗ andere XSD-Achse';
    const lstb = lstbBezug(r.atom.drucktext) ? ', LStB-Bezug' : '';
    return `- ${r.atom.ecode} [${flag}, path=${r.kontext}${lstb}]: ${r.atom.drucktext}`;
  }).join('\n');

  const rules: string[] = [];
  rules.push('AUSWAHL-REGELN (verbindlich):');
  rules.push('  1. Bevorzuge IMMER Kandidaten mit [✓ kontextPath-Match]. Diese passen zur XSD-Achse des Belegs.');
  rules.push('  2. Kandidaten mit [✗ andere XSD-Achse] sind nur dann zulässig wenn ALLE ✓-Kandidaten semantisch unpassend sind.');
  if (belegCtx.hasLStBBezug === false || belegCtx.beitragstragung !== 'arbeitgeber') {
    rules.push('  3. Beleg hat KEINEN Lohnsteuer-Bezug. Kandidaten mit "Nr. 24/25/26 LStB" sind FALSCH.');
  }
  rules.push('  4. Wenn die Beitragsart "Gesamt", "gesamt" oder "Summe" enthält UND der Beleg separate Aufschlüsselungen liefert: antworte IMMER NONE.');
  rules.push('  5. Antworte NONE wenn KEIN Kandidat semantisch passt.');

  const ctxLines = [
    belegCtx.profileSummary ? `Mandant-Profil: ${belegCtx.profileSummary}` : null,
    belegCtx.belegtyp ? `Belegart: ${belegCtx.belegtyp}` : null,
    belegCtx.uebermittelndeStelle ? `Versicherer: ${belegCtx.uebermittelndeStelle} (${belegCtx.versichererTyp})` : null,
    belegCtx.beitragstragung ? `Beitragstragung: ${belegCtx.beitragstragung}` : null,
    belegCtx.hasLStBBezug !== undefined ? `LStB-Bezug im Beleg: ${belegCtx.hasLStBBezug ? 'JA' : 'NEIN'}` : null,
    belegCtx.preferredKontextPaths?.length ? `Bevorzugte XSD-kontextPaths: ${belegCtx.preferredKontextPaths.join(', ')}` : null,
  ].filter(Boolean).join('\n');

  const user = [
    'Aufgabe: Wähle den ELSTER-eCode aus, der den folgenden Beleg-Beitragsart am genauesten beschreibt.',
    '',
    ctxLines,
    `Beleg-Beitragsart: "${beitragsart}"`,
    '',
    ...rules,
    '',
    'Kandidaten (sortiert: kontextPath-Match zuerst):',
    candLines,
    '',
    'Antwort-Format: EXAKT eine Zeile, NICHTS davor/danach:',
    'ECODE|kurze Begründung',
    '',
    'Wenn KEIN Kandidat genau passt: NONE|Begründung',
  ].join('\n');

  return { system, user, rankedCandidates: ranked };
}

function parseResponse(text: string, validEcodes: Set<string>): { picked: string | null; reasoning: string } {
  const cleaned = text.trim().replace(/^`+|`+$/g, '');
  let m = cleaned.match(/^(NONE|E\d{7})\s*\|\s*(.+?)$/s);
  if (!m) {
    const ecMatch = cleaned.match(/(NONE|E\d{7})/);
    if (ecMatch) {
      const after = cleaned.slice(ecMatch.index! + ecMatch[1].length).replace(/^[^|]*\|\s*/, '');
      m = [cleaned, ecMatch[1], after || cleaned] as unknown as RegExpMatchArray;
    }
  }
  if (!m) return { picked: null, reasoning: 'parse-failed: ' + cleaned.slice(0, 120) };
  const ec = m[1];
  if (ec === 'NONE') return { picked: null, reasoning: m[2].trim().slice(0, 250) };
  if (!validEcodes.has(ec)) return { picked: null, reasoning: 'hallucinated-ecode: ' + ec + ' — ' + m[2].trim().slice(0, 200) };
  return { picked: ec, reasoning: m[2].trim().slice(0, 250) };
}

export async function gemmaDisambiguate(
  section: Section,
  candidates: Array<{ atom: AtomMeta; score: number }>,
  belegCtx: BelegContext,
): Promise<Tier2Result> {
  const t0 = Date.now();
  const { system, user, rankedCandidates } = buildPrompt(section, candidates, belegCtx);
  const fullPrompt = system + '\n\n' + user;
  const promptSha = createHash('sha256').update(fullPrompt).digest('hex');

  const resp = await fetch(VLLM_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: SAMPLING.temperature, seed: SAMPLING.seed, max_tokens: SAMPLING.max_tokens,
    }),
  });
  if (!resp.ok) throw new Error('vLLM ' + resp.status + ': ' + await resp.text());
  const data = await resp.json() as { choices: Array<{ message: { content: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  const completion = data.choices[0]?.message?.content ?? '';
  const validEcodes = new Set(rankedCandidates.slice(0, 15).map(r => r.atom.ecode));
  const { picked, reasoning } = parseResponse(completion, validEcodes);

  return {
    picked_ecode: picked,
    reasoning,
    audit: {
      model: MODEL_ROOT, served_model_name: MODEL, endpoint: VLLM_URL,
      sampling: { ...SAMPLING }, prompt_sha256: promptSha, prompt: fullPrompt, completion,
      tokens_in: data.usage?.prompt_tokens ?? 0,
      tokens_out: data.usage?.completion_tokens ?? 0,
      ms: Date.now() - t0,
    },
  };
}
