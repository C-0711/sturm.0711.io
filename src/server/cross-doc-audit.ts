/**
 * cross-doc-audit — Cross-Document Reasoning über master.json via Gemma-4.
 *
 * Aufruf: in writeCaseMaster() nach BMF-Compute, NICHT per-Doc.
 * Output: master.cross_doc_audit Block.
 *
 * Was Gemma-4 prüft (LLM, kein hardcoded Regelwerk):
 *   • Year-Carry-over   — welche Werte aus einem anderen Jahr darf
 *                          das case.veranlagungsjahr nutzen
 *                          (Stammdaten/Pauschalen ja, jahresgebundene nein)
 *   • Person A / B      — bei Lohnsteuer-Belegen erkennen, ob es um Ehemann
 *                          oder Ehefrau geht (über IdNr-Match)
 *   • Duplikate         — gleicher Beleg mehrfach hochgeladen
 *   • Konflikte          — zwei Quellen, derselbe eCode, andere Werte
 *   • Fehlende Belege   — was bei der gegebenen Anlagen-Kombo noch fehlt
 *   • Konsistenz         — Summen-Plausibilität (KapErtr-Summe in KAP Z.7)
 *
 * Strict no-fallback: Gemma-Call schlägt fehl → Audit-Block bleibt leer
 * mit reason, aber master.json wird trotzdem geschrieben.
 */

const PROMPT = (jahr: number | null) => [
  'Du bist Steuerassistent. Du bekommst master.json eines Steuerfalls',
  jahr ? `(Veranlagungsjahr ${jahr}).` : '(Veranlagungsjahr nicht gesetzt).',
  '',
  'Prüfe Plausibilität + Konsistenz ÜBER ALLE BELEGE hinweg und liefere',
  'strukturierte Hinweise als STRICT JSON:',
  '{',
  '  "warnings": [',
  '    {',
  '      "severity": "info|warn|error",',
  '      "kategorie": "year|person|duplicate|conflict|missing|consistency",',
  '      "message": "<knappe Begründung in Deutsch>",',
  '      "betrifft_ecodes": ["EXXXXX", ...],',
  '      "betrifft_dokumente": ["filename.pdf", ...]',
  '    }',
  '  ],',
  '  "year_carryover_ok": [',
  '    {"ecode": "EXXXXX", "from_jahr": YYYY, "reason": "Stammdatum / Pauschale"}',
  '  ],',
  '  "year_carryover_blocked": [',
  '    {"ecode": "EXXXXX", "from_jahr": YYYY, "reason": "Jahresgebundener Wert"}',
  '  ],',
  '  "person_zuordnung": [',
  '    {"dokument": "filename.pdf", "person": "A|B|unbekannt", "begruendung": "..."}',
  '  ],',
  '  "missing_anlagen": [',
  '    {"anlage": "<CODE>", "reason": "..."}',
  '  ],',
  '  "summary": "<1-2 Sätze: was der Mandant wissen sollte>"',
  '}',
  '',
  'Regeln:',
  '- Stammdaten (IdNr, Name, Religion, Bankverbindung) gelten jahresübergreifend',
  '- Pauschalen (Werbungskosten, Sonderausgaben-Pauschbetrag, Sparer-Pauschbetrag) gelten jahresübergreifend',
  '- Jahresgebundene Werte: Bruttoarbeitslohn, Lohnsteuer, KirchSt-AN, KapErträge,',
  '  Rentenbezüge, Vorsorgeaufwendungen, Kindergeld-Auszahlung',
  '- IdNr-Match: gleiche IdNr in mehreren Belegen → Person A. Andere IdNr',
  '  + verheiratet-Indikator → Person B',
  '- Duplikate: gleicher Aussteller + gleicher Betrag + gleiche Periode',
  '- Pflicht-Belege je Anlage:',
  '    N → Lohnsteuerbescheinigung',
  '    KAP → Steuerbescheinigung Bank ODER Mitteilung Kapitalerträge',
  '    R → Rentenbezugsmitteilung',
  '    VOR → Beitragsbescheinigung KV/PV (oder aus LSt-Besch Nr.22-26)',
  '- KEINE Erklärung, KEIN Markdown, NUR das JSON',
].join('\n');

interface MasterDocSummary {
  filename: string;
  anlagen?: string[];
  fieldsExtracted?: number | null;
  indikation?: {
    belegtyp?: string | null;
    steuerjahr?: number | null;
    wichtige_werte?: Array<{ label: string; value: string }>;
  } | null;
}

interface MasterShape {
  caseId?: string;
  jahr?: number | null;
  documents?: MasterDocSummary[];
  merged_layer?: Record<string, {
    value: string; normalized?: string | null;
    anlage?: string; vordruckzeile?: string;
    drucktext?: string; origin?: string; trust?: string;
    confirmed_by?: Array<{ filename?: string; page?: number }>;
  }>;
  bmf?: { erfolg?: boolean; daten?: { zve?: number; einkommensteuer?: number } };
}

