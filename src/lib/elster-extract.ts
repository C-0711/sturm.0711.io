/**
 * STURM Pass 2 — strukturierte ELSTER-Extraktion mit Mistral.
 *
 * Architektur (Hand in Hand mit Pass 1 / classify.ts):
 *   Pass 1 liefert {label, summary, kpis, recommendedAnlagen}
 *   Pass 2 baut für jede recommended Anlage ein JSON-Schema aus dem
 *   Feldkatalog workflows/elster/data/<vz>/felder/<anlage>.json und ruft
 *   Mistral pro Anlage auf. Mistral liefert {<elster_code>: <wert>, ...}
 *   wobei <elster_code> einer der ELSTER-Codes des Feldkatalogs ist.
 *
 * Werte bleiben Strings (Originalformat aus dem Dokument). Coercion auf
 * value_type (DEZIMAL_2NK, DATUM, etc.) macht der Konsument (cb-ctax via
 * Lane 5 / Smart-Schema-Service).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHAT_URL = 'https://api.mistral.ai/v1/chat/completions';
const MODEL = 'mistral-small-latest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// src/lib → ../workflows/elster/data
const FELDER_ROOT = path.resolve(__dirname, '..', 'workflows', 'elster', 'data');

export interface ExtractedValue {
  elster_code: string;
  value: string;
  anlage: string;
  drucktext?: string;
  vordruckzeile?: string;
}

export interface ElsterExtractResult {
  vz: number;
  values: ExtractedValue[];
  perAnlage: Array<{
    anlage: string;
    fieldsInSchema: number;
    valuesReturned: number;
    ms: number;
    tokens?: number;
    error?: string;
  }>;
  totalMs: number;
}

interface FelderJson {
  name: string;
  felder: Array<{
    Name?: string;
    Beschreibung?: string;
    Drucktext?: string;
    Vordruckzeile?: string;
    Format?: string;
    Pflichtfeld?: string;
    Indexfeld?: string;
    InternesERiCFeld?: string;
    Kontext?: string;
  }>;
}

interface SchemaProperty {
  type: 'string';
  description: string;
}

interface MistralChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { total_tokens?: number };
}

/**
 * Dekodiert HTML-Entities die im ELSTER-Feldkatalog auftauchen
 * (`&#10;` = Newline, `&amp;`, `&quot;`, `&lt;`, `&gt;`). Newlines
 * werden zu " — " konvertiert damit der Drucktext einzeilig bleibt.
 *
 * Siehe Bug B18: ohne diesen Fix steht "&#10;" wortwörtlich in der UI.
 */
