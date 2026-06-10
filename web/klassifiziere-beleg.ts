/**
 * web/klassifiziere-beleg — LLM-Klassifizierung EINES Belegs über Gemma-4 (vLLM).
 *
 * Ein einzelner /v1/chat/completions-Call (~1,6 s) liefert eine strukturierte
 * Klassifikation: Belegtyp, EINKUNFTSART (aktiver Lohn vs Versorgungsbezug — die
 * Semantik, die der deterministische StKl-Pfad nur approximiert), Steuerklasse,
 * Anlagen, VERANLAGUNGSZEITRAUM (aus dem Beleg → gegen den VZ-Mismatch), Person.
 *
 * Robust: gibt bei JEDEM Fehler `null` zurück (bricht die Pipeline nie). Gedacht
 * für den HINTERGRUND-Pfad (kickMastercase), wo Latenz unkritisch ist;
 * deterministisch (detectBelegTyp) bleibt primär, Gemma ergänzt/korrigiert.
 *
 * Endpoint via Env VLLM_URL überschreibbar (Default http://127.0.0.1:11435),
 * Modell via VLLM_MODEL (Default gemma4-mm). Kein Modellname im User-Facing-Text.
 */
const VLLM_URL = process.env.VLLM_URL ?? 'http://127.0.0.1:11435';
const MODEL = process.env.VLLM_MODEL ?? 'gemma4-mm';

export interface BelegKlassifikation {
  belegtyp: string;
  /** 'aktiver Arbeitslohn' | 'Versorgungsbezug' | 'gesetzliche Rente' | 'Kapitalerträge' | 'keine' */
  einkunftsart: string;
  steuerklasse: number | null;
  elster_anlagen: string[];
  veranlagungszeitraum: number | null;
  person: string | null;
  begruendung: string;
}

const promptFor = (raw: string): string =>
  `Du bist ein Klassifizierer für deutsche Steuerbelege. Analysiere den OCR-/RAW-Text EINES Belegs und antworte AUSSCHLIESSLICH mit einem JSON-Objekt (kein Markdown, kein Text drumherum):
{"belegtyp":"Lohnsteuerbescheinigung|Rentenbezugsmitteilung|Bank-Steuerbescheinigung|Einkommensteuererklärung|Steuerkontoabfrage|Stammdaten|Religionszugehörigkeit|Krankenversicherung|Spendenbescheinigung|Sonstiges","einkunftsart":"aktiver Arbeitslohn|Versorgungsbezug|gesetzliche Rente|Kapitalerträge|keine","steuerklasse":Zahl oder null,"elster_anlagen":["N","VOR","KAP","R","SO"],"veranlagungszeitraum":Jahr als Zahl oder null,"person":"Name oder null","begruendung":"ein kurzer Satz, woran erkannt"}

=== BELEG-TEXT ===
${raw.slice(0, 6000)}
=== ENDE ===`;

/** Toleranter JSON-Parse: zieht das erste {…}-Objekt aus der Antwort (auch wenn
 *  das Modell ```json-Fences oder Begleittext liefert). */
function parse(content: string): BelegKlassifikation | null {
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    const num = (v: unknown): number | null => (v == null || v === '' ? null : Number(v) || null);
    return {
      belegtyp: String(o.belegtyp ?? ''),
      einkunftsart: String(o.einkunftsart ?? ''),
      steuerklasse: num(o.steuerklasse),
      elster_anlagen: Array.isArray(o.elster_anlagen) ? o.elster_anlagen.map(String) : [],
      veranlagungszeitraum: num(o.veranlagungszeitraum),
      person: o.person ? String(o.person) : null,
      begruendung: String(o.begruendung ?? ''),
    };
  } catch {
    return null;
  }
}

export async function klassifiziereBeleg(
  rawText: string,
  opts: { vllmUrl?: string; model?: string; timeoutMs?: number } = {},
): Promise<BelegKlassifikation | null> {
  if (!rawText || rawText.trim().length < 20) return null;
  const url = (opts.vllmUrl ?? VLLM_URL).replace(/\/$/, '') + '/v1/chat/completions';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), opts.timeoutMs ?? 20000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: opts.model ?? MODEL,
        temperature: 0,
        max_tokens: 400,
        messages: [{ role: 'user', content: promptFor(rawText) }],
      }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return parse(j.choices?.[0]?.message?.content ?? '');
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