export interface CrossDocAuditResult {
  ran: boolean;
  ms: number;
  llm_used: string | null;
  warnings: Array<{
    severity: 'info' | 'warn' | 'error';
    kategorie: string;
    message: string;
    betrifft_ecodes?: string[];
    betrifft_dokumente?: string[];
  }>;
  year_carryover_ok: Array<{ ecode: string; from_jahr: number; reason: string }>;
  year_carryover_blocked: Array<{ ecode: string; from_jahr: number; reason: string }>;
  person_zuordnung: Array<{ dokument: string; person: 'A' | 'B' | 'unbekannt'; begruendung: string }>;
  missing_anlagen: Array<{ anlage: string; reason: string }>;
  summary: string;
  reason?: string;
}

/**
 * Compact representation of master.json for the LLM-prompt. We drop:
 *   - confirmed_by[].snippet (token-budget)
 *   - merged_layer fields the LLM doesn't need for reasoning
 *   - bmf.berechnungsdetails.rechenschritte (already aggregated)
 */
function compactMaster(master: MasterShape): unknown {
  const docs = (master.documents ?? []).map((d) => ({
    filename: d.filename,
    anlagen: d.anlagen ?? [],
    fieldsExtracted: d.fieldsExtracted ?? null,
    indikation: d.indikation ? {
      belegtyp: d.indikation.belegtyp ?? null,
      steuerjahr: d.indikation.steuerjahr ?? null,
      werte: d.indikation.wichtige_werte ?? [],
    } : null,
  }));
  const ml = master.merged_layer ?? {};
  // Nur ein Sample: pro Anlage die ersten 20 eCodes mit Wert + Quelle.
  // Reduziert Token-Volumen drastisch.
  const byAnlage = new Map<string, Array<{
    ecode: string; value: string; anlage: string; zeile?: string; origin?: string;
    quellen: string[];
  }>>();
  for (const [eCode, v] of Object.entries(ml)) {
    const a = v.anlage ?? '?';
    if (!byAnlage.has(a)) byAnlage.set(a, []);
    if (byAnlage.get(a)!.length >= 20) continue;
    byAnlage.get(a)!.push({
      ecode: eCode,
      value: v.normalized ?? v.value ?? '',
      anlage: a,
      zeile: v.vordruckzeile,
      origin: v.origin,
      quellen: (v.confirmed_by ?? []).map((c) => c.filename ?? '').filter(Boolean),
    });
  }
  const bmf = master.bmf?.daten ?? null;
  return {
    case: { jahr: master.jahr ?? null, dok_count: docs.length },
    dokumente: docs,
    merged_layer_sample: Object.fromEntries(byAnlage),
    bmf: bmf ? { zve: bmf.zve, einkommensteuer: bmf.einkommensteuer } : null,
  };
}

/**
 * Calls Gemma-4 vLLM with the master-summary + prompt. Returns parsed JSON
 * or an empty audit with reason on failure.
 */
export async function runCrossDocAudit(
  master: MasterShape,
  opts: { vllmUrl?: string; model?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CrossDocAuditResult> {
  const t0 = Date.now();
  const empty: CrossDocAuditResult = {
    ran: false, ms: 0, llm_used: null,
    warnings: [], year_carryover_ok: [], year_carryover_blocked: [],
    person_zuordnung: [], missing_anlagen: [], summary: '',
  };
  if (!master.merged_layer || Object.keys(master.merged_layer).length === 0) {
    return { ...empty, reason: 'no merged_layer fields', ms: Date.now() - t0 };
  }
  const vllmUrl = opts.vllmUrl ?? process.env['VLLM_URL'] ?? 'http://localhost:11435';
  const model = opts.model ?? 'gemma4-mm';
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const compact = compactMaster(master);
  const userText = PROMPT(master.jahr ?? null) + '\n\n--- master.json ---\n' + JSON.stringify(compact, null, 2);

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${vllmUrl.replace(/\/+$/, '')}/v1/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, max_tokens: 2500, temperature: 0, stream: false,
        messages: [{ role: 'user', content: userText }],
      }),
    });
    if (!res.ok) {
      return { ...empty, reason: `vllm ${res.status}`, ms: Date.now() - t0, llm_used: model };
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = data.choices?.[0]?.message?.content ?? '{}';
    // Tolerant JSON parse: Gemma packt manchmal Markdown ```json``` herum.
    const match = raw.match(/\{[\s\S]*\}/);
    const json = match ? match[0] : raw;
    let parsed: Partial<CrossDocAuditResult> = {};
    try { parsed = JSON.parse(json) as Partial<CrossDocAuditResult>; } catch { /* empty */ }
    return {
      ran: true,
      ms: Date.now() - t0,
      llm_used: model,
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
      year_carryover_ok: Array.isArray(parsed.year_carryover_ok) ? parsed.year_carryover_ok : [],
      year_carryover_blocked: Array.isArray(parsed.year_carryover_blocked) ? parsed.year_carryover_blocked : [],
      person_zuordnung: Array.isArray(parsed.person_zuordnung) ? parsed.person_zuordnung : [],
      missing_anlagen: Array.isArray(parsed.missing_anlagen) ? parsed.missing_anlagen : [],
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    };
  } catch (err) {
    return { ...empty, reason: (err as Error).message, ms: Date.now() - t0, llm_used: model };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}
