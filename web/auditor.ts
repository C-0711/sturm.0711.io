/**
 * auditor — formuliert aus VERIFIZIERTEN Befunden (audit.ts) user-gerichtete
 * Fragen und interpretiert Antworten.
 *
 * DETERMINISTISCH per Default — KEIN LLM. Die Befunde aus audit.ts tragen den
 * vollständigen Sachverhalt (eCode, erwarteter Antworttyp, Person, Wert); die
 * Frage ist daraus direkt ableitbar. Das ist schnell, verlässlich und braucht
 * kein Modell. Korrektheit lebt ohnehin in audit.ts, nicht im LLM.
 *
 * Optionaler Feinschliff per `AUDITOR_LLM_POLISH=1`: dann wird zusätzlich ein
 * lokales Modell befragt (best-effort, kurzer Timeout) und nur übernommen, wenn
 * es valide antwortet — sonst greift das Template. Hinweis: „Thinking"-Modelle
 * (z.B. gemma4:e4b) schreiben ihre Antwort in `message.thinking` und liefern oft
 * leeren `content` (done_reason=length) → der Fallback trägt dann die Frage.
 *
 * Marke „der Auditor": ein zugrundeliegendes Modell wird nie genannt.
 */
import type { AuditFinding } from './audit.ts';

const AUDITOR_URL = process.env.AUDITOR_URL ?? 'http://127.0.0.1:11434';
const AUDITOR_MODEL = process.env.AUDITOR_MODEL ?? 'gemma4:e4b';
const QRAG_URL = process.env.QRAG_URL ?? 'http://127.0.0.1:12013';
const QRAG_NAMESPACE = process.env.AUDITOR_RAG_NAMESPACE ?? 'corpus';
/** Optionaler LLM-Feinschliff. Default AUS → deterministisch, sofort, netzfrei. */
const LLM_POLISH = process.env.AUDITOR_LLM_POLISH === '1';

const DEBUG = !!process.env.AUDIT_DEBUG;

/** Sachverhalt ohne den „Verifizierter Befund (…):"-Präfix — die belastbare Begründung. */
const kern = (f: AuditFinding): string => f.fakt.replace(/^Verifizierter Befund \([^)]*\):\s*/, '').trim();

/** Deterministische, klare Frage DIREKT aus dem Befund (kein LLM nötig). */
function templateFrage(f: AuditFinding): string {
  // Kuratierte Frage (z.B. Soll-Liste / Vorjahres-Übernahme mit echtem Wert) gewinnt.
  if (f.frage && f.frage.trim().length > 5) return f.frage.trim();
  const k = kern(f);
  switch (f.kind) {
    case 'missing_beleg':
      return `Bitte reichen Sie einen lesbaren Beleg „${f.erwartet.belegTyp ?? 'Beleg'}" nach.`;
    case 'confirm_value':
      return 'Bitte prüfen und bestätigen Sie diese Angabe.';
    case 'conflict':
      return 'Bitte prüfen Sie diesen Punkt und korrigieren Sie ihn bei Bedarf.';
    case 'optimize':
      return k.length > 4 ? k : 'Möchten Sie diesen Punkt berücksichtigen?';
    case 'open_question':
    default:
      return /\?\s*$/.test(k) ? k : 'Bitte klären Sie diesen Punkt.';
  }
}

