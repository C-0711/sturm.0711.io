// case-narrator.ts — Haiku-4.5 Coach-Voice Narrator
//
// Wird vom case-watcher per debouncedNarrate(caseId) angetriggert, sobald sich
// im case-JSON was geändert hat. Liest die letzten N Events aus dem buffer,
// baut einen Coach-Prompt, ruft Haiku, streamt das Ergebnis als
// narrator.say-Event ans Frontend.

import { caseEvents, type CaseEvent } from './case-events.ts';
import { getCaseSnapshot } from './case-watcher.ts';

const API_BASE = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

// last-said-cache per caseId, anti-repetition
const lastSaid = new Map<string, string[]>();
// last-processed event count per caseId
const lastProcessedTs = new Map<string, string>();

const SYSTEM_PROMPT = `Du bist ein Steuer-Coach. Du sprichst den Mandanten direkt
an wie ein erfahrener, ermutigender Kollege, der gerade neben ihm sitzt.

Stil:
- max 22 Wörter pro Antwort
- pro Antwort 1 Satz, höchstens 2
- Beträge konkret nennen ("4.019€ Lohn von Philips")
- bei wichtigen steuerlichen Konzepten (Splittingtarif, Sparer-Pauschbetrag,
  KapESt-Anrechnung) → ein knapper Lehrsatz dran
- Encouragement subtil ("solider Hauptverdienst", "die holst du dir zurück")
- niemals Floskeln, keine Warnungen wenn nicht nötig
- Stille (= leerer String "") wenn nichts wirklich Neues passiert ist
- Anti-Repetition: was bereits gesagt wurde nicht wiederholen
- Coach-Voice: ermutigend, klar, lehrreich, niemals belehrend

Antworte AUSSCHLIESSLICH mit dem Satz (kein JSON, keine Anführungszeichen).`;

function buildUserPrompt(caseId: string, events: CaseEvent[], snapshot: any, previouslySaid: string[]): string {
  const personenCount = snapshot?.documents
    ? new Set(JSON.stringify(snapshot.documents).match(/\b\d{11}\b/g) || []).size
    : 0;
  const totalDocs = snapshot?.documents?.length ?? 0;
  const fertigDocs = (snapshot?.documents ?? []).filter((d: any) => d.state === 'ok' || d.indikation).length;
  const jahr = snapshot?.veranlagungsjahr ?? '?';
  const veranl = personenCount >= 2 ? 'Zusammenveranlagung' : 'Einzelveranlagung';

  const eventsCompact = events.slice(-8).map(e => {
    const parts: string[] = [e.kind];
    if (e.filename) parts.push(`file=${e.filename.slice(0,40)}`);
    if (e.belegtyp) parts.push(`typ=${e.belegtyp}`);
    if (e.anlagen?.length) parts.push(`anlagen=${e.anlagen.join(',')}`);
    if (e.label) parts.push(`${e.label}=${e.value}`);
    if (e.data) parts.push(`data=${JSON.stringify(e.data)}`);
    return parts.join(' ');
  }).join('\n');

  return `Fall-Kontext: ESt ${jahr}, ${veranl}, ${fertigDocs}/${totalDocs} Belege fertig.

Letzte Events (chronologisch):
${eventsCompact}

Bereits gesagt (NICHT wiederholen):
${previouslySaid.slice(-3).map(s => `- "${s}"`).join('\n') || '(noch nichts)'}

Schreibe genau EINEN Coach-Satz zu den letzten Events. Wenn nichts wirklich Neues
(z.B. nur Heartbeat oder identischer Wert) → leerer String "".`;
}

async function callHaiku(prompt: string, signal?: AbortSignal): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY nicht gesetzt');

  const res = await fetch(API_BASE, {
    method: 'POST',
    signal,
    headers: {
      'x-api-key': key,
      'anthropic-version': API_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 120,
      temperature: 0.4,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Haiku ${res.status}: ${txt.slice(0, 200)}`);
  }

  const j = await res.json() as any;
  const content = j?.content?.[0]?.text ?? '';
  return String(content).trim().replace(/^"+|"+$/g, '');
}

export async function narratorTick(caseId: string): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) return;  // disabled cleanly

  const all = caseEvents.replay(caseId);
  if (all.length === 0) return;

  const lastTs = lastProcessedTs.get(caseId) ?? '';
  const fresh = all.filter(e => e.ts > lastTs && e.kind !== 'narrator.say' && e.kind !== 'narrator.error' && e.kind !== 'heartbeat');
  if (fresh.length === 0) return;

  lastProcessedTs.set(caseId, all[all.length - 1].ts);

  const snapshot = getCaseSnapshot(caseId);
  const prev = lastSaid.get(caseId) ?? [];
  const prompt = buildUserPrompt(caseId, fresh, snapshot, prev);

  try {
    const text = await callHaiku(prompt);
    if (text && text.length > 0) {
      caseEvents.emit(caseId, { kind: 'narrator.say', text });
      const arr = lastSaid.get(caseId) ?? [];
      arr.push(text);
      while (arr.length > 5) arr.shift();
      lastSaid.set(caseId, arr);
    }
  } catch (e: any) {
    caseEvents.emit(caseId, { kind: 'narrator.error', message: e?.message ?? String(e) });
  }
}

/** Generiere die 9-Karten-Story (vollständig durch Haiku). Aufruf-Trigger:
 *  wenn alle docs status='ok' UND berechnung.ergebnis vorhanden. */
export async function generateStoryCards(caseId: string): Promise<any[]> {
  const snapshot = getCaseSnapshot(caseId);
  if (!snapshot) return [];

  const docs = snapshot.documents ?? [];
  const berechnung = snapshot.berechnung ?? snapshot.fall_daten?.berechnung;
  const erg = berechnung?.ergebnis;

  // Daten-Briefing für Haiku
  const briefing = {
    jahr: snapshot.veranlagungsjahr,
    veranlagung: 'TBD',
    docs_summary: docs.map((d: any) => ({
      typ: d.indikation?.belegtyp,
      werte: d.indikation?.wichtige_werte?.slice(0, 3),
    })),
    berechnung: erg ? {
      zve: erg.zve,
      est: erg.einkommensteuer,
      erstattung: erg.erstattung_oder_nachzahlung,
    } : null,
  };

  const cardsPrompt = `Erstelle GENAU 9 Story-Karten für diesen Steuerfall im Coach-Stil.
Jede Karte: { "kicker": "Kapitel XX · ...", "headline": "...", "value": "Zahl mit €", "sub": "...", "lesson": "Lehrsatz max 18 Wörter" }
Antworte mit JSON-Array von 9 Objekten, sonst nichts.

Fall: ${JSON.stringify(briefing, null, 2)}`;

  try {
    const txt = await callHaiku(cardsPrompt);
    const start = txt.indexOf('[');
    const end = txt.lastIndexOf(']');
    if (start < 0 || end <= start) return [];
    return JSON.parse(txt.slice(start, end + 1));
  } catch (e) {
    return [];
  }
}
