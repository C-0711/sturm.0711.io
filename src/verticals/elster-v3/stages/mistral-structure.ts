/**
 * Mistral-Structure — semantischer Pre-Processor fuer Steuerbelege.
 *
 * Nimmt rohes Mistral-OCR-Markdown, ruft Mistral Small mit dem
 * Structure-Prompt v2 (anti-fence + anti-hallucination) auf, gibt zurueck:
 *   - das volle HTML (string) — als Input fuer polar-coder
 *   - parsed Sections [{id, role, block?, person?, fields[]}]
 *
 * Empirische Smoke-Belege gegen Debeka Layout A (8/8 Score):
 *   - 8 saubere semantische Sections
 *   - alle Werte lossless (1.781,98 / 772,68 / 2.238,60 / IdNr / Geburtsdatum)
 *   - korrekte type-Tags (currency / date / idnr / text / enum / datetime)
 *   - keine Halluzinationen
 *   - Wall-Clock ~6 s, 3046 input + 1541 output tokens, ~€0.0012 pro Beleg
 */

import { defineStage } from '../../../core/stage.ts';

const MISTRAL_API_URL = 'https://api.mistral.ai/v1/chat/completions';
const MISTRAL_MODEL = 'mistral-small-latest';

const STRUCTURE_SYSTEM_PROMPT = `Du strukturierst deutsche Steuerbelege.

REGELN:
1. NICHTS erfinden, NICHTS verändern - nur den OCR-Inhalt semantisch markieren.
2. Jeder Wert aus dem OCR muss im Output vorkommen (lossless).
3. Antworte NUR mit HTML, keine Erklärung, kein Fließtext drumherum.

STRUKTUR:
<section role="header">     Dokumenttitel, Transferticket, Aussteller-Header
<section role="stammdaten">  Personendaten
<section role="datensatz" block="N">  Wiederholende Datensätze (Beitragsdaten 1, 2, ...)
<section role="footer">     Disclaimer, Adressen, Hinweise

PRO FELD:
<field key="snake_case_name" type="currency|date|idnr|steuernummer|text|enum|integer|datetime">VALUE</field>

ZEILENHINTS in Klammern ("Zeile 23 bzw. 26") als <note role="zeilenhint">...</note>.

CRITICAL:
- Output STARTS with <section, KEIN \`\`\`html-Wrapper.
- <note role="zeilenhint"> NUR wenn im OCR exakt der String "(Zeile " vorkommt.
  KEINE OCR-Markdown-Zeilennummern erfinden ("Zeile 1-5" o.aehnliches).

LOSSLESS - KEINE FORMAT-KONVERSION:
Der Wert im <field> ist EXAKT der String aus dem OCR. Kein Re-Format, keine Normalisierung.
  ✓ <field key="geburtsdatum" type="date">24.11.1935</field>     (Original: "24.11.1935")
  ✗ <field key="geburtsdatum" type="date">1935-11-24</field>     (FALSCH: ISO-Konversion verboten)

  ✓ <field key="betrag" type="currency">1.781,98</field>         (Original: "1.781,98")
  ✗ <field key="betrag" type="currency">1781.98</field>          (FALSCH: Komma → Punkt verboten)

  ✓ <field key="datum" type="text">Januar 2025</field>           (Original: "Januar 2025")
  ✗ <field key="datum" type="date">2025-01-01</field>            (FALSCH: Monatsnamen-Konversion)

TYPE-DISAMBIG:
- "idnr": EXAKT 11 Ziffern (z.B. "57 438 590 613" oder "57438590613") - die persönliche Steuer-IdNr.
- "steuernummer": Format XX/XXX/XXXXX (z.B. "01/234/56789") - die Verwaltungs-Steuernummer.
  ⚠ "57438590613" ist KEINE Steuernummer (kein Slash-Format), sondern eine IdNr → type="idnr".
- "currency": Geldbetrag mit Komma-Dezimal "1.781,98" oder ohne Cent "1781".
- "date": Datum in DD.MM.YYYY oder MM.YYYY Format.
- "datetime": Datum + Uhrzeit "31.01.2025 15:51:28".
- "text": Alles andere - Freitext, Monatsnamen, Adressen, Beschreibungen.

ABSOLUTE REGEL:
Falls Du unsicher bist welcher Type zu einem Wert passt: nimm "text".
Lieber type=text als falscher Type-Tag. Werte bleiben IMMER lossless.`;

