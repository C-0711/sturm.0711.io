/**
 * elster-v3/label-value-parser — extrahiert deterministisch Label-Wert-Paare
 * aus dem pdftotext-Layout-Output eines VAST-Belegs (WISO/Steuer-Software-Exporte).
 *
 * Annahme: PDF hat einen sauberen Text-Layer mit zwei-Spalten-Layout
 *   "Label                                              Wert"
 * mit ≥2 Whitespaces als Trenner — wie es WISO Steuer 2025 und vergleichbare
 * Programme produzieren. Für eingescannte PDFs ist dieser Pfad NICHT geeignet
 * (→ Vision-Path).
 *
 * Output:
 *   • belege:  Array von Belegen (split nach "Transferticket:" Anker)
 *     - jedes mit doc_class (lohnsteuerbescheinigung | mitteilung_kapitalertraege | …),
 *       title (z.B. "Lohnsteuerbescheinigung Verbandsgemeindewerke Abwasser"),
 *       chunks (Label-Wert-Paare).
 *
 * Performance: ~10 ms für ein 5-Beleg-Bundle. Keine Embeddings, kein LLM.
 */
import { createHash } from 'node:crypto';
import { defineStage } from '../../../core/stage.ts';

export interface LabelValueChunk {
  /** Vordruckzeile-Marker falls präsent (z.B. " 3." aus " 3. Bruttoarbeitslohn …"). */
  zeile?: string;
  label: string;
  value: string;
  /** Originalzeile, ungeparst — für Spätere Bbox/Citation-Recovery. */
  rawLine: string;
  /** 0-basierter Zeilenindex im Beleg. */
  lineIndex: number;
}

export interface BelegBlock {
  /** 0-basierter Beleg-Index im Bundle. */
  index: number;
  /** Heuristische Klassifikation aus Beleg-Header. */
  doc_class:
    | 'lohnsteuerbescheinigung'
    | 'mitteilung_kapitalertraege'
    | 'religionszugehoerigkeit'
    | 'rentenbezug_mitteilung'
    | 'spendenquittung'
    | 'unknown';
  /** Header-Titel-Zeile, z.B. "Lohnsteuerbescheinigung Verbandsgemeindewerke Abwasser". */
  title: string;
  /** Roh-Text dieses Belegs (für ggf. nachgelagerte LLM-Disambig). */
  rawText: string;
  /** Label/Wert-Chunks. */
  chunks: LabelValueChunk[];
  /** sha256 über rawText — Replay-Anker. */
  text_sha256: string;
}

export interface LabelValueParserInput {
  /** Voller pdftotext-Output (mit -layout). */
  text: string;
}

export interface LabelValueParserConfig {
  /**
   * Split-Anker für Beleg-Trennung. Default `^Transferticket:` aus VAST-Abruf.
   * Bei anderen Quellen kann ein abweichender Regex-String gesetzt werden.
   */
  splitAnchor?: string;
  /** Minimale Label-Länge in Zeichen. Default 4. */
  minLabelChars?: number;
  /** Mindestabstand (Leerzeichen) zwischen Label und Wert. Default 2. */
  gapWhitespace?: number;
}

export interface LabelValueParserOutput {
  belege: BelegBlock[];
  /** Aggregierter Chunk-Count über alle Belege. */
  totalChunks: number;
  ms: number;
}

// ─── Beleg-Klassifikator (deterministisch, Heuristik über Header-Text) ────

function classifyBeleg(headerLine: string): BelegBlock['doc_class'] {
  const h = headerLine.toLowerCase();
  if (h.includes('lohnsteuerbescheinigung')) return 'lohnsteuerbescheinigung';
  if (h.includes('freigestellte kapitalerträge')) return 'mitteilung_kapitalertraege';
  if (h.includes('kapitalerträge')) return 'mitteilung_kapitalertraege';
  if (h.includes('religionszugehörigkeit') || h.includes('religion')) return 'religionszugehoerigkeit';
  if (h.includes('rentenbezug') || h.includes('rentenmitteilung')) return 'rentenbezug_mitteilung';
  if (h.includes('spende') || h.includes('zuwendungsbestätigung')) return 'spendenquittung';
  return 'unknown';
}

// ─── Header-Extraktor — die Belegart-Zeile nach "übernommen"/"nicht übernommen" ──

function extractBelegHeader(belegText: string): string {
  const m = belegText.match(
    /(?:Diese Bescheinigung wurde (?:nicht )?übernommen\.)\s*\n+\s*([^\n]+)/,
  );
  if (m) return m[1].trim();
  // Fallback: erste nicht-leere Zeile, die nicht "Transferticket"/"Zuletzt"/"Diese" beginnt.
  for (const line of belegText.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (/^(Transferticket|Zuletzt abgerufen|Diese Bescheinigung|Seite)/.test(t)) continue;
    return t;
  }
  return '(unbekannt)';
}

// ─── Label/Wert-Parser für eine einzelne Zeile ───────────────────────────

const LABEL_VALUE_RE = (gap: number) =>
  new RegExp(
    // optional führender Marker " 3." oder "22. b)" oder " a)"
    '^\\s*(?:(?<zeile>\\d{1,3}\\.(?:\\s*[a-z]\\))?))?\\s*' +
      // Label: start with letter/umlaut, then any non-newline chars (lazy).
      // Wichtig: Digits MÜSSEN erlaubt sein, weil VAST-Labels wie
      // "Bruttoarbeitslohn (ohne 9. und 10.)" oder "Einbehaltene Lohnsteuer
      // (von 3.)" parenthetische Zeilenreferenzen enthalten. Boundary
      // zum Wert wird durch \s{gap,} gefunden (lazy match macht das robust).
      '(?<label>[A-ZÄÖÜa-zäöü][^\\n]{3,}?)' +
      // Trenner: ≥ gap Whitespaces
      '\\s{' + gap + ',}' +
      // Wert: Rest der Zeile (kann Zahlen, Wörter, Symbole enthalten)
      '(?<value>\\S.{0,200}?)\\s*$',
  );