function dekodiereHtmlEntities(s: string | null | undefined): string {
  if (!s) return '';
  return String(s)
    .replace(/&#10;|&#xa;|&#xA;/g, ' — ')
    .replace(/&#9;|&#x9;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/**
 * Lädt die Feldliste einer Anlage und filtert irrelevante Felder weg
 * (Indexfelder, interne ERiC-Felder, Felder ohne ELSTER-Code).
 */
// VZ_2023_FALLBACK — fuer 2023 fehlen die ELSTER-Kataloge auf der Disk.
// Wir nutzen den 2024-Katalog als Naeherung (BMF-Felder aendern sich Jahr
// fuer Jahr nur marginal). Fuer andere Jahre keine Fallback-Logik.
const VZ_2023_FALLBACK = 2024;

async function ladeFelder(vz: number, anlage: string): Promise<FelderJson['felder']> {
  const primaryFile = path.join(FELDER_ROOT, String(vz), 'felder', `${anlage}.json`);
  let raw: string;
  try {
    raw = await fs.readFile(primaryFile, 'utf-8');
  } catch (e: any) {
    if (e?.code === 'ENOENT' && vz === 2023) {
      const fallbackFile = path.join(FELDER_ROOT, String(VZ_2023_FALLBACK), 'felder', `${anlage}.json`);
      raw = await fs.readFile(fallbackFile, 'utf-8');
      console.log(`[elster-extract] VZ-2023-Fallback fuer ${anlage}: nutze 2024-Schema`);
    } else {
      throw e;
    }
  }
  const data = JSON.parse(raw) as FelderJson;
  const basis = data.felder.filter((f) => {
    if (!f.Name || !/^E\d{6,7}$/.test(f.Name)) return false;
    if (f.InternesERiCFeld === 'Ja') return false;
    if (f.Indexfeld === 'Ja') return false;
    return true;
  });

  // B19-Fix: ELSTER-Katalog hat fuer fast jede Geld-Position zwei Codes —
  //   xxx-1: GeldBetragOhneCent ODER "ohne Vorzeichen" (legacy)
  //   xxx-4: GeldBetragMitCent + Minusvorzeichen erlaubt (modern)
  // Beide haben (fast) identischen Drucktext + dieselbe Vordruckzeile.
  // Mistral fuellt beide aus dem Document, was zu doppelten Zeilen im
  // Fall-Arbeitstisch fuehrt. Wir behalten pro (Vordruckzeile, Drucktext-
  // Stamm) nur den modernsten Code (= hoechster eCode-Suffix).
  type F = FelderJson['felder'][number];
  const gruppen = new Map<string, F[]>();
  for (const f of basis) {
    const vzKey = (f.Vordruckzeile ?? '').trim();
    if (!vzKey) {
      // Felder ohne Vordruckzeile: einzeln durchlassen.
      gruppen.set(`__solo__${f.Name}`, [f]);
      continue;
    }
    const drucktextKey = (f.Drucktext ?? f.Beschreibung ?? '')
      .replace(/&#10;|\s+/g, ' ')
      .toLowerCase()
      .slice(0, 40);
    const k = `${vzKey}::${drucktextKey}`;
    const arr = gruppen.get(k);
    if (arr) arr.push(f); else gruppen.set(k, [f]);
  }

  const gefiltert: F[] = [];
  for (const arr of gruppen.values()) {
    if (arr.length === 1) {
      gefiltert.push(arr[0]);
      continue;
    }
    // Praeferenz: GeldBetragMitCent + "Minusvorzeichen erlaubt" gewinnt.
    // Tie-Break: hoechster ELSTER-Code (typisch der modernere).
    const ranking = (f: F): number => {
      const fmt = (f.Format ?? '').toLowerCase();
      let r = 0;
      if (fmt.includes('mitcent')) r += 2;
      if (fmt.includes('minusvorzeichen erlaubt')) r += 1;
      return r;
    };
    arr.sort((a, b) => {
      const dr = ranking(b) - ranking(a);
      if (dr !== 0) return dr;
      return (b.Name ?? '').localeCompare(a.Name ?? '');
    });
    gefiltert.push(arr[0]);
  }
  return gefiltert;
}

/**
 * Baut aus Feldkatalog ein JSON-Schema für Mistral. Alle Properties sind
 * optional (Mistral füllt nur, was es findet). Werte bleiben strings; die
 * Description trägt Drucktext + Format-Hint, damit Mistral den semantischen
 * Kontext versteht.
 */
function baueSchemaFuerAnlage(felder: FelderJson['felder']): {
  schema: { type: 'object'; properties: Record<string, SchemaProperty>; additionalProperties: false };
  fieldCount: number;
} {
  const properties: Record<string, SchemaProperty> = {};

  for (const f of felder) {
    if (!f.Name) continue;
    const drucktext = dekodiereHtmlEntities(f.Drucktext || f.Beschreibung || f.Name);
    const zeile = f.Vordruckzeile ? ` | Vordruckzeile ${f.Vordruckzeile}` : '';
    const format = f.Format ? ` | Format: ${f.Format.split('\n')[0].slice(0, 80)}` : '';
    const kontext = f.Kontext ? ` | Kontext: ${f.Kontext}` : '';
    properties[f.Name] = {
      type: 'string',
      description: `${drucktext}${zeile}${format}${kontext}`.slice(0, 380),
    };
  }

  return {
    schema: {
      type: 'object',
      properties,
      additionalProperties: false,
    },
    fieldCount: Object.keys(properties).length,
  };
}

const ANLAGE_KONTEXT_HINWEISE: Record<string, string> = {
  KAP:
    `Spezialfall Anlage KAP (Kapitalerträge):\n` +
    `Bei Steuerbescheinigung / VAST-Beleg / Kontoauszug einer Bank gilt:\n` +
    `- "Kapitalerträge gesamt" / "Bruttobetrag der Kapitalerträge" → E1900701\n` +
    `- "Anrechenbare Kapitalertragsteuer" → E1904701\n` +
    `- "Solidaritätszuschlag" → E1904901\n` +
    `- "Kirchensteuer" (auf KapErtSt) → E1904801\n` +
    `- "In Anspruch genommener Sparer-Pauschbetrag" → E1901401\n` +
    `Mehrere Bankbescheinigungen im selben Dokument: nimm pro ELSTER-Code\n` +
    `den Bank-Eintrag mit dem grössten Betrag (oder den ersten wenn gleich).\n`,
  N:
    `Spezialfall Anlage N (Lohnsteuerbescheinigung):\n` +
    `- "Bruttoarbeitslohn" → E0200204 (mit Cent-Format)\n` +
    `- "Einbehaltene Lohnsteuer" → E0200304\n` +
    `- "Solidaritätszuschlag" → E0200404\n` +
    `- "Kirchensteuer Arbeitnehmer" → E0200504\n` +
    `- "Kirchensteuer Ehegatte" (nur bei Konfessionsverschiedenheit) → E0200604\n` +
    `- "Steuerklasse" → E0200002\n`,
  Vorsorgeaufwendungen:
    `Spezialfall Anlage Vorsorgeaufwendungen (aus Lohnsteuerbescheinigung):\n` +
    `- "Arbeitnehmeranteil Rentenversicherung" → E2000401\n` +
    `- "Arbeitnehmerbeitraege Krankenversicherung" → E2001203\n` +
    `- "Arbeitnehmerbeitraege Pflegeversicherung" → E2001505\n` +
    `- "Arbeitnehmerbeitraege Arbeitslosenversicherung" → E2004403\n`,
};

const PROMPT_TEMPLATE = (anlage: string, fieldCount: number) => {
  const kontext = ANLAGE_KONTEXT_HINWEISE[anlage] ?? '';
  return (
    `Extrahiere aus dem Dokument die ELSTER-Werte für Anlage "${anlage}" (${fieldCount} mögliche Felder im Schema).\n` +
    `Regeln:\n` +
    `- Gib NUR Werte zurück die im Dokument klar belegt sind. Werte erfinden ist verboten.\n` +
    `- Schlüssel im Output ist der ELSTER-Code (z.B. "E0200204"), Wert ist die exakte Zeichenkette aus dem Dokument im Originalformat.\n` +
    `- Geldbeträge: Originalformat des Dokuments (z.B. "12345,67" oder "12.345,67"). NICHT umrechnen.\n` +
    `- Datumswerte: Originalformat (z.B. "31.12.2024" oder "2024-12-31"). NICHT konvertieren.\n` +
    `- Felder die im Dokument fehlen: WEGLASSEN (nicht null, nicht leerer String, nicht 0).\n` +
    `- Bei Personen-Index (Person A / Person B): Felder pro Person nur einmal — wenn das Feld doppelt vorkommt, wähle den Stpfl A-Wert.\n` +
    `${kontext ? '\n' + kontext + '\n' : ''}` +
    `Gib ein JSON-Objekt zurück: { "<elster_code>": "<wert>", ... }. Keine Erklärungen.`
  );
};

/**
 * Ruft Mistral für genau eine Anlage auf. Wird parallel pro Anlage aufgerufen
 * vom dispatcher unten.
 */
async function extrahiereEineAnlage(opts: {
  vz: number;
  anlage: string;
  documentUrl?: string;
  markdown?: string;
  apiKey: string;
  signal?: AbortSignal;
  baseUrl?: string;
}): Promise<{
  anlage: string;
  values: ExtractedValue[];
  fieldsInSchema: number;
  ms: number;
  tokens?: number;
  raw: { request: unknown; response: unknown };
}> {
  const t0 = Date.now();
  const felder = await ladeFelder(opts.vz, opts.anlage);
  if (felder.length === 0) {
    return {
      anlage: opts.anlage,
      values: [],
      fieldsInSchema: 0,
      ms: Date.now() - t0,
      raw: { request: { skipped: 'no fields' }, response: null },
    };
  }

  const { schema, fieldCount } = baueSchemaFuerAnlage(felder);
  const prompt = PROMPT_TEMPLATE(opts.anlage, fieldCount);

  // Drucktext-Lookup für die Rueckanreicherung
  const druckMap = new Map<string, { drucktext: string; vordruckzeile: string }>();
  for (const f of felder) {
    if (f.Name) druckMap.set(f.Name, {
      drucktext: dekodiereHtmlEntities(f.Drucktext || f.Beschreibung || f.Name),
      vordruckzeile: f.Vordruckzeile || '',
    });
  }

  let userContent: any[];
  if (opts.markdown !== undefined) {
    userContent = [
      { type: 'text', text: prompt },
      { type: 'text', text: '\n\n--- Document Markdown (Mistral OCR pre-extract) ---\n' + opts.markdown },
    ];
  } else if (opts.documentUrl) {
    userContent = [
      { type: 'text', text: prompt },
      { type: 'document_url', document_url: opts.documentUrl },
    ];
  } else {
    throw new Error('extrahiereEineAnlage: either markdown or documentUrl required');
  }

  const body = {
    model: MODEL,
    stream: false,
    temperature: 0,
    messages: [
      { role: 'user', content: userContent },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: `elster_${opts.anlage.toLowerCase()}_${opts.vz}`,
        schema,
        strict: false,
      },
    },
  };

  const url = opts.baseUrl ?? CHAT_URL;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`mistral elster-extract ${opts.anlage} ${resp.status}: ${text.slice(0, 500)}`);
  }

  const json = JSON.parse(text) as MistralChatResponse;
  const content = json.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    throw new Error(`mistral elster-extract ${opts.anlage}: empty content`);
  }
  let parsed: Record<string, string>;
  try { parsed = JSON.parse(content); }
  catch { throw new Error(`mistral elster-extract ${opts.anlage}: non-JSON content: ${content.slice(0, 300)}`); }

  const values: ExtractedValue[] = [];
  for (const [code, raw] of Object.entries(parsed)) {
    if (raw == null || raw === '') continue;
    const meta = druckMap.get(code);
    values.push({
      elster_code: code,
      value: String(raw),
      anlage: opts.anlage,
      drucktext: meta?.drucktext,
      vordruckzeile: meta?.vordruckzeile || undefined,
    });
  }

  return {
    anlage: opts.anlage,
    values,
    fieldsInSchema: fieldCount,
    ms: Date.now() - t0,
    tokens: json.usage?.total_tokens,
    raw: { request: { model: MODEL, prompt, documentUrl: opts.documentUrl, markdownLen: opts.markdown ? opts.markdown.length : 0, schemaFieldCount: fieldCount }, response: json },
  };
}

