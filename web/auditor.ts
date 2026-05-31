/**
 * auditor — formuliert aus VERIFIZIERTEN Befunden (audit.ts) user-gerichtete
 * Fragen und interpretiert Antworten. Lokal, on-prem, über ein Gemma-Modell
 * (ollama, Constrained JSON). Der Auditor erfindet nichts — die Korrektheit
 * trägt das deterministische Skelett; das Modell macht nur Sprache auf Schienen.
 *
 * Marke: „der Auditor". Das zugrundeliegende Modell wird NIE genannt — weder
 * im System-Prompt-Selbstbild noch in der Ausgabe. Modell/Endpoint stecken in
 * genau zwei Env-Variablen.
 */
import type { AuditFinding } from './audit.ts';

const AUDITOR_URL = process.env.AUDITOR_URL ?? 'http://127.0.0.1:11434';
const AUDITOR_MODEL = process.env.AUDITOR_MODEL ?? 'gemma4:e4b';

const SYS_PHRASE =
  'Du bist der Auditor, ein deutscher Steuer-Vollständigkeitsprüfer. Zu einem bereits ' +
  'VERIFIZIERTEN Befund formulierst du genau EINE klare, höfliche Frage an den ' +
  'Steuerpflichtigen (Anrede „Sie") plus eine kurze, sachliche Begründung. Bleibe strikt ' +
  'beim Befund — erfinde keine zusätzlichen Anforderungen, keine neuen Beträge, keine ' +
  'Rechtsfolgen. Nenne niemals ein zugrundeliegendes Modell, eine KI oder einen Hersteller; ' +
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
  properties: {
    status: { type: 'string', enum: ['erledigt', 'offen'] },
    wert: { type: 'string' },
    notiz: { type: 'string' },
  },
  required: ['status'],
};

interface ChatMsg { role: 'system' | 'user'; content: string; }

/** Ein constrained-JSON-Aufruf gegen das lokale Gemma; ein Retry bei Parse-Fehler. */
const DEBUG = !!process.env.AUDIT_DEBUG;
async function chatJson<T>(messages: ChatMsg[], schema: unknown, timeoutMs = 90_000): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(`${AUDITOR_URL}/api/chat`, {
        method: 'POST', signal: ac.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: AUDITOR_MODEL, stream: false, format: schema,
          options: { temperature: 0, num_ctx: 4096, num_predict: 512 },
          messages,
        }),
      });
      if (!res.ok) { if (DEBUG) console.error(`[chatJson] attempt ${attempt}: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`); continue; }
      const data = await res.json() as { message?: { content?: string }; done_reason?: string };
      const content = data.message?.content ?? '';
      try {
        return JSON.parse(content) as T;
      } catch (e) {
        if (DEBUG) console.error(`[chatJson] attempt ${attempt}: parse-fail done=${data.done_reason} len=${content.length} :: ${JSON.stringify(content.slice(0, 180))}`);
      }
    } catch (e) {
      if (DEBUG) console.error(`[chatJson] attempt ${attempt}: ${(e as Error).name} ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** Deterministischer Fallback: der User bekommt IMMER eine brauchbare Frage. */
function fallbackFrage(f: AuditFinding): { frage: string; begruendung: string } {
  const begruendung = f.fakt.replace(/^Verifizierter Befund \([^)]*\):\s*/, '');
  switch (f.kind) {
    case 'confirm_value':
      return { frage: `Können Sie den Wert ${f.erwartet.eCode ?? ''} bestätigen?`, begruendung };
    case 'missing_beleg':
      return { frage: `Können Sie einen lesbaren ${f.erwartet.belegTyp ?? 'Beleg'} bereitstellen?`, begruendung };
    case 'conflict':
      return { frage: `Können Sie diesen Punkt prüfen und ggf. korrigieren?`, begruendung };
    case 'open_question':
      return { frage: `Können Sie diesen Punkt klären?`, begruendung };
    default:
      return { frage: `Möchten Sie diesen Punkt berücksichtigen?`, begruendung };
  }
}

/** Einen Befund in eine user-gerichtete Frage gießen (Gemma, mit Fallback). */
export async function phraseFinding(f: AuditFinding): Promise<AuditFinding> {
  const obj = await chatJson<{ frage?: string; begruendung?: string }>(
    [{ role: 'system', content: SYS_PHRASE }, { role: 'user', content: f.fakt }],
    PHRASE_SCHEMA,
  );
  if (obj && typeof obj.frage === 'string' && obj.frage.trim().length > 5)
    return { ...f, frage: obj.frage.trim(), begruendung: String(obj.begruendung ?? '').trim() };
  const fb = fallbackFrage(f);
  return { ...f, frage: fb.frage, begruendung: fb.begruendung };
}

/** Alle Befunde formulieren (sequenziell — ein geladenes Modell, kleine Prompts). */
export async function phraseFindings(findings: AuditFinding[]): Promise<AuditFinding[]> {
  const out: AuditFinding[] = [];
  for (const f of findings) out.push(await phraseFinding(f));
  return out;
}

export interface AnswerVerdict { status: 'erledigt' | 'offen'; wert?: string; notiz?: string; }

/** Freitext-Antwort des Users gegen einen Befund interpretieren. */
export async function interpretAnswer(f: AuditFinding, antwort: string): Promise<AnswerVerdict> {
  const ctx = `Befund: ${f.fakt}\nErwartet: ${f.erwartet.typ}${f.erwartet.eCode ? ` (${f.erwartet.eCode})` : ''}\nAntwort des Steuerpflichtigen: ${antwort}`;
  const obj = await chatJson<AnswerVerdict>(
    [{ role: 'system', content: SYS_INTERPRET }, { role: 'user', content: ctx }],
    INTERPRET_SCHEMA,
  );
  if (obj && (obj.status === 'erledigt' || obj.status === 'offen'))
    return { status: obj.status, wert: obj.wert?.trim() || undefined, notiz: obj.notiz?.trim() || undefined };
  return { status: 'offen', notiz: 'Antwort konnte nicht automatisch interpretiert werden.' };
}

export const auditorConfig = () => ({ url: AUDITOR_URL, model: AUDITOR_MODEL });