/** Boilerplate-Zeilen die nie Label/Wert sind — vor Match aussortieren. */
const BOILERPLATE_PREFIX = [
  'Transferticket',
  'Zuletzt abgerufen',
  'Diese Bescheinigung',
  'Die folgende Daten',
  'Soweit im Einzelnen',
  'Seite ',
];

function isBoilerplate(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  for (const p of BOILERPLATE_PREFIX) if (t.startsWith(p)) return true;
  return false;
}

function parseChunks(text: string, minLabelChars: number, gap: number): LabelValueChunk[] {
  const re = LABEL_VALUE_RE(gap);
  const out: LabelValueChunk[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isBoilerplate(line)) continue;
    const m = line.match(re);
    if (!m || !m.groups) continue;
    const label = m.groups.label.trim().replace(/[:\s]+$/, '');
    let value = m.groups.value.trim();
    // Value-Sanitization: Mehrfach-Whitespaces in Wert kollabieren
    value = value.replace(/\s+/g, ' ');
    if (label.length < minLabelChars) continue;
    if (!value) continue;
    // Häufige Müll-Werte ausfiltern
    if (/^[—–-]+$/.test(value)) continue;
    out.push({
      zeile: m.groups.zeile?.trim() || undefined,
      label,
      value,
      rawLine: line,
      lineIndex: i,
    });
  }
  return out;
}

// ─── Stage ─────────────────────────────────────────────────────────────────

export const labelValueParserStage = defineStage<
  LabelValueParserInput,
  LabelValueParserOutput,
  LabelValueParserConfig
>({
  id: 'elster-v3/label-value-parser',
  name: 'Label-Value-Parser (VAST-Belege)',
  description:
    'Splittet pdftotext-Output an "Transferticket:"-Ankern in Einzel-Belege, klassifiziert ' +
    'die Belegart heuristisch (lohnsteuerbescheinigung | mitteilung_kapitalertraege | …) ' +
    'und extrahiert Label/Wert-Paare per Whitespace-Layout (zwei-Spalten-Vordrucke). ' +
    'Deterministisch, ~10ms für 5-Beleg-Bundle, kein LLM/Embed-Aufruf.',
  hints: {
    inputs: 'text: voller pdftotext-Output (mit -layout)',
    outputs: 'belege[{index, doc_class, title, chunks[{label, value, zeile, lineIndex}], text_sha256}], totalChunks, ms',
    configExample: '{"splitAnchor": "^Transferticket:", "minLabelChars": 4, "gapWhitespace": 2}',
    inputPorts: [{ name: 'text', type: 'text', description: 'pdftotext-Layout-Output' }],
    outputPorts: [
      { name: 'belege', type: 'belege', description: 'Klassifizierte Belege mit Label/Wert-Chunks' },
      { name: 'totalChunks', type: 'number' },
    ],
  },

  async run(input, ctx) {
    const t0 = Date.now();
    if (!input?.text) {
      ctx.logger.warn('label-value-parser: leerer Text — keine Belege');
      return { belege: [], totalChunks: 0, ms: 0 };
    }
    const text = input.text;
    const splitAnchorStr = ctx.config?.splitAnchor ?? 'Transferticket:\\s+Steuer-Abruf';
    const minLabelChars = ctx.config?.minLabelChars ?? 4;
    const gapWhitespace = ctx.config?.gapWhitespace ?? 2;

    // Split — der Anker ist Lookbehind: jeder Teilstring beginnt mit
    // "Transferticket:". Falls der Anker am Anfang fehlt, ergibt sich eine
    // einzelne Beleg-Sektion (Single-Doc-PDF).
    const splitRe = new RegExp(`(?=${splitAnchorStr})`, 'g');
    const parts = text.split(splitRe).filter((p) => p.trim().length > 0);
    // Falls kein einziger Anker gefunden wurde → das gesamte Dokument ist
    // ein "Beleg".
    const segments = parts.length > 1 || /Transferticket:/.test(text)
      ? parts
      : [text];

    const belege: BelegBlock[] = [];
    for (let i = 0; i < segments.length; i++) {
      const segText = segments[i].trim();
      if (segText.length < 20) continue; // Mini-Sektion, vermutlich Footer-Rest
      const title = extractBelegHeader(segText);
      const doc_class = classifyBeleg(title);
      const chunks = parseChunks(segText, minLabelChars, gapWhitespace);
      const text_sha256 = createHash('sha256').update(segText).digest('hex');
      belege.push({
        index: i,
        doc_class,
        title,
        rawText: segText,
        chunks,
        text_sha256,
      });
    }

    const totalChunks = belege.reduce((s, b) => s + b.chunks.length, 0);
    const ms = Date.now() - t0;
    ctx.emit('label_value_parsed', {
      belege: belege.length,
      totalChunks,
      perBeleg: belege.map((b) => ({ idx: b.index, class: b.doc_class, chunks: b.chunks.length })),
      ms,
    });
    return { belege, totalChunks, ms };
  },
});
