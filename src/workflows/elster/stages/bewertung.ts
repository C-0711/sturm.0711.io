import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { defineStage } from '../../../core/stage.ts';
import {
  bmfPflichtFelderFuerKombi,
  bmfValidiereWert,
  istBelegt,
  leseAusPfad,
  sammleBelegteCodes,
  sammleCodesAusSchema,
  sammlePflichtfelder,
  type JsonSchemaNode,
  type Pflichtfeld,
} from '../lib/helpers.ts';

// ─── I/O-Typen ────────────────────────────────────────────────────────────

export interface BewertungInput {
  /** finalAnnotation aus baseline-merge. */
  annotation: Record<string, unknown>;
  /** JSON-Schema aus schema-bau (optional). */
  jsonSchema?: Record<string, unknown>;
  /** Absoluter Pfad zur Original-Datei — für Opus-Vision-Call. */
  filePath: string;
  /** Ursprünglicher Dateiname — für MIME-Detection. */
  filename: string;
  /** User-selektierte Anlagen, z.B. ["ESt1A", "N"]. */
  gewaehlteAnlagen: string[];
  /** Wenn true, wird der Opus-Vision-Call komplett übersprungen. */
  ohneOpus?: boolean;
  /** Claude-Model-Override; default 'claude-opus-4-7'. */
  opusModel?: string;
}

export interface OpusHinweis {
  code?: string;
  anlage?: string;
  text: string;
  schwere: 'info' | 'warnung' | 'fehler';
}

export interface KonsistenzDetail {
  code: string;
  wert: unknown;
  regel: string;
  verletzt: boolean;
}

export interface BewertungOutput {
  pflicht_belegt: { belegt: number; total: number; fehlend: string[] };
  dichte_score: number;
  konsistenz_score: number;
  opus_score?: number | null;
  opus_hinweise?: OpusHinweis[];
  gesamt_score: number;
  ergebnis: 'ok' | 'retry';
  konsistenz_details: KonsistenzDetail[];
  opus_ms?: number;
}

// ─── MIME-Lookup (Legacy server.mjs:176) ──────────────────────────────────

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

// ─── pruefeKonsistenz (Legacy server.mjs:889-916) ─────────────────────────
// Lokaler Helper — aktuell nur hier gebraucht. BMF-Regex-autoritative
// Konsistenzprüfung: traversiert annotation, findet E-Code-Blätter, validiert
// deren Werte über bmfValidiereWert.

interface KonsistenzBefund {
  regel: string;
  ok: boolean;
  details: string | null;
  /** Feld-Pfad (inkl. Anlagen-Segment), hilfreich für UI/Debug. */
  pfad: string;
  /** E-Code am Blatt. */
  code: string;
  /** Rohwert. */
  wert: unknown;
}

function pruefeKonsistenz(annotation: Record<string, unknown>): KonsistenzBefund[] {
  const befunde: KonsistenzBefund[] = [];
  const flat: Array<[string, unknown]> = [];

  const walk = (o: unknown, p: string[]): void => {
    if (o === null || o === undefined) return;
    if (typeof o !== 'object') {
      flat.push([p.join('.'), o]);
      return;
    }
    if (Array.isArray(o)) {
      o.forEach((x, i) => walk(x, [...p, String(i)]));
      return;
    }
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      walk(v, [...p, k]);
    }
  };
  walk(annotation, []);

  for (const [pfad, wert] of flat) {
    if (wert === '' || wert === null || wert === undefined) continue;
    const teile = pfad.split('.');
    const letztes = teile[teile.length - 1] || '';
    if (!/^E\d{7}$/.test(letztes)) continue;

    // Anlage aus erstem Pfadsegment raten (bei Wrapper-Schemas z.B. "ESt1A")
    const anlageKandidat = teile[0] && /^[A-Za-z_0-9]+$/.test(teile[0]) ? teile[0] : undefined;
    const check = bmfValidiereWert(letztes, String(wert), anlageKandidat);
    if (!check) continue;
    befunde.push({
      regel: `BMF ${pfad} (${check.format})`,
      ok: check.ok,
      details: check.details,
      pfad,
      code: letztes,
      wert,
    });
  }
  return befunde;
}

