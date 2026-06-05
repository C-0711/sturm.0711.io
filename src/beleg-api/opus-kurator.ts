/**
 * Beleg-API — der Kurator (Opus 4.8), ELSTER-Steuerbeleg-Modus.
 *
 * Ein Anthropic-/v1/messages-Call liest genau eine Datei (PDF/Bild/Text nativ)
 * und liefert: eine originalgetreue Markdown-Transkription PLUS die strukturierte
 * Lesung als `dokumente[] → positionen[]`. Der Kurator liest nur, was im Beleg
 * steht (bezeichnung/anlage/zeile/kennzahl/wert); die ELSTER-Auflösung
 * (e_code etc.) macht danach der Katalog-Resolver gegen die SSoT.
 *
 * House rule #2: nach außen heißt das Ding "Kurator", nie der Modellname.
 */
import { BelegFehler, KuratorRoh, KuratorDokumentRoh, KuratorPositionRoh } from './typen.ts';
import { QuellInfo } from './ids.ts';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

const SYSTEM_PROMPT =
  'Du bist ein präziser Steuerbeleg-Kurator für deutsche ELSTER-Einkommensteuer. ' +
  'Du bekommst EINE Datei (Steuerbescheinigung, Lohnsteuerbescheinigung, ' +
  'Spendenquittung, VAST-Auszug, Bescheid, …). Eine Datei kann MEHRERE Dokumente ' +
  'enthalten. Liefere EIN JSON-Objekt:\n\n' +
  '{\n' +
  '  "markdown": "<vollständige, originalgetreue Markdown-Transkription des gesamten Belegs>",\n' +
  '  "warnung": <true wenn Beleg unklar/schlechte Qualität, sonst false>,\n' +
  '  "dokumente": [\n' +
  '    {\n' +
  '      "dokument_typ": "<z. B. Steuerbescheinigung, Lohnsteuerbescheinigung, Spendenquittung>",\n' +
  '      "aussteller": "<z. B. LBS Süd, Arbeitgeber, Verein>",\n' +
  '      "person": "<vollständiger Name der Person, auf die sich die Werte beziehen>",\n' +
  '      "kalenderjahr": <Steuerjahr der Werte als Zahl, z. B. 2024>,\n' +
  '      "finanzamt": "<falls genannt, sonst null>",\n' +
  '      "rolle": "<A = steuerpflichtige Person, B = Ehepartner; null wenn unklar>",\n' +
  '      "positionen": [\n' +
  '        {\n' +
  '          "bezeichnung": "<Beschriftung der Wert-Zeile, wie im Beleg gedruckt>",\n' +
  '          "anlage": "<ELSTER-Anlage, falls erkennbar, z. B. \\"Anlage KAP\\", \\"Anlage N\\", \\"Hauptvordruck\\"; sonst null>",\n' +
  '          "zeile": "<Zeilennummer, falls gedruckt, z. B. \\"Zeile 7\\"; sonst null>",\n' +
  '          "kennzahl": "<ELSTER-Kennzahl/Kennziffer, falls gedruckt, z. B. \\"210\\"; sonst null>",\n' +
  '          "wert": "<Wert im ORIGINALFORMAT, z. B. \\"36,00\\", \\"1.785,00 EUR\\", \\"15.03.2024\\">",\n' +
  '          "rolle": "<A oder B, falls die Zeile personenspezifisch ist; sonst null>"\n' +
  '        }\n' +
  '      ]\n' +
  '    }\n' +
  '  ]\n' +
  '}\n\n' +
  'Regeln:\n' +
  '- Extrahiere ALLE Wert-Zeilen (Vollständigkeit vor Auswahl).\n' +
  '- Werte NICHT umrechnen/normalisieren — exakt wie gedruckt übernehmen.\n' +
  '- anlage/zeile/kennzahl NUR setzen, wenn im Beleg gedruckt ODER eindeutig durch ' +
  'den Dokumenttyp impliziert (z. B. Kapitalerträge → "Anlage KAP"). Sonst null — ' +
  'der Katalog löst auf. Keine e_codes erfinden.\n' +
  'Antworte AUSSCHLIESSLICH mit dem JSON-Objekt, ohne Markdown-Codeblock drumherum.';