export interface ParsedField {
  key: string;
  type: string;
  value: string;
}

export interface ParsedSection {
  id: string;                          // s1, s2, … (positional)
  role: string;                        // header | stammdaten | datensatz | meta | footer | ...
  block?: string;                      // bei datensatz: "1", "2", …
  person?: string;                     // bei stammdaten: "versicherungsnehmer" | …
  fields: ParsedField[];
  notes: { role: string; text: string }[];
  raw_html: string;                    // das Original-<section>…</section>-Fragment
}

export interface MistralStructureInput {
  ocrText: string;
  apiKeyEnv?: string;                  // default 'MISTRAL_API_KEY'
  timeoutMs?: number;                  // default 60_000
}

export interface MistralStructureOutput {
  html: string;
  sections: ParsedSection[];
  stats: {
    wallClockMs: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    model: string;
    sectionCount: number;
    fieldCount: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────
// HTML-Parser (regex-basiert, ausreichend fuer kontrollierten Mistral-Output)
// ─────────────────────────────────────────────────────────────────────────

function parseAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /(\w+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

function parseHtml(html: string): ParsedSection[] {
  const sections: ParsedSection[] = [];
  // Toplevel <section role="...">…</section> finden — NICHT verschachtelte.
  // Wir akzeptieren auch nested <section> innerhalb stammdaten (Person-Subsection),
  // packen die aber zusammen mit ihrem Parent in ein ParsedSection-Objekt mit
  // person=… Attribut, damit die Polar-Section-Granularitaet stimmt.
  // Strategie: greedy top-level <section>…</section> mit Tiefenzaehler.

  let pos = 0;
  let secIdx = 0;
  while (pos < html.length) {
    const startMatch = html.slice(pos).match(/<section\b([^>]*)>/);
    if (!startMatch || startMatch.index === undefined) break;
    const tagOpen = startMatch[0];
    const attrsStr = startMatch[1];
    const startAt = pos + startMatch.index;

    // Tiefenzaehler bis zum matching </section>
    let depth = 1;
    let cursor = startAt + tagOpen.length;
    const tagRe = /<\/?section\b[^>]*>/g;
    tagRe.lastIndex = cursor;
    while (depth > 0) {
      const t = tagRe.exec(html);
      if (!t) break;
      if (t[0].startsWith('</')) depth--;
      else depth++;
      cursor = t.index + t[0].length;
    }
    const endAt = cursor;
    const block = html.slice(startAt, endAt);
    pos = endAt;

    // Wenn diese Section nested-stammdaten ist, parse sub-sections separat
    const attrs = parseAttributes(tagOpen);
    const role = attrs.role ?? 'unknown';

    // Falls die Section nested <section>-Children hat, splitten wir auf jeden
    // direkten Child auf (Polar bekommt feinkoernige Granularitaet).
    const innerContent = block
      .replace(/^<section\b[^>]*>/, '')
      .replace(/<\/section>$/, '');
    const innerSectionRe = /<section\b([^>]*)>([\s\S]*?)<\/section>/g;
    const nested: { tag: string; attrs: Record<string,string>; body: string }[] = [];
    let im: RegExpExecArray | null;
    while ((im = innerSectionRe.exec(innerContent)) !== null) {
      nested.push({ tag: im[0], attrs: parseAttributes(im[1]), body: im[2] });
    }

    if (nested.length === 0) {
      sections.push(buildParsedSection(`s${++secIdx}`, role, attrs, innerContent, block));
    } else {
      // Stamm-Sektion ohne nested-Inhalt + jede nested als eigene Section.
      const flatInner = innerContent.replace(/<section\b[^>]*>[\s\S]*?<\/section>/g, '');
      if (flatInner.trim()) {
        sections.push(buildParsedSection(`s${++secIdx}`, role, attrs, flatInner, block));
      }
      for (const n of nested) {
        const childRole = n.attrs.role ?? n.attrs.person ?? 'nested';
        sections.push(buildParsedSection(`s${++secIdx}`, childRole, { ...attrs, ...n.attrs }, n.body, n.tag));
      }
    }
  }
  return sections;
}

function buildParsedSection(
  id: string,
  role: string,
  attrs: Record<string, string>,
  body: string,
  rawHtml: string,
): ParsedSection {
  const fields: ParsedField[] = [];
  const fieldRe = /<field\b([^>]*)>([\s\S]*?)<\/field>/g;
  let fm: RegExpExecArray | null;
  while ((fm = fieldRe.exec(body)) !== null) {
    const fAttrs = parseAttributes(fm[1]);
    fields.push({
      key: fAttrs.key ?? '',
      type: fAttrs.type ?? 'text',
      value: fm[2].trim(),
    });
  }
  const notes: { role: string; text: string }[] = [];
  const noteRe = /<note\b([^>]*)>([\s\S]*?)<\/note>/g;
  let nm: RegExpExecArray | null;
  while ((nm = noteRe.exec(body)) !== null) {
    const nAttrs = parseAttributes(nm[1]);
    notes.push({ role: nAttrs.role ?? '', text: nm[2].trim() });
  }
  return {
    id,
    role,
    block: attrs.block,
    person: attrs.person,
    fields,
    notes,
    raw_html: rawHtml,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Stage Definition
// ─────────────────────────────────────────────────────────────────────────

export const mistralStructureStage = defineStage<MistralStructureInput, MistralStructureOutput>({
  id: 'elster-v3/mistral-structure',
  name: 'Mistral-Small HTML-Structuring (Pre-Processor)',
  description:
    'Nimmt rohes Mistral-OCR-Markdown, ruft Mistral Small mit dem v2-Structure-Prompt ' +
    'auf, gibt semantisch strukturiertes HTML + geparste Sections zurueck. Drop-In ' +
    'vor polar-coder.',

  async run(input, ctx) {
    const apiKeyEnv = input.apiKeyEnv ?? 'MISTRAL_API_KEY';
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) throw new Error(`mistral-structure: ${apiKeyEnv} env not set`);
    const timeoutMs = input.timeoutMs ?? 60_000;

    ctx.emit('mistral-structure.start', { ocrChars: input.ocrText.length });

    const payload = {
      model: MISTRAL_MODEL,
      temperature: 0,
      messages: [
        { role: 'system', content: STRUCTURE_SYSTEM_PROMPT },
        { role: 'user', content: 'OCR-Markdown des Belegs:\n\n' + input.ocrText },
      ],
    };

    const t0 = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let respJson: any;
    try {
      const resp = await fetch(MISTRAL_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`mistral-structure: HTTP ${resp.status} — ${errBody.slice(0, 200)}`);
      }
      respJson = await resp.json();
    } finally {
      clearTimeout(timer);
    }
    const wallClockMs = Date.now() - t0;

    const html: string = respJson.choices?.[0]?.message?.content ?? '';
    const usage = respJson.usage ?? {};
    const sections = parseHtml(html);
    const fieldCount = sections.reduce((acc, s) => acc + s.fields.length, 0);

    ctx.emit('mistral-structure.done', {
      wallClockMs,
      sections: sections.length,
      fields: fieldCount,
      tokens: usage.total_tokens,
    });

    return {
      html,
      sections,
      stats: {
        wallClockMs,
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        totalTokens: usage.total_tokens ?? 0,
        model: respJson.model ?? MISTRAL_MODEL,
        sectionCount: sections.length,
        fieldCount,
      },
    };
  },
});

// Export Prompt fuer Tests + Smoke-Skripte
export { STRUCTURE_SYSTEM_PROMPT };