// ─── opusEvaluierung (Legacy server.mjs:919-1023) ─────────────────────────
// Claude-Opus-Vision-Call: lädt Datei als base64, baut system+user-Prompt,
// erwartet strict-JSON-Antwort mit opus_score + hinweise.

interface OpusLegacyHinweis {
  elster_code: string;
  feld_pfad: string;
  problem: string;
  anweisung: string;
}

interface OpusErgebnis {
  score: number;
  begruendung: string;
  hinweise: OpusLegacyHinweis[];
  ms: number;
}

async function opusEvaluierung(
  filePath: string,
  filename: string,
  annotation: Record<string, unknown>,
  fehlendePflicht: Pflichtfeld[],
  model: string,
  signal: AbortSignal,
): Promise<OpusErgebnis> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Legacy: wirft NICHT, gibt neutral-Score zurück. Wir bleiben kompatibel.
    return { score: 0.5, begruendung: 'ANTHROPIC_API_KEY fehlt', hinweise: [], ms: 0 };
  }

  const buf = await fs.readFile(filePath);
  const ext = path.extname(filename || filePath).toLowerCase();
  const mime = MIME[ext] ?? 'application/pdf';
  const b64 = buf.toString('base64');

  const system = `Du bist Qualitaets-Pruefer fuer Mistral-OCR-Extraktionen aus deutschen
Steuerdokumenten. Du siehst das Originaldokument (Bild oder PDF) und die Annotation.
Deine Aufgabe:
  1. Pruefe jeden Wert in der Annotation gegen das Dokument.
  2. Identifiziere uebersehene Felder (Liste "fehlende Pflichtfelder" beruecksichtigen).
  3. Erkenne Halluzinationen (Felder die im Dokument nicht stehen).
  4. Gib KONKRETE Prompt-Hinweise fuer den naechsten Mistral-Lauf. Jeder Hinweis
     wird als 'description'-Ergaenzung an ein Schema-Feld angehaengt.

PFLICHT-REGELN fuer Hinweise:
  - Jeder Hinweis betrifft GENAU EIN Feld. Betrifft ein Problem mehrere Felder
    (z.B. IBAN + BIC + Kontoinhaber), gib mehrere Hinweise aus.
  - Jeder Hinweis MUSS "elster_code" als genau 8 Zeichen im Format E+7-Ziffern
    enthalten (z.B. "E0100402"). Kein Hinweis ohne elster_code.
  - "feld_pfad" = vollstaendiger JSON-Pfad inklusive des E-Codes am Ende
    (z.B. "ESt1A.Allg.A.E0100402"). Keine abstrakten Gruppennamen ohne E-Code.

ANTWORTE NUR MIT EINEM JSON-OBJEKT (keine Code-Fences, kein Fliesstext):
{
  "opus_score": 0..1,
  "begruendung": "<1-3 Saetze>",
  "hinweise": [
    {"elster_code": "E0200201", "feld_pfad": "N.E0200201", "problem": "<kurz>", "anweisung": "<konkreter Hinweis>"}
  ]
}
Max 8 Hinweise. Leere Liste wenn alles passt.`;

  const annoKurz = JSON.stringify(annotation).slice(0, 10000);
  const fehlendKurz = (fehlendePflicht || []).slice(0, 20).map(f => `- ${f.pfad}`).join('\n');

  type ContentBlock =
    | { type: 'document'; source: { type: 'base64'; media_type: string; data: string } }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
    | { type: 'text'; text: string };

  const content: ContentBlock[] = [];
  if (mime === 'application/pdf') {
    content.push({ type: 'document', source: { type: 'base64', media_type: mime, data: b64 } });
  } else {
    content.push({ type: 'image', source: { type: 'base64', media_type: mime, data: b64 } });
  }
  content.push({
    type: 'text',
    text:
      `Dokument: ${filename || path.basename(filePath)}\n\n` +
      `Mistral-Annotation (JSON, gekuerzt):\n\`\`\`json\n${annoKurz}\n\`\`\`\n\n` +
      (fehlendKurz ? `Pflichtfelder die Mistral NICHT belegt hat:\n${fehlendKurz}\n\n` : '') +
      `Emittiere dein JSON-Urteil.`,
  });

  const t0 = Date.now();
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || 'claude-opus-4-7',
      max_tokens: 1500,
      system,
      messages: [{ role: 'user', content }],
    }),
    signal,
  });
  const ms = Date.now() - t0;

  if (!resp.ok) {
    const t = await resp.text();
    return { score: 0.5, begruendung: `Opus HTTP ${resp.status}: ${t.slice(0, 200)}`, hinweise: [], ms };
  }
  const j = (await resp.json()) as { content?: Array<{ text?: string }> };
  const text = (j.content || []).map(c => c.text || '').join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { score: 0.5, begruendung: 'Opus ohne JSON', hinweise: [], ms };

  let parsed: {
    opus_score?: unknown;
    begruendung?: unknown;
    hinweise?: unknown;
  };
  try {
    parsed = JSON.parse(m[0]);
  } catch {
    return { score: 0.5, begruendung: 'Opus JSON invalid', hinweise: [], ms };
  }

  const score = typeof parsed.opus_score === 'number'
    ? Math.max(0, Math.min(1, parsed.opus_score))
    : 0.5;

  const hinweise: OpusLegacyHinweis[] = Array.isArray(parsed.hinweise)
    ? parsed.hinweise.slice(0, 8).map((h: Record<string, unknown>) => {
        const pfad = String(h.feld_pfad || '');
        // elster_code: zuerst explizites Feld, sonst Fallback: letztes E+7-Stück aus dem Pfad.
        let code = String(h.elster_code || '').trim();
        if (!/^E\d{7}$/.test(code)) {
          const mm = pfad.match(/E\d{7}/g);
          code = mm ? mm[mm.length - 1] : '';
        }
        return {
          elster_code: code,
          feld_pfad: pfad,
          problem: String(h.problem || '').slice(0, 200),
          anweisung: String(h.anweisung || '').slice(0, 400),
        };
      }).filter(h => h.anweisung && h.elster_code)
    : [];

  return { score, begruendung: String(parsed.begruendung || '').slice(0, 600), hinweise, ms };
}