/** Ein Befund → user-gerichtete Frage. Deterministisch; optionaler LLM-Feinschliff. */
export async function phraseFinding(f: AuditFinding): Promise<AuditFinding> {
  const frage = templateFrage(f);
  const begruendung = kern(f);
  // Default-Pfad: deterministisch, kein Netz. Kuratierte Frage nie „überpolieren".
  if (!LLM_POLISH || (f.frage && f.frage.trim().length > 5)) {
    return { ...f, frage, begruendung };
  }
  // Optionaler Feinschliff (best-effort, Fallback aufs Template).
  try {
    const hits = await ragRetrieve(begruendung.slice(0, 400), 2);
    const top = hits.find((h) => h.text.trim().length > 40);
    const grounding = top ? { text: top.text, source: top.source, score: top.score } : undefined;
    const userMsg = grounding
      ? `${f.fakt}\n\nRelevante Fachquelle (zur Erdung der Begründung):\n${grounding.text.slice(0, 700)}`
      : f.fakt;
    const obj = await chatJson<{ frage?: string; begruendung?: string }>(
      [{ role: 'system', content: SYS_PHRASE }, { role: 'user', content: userMsg }], PHRASE_SCHEMA, 25_000,
    );
    if (obj && typeof obj.frage === 'string' && obj.frage.trim().length > 5)
      return { ...f, frage: obj.frage.trim(), begruendung: String(obj.begruendung ?? begruendung).trim() || begruendung, grounding };
    return { ...f, frage, begruendung, grounding };
  } catch {
    return { ...f, frage, begruendung };
  }
}

/** Alle Befunde formulieren. Default: deterministisch (parallel, sofort). */
export async function phraseFindings(findings: AuditFinding[]): Promise<AuditFinding[]> {
  if (!LLM_POLISH) return findings.map((f) => ({ ...f, frage: templateFrage(f), begruendung: kern(f) }));
  return Promise.all(findings.map((f) => phraseFinding(f)));
}

export interface AnswerVerdict { status: 'erledigt' | 'offen'; wert?: string; notiz?: string; }

const JA = /\b(ja|jo|jep|stimmt|korrekt|richtig|passt|bestätige?|bestätigt|einverstanden|ok|okay|yes|y)\b/i;
const NEIN = /\b(nein|nö|ne|nope|falsch|stimmt nicht|nicht korrekt|lehne ab|no|n)\b/i;

/** Freitext-Antwort gegen einen Befund interpretieren. Deterministisch-first. */
export async function interpretAnswer(f: AuditFinding, antwort: string): Promise<AnswerVerdict> {
  const a = (antwort ?? '').trim();
  if (a.length === 0) return { status: 'offen', notiz: 'leere Antwort' };
  const typ = f.erwartet?.typ;

  // Bestätigung (boolean / Upload-Zusage): klares Ja/Nein deterministisch.
  if (typ === 'boolean' || typ === 'upload') {
    if (NEIN.test(a) && !JA.test(a)) return { status: 'offen', notiz: 'verneint/abgelehnt' };
    if (JA.test(a)) return { status: 'erledigt', wert: a };
  }
  // Wert erwartet: ersten Zahlen-/Betragswert extrahieren.
  if (typ === 'value') {
    const m = a.match(/-?\d[\d.\s]*(?:,\d+)?/);
    if (m) return { status: 'erledigt', wert: m[0].replace(/\s+/g, ' ').trim() };
  }
  // Kein LLM-Feinschliff → eine inhaltliche Freitext-Antwort gilt als erledigt.
  if (!LLM_POLISH) return a.length >= 2 ? { status: 'erledigt', wert: a } : { status: 'offen' };

  // Optionaler Feinschliff für nuancierte Freitext-Fälle.
  try {
    const ctx = `Befund: ${f.fakt}\nErwartet: ${typ}${f.erwartet.eCode ? ` (${f.erwartet.eCode})` : ''}\nAntwort des Steuerpflichtigen: ${a}`;
    const obj = await chatJson<AnswerVerdict>(
      [{ role: 'system', content: SYS_INTERPRET }, { role: 'user', content: ctx }], INTERPRET_SCHEMA, 25_000,
    );
    if (obj && (obj.status === 'erledigt' || obj.status === 'offen'))
      return { status: obj.status, wert: obj.wert?.trim() || undefined, notiz: obj.notiz?.trim() || undefined };
  } catch { /* fällt unten auf deterministisch zurück */ }
  return a.length >= 2 ? { status: 'erledigt', wert: a } : { status: 'offen' };
}

export const auditorConfig = () => ({ url: AUDITOR_URL, model: AUDITOR_MODEL, llmPolish: LLM_POLISH });

