/**
 * audit — deterministisches Audit-Skelett. Aus dem gerechneten Steuerfall
 * werden VERIFIZIERTE Befunde abgeleitet: Katalog-/Regel-Lücken, BMF-MCP-
 * Konflikte, Provenienz-Lücken, Haushalts-Konsistenz. Diese Befunde sind die
 * Ground Truth — der Auditor (auditor.ts, lokales Gemma) formuliert daraus nur
 * Fragen; er erfindet keine Anforderungen. Korrektheit lebt hier, nicht im LLM.
 */

import { pruefeSoll, SOLL_ECODES } from './soll-katalog.ts';

export type FindingKind = 'missing_beleg' | 'open_question' | 'conflict' | 'confirm_value' | 'optimize';
export type Severity = 'blocker' | 'empfohlen' | 'optional';
export type ErwartetTyp = 'upload' | 'boolean' | 'value' | 'text';

export interface AuditFinding {
  id: string;
  kind: FindingKind;
  severity: Severity;
  /** Verifizierter Befund (intern; Eingabe für den Auditor). */
  fakt: string;
  /** Zitierbare Grundlage. */
  basis: { quelle: 'catalog' | 'gesetz' | 'mcp' | 'rule' | 'provenance'; ref: string };
  /** Was die Antwort liefern soll. */
  erwartet: { typ: ErwartetTyp; eCode?: string; belegTyp?: string; person?: string };
  /** Vom Auditor formuliert (user-facing) — von auditor.ts gefüllt. */
  frage?: string;
  begruendung?: string;
  /** Vom Nutzer gelieferter/bestätigter Wert (Antwort-Interpretation). */
  wert?: string;
  /** Erdung aus dem Fachkorpus (quantum-rag) — Zitat-Beleg für die Begründung. */
  grounding?: { text: string; source: string | null; score: number };
  state: 'offen' | 'beantwortet' | 'erledigt' | 'uebersprungen';
}

interface Feld { eCode: string; label?: string; wert?: string; person?: string; anlage?: string; method?: string; prov?: unknown; }
interface Beleg { source?: string; belegTyp?: string; person?: string; status?: string; felder?: number; method?: string; felderListe?: Feld[]; vorjahr?: boolean; dokumentJahr?: number; }
/** Ein fremdjähriges Feld (Beleg ≠ VZ) — von lane1 klassifiziert, nie in der Berechnung. */
export interface VorjahrFeld {
  eCode: string; anlage?: string; person?: string; wert?: string; pdfLabel?: string;
  dokumentJahr: number; kind: 'prefill' | 'frage' | 'vorhanden'; vorhandenAktuell?: boolean;
}
export interface CaseData {
  fields?: Feld[];
  belege?: Beleg[];
  warnings?: string[];
  calcs?: Array<{ person?: string; konflikte?: number; abgleich?: string | null }>;
  veranlagungsart?: string;
  household?: { personA?: Record<string, unknown>; personB?: Record<string, unknown> };
  /** Vorjahres-Kontext (fremdjährige Belege): Prefill-Vorschläge + Rückfragen. */
  vorjahr?: { jahr: number | null; felder?: VorjahrFeld[] } | null;
}

const val = (s?: string) => (s ?? '').trim();
/** „echter" Geldbetrag: enthält Ziffern und hat ≥2 signifikante Stellen (schließt "0" aus). */
const isMoney = (s?: string) => /\d/.test(s ?? '') && (s ?? '').replace(/\D/g, '').replace(/^0+$/, '').length >= 2;

export interface AuditReport {
  findings: AuditFinding[];
  score: { blocker: number; empfohlen: number; optional: number; total: number };
}