const USER_HINWEIS = 'Kuratiere den beigefügten Steuerbeleg und gib NUR das JSON-Objekt zurück.';

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

function baueContent(quelle: QuellInfo, buf: Buffer): unknown[] {
  if (quelle.art === 'pdf') {
    return [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } },
      { type: 'text', text: USER_HINWEIS },
    ];
  }
  if (quelle.art === 'bild') {
    return [
      { type: 'image', source: { type: 'base64', media_type: quelle.mimeType, data: buf.toString('base64') } },
      { type: 'text', text: USER_HINWEIS },
    ];
  }
  return [{ type: 'text', text: `${USER_HINWEIS}\n\n--- DOKUMENTINHALT ---\n${quelle.text ?? ''}` }];
}

function isoliereJson(s: string): string {
  let t = s.trim();
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  return start >= 0 && end > start ? t.slice(start, end + 1) : t;
}

function s(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
function rolle(v: unknown): 'A' | 'B' | null {
  const t = typeof v === 'string' ? v.trim().toUpperCase() : '';
  return t === 'A' || t === 'B' ? t : null;
}

function mapPosition(p: unknown): KuratorPositionRoh | null {
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  const bez = s(o.bezeichnung);
  if (!bez) return null;
  return {
    bezeichnung: bez,
    anlage: s(o.anlage),
    zeile: s(o.zeile),
    kennzahl: s(o.kennzahl),
    wert: s(o.wert),
    person: s(o.person),
    rolle: rolle(o.rolle),
  };
}

function mapDokument(d: unknown): KuratorDokumentRoh {
  const o = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>;
  const jahr = typeof o.kalenderjahr === 'number'
    ? o.kalenderjahr
    : (s(o.kalenderjahr) ? parseInt(s(o.kalenderjahr)!, 10) : null);
  return {
    dokument_typ: s(o.dokument_typ) ?? 'unbekannt',
    aussteller: s(o.aussteller),
    person: s(o.person),
    kalenderjahr: Number.isFinite(jahr as number) ? (jahr as number) : null,
    finanzamt: s(o.finanzamt),
    rolle: rolle(o.rolle) ?? undefined,
    positionen: Array.isArray(o.positionen)
      ? o.positionen.map(mapPosition).filter((x): x is KuratorPositionRoh => x !== null)
      : [],
  };
}

/** Kuratiert genau einen Beleg. Wirft `BelegFehler('kurator_fehler', …)`. */
export async function kuratiere(opts: {
  buf: Buffer;
  quelle: QuellInfo;
  apiKey: string;
  modell: string;
  signal?: AbortSignal;
}): Promise<KuratorRoh> {
  const t0 = Date.now();
  // `temperature` wird von Opus 4.8 abgelehnt → weglassen.
  const body = {
    model: opts.modell,
    max_tokens: 16384,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: baueContent(opts.quelle, opts.buf) }],
  };

  let resp: Response;
  try {
    resp = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': opts.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (e) {
    throw new BelegFehler('kurator_fehler', `Netzwerkfehler zum Kurator: ${(e as Error).message}`);
  }

  const text = await resp.text();
  if (!resp.ok) throw new BelegFehler('kurator_fehler', `Kurator ${resp.status}: ${text.slice(0, 400)}`);

  let json: AnthropicResponse;
  try { json = JSON.parse(text) as AnthropicResponse; }
  catch { throw new BelegFehler('kurator_fehler', `Kurator lieferte kein JSON: ${text.slice(0, 200)}`); }

  const content = json.content?.find((c) => c.type === 'text')?.text;
  if (!content) throw new BelegFehler('kurator_fehler', 'Kurator lieferte leeren Inhalt');

  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(isoliereJson(content)) as Record<string, unknown>; }
  catch { throw new BelegFehler('kurator_fehler', `Kurator-Antwort nicht parsebar: ${content.slice(0, 200)}`); }

  const dokumente = Array.isArray(parsed.dokumente) ? parsed.dokumente.map(mapDokument) : [];
  return {
    markdown: typeof parsed.markdown === 'string' ? parsed.markdown : '',
    dokumente,
    warnung: parsed.warnung === true,
    usage: { input: json.usage?.input_tokens, output: json.usage?.output_tokens },
    ms: Date.now() - t0,
  };
}
