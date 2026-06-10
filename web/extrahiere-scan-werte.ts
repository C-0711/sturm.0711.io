/**
 * web/extrahiere-scan-werte — Gemma-Feld-Extraktion für GESCANNTE Belege
 * (lighton-Markdown), wo die positions-/regex-basierten Parser scheitern:
 *   - parseSpenden über-summiert jede „Betrag"-Zeile (Markdown-Tabellen).
 *   - parse35aBasis findet die „Summe"-Zeilen im Markdown nicht.
 *
 * Domänen-bewusster Prompt: §35a = NUR der haushaltsnahe Dienstleistungs-/
 * Pflegeanteil im Heimentgelt (nicht Gesamtentgelt/Verpflegung). Ein Call/Beleg,
 * robust (null bei jedem Fehler). Für digitale PDFs bleiben die Regex-Parser.
 *
 * vLLM-Endpoint via VLLM_URL (Default :11435), Modell VLLM_MODEL (gemma4-mm).
 */
const VLLM_URL = process.env.VLLM_URL ?? 'http://127.0.0.1:11435';
const MODEL = process.env.VLLM_MODEL ?? 'gemma4-mm';

export interface ScanWerte {
  /** §10b — Spende/Zuwendung. */
  spende: number | null;
  /** §35a Abs.2 — haushaltsnahe Dienstleistungs-/Pflegeanteil (Heim/Wohnstift). */
  haushaltsnahe_dienstleistung: number | null;
  /** §20 — Zinsen aus (Wohn-)Darlehen. */
  darlehenszinsen: number | null;
}

const promptFor = (md: string): string =>
  `Du extrahierst steuerlich relevante Beträge aus EINEM deutschen Beleg (OCR-Markdown). Antworte AUSSCHLIESSLICH mit einem JSON-Objekt. Trage einen Betrag NUR ein, wenn er im Beleg WIRKLICH steht; sonst null:
{"spende": <Euro-Betrag einer Spende/Zuwendung §10b oder null>, "haushaltsnahe_dienstleistung": <§35a-Anteil im Wohn-/Heimentgelt = SUMME der haushaltsnahen Dienstleistungen (HND) PLUS der Pflege-/Betreuungsleistungen (PBL); addiere beide "Summe"-Zeilen, falls vorhanden. NICHT das Gesamt-/Jahresentgelt, NICHT Verpflegung/Speisen/Unterkunft/Miete; oder null>, "darlehenszinsen": <Zinsen aus einem (Wohn-)Darlehen §20 oder null>, "begruendung": "kurz"}

=== BELEG (Markdown) ===
${md.slice(0, 6000)}
=== ENDE ===`;

function parseNum(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export async function extrahiereScanWerte(
  markdown: string,
  opts: { vllmUrl?: string; model?: string; timeoutMs?: number } = {},
): Promise<ScanWerte | null> {
  if (!markdown || markdown.trim().length < 30) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), opts.timeoutMs ?? 20000);
  try {
    const res = await fetch(`${(opts.vllmUrl ?? VLLM_URL).replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({ model: opts.model ?? MODEL, temperature: 0, max_tokens: 300, messages: [{ role: 'user', content: promptFor(markdown) }] }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const m = (j.choices?.[0]?.message?.content ?? '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    return {
      spende: parseNum(o.spende),
      haushaltsnahe_dienstleistung: parseNum(o.haushaltsnahe_dienstleistung),
      darlehenszinsen: parseNum(o.darlehenszinsen),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