// ─── Adapter: Legacy-Hinweis → Output-Shape ───────────────────────────────

function extrahiereAnlageAusPfad(pfad: string): string | undefined {
  const teile = pfad.split('.').filter(Boolean);
  return teile[0] && /^[A-Za-z_0-9]+$/.test(teile[0]) ? teile[0] : undefined;
}

function toOutputHinweis(h: OpusLegacyHinweis): OpusHinweis {
  return {
    code: h.elster_code || undefined,
    anlage: extrahiereAnlageAusPfad(h.feld_pfad),
    text: h.anweisung || h.problem,
    // Legacy liefert keine Schwere; wir defaulten auf 'warnung' (Retry-Signal aus Opus).
    schwere: 'warnung',
  };
}

// ─── Stage-Run (Legacy server.mjs:2005-2067) ──────────────────────────────

export const bewertungStage = defineStage<BewertungInput, BewertungOutput>({
  id: 'elster-bewertung',
  name: 'Bewertung',
  description: 'Pflichtfelder, Dichte, Konsistenz und Opus-Vision',

  async run(input, ctx) {
    if (!input?.annotation) throw new Error('bewertung: annotation fehlt');
    if (!input?.gewaehlteAnlagen) throw new Error('bewertung: gewaehlteAnlagen fehlt');

    const schema = (input.jsonSchema ?? null) as JsonSchemaNode | null;
    const ohneOpus = Boolean(input.ohneOpus);

    // 1. Schema-Pflichtfelder (falls Schema gegeben)
    const pflichtfelder = sammlePflichtfelder(schema);
    const belegt: Pflichtfeld[] = [];
    const fehlend: Pflichtfeld[] = [];
    for (const pf of pflichtfelder) {
      (istBelegt(leseAusPfad(input.annotation, pf.pfad)) ? belegt : fehlend).push(pf);
    }

    // 2. BMF-Pflicht (offizielle Jahresdokumentation via Kombi der Anlagen)
    const bmfPflicht = bmfPflichtFelderFuerKombi(input.gewaehlteAnlagen || []);
    const belegteCodes = sammleBelegteCodes(input.annotation);
    const bmfBelegt = bmfPflicht.filter(f => belegteCodes.has(String(f.name ?? '')));
    const bmfFehlend = bmfPflicht.filter(f => !belegteCodes.has(String(f.name ?? '')));
    const bmf_quote = bmfPflicht.length > 0 ? bmfBelegt.length / bmfPflicht.length : 1;
    ctx.emit('bewertung_bmf', { belegt: bmfBelegt.length, gesamt: bmfPflicht.length, quote: bmf_quote });

    // 3. Dichte — wieviel vom Schema hat Mistral belegt
    const schemaCodes = sammleCodesAusSchema(schema);
    const dichte_belegt = [...schemaCodes].filter(c => belegteCodes.has(c)).length;
    const dichte_score = schemaCodes.size > 0 ? dichte_belegt / schemaCodes.size : 0;
    ctx.emit('bewertung_dichte', { belegt: dichte_belegt, gesamt: schemaCodes.size, score: dichte_score });

    // 4. Konsistenz (BMF-Regex-autoritativ)
    const konsistenz = pruefeKonsistenz(input.annotation);
    const konsistenz_bestanden = konsistenz.filter(k => k.ok).length;
    const konsistenz_score = konsistenz.length > 0 ? konsistenz_bestanden / konsistenz.length : 1;
    ctx.emit('bewertung_konsistenz', {
      bestanden: konsistenz_bestanden,
      gesamt: konsistenz.length,
      score: konsistenz_score,
    });

    // 5. Opus-Vision (optional)
    let opus: OpusErgebnis | null = null;
    if (!ohneOpus) {
      if (!input.filePath) throw new Error('bewertung: filePath für Opus-Call erforderlich (oder ohneOpus=true)');
      ctx.emit('bewertung_opus_start', {});
      opus = await opusEvaluierung(
        input.filePath,
        input.filename,
        input.annotation,
        fehlend,
        input.opusModel ?? 'claude-opus-4-7',
        ctx.signal,
      );
      ctx.emit('bewertung_opus_done', {
        score: opus.score,
        hinweise_count: opus.hinweise.length,
        hinweise: opus.hinweise,
        begruendung: opus.begruendung,
        ms: opus.ms,
      });
    }

    // 6. Gewichteter Gesamt-Score (identisch zu Legacy)
    const gesamt = opus
      ? 0.25 * bmf_quote + 0.15 * dichte_score + 0.10 * konsistenz_score + 0.50 * opus.score
      : 0.40 * bmf_quote + 0.30 * dichte_score + 0.30 * konsistenz_score;

    // Threshold ~0.8 → ok, sonst retry
    const ergebnis: 'ok' | 'retry' = gesamt >= 0.8 ? 'ok' : 'retry';

    // Fehlend-Pfade als String-Liste (Output-Shape erwartet string[])
    const fehlendPfade = fehlend.map(f => f.pfad).slice(0, 50);
    const bmfFehlendPfade = bmfFehlend.map(f => String(f.name ?? '')).slice(0, 30);
    const alleFehlend = [...fehlendPfade, ...bmfFehlendPfade];

    // konsistenz_details (Output-Shape)
    const konsistenz_details: KonsistenzDetail[] = konsistenz.map(k => ({
      code: k.code,
      wert: k.wert,
      regel: k.regel,
      verletzt: !k.ok,
    }));

    const output: BewertungOutput = {
      pflicht_belegt: {
        belegt: belegt.length,
        total: pflichtfelder.length,
        fehlend: alleFehlend,
      },
      dichte_score,
      konsistenz_score,
      opus_score: opus ? opus.score : null,
      opus_hinweise: opus ? opus.hinweise.map(toOutputHinweis) : [],
      gesamt_score: gesamt,
      ergebnis,
      konsistenz_details,
      opus_ms: opus ? opus.ms : 0,
    };

    ctx.emit('bewertung_score', { score: gesamt, ergebnis });

    return output;
  },
});
