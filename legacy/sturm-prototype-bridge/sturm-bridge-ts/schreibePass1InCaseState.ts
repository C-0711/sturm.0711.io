// ════════════════════════════════════════════════════════════════════════════
// schreibePass1InCaseState.ts — Pass-1-only Bridge (Phase A).
//
// Im Gegensatz zu schreibeSturmInCaseState() baut diese Funktion KEINE
// Annahmen ueber ELSTER-Codes. Sie nimmt die rohen Mistral-Small-KPIs
// {key, value} und schreibt sie 1:1 als Felder in den case_state. Die
// Felder bekommen einen DETERMINISTISCHEN domain_pfad `sturm.<slug>`,
// abgeleitet aus dem Key — ohne Mapping-Tabelle, ohne ELSTER-Code.
//
// Personen werden aus den Key-Suffixen abgeleitet (Person A / Person B),
// nur die offensichtlichen Stammdaten (Vorname, Nachname, IdNr, Religion,
// Geburtsdatum, Anschrift) — alles andere bleibt als generisches Feld
// auf der Person bzw. allgemein im Beleg.
//
// Phase B (separat) baut darauf auf und ergaenzt das Mapping auf
// ELSTER-Codes via DB-Lookup.
// ════════════════════════════════════════════════════════════════════════════

import type { Actor } from "../core/types/case_state.js";
import { applyTool } from "../core/index.js";
import {
  initialisiereFallFallsNoetig,
  leiteCaseIdAb,
} from "./applyToCaseState.js";
import { validatePass2Output, type Pass2Wert as ValPass2Wert } from "./validateSturmOutput.js";
import pg from "pg";

// Lazy-init pg pool nur fuer die Validation; teilt sich Connection mit
// der Haupt-DB ueber DATABASE_URL.
let _validationPool: pg.Pool | null = null;
function getValidationPool(): pg.Pool {
  if (_validationPool) return _validationPool;
  const url = process.env.DATABASE_URL ??
    `postgresql://${process.env.DB_USER ?? "ctax"}:${process.env.DB_PASSWORD ?? ""}` +
    `@${process.env.DB_HOST ?? "localhost"}:${process.env.DB_PORT ?? "9432"}` +
    `/${process.env.DB_NAME ?? "ctax_cb_chat"}`;
  _validationPool = new pg.Pool({
    connectionString: url,
    options: "-c search_path=ag_catalog,ctax,public",
  });
  return _validationPool;
}

// ─── Typen ──────────────────────────────────────────────────────────────────

export interface Pass1Kpi {
  key: string;
  value: string;
  /** STURM-Citation: Seite + Original-Text-Auszug aus dem PDF. Wird in
   *  alle_werte[].zitat geschrieben — UI rendert es als Quellnachweis. */
  citation?: {
    page?: number | null;
    charOffset?: number | null;
    length?: number | null;
    evidence?: string | null;
    confidence?: string | null;
    matchedText?: string | null;
  } | null;
}

/**
 * STURM Pass-2-Output: vom JSON-Schema gefuehrte Mistral-Extraktion pro
 * recommendedAnlage. Liefert direkt eCode-keyed Werte mit Anlage + Drucktext.
 * Wenn vorhanden, ist das die authoritative Quelle fuer ELSTER-Codes —
 * Smart-Schema-Lookup fungiert dann nur noch als Backup fuer Felder die
 * Pass-2 nicht gefunden hat.
 */
export interface Pass2Wert {
  elster_code: string;
  value: string;
  anlage: string;
  drucktext?: string;
  vordruckzeile?: string;
}

export interface SchreibePass1Optionen {
  dateiname?: string | null;
  mime?: string | null;
  sha256?: string | null;
  actor?: Actor;
  actor_id?: string | null;
  defaultKonfidenz?: number;
}

export interface SchreibePass1Ergebnis {
  case_id: string;
  beleg_id: string;
  felder_geschrieben: number;
  personen_geschrieben: number;
  fehler?: string;
}

// ─── Slug-Bildung ───────────────────────────────────────────────────────────