/**
 * Pass 2 Hauptaufruf. Extrahiert über alle übergebenen Anlagen (parallel)
 * und liefert eine flache Werteliste.
 */
export async function extractElsterValues(opts: {
  vz: number;
  anlagen: string[];
  documentUrl?: string;
  markdown?: string;
  apiKey: string;
  signal?: AbortSignal;
  baseUrl?: string;
  /** Pro-Anlage Status-Callback. Wird vom Caller (workspaces.ts) zum
   *  SSE-Streaming an den Browser benutzt. */
  onAnlageDone?: (info: {
    anlage: string;
    valuesReturned: number;
    fieldsInSchema: number;
    ms: number;
    error?: string;
  }) => void;
}): Promise<ElsterExtractResult> {
  const t0 = Date.now();
  const perAnlage: ElsterExtractResult['perAnlage'] = [];
  const allValues: ExtractedValue[] = [];

  const results = await Promise.allSettled(
    opts.anlagen.map(async (anlage) => {
      try {
        const r = await extrahiereEineAnlage({
          vz: opts.vz,
          anlage,
          documentUrl: opts.documentUrl,
          markdown: opts.markdown,
          apiKey: opts.apiKey,
          signal: opts.signal,
          baseUrl: opts.baseUrl,
        });
        return { ok: true as const, ...r };
      } catch (e) {
        const err = e as Error;
        return { ok: false as const, anlage, error: err.message ?? String(err), ms: 0, fieldsInSchema: 0, values: [] as ExtractedValue[] };
      }
    }),
  );

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const v = r.value;
    if (v.ok) {
      perAnlage.push({
        anlage: v.anlage,
        fieldsInSchema: v.fieldsInSchema,
        valuesReturned: v.values.length,
        ms: v.ms,
        tokens: v.tokens,
      });
      allValues.push(...v.values);
      opts.onAnlageDone?.({
        anlage: v.anlage,
        valuesReturned: v.values.length,
        fieldsInSchema: v.fieldsInSchema,
        ms: v.ms,
      });
    } else {
      perAnlage.push({
        anlage: v.anlage,
        fieldsInSchema: 0,
        valuesReturned: 0,
        ms: 0,
        error: v.error,
      });
      opts.onAnlageDone?.({
        anlage: v.anlage,
        valuesReturned: 0,
        fieldsInSchema: 0,
        ms: 0,
        error: v.error,
      });
    }
  }

  return {
    vz: opts.vz,
    values: allValues,
    perAnlage,
    totalMs: Date.now() - t0,
  };
}