export function auditCase(data: CaseData): AuditReport {
  const out: AuditFinding[] = [];
  const seen = new Set<string>();
  const push = (f: Omit<AuditFinding, 'id' | 'state'>) => {
    const id = `${f.kind}:${f.basis.ref}:${f.erwartet.eCode ?? f.erwartet.belegTyp ?? ''}`.slice(0, 90);
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ ...f, id, state: 'offen' });
  };

  const belege = data.belege ?? [];
  const fields = data.fields ?? [];

  // A) Provenienz-Lücken: OCR-Feld ohne Box → Wert konnte nicht lokalisiert werden.
  for (const b of belege) {
    if (b.method !== 'ocr') continue;
    if (b.vorjahr) continue;  // Vorjahres-Belege: kein Rechenwert → §G, nicht Provenienz
    for (const f of b.felderListe ?? []) {
      if (f.prov || !isMoney(f.wert)) continue;
      push({
        kind: 'confirm_value', severity: 'empfohlen',
        fakt: `Verifizierter Befund (Provenienz): Der erkannte Feldwert ${f.eCode}${f.label ? ` "${f.label}"` : ''} = ${val(f.wert)} konnte im hochgeladenen Beleg nicht eindeutig lokalisiert werden. Der Wert sollte vom Steuerpflichtigen bestätigt werden.`,
        basis: { quelle: 'provenance', ref: f.eCode }, erwartet: { typ: 'boolean', eCode: f.eCode, person: f.person },
      });
    }
  }

  // B) BMF-MCP-Warnungen und -Konflikte (autoritative Rechen-Signale).
  for (const w of data.warnings ?? []) {
    if (!w || !w.trim()) continue;
    push({
      kind: 'conflict', severity: 'empfohlen',
      fakt: `Verifizierter Befund (BMF-MCP/Regel): ${w.trim()}`,
      basis: { quelle: 'mcp', ref: w.trim().slice(0, 48) }, erwartet: { typ: 'text' },
    });
  }
  for (const c of data.calcs ?? []) {
    if ((c.konflikte ?? 0) > 0)
      push({
        kind: 'conflict', severity: 'empfohlen',
        fakt: `Verifizierter Befund (BMF-MCP): Im Bescheid für Einheit "${c.person ?? '?'}" bestehen ${c.konflikte} Konflikt(e) zwischen erklärtem und berechnetem Wert.`,
        basis: { quelle: 'mcp', ref: `konflikt:${c.person ?? '?'}` }, erwartet: { typ: 'text', person: c.person },
      });
  }

  // C) Beleg nicht lesbar / 0 Felder → erneut liefern.
  for (const b of belege) {
    const deferred = String(b.status ?? '').includes('deferred');
    if (deferred || (b.felder ?? 0) === 0) {
      const name = (b.source ?? '').split('#')[0].split('/').pop() || 'Beleg';
      push({
        kind: 'missing_beleg', severity: 'blocker',
        fakt: `Verifizierter Befund (Beleg-Status): Der Beleg "${name}" (${b.belegTyp ?? 'Unbekannt'}) konnte nicht ausgewertet werden (${deferred ? 'OCR zurückgestellt' : '0 Felder erkannt'}). Ein lesbares Exemplar wird benötigt.`,
        basis: { quelle: 'rule', ref: `unlesbar:${name}` }, erwartet: { typ: 'upload', belegTyp: b.belegTyp },
      });
    }
  }

  // D) Zusammenveranlagung, aber keine Person-B-Daten.
  if (data.veranlagungsart === 'zusammen') {
    const hasB = belege.some((b) => b.person === 'B') || fields.some((f) => f.person === 'B');
    if (!hasB)
      push({
        kind: 'open_question', severity: 'empfohlen',
        fakt: `Verifizierter Befund (Haushalt): Es wurde Zusammenveranlagung erkannt, aber es liegen keine Belege oder Felder für Person B vor. Zu klären, ob Person B im Veranlagungszeitraum Einkünfte hatte.`,
        basis: { quelle: 'rule', ref: 'zusammen-ohne-b' }, erwartet: { typ: 'boolean', person: 'B' },
      });
  }

  // E) Kapitalerträge vorhanden, aber Sparer-Pauschbetrag 0/fehlt → Freistellungsauftrag.
  const hasKap = fields.some((f) => String(f.anlage).toLowerCase() === 'kap' && isMoney(f.wert));
  const sparer = fields.find((f) => f.eCode === 'E1901402');
  if (hasKap && (!sparer || !isMoney(sparer.wert)))
    push({
      kind: 'open_question', severity: 'empfohlen',
      fakt: `Verifizierter Befund (Katalog-KG): Es liegen Kapitalerträge (Anlage KAP) vor, aber kein Sparer-Pauschbetrag (E1901402 = ${sparer?.wert ?? 'leer'}). Zu klären, ob ein Freistellungsauftrag bzw. der Sparer-Pauschbetrag (801 € einzeln / 1602 € zusammen) berücksichtigt wurde.`,
      basis: { quelle: 'catalog', ref: 'kap-ohne-sparer' }, erwartet: { typ: 'value', eCode: 'E1901402' },
    });

  // F) Vollständigkeit gegen die volle EST MIT Recovery-Regel: erst aus Beleg /
  // Berechnung / Vorjahr recovern, nur was nirgends herkommt wird gefragt.
  for (const r of pruefeSoll(data).ergebnisse) {
    if (r.status === 'erfuellt') continue;
    const it = r.item;
    const basis = { quelle: 'rule' as const, ref: `soll:${it.id}` };
    const pre = `Verifizierter Befund (Soll-Liste · ${it.kategorie}): „${it.label}"`;
    if (r.status === 'im_beleg') {
      push({ kind: 'confirm_value', severity: 'empfohlen', fakt: `${pre} ${r.hinweis}.`,
        frage: `Bitte „${it.label}" aus dem Beleg „${r.belegTyp}" übernehmen und bestätigen.`,
        basis, erwartet: { typ: 'value', eCode: it.eCodes[0] } });
    } else if (r.status === 'berechenbar') {
      push({ kind: 'optimize', severity: 'optional', fakt: `${pre} — ${r.hinweis}`,
        frage: r.hinweis, basis, erwartet: { typ: 'text', eCode: it.eCodes[0] } });
    } else if (r.status === 'vorjahr') {
      const vw = r.vorjahrWert ? ` Vorjahreswert: ${r.vorjahrWert}.` : '';
      push({ kind: 'confirm_value', severity: 'empfohlen', fakt: `${pre} ${r.hinweis}.`,
        frage: `„${it.label}" aus der Vorjahres-Erklärung übernehmen?${vw}`,
        basis, erwartet: { typ: 'boolean', eCode: it.eCodes[0] } });
    } else {
      const istAbzug = it.kategorie === 'Werbungskosten' || it.kategorie === 'Kapitalerträge';
      push({ kind: istAbzug ? 'optimize' : 'open_question', severity: it.severity,
        fakt: `${pre} fehlt im Fall (${it.herkunft}).`, frage: it.frage,
        basis, erwartet: { typ: istAbzug ? 'boolean' : 'value', eCode: it.eCodes[0] } });
    }
  }

  // G) Vorjahres-Kontext: fremdjährige Belege (z.B. eine 2023er Erklärung in
  //    einem VZ-2024-Fall) liefern KEINE Rechenwerte, aber Hinweise. Stabile
  //    Stammdaten, die im aktuellen Jahr fehlen → übernehmen (confirm_value);
  //    fehlende Beträge → gezielt nachfragen (open_question, Wert NIE auto-
  //    übernommen). Kuratiert behandelte (Soll-Liste) und im aktuellen Jahr
  //    bereits belegte eCodes werden übersprungen — kein Doppel-Befund.
  const aktuelleECodes = new Set(fields.map((f) => f.eCode));
  for (const v of data.vorjahr?.felder ?? []) {
    if (v.kind === 'vorhanden' || v.vorhandenAktuell) continue;
    if (SOLL_ECODES.has(v.eCode) || aktuelleECodes.has(v.eCode)) continue;
    const wert = val(v.wert);
    const label = v.pdfLabel || v.eCode;
    if (v.kind === 'prefill') {
      push({
        kind: 'confirm_value', severity: 'empfohlen',
        fakt: `Verifizierter Befund (Vorjahres-Kontext): „${label}" (${v.eCode}) = ${wert} stammt aus der Vorjahres-Erklärung (${v.dokumentJahr}) und ist im aktuellen Jahr nicht belegt. Stabile Stammdaten können übernommen werden — bitte bestätigen.`,
        frage: `„${label}" aus dem Vorjahr (${v.dokumentJahr}) übernehmen? Wert: ${wert}.`,
        basis: { quelle: 'rule', ref: `vorjahr:${v.eCode}` },
        erwartet: { typ: 'boolean', eCode: v.eCode, person: v.person },
      });
    } else {
      push({
        kind: 'open_question', severity: 'optional',
        fakt: `Verifizierter Befund (Vorjahres-Kontext): Im Vorjahr (${v.dokumentJahr}) war „${label}" (${v.eCode}) = ${wert} (Betrag); im aktuellen Jahr liegt dazu nichts vor. Der Vorjahreswert wird NICHT in die Berechnung übernommen — zu klären, ob ein entsprechender Betrag im Veranlagungszeitraum anfällt.`,
        frage: `Im Vorjahr (${v.dokumentJahr}): „${label}" = ${wert}. Gibt es einen entsprechenden Betrag auch im aktuellen Jahr?`,
        basis: { quelle: 'rule', ref: `vorjahr-betrag:${v.eCode}` },
        erwartet: { typ: 'value', eCode: v.eCode, person: v.person },
      });
    }
  }

  const order: Record<Severity, number> = { blocker: 0, empfohlen: 1, optional: 2 };
  out.sort((a, b) => order[a.severity] - order[b.severity]);
  const score = { blocker: 0, empfohlen: 0, optional: 0, total: out.length };
  for (const f of out) score[f.severity]++;
  return { findings: out, score };
}