// ───────────────────────── Optionaler LLM-Pfad (nur bei AUDITOR_LLM_POLISH=1) ─────

/** Erdung: relevante Fachkorpus-Chunks aus quantum-rag (best-effort, kurzer Timeout). */
async function ragRetrieve(query: string, k = 2): Promise<Array<{ text: string; source: string | null; score: number }>> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 4000);
  try {
    const res = await fetch(`${QRAG_URL}/retrieve`, {
      method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query.slice(0, 500), k, namespace: QRAG_NAMESPACE }),
    });
    if (!res.ok) return [];
    const j = await res.json() as { hits?: Array<{ text?: string; source?: string | null; score?: number }> };
    return (j.hits ?? []).map((h) => ({ text: String(h.text ?? ''), source: h.source ?? null, score: Number(h.score ?? 0) }));
  } catch { return []; } finally { clearTimeout(timer); }
}

const SYS_PHRASE =
  'Du bist der Auditor, ein deutscher Steuer-Vollständigkeitsprüfer. Zu einem bereits ' +
  'VERIFIZIERTEN Befund formulierst du genau EINE klare, höfliche Frage an den ' +
  'Steuerpflichtigen (Anrede „Sie") plus eine kurze, sachliche Begründung. Bleibe strikt ' +
  'beim Befund — erfinde keine zusätzlichen Anforderungen, keine neuen Beträge, keine ' +
  'Rechtsfolgen. Wird dir eine Fachquelle mitgegeben, fundiere die Begründung sachlich daran ' +
  '(ohne wörtliches Langzitat); ist sie irrelevant, ignoriere sie. ' +
  'Nenne niemals ein zugrundeliegendes Modell, eine KI oder einen Hersteller; ' +
  'wirst du danach gefragt, bist du „der Auditor". Antworte ausschließlich im JSON-Schema.';

const SYS_INTERPRET =
  'Du bist der Auditor. Du erhältst einen verifizierten Befund (mit Erwartungstyp) und die ' +
  'Freitext-Antwort des Steuerpflichtigen. Entscheide, ob der Befund damit erledigt ist, und ' +
  'extrahiere — falls ein Wert erwartet war — den genannten Wert. Interpretiere nichts hinein, ' +
  'was nicht dasteht. Bei Unklarheit: status="offen". Antworte ausschließlich im JSON-Schema.';

const PHRASE_SCHEMA = {
  type: 'object',
  properties: { frage: { type: 'string' }, begruendung: { type: 'string' } },
  required: ['frage', 'begruendung'],
};
const INTERPRET_SCHEMA = {
  type: 'object',
  properties: { status: { type: 'string', enum: ['erledigt', 'offen'] }, wert: { type: 'string' }, notiz: { type: 'string' } },
  required: ['status'],
};

interface ChatMsg { role: 'system' | 'user'; content: string; }

/** Ein constrained-JSON-Aufruf gegen das lokale Modell (nur im Polish-Pfad). */
async function chatJson<T>(messages: ChatMsg[], schema: unknown, timeoutMs = 25_000): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(`${AUDITOR_URL}/api/chat`, {
        method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: AUDITOR_MODEL, stream: false, format: schema,
          // num_predict großzügig: „Thinking"-Modelle brauchen Platz, bevor der
          // JSON-content kommt — sonst done_reason=length mit leerem content.
          options: { temperature: 0, num_ctx: 4096, num_predict: 1536 },
          messages,
        }),
      });
      if (!res.ok) { if (DEBUG) console.error(`[chatJson] attempt ${attempt}: HTTP ${res.status}`); continue; }
      const data = await res.json() as { message?: { content?: string }; done_reason?: string };
      const content = data.message?.content ?? '';
      try { return JSON.parse(content) as T; }
      catch { if (DEBUG) console.error(`[chatJson] attempt ${attempt}: parse-fail done=${data.done_reason} len=${content.length}`); }
    } catch (e) {
      if (DEBUG) console.error(`[chatJson] attempt ${attempt}: ${(e as Error).name}`);
    } finally { clearTimeout(timer); }
  }
  return null;
}