/**
 * Baut aus einem Mistral-Small-KPI-Key einen slug-tauglichen Pfad.
 * Beispiele:
 *   "Bruttoarbeitslohn Person A"   -> "bruttoarbeitslohn_person_a"
 *   "IBAN"                          -> "iban"
 *   "Übermittlung Datum / Uhrzeit"  -> "uebermittlung_datum_uhrzeit"
 *
 * Strategie: NFD → ASCII (Umlaute aufloesen), nicht-alphanumerisch zu "_",
 * Mehrfach-Underscore zusammenziehen, lower-case. Deterministisch:
 * gleicher Key liefert IMMER denselben Slug.
 */
export function slugifyKey(key: string): string {
  const ohneUmlaute = key
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .replace(/Ø/g, "o");
  return ohneUmlaute
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

// ─── Person-Pattern-Erkennung ───────────────────────────────────────────────

const PERSON_B_REGEX = /\b(person\s*b|partner|ehepartner|ehegatte)\b/i;
const PERSON_A_REGEX = /\b(person\s*a)\b/i;

function detektierePerson(key: string): "A" | "B" | null {
  if (PERSON_B_REGEX.test(key)) return "B";
  if (PERSON_A_REGEX.test(key)) return "A";
  return null;
}

/**
 * Heuristische Stammdaten-Klassifikation eines Keys. Wir entscheiden hier
 * nur "ist das ein Person-Stammdatum-Feld?" — ohne ELSTER-Code-Mapping.
 *
 * Liefert das Ziel-Attribut auf der Person ('vorname', 'nachname', 'idnr',
 * 'religion', 'geburtsdatum') oder null, wenn das Feld nicht zur Person
 * gehoert.
 */
function detektiereStammdatum(key: string): string | null {
  const k = key.toLowerCase();
  // IdNr-Varianten
  if (/identifikationsnummer|idnr|steuer-?id\b/i.test(key)) return "idnr";
  // Vorname / Nachname
  if (/^vorname\b|\bvorname\b/.test(k) && !/arbeitgeber/.test(k)) return "vorname";
  if (/^nachname\b|\bnachname\b/.test(k) && !/arbeitgeber/.test(k)) return "nachname";
  // Religion / Konfession / Kirchensteuermerkmal
  if (/religion|konfession|kirchensteuermerkmal/i.test(k)) return "religion";
  // Geburtsdatum
  if (/geburtsdatum|geburtstag/i.test(k)) return "geburtsdatum";
  // Titel
  if (/^titel\b/.test(k)) return "titel";
  return null;
}

interface PersonAggregat {
  rolle: "A" | "B";
  vorname: string | null;
  nachname: string | null;
  idnr: string | null;
  religion: string | null;
  geburtsdatum: string | null;
  titel: string | null;
}

function leerePerson(rolle: "A" | "B"): PersonAggregat {
  return {
    rolle,
    vorname: null,
    nachname: null,
    idnr: null,
    religion: null,
    geburtsdatum: null,
    titel: null,
  };
}

function aggregierePersonen(kpis: Pass1Kpi[]): PersonAggregat[] {
  const a = leerePerson("A");
  const b = leerePerson("B");
  let aHatTreffer = false;
  let bHatTreffer = false;

  for (const kpi of kpis) {
    const stamm = detektiereStammdatum(kpi.key);
    if (!stamm) continue;
    const person = detektierePerson(kpi.key);
    // Ohne Person-Hint: standardmaessig auf A
    const ziel = person === "B" ? b : a;
    if (person === "B") bHatTreffer = true;
    else aHatTreffer = true;
    const wert = kpi.value?.trim() || null;
    if (!wert) continue;
    // Erstes Auftreten gewinnt — nicht ueberschreiben (Stricker korrigiert
    // -Pattern liefert manchmal varianten)
    if (stamm === "vorname" && !ziel.vorname) ziel.vorname = wert;
    else if (stamm === "nachname" && !ziel.nachname) ziel.nachname = wert;
    else if (stamm === "idnr" && !ziel.idnr) ziel.idnr = wert.replace(/\D/g, "") || wert;
    else if (stamm === "religion" && !ziel.religion) ziel.religion = wert;
    else if (stamm === "geburtsdatum" && !ziel.geburtsdatum) ziel.geburtsdatum = wert;
    else if (stamm === "titel" && !ziel.titel) ziel.titel = wert;
  }

  const out: PersonAggregat[] = [];
  if (aHatTreffer) out.push(a);
  if (bHatTreffer) out.push(b);
  return out;
}

// ─── Hauptfunktion ──────────────────────────────────────────────────────────

/**
 * Phase-A-Bridge: schreibt Pass-1-KPIs als generische Felder + Personen
 * in den case_state. KEIN ELSTER-Mapping.
 *
 * Reihenfolge:
 *   1. case_state init falls noetig
 *   2. BELEG_ANGENOMMEN
 *   3. BELEG_KLASSIFIZIERT (nur typ + label, keine anlagen_hints)
 *   4. BELEG_EXTRAHIERT mit roh-Feldern (domain_pfad = sturm.<slug>)
 *   5. PERSON_HINZUFUEGEN pro Person (aus Key-Pattern aggregiert)
 */
export async function schreibePass1InCaseState(args: {
  fall_id: string;
  beleg_id: string;
  mandant_id?: string | null;
  steuerjahr: number;
  doc_type_label: string;
  kpis: Pass1Kpi[];
  /** STURM Pass-2-Output: eCode-keyed Werte. Wenn vorhanden, werden sie
   *  als authoritative ELSTER-Code-Quelle genutzt. Pass-1-KPIs liefern
   *  zusaetzlich Person-Stammdaten (PERSON_HINZUFUEGEN) sowie Felder die
   *  Pass-2 nicht abgedeckt hat. */
  pass2Values?: Pass2Wert[];
  /** Sprint 2: Pass-1's recommendedAnlagen (z.B. ['ESt1A','N','VOR','Vorsatz']).
   *  Wird durch /validate-anlagen-scope normalisiert + halluzinationsbereinigt
   *  + via doctype_pflicht_anlagen ergaenzt, dann als anlagen_scope an
   *  /klassifiziere-kpis durchgereicht. */
  recommendedAnlagen?: string[];
  optionen?: SchreibePass1Optionen;
}): Promise<SchreibePass1Ergebnis> {
  const caseId = leiteCaseIdAb(args.fall_id, args.mandant_id, args.steuerjahr);
  const actor: Actor = args.optionen?.actor ?? "system";
  const actorId = args.optionen?.actor_id ?? "sturm.client.pass1";
  const defaultKonfidenz = args.optionen?.defaultKonfidenz ?? 0.95;

  const ergebnis: SchreibePass1Ergebnis = {
    case_id: caseId,
    beleg_id: args.beleg_id,
    felder_geschrieben: 0,
    personen_geschrieben: 0,
  };

  // ─── 1) Case ggf. anlegen ────────────────────────────────────────────────
  try {
    await initialisiereFallFallsNoetig(
      caseId,
      args.mandant_id ?? "default",
      args.steuerjahr,
    );
  } catch (e: any) {
    ergebnis.fehler = `init: ${e?.message ?? String(e)}`;
    console.error(`[schreibePass1] case_state-Init fehlgeschlagen fuer ${caseId}:`, e);
    return ergebnis;
  }

  // ─── 2) BELEG_ANGENOMMEN ────────────────────────────────────────────────
  try {
    await applyTool({
      case_id: caseId,
      tool: "BELEG_ANGENOMMEN",
      actor,
      actor_id: actorId,
      payload: {
        beleg_id: args.beleg_id,
        dateiname: args.optionen?.dateiname ?? `sturm-${args.beleg_id}`,
        mime: args.optionen?.mime ?? null,
        sha256: args.optionen?.sha256 ?? null,
        quellen_typ: "ki_extraktion",
        prioritaet: 5,
      },
    });
  } catch (e: any) {
    ergebnis.fehler = `BELEG_ANGENOMMEN: ${e?.message ?? String(e)}`;
    console.error(`[schreibePass1] BELEG_ANGENOMMEN fehlgeschlagen fuer ${caseId}:`, e);
    return ergebnis;
  }

  // ─── 3) BELEG_KLASSIFIZIERT (ohne anlagen_hints — kein Mapping) ─────────
  try {
    await applyTool({
      case_id: caseId,
      tool: "BELEG_KLASSIFIZIERT",
      actor,
      actor_id: actorId,
      payload: {
        beleg_id: args.beleg_id,
        typ: args.doc_type_label || "unbekannt",
        doc_typ_konfidenz: defaultKonfidenz,
        steuerjahr_des_belegs: args.steuerjahr,
        primaere_anlage: null,
        anlagen_hints: {},
      },
    });
  } catch (e: any) {
    console.error(`[schreibePass1] BELEG_KLASSIFIZIERT fehlgeschlagen fuer ${caseId}:`, e);
  }

  // ─── 4) Pass-1-Felder via BELEG_EXTRAHIERT in case_state schreiben ──────
  // Phase B: Smart-Schema /klassifiziere-kpis liefert pro KPI den echten
  // ELSTER-Code (E0xxxxxx) wenn die Konfidenz reicht. Faellt sie unter den
  // Schwellwert oder kennt Smart-Schema den Key nicht → Phase-A-Fallback
  // KPI:<slug>, damit der Reducer (NOT-NULL) durchgeht und der Wert im
  // case_state sichtbar bleibt.
  const SMART_SCHEMA_URL = process.env.SMART_SCHEMA_URL || "http://localhost:7820";
  const ECODE_KONFIDENZ_SCHWELLE = 0.5;

  // ─── Sprint 2: Anlagen-Validator als Pre-Step ─────────────────────────
  // Pass-1's recommendedAnlagen werden gegen lane5_elster_export.anlagen_aliase
  // normalisiert, gegen v_field_catalog/elster_kennzahlen validiert (Halluzinations-
  // Filter) und um doctype_pflicht_anlagen ergaenzt. Resultat geht als
  // anlagen_scope an /klassifiziere-kpis weiter. Best-effort: bei Fehler
  // wird recommendedAnlagen unveraendert durchgereicht.
  let validierterScope: string[] | undefined;
  let scopeAuditInfo = "(kein Validator-Lauf)";
  try {
    const r = await fetch(`${SMART_SCHEMA_URL}/validate-anlagen-scope`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pass1_anlagen: args.recommendedAnlagen ?? [],
        doc_type: args.doc_type_label || null,
      }),
    });
    if (r.ok) {
      const data: any = await r.json();
      validierterScope = Array.isArray(data?.gueltiger_scope) ? data.gueltiger_scope : undefined;
      const verworfen = (data?.verworfen ?? []).join(",") || "-";
      const hinzugefuegt = (data?.hinzugefuegt ?? []).join(",") || "-";
      scopeAuditInfo = `verworfen=[${verworfen}] hinzugefuegt=[${hinzugefuegt}]`;
    }
  } catch (e: any) {
    console.warn(`[schreibePass1] validate-anlagen-scope fehlgeschlagen, fallback: ${e?.message}`);
  }
  console.log(
    `[schreibePass1] anlagen_scope (doc_type=${args.doc_type_label}): ` +
    `pass1=[${(args.recommendedAnlagen ?? []).join(",")}] → ` +
    `validiert=[${(validierterScope ?? []).join(",")}] ${scopeAuditInfo}`,
  );

  // KPI-Klassifikation einmal als Batch (kein Per-KPI-Roundtrip)
  // Sprint 4: Switchover auf v_field_catalog (composite-score, Antrag-Slot,
  // Token-EXAKT, Konfidenz-Cap @ 0.95). audit_diff=true persistiert die
  // Vergleichs-Diffs gegen den alten ag_catalog-Pfad in
  // lane5_elster_export.kpi_match_diff_audit fuer Live-Auditierung.
  // Rollback: SMART_SCHEMA_MATCH_SOURCE=ag_catalog setzen.
  const matchSource = process.env.SMART_SCHEMA_MATCH_SOURCE || "v_field_catalog";
  const auditDiff = (process.env.SMART_SCHEMA_AUDIT_DIFF ?? "1") !== "0";

  const ecodeMap = new Map<string, { elster_code: string; anlage?: string; konfidenz: number }>();
  try {
    const r = await fetch(`${SMART_SCHEMA_URL}/klassifiziere-kpis`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kpis: args.kpis.map(k => ({ key: k.key, value: String(k.value ?? "") })),
        // ELSTER-Drucktexte sind in der DB nur fuer tax_year=2024 hinterlegt;
        // sie sind zwischen 2023 und 2024 stabil, daher konsistent 2024 nutzen
        // (verhindert dass 2023-Faelle keine Treffer bekommen).
        steuerjahr: 2024,
        doc_type: args.doc_type_label || null,
        // Sprint 2: validierter Scope an Smart-Schema durchreichen
        ...(validierterScope ? { anlagen_scope: validierterScope } : {}),
        // Sprint 4: Switchover
        match_source: matchSource,
        audit_diff: auditDiff,
        fall_id: caseId,
        beleg_id: args.beleg_id,
      }),
    });
    if (r.ok) {
      const data: any = await r.json();
      for (const item of (data.gemappt ?? [])) {
        if (item?.elster_code && (item.konfidenz ?? 0) >= ECODE_KONFIDENZ_SCHWELLE) {
          ecodeMap.set(item.key, {
            elster_code: item.elster_code,
            anlage: item.anlage,
            konfidenz: item.konfidenz,
          });
        }
      }
    }
  } catch (e: any) {
    console.warn(`[schreibePass1] Smart-Schema klassifiziere-kpis fehlgeschlagen, fallback Phase A: ${e?.message}`);
  }

  try {
    // Pass-2-Werte: schon eCode-keyed direkt aus dem Mistral-JSON-Schema.
    // VOR dem Schreiben: Validierung gegen ag_catalog.elster_fields, damit
    // kaputte Werte ("Maria Ute" als Nachname, "Rainer Stricker" als Vorname,
    // "abc" als Betrag) gar nicht erst ins case_state landen.
    const rohPass2 = (args.pass2Values ?? []) as ValPass2Wert[];
    let pass2 = rohPass2;
    if (rohPass2.length > 0) {
      try {
        const valResult = await validatePass2Output(rohPass2, getValidationPool());
        if (valResult.rejected.length > 0) {
          for (const issue of valResult.rejected) {
            console.warn(
              `[schreibePass1] Pass-2-Wert verworfen [${issue.severity}] ` +
              `${issue.elster_code}="${issue.value}" (${issue.bezeichnung}): ${issue.reason}`,
            );
          }
        }
        pass2 = valResult.accepted as any;
        if (valResult.rejected.length > 0) {
          console.log(
            `[schreibePass1] Pass-2-Validation: ${valResult.accepted.length}/${valResult.total} akzeptiert, ` +
            `${valResult.rejected.length} verworfen.`,
          );
        }
      } catch (e: any) {
        console.warn(`[schreibePass1] Pass-2-Validation fehlgeschlagen, fallback unvalidiert: ${e?.message ?? e}`);
        pass2 = rohPass2;
      }
    }
    const pass2ECodes = new Set<string>(pass2.map(v => v.elster_code));

    // Pass-2-Felder zuerst — eCode/Anlage direkt aus Mistral-Schema.
    const pass2Felder = pass2
      .filter(v => (v.value ?? "").toString().trim().length > 0)
      .map(v => ({
        domain_pfad: `elster.${v.elster_code}`,
        person_id: null,             // Pass-2 trennt Person nicht; Wert
                                      // ist generisch fuer den eCode-Slot.
                                      // Personen-Aggregation laeuft via
                                      // PERSON_HINZUFUEGEN (Pass-1-Pfad).
        primaerer_elster_code: v.elster_code,
        elster_code_aliase: [],
        anlagen: [v.anlage],
        primaere_anlage: v.anlage,
        value_type: "string" as const,
        wert: String(v.value ?? ""),
        wert_einheit: null,
        konfidenz: 0.97,             // Pass-2 ist hoechste Konfidenz
                                      // (JSON-Schema-gefuehrt + dokument-belegt)
        sub_id: null,
        label: v.drucktext ?? v.elster_code,
        person_idnr: null,
      }));

    // Pass-1-Felder als Backup — nur fuer KPIs die NICHT bereits in Pass-2
    // gemappt sind. Echter eCode kommt aus Smart-Schema (Konfidenz-Filter),
    // sonst KPI:slug.
    const pass1Felder = args.kpis
      .filter((kpi) => (kpi.value ?? "").toString().trim().length > 0)
      .map((kpi) => {
        const slug = slugifyKey(kpi.key);
        const personHint = detektierePerson(kpi.key);
        const personId = personHint === "B" ? "p_b" : personHint === "A" ? "p_a" : null;
        const eCodeMatch = ecodeMap.get(kpi.key);
        const echterECode = eCodeMatch?.elster_code ?? null;
        // Citation aus Pass-1 als zitat in alle_werte schreiben.
        const zitat = kpi.citation ? {
          seite: typeof kpi.citation.page === "number" ? kpi.citation.page : null,
          zeile: null,
          bbox: null as [number, number, number, number] | null,
          text_snippet: kpi.citation.evidence ?? kpi.citation.matchedText ?? null,
          feld_bezeichnung_im_doc: kpi.key,
        } : null;
        return {
          domain_pfad: echterECode ? `elster.${echterECode}` : `sturm.${slug}`,
          person_id: personId,
          primaerer_elster_code: echterECode ?? `KPI:${slug}`,
          elster_code_aliase: [],
          anlagen: eCodeMatch?.anlage ? [eCodeMatch.anlage] : [] as string[],
          primaere_anlage: eCodeMatch?.anlage ?? "",
          value_type: "string" as const,
          wert: String(kpi.value ?? ""),
          wert_einheit: null,
          konfidenz: eCodeMatch?.konfidenz ?? defaultKonfidenz,
          sub_id: null,
          label: kpi.key,
          person_idnr: null,
          zitat,
        };
      })
      // Filter: skippe Pass-1-KPIs die bereits einen Pass-2-eCode haben
      // (sonst Doppel-Schreibung auf demselben elster.<code>-Pfad).
      .filter(f => !pass2ECodes.has(f.primaerer_elster_code));

    const felderForReducer = [...pass2Felder, ...pass1Felder];

    if (felderForReducer.length > 0) {
      await applyTool({
        case_id: caseId,
        tool: "BELEG_EXTRAHIERT",
        actor,
        actor_id: actorId,
        payload: {
          beleg_id: args.beleg_id,
          felder: felderForReducer,
          extraktions_quelle: "sturm_pass2",
          konfidenz_durchschnitt: pass2.length > 0 ? 0.97 : defaultKonfidenz,
        },
      });
      ergebnis.felder_geschrieben = felderForReducer.length;
      console.log(
        `[schreibePass1] Pass-2: ${pass2Felder.length} eCode-Felder + ` +
        `Pass-1: ${pass1Felder.length} KPI-Felder = ${felderForReducer.length} gesamt`,
      );
    }
  } catch (e: any) {
    console.error(
      `[schreibePass1] BELEG_EXTRAHIERT fehlgeschlagen fuer ${caseId}:`,
      e,
    );
  }

  // ─── 5) PERSON_HINZUFUEGEN ──────────────────────────────────────────────
  try {
    const personen = aggregierePersonen(args.kpis);
    for (const p of personen) {
      try {
        await applyTool({
          case_id: caseId,
          tool: "PERSON_HINZUFUEGEN",
          actor,
          actor_id: actorId,
          payload: {
            person_id: p.rolle === "A" ? "p_a" : "p_b",
            rolle: p.rolle === "A" ? "steuerpflichtiger_a" : "steuerpflichtiger_b",
            idnr: p.idnr ?? null,
            vorname: p.vorname ?? null,
            nachname: p.nachname ?? null,
            geburtsdatum: p.geburtsdatum ?? null,
            religion: p.religion ?? null,
            anschrift: null,
            iban: null,
            bic: null,
            konfidenz_identitaet: defaultKonfidenz,
            quelle_beleg_id: args.beleg_id,
          },
        });
        ergebnis.personen_geschrieben += 1;
      } catch (e: any) {
        console.error(
          `[schreibePass1] PERSON_HINZUFUEGEN ${p.rolle} fehlgeschlagen fuer ${caseId}:`,
          e,
        );
      }
    }
  } catch (e: any) {
    console.error(`[schreibePass1] Personen-Aggregation fehlgeschlagen:`, e);
  }

  console.log(
    `[schreibePass1] case_state ${caseId}: ` +
    `${ergebnis.felder_geschrieben} Felder + ${ergebnis.personen_geschrieben} Personen ` +
    `(beleg=${args.beleg_id}, doc_type=${args.doc_type_label})`,
  );

  return ergebnis;
}
