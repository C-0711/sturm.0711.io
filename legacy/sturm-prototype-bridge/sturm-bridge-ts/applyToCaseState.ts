// ════════════════════════════════════════════════════════════════════════════
// applyToCaseState.ts — Bruecke STURM-Output -> case_state via applyTool().
//
// Wave 24 Phase E: STURM extrahiert pro Beleg ~65 ELSTER-Werte mit eCode +
// person + anlage. Bisher landeten diese Werte nur in
// tax_case.documents[].sturm_kpis (label-keyed Legacy-Dump). Der neue
// case_state-Schreibpfad pflegt sie sauber als BELEG_ANGENOMMEN +
// BELEG_KLASSIFIZIERT + BELEG_EXTRAHIERT + PERSON_HINZUFUEGEN-Patches ein,
// damit die PersonenakteKachel + Wave-16-Plausibilitaet + Phase-D-Pflege-
// Punkte ihre Datenquelle bekommen.
//
// Keine direkten Reducer-Calls — alle Mutationen gehen ueber applyTool(),
// damit Audit-Log, Optimistic-Locking und Eventbus konsistent bleiben.
//
// Soft-Fail: jede Persistenz-Exception wird intern geloggt aber nicht
// propagiert. STURM-Upload bleibt erfolgreich, auch wenn case_state-
// Schreibung fehlschlaegt (Brueckenlogik darf den Hauptpfad nicht brechen).
// ════════════════════════════════════════════════════════════════════════════

import { randomUUID } from "node:crypto";
import type {
  CaseState,
  Actor,
  ValueType,
} from "../core/types/case_state.js";
import { applyTool, loadAndGetSnapshot } from "../core/index.js";
import { saveCase, loadCase, CaseNotFoundError } from "../core/caseStore.js";
import { SCHEMA_VERSION } from "../core/schemaVersion.js";
import {
  aggregierePersonenAusWerten,
  type SturmRohWert,
  type AggregiertePerson,
} from "./aggregierePersonen.js";

// ─── Typen ──────────────────────────────────────────────────────────────────

/**
 * STURM `anreicherung/output.json`-Form (Subset der von uns konsumierten
 * Felder). Vollstaendig: per_anlage / alle_werte / summen.
 */
export interface SturmOutput {
  per_anlage?: Record<string, unknown>;
  alle_werte: SturmRohWert[];
  summen?: unknown;
}

export interface SchreibeOptionen {
  /** Optional: Dateiname des Original-Belegs fuer BELEG_ANGENOMMEN. */
  dateiname?: string | null;
  /** Optional: MIME des Original-Belegs. */
  mime?: string | null;
  /** Optional: SHA256 zur Idempotenz-Pruefung im Beleg-Eintrag. */
  sha256?: string | null;
  /** Default: { actor: 'system', actor_id: 'sturm.client' } */
  actor?: Actor;
  actor_id?: string | null;
  /** Default: 0.95 — STURM-Output hat keine per-Wert-Konfidenz. */
  defaultKonfidenz?: number;
}

export interface SchreibeErgebnis {
  case_id: string;
  beleg_id: string;
  felder_geschrieben: number;
  personen_geschrieben: number;
  fehler?: string;
}

// ─── case_id-Synthese ───────────────────────────────────────────────────────

/**
 * Deterministischer case_id-Schluessel im 0711-Format.
 *
 * Pattern: `0711:ctax:b2c:<mandant>:<jahr>:<fall_id_short>`
 *
 * @example
 *   leiteCaseIdAb('a3f7c1d2-...', 'cb-chat', 2024)
 *     -> '0711:ctax:b2c:cb-chat:2024:a3f7c1d2'
 */
export function leiteCaseIdAb(
  fallId: string,
  mandantId: string | null | undefined,
  steuerjahr: number,
): string {
  const mandant = (mandantId ?? "default").trim() || "default";
  const kurz = fallId.replace(/-/g, "").slice(0, 8);
  return `0711:ctax:b2c:${mandant}:${steuerjahr}:${kurz}`;
}

// ─── Helper: STURM-Format -> case_state ─────────────────────────────────────

/**
 * Mapping STURM-Format-Code -> case_state ValueType.
 *
 * STURM-Formate (gesehen in Stricker-Fixture):
 *   D = Date          -> "date"
 *   I = Integer       -> "integer"
 *   C = Char/String   -> "string"
 *   X = Boolean       -> "boolean"
 *   J = Ja-Flag       -> "boolean"
 *   H = Enum/Hint     -> "enum"
 *   U/N/P/G/% = Numerisch -> "number"
 *   B = Range/Block   -> "string" (kein eigener case_state-Typ)
 *   O = Auswahl       -> "string"
 *
 * Default: "string" — robust gegen unbekannte STURM-Codes.
 */
export function deriveValueType(format: string | null | undefined): ValueType {
  if (!format) return "string";
  const f = format.trim().toUpperCase();
  switch (f) {
    case "D": return "date";
    case "I": return "integer";
    case "X": return "boolean";
    case "J": return "boolean";
    case "H": return "enum";
    case "U":
    case "N":
    case "P":
    case "G":
    case "%": return "number";
    default: return "string";
  }
}

/**
 * Mapping ELSTER-Code -> domain_pfad.
 *
 * Fuer die haeufigsten Person-/Stammdaten-Codes pflegen wir explizite Pfade
 * (kompatibel zu Konventionen in opusOrchestrator/anlagenAuswahl). Fuer den
 * Rest bilden wir einen deterministischen Default `${anlage}.${ecode}` (lower).
 *
 * Diese Tabelle ist absichtlich klein gehalten — sie soll nur dort wachsen,
 * wo Berechnungs-Module (Lane 1) den Pfad als Schluessel erwarten. Der
 * primaerer_elster_code im Feld bleibt die wahre Quelle der Wahrheit fuer
 * ELSTER-Mapping (felder.nach_elster_code-Index).
 */
const PFAD_TABELLE: Record<string, string> = {
  // Stammdaten Person A
  E0100201: "stammdaten.nachname",
  E0100301: "stammdaten.vorname",
  E0100401: "stammdaten.geburtsdatum",
  E0100081: "stammdaten.idnr",
  E0100402: "stammdaten.religion",
  E0100403: "stammdaten.beruf",

  // Stammdaten Person B
  E0100901: "stammdaten.nachname",
  E0100801: "stammdaten.vorname",
  E0101001: "stammdaten.geburtsdatum",
  E0100082: "stammdaten.idnr",
  E0101002: "stammdaten.religion",

  // Adresse (gemeinsam)
  E0101104: "adresse.strasse",
  E0101206: "adresse.hausnummer",
  E0100601: "adresse.plz",
  E0100602: "adresse.ort",

  // Bankverbindung
  E0102102: "bankverbindung.iban",
};

export function deriveDomainPfad(eCode: string, anlage: string | null | undefined): string {
  const expliziter = PFAD_TABELLE[eCode];
  if (expliziter) return expliziter;
  const a = (anlage ?? "sonstige").toLowerCase();
  return `${a}.${eCode.toLowerCase()}`;
}

/** Gibt die IdNr fuer eine Person aus den STURM-Werten zurueck (oder null). */
export function getIdnrFuerPerson(
  werte: SturmRohWert[],
  person: "A" | "B" | null | undefined,
): string | null {
  if (!person) return null;
  const code = person === "A" ? "E0100081" : "E0100082";
  const treffer = werte.find((w) => w.eCode === code);
  if (!treffer) return null;
  const v = treffer.wert;
  return v === null || v === undefined ? null : String(v).trim() || null;
}

// ─── Case-Initialisierung ───────────────────────────────────────────────────

/**
 * Erzeugt einen leeren CaseState v1.1 mit den Pflicht-Slots. Wird ueber
 * saveCase() in die DB geschrieben (revision=0), damit applyTool() ab
 * expectedRevision=0 zuschlagen kann.
 *
 * Achtung: identische Form wie in `core/test/integration.test.ts`
 * `leererCaseState()` — bewusst lokal dupliziert, weil das eine Test-Helfer-
 * Funktion ist, die kein Produktivpfad importieren sollte.
 */
function leererCaseState(args: {
  case_id: string;
  mandant_id: string;
  jahr: number;
}): CaseState {
  const jetzt = new Date().toISOString();
  return {
    case_id: args.case_id,
    mandant_id: args.mandant_id,
    tenant: "system",
    jahr: args.jahr,
    veranlagungsart: "zusammenveranlagung",
    schema_version: SCHEMA_VERSION,
    revision: 0,
    created_at: jetzt,
    updated_at: jetzt,
    personen: [],
    belege: [],
    felder: { deterministisch: {}, nach_elster_code: {} },
    bilanz: {
      berechnet_am: null,
      lane1_revision: null,
      case_revision_input: null,
      stale: true,
      ergebnis: null,
      betrag_eur: null,
      zve_eur: null,
      festgesetzte_est_eur: null,
      soli_eur: null,
      kist_eur: null,
      vorauszahlungen_eur: null,
      module_verwendet: [],
      schritte: [],
      fuenftelregelung_angewandt: null,
      fuenftelregelung_vergleich: null,
    },
    qa_log: [],
    kuratierung: {
      status: "offen",
      vier_augen_aktiv: false,
      freigaben: [],
      offene_rueckfragen: [],
      mandanten_kontakt: null,
    },
    regeln: [],
    lanes_status: {
      sturm: { status: "unbekannt", last_seen: null, aktueller_task: null, queue_len: null, fehler_message: null, version: null },
      lane1: { status: "unbekannt", last_seen: null, aktueller_task: null, queue_len: null, fehler_message: null, version: null },
      lane2: { status: "unbekannt", last_seen: null, aktueller_task: null, queue_len: null, fehler_message: null, version: null },
      lane5: { status: "unbekannt", last_seen: null, aktueller_task: null, queue_len: null, fehler_message: null, version: null },
    },
    warnungen: [],
    audit: [],
  };
}

/**
 * Initialisiert einen leeren case_state in der DB falls noch nicht vorhanden.
 * Idempotent — wenn der Fall existiert, kein Schreibvorgang.
 */
export async function initialisiereFallFallsNoetig(
  caseId: string,
  mandantId: string,
  steuerjahr: number,
): Promise<void> {
  const existierend = await loadCase(caseId);
  if (existierend) return;
  await saveCase(leererCaseState({
    case_id: caseId,
    mandant_id: mandantId,
    jahr: steuerjahr,
  }));
}

// ─── Hauptfunktion ──────────────────────────────────────────────────────────

/**
 * Schreibt einen STURM-Output als BELEG-Pipeline + PERSON-Patches in den
 * case_state.
 *
 * Reihenfolge:
 *   1. case_state initialisieren falls noetig
 *   2. BELEG_ANGENOMMEN (idempotent)
 *   3. BELEG_KLASSIFIZIERT (typ + anlagen_hints)
 *   4. BELEG_EXTRAHIERT (alle ELSTER-Werte als ExtrahiertesFeld[])
 *   5. PERSON_HINZUFUEGEN pro aggregierter Person
 *
 * Jeder Schritt ist eigenstaendig try/catch-geschuetzt — ein Fehler in einem
 * Schritt blockiert die folgenden NICHT (ausser BELEG_ANGENOMMEN, weil ohne
 * das die spaeteren Reducer den Beleg nicht finden).
 *
 * @returns Ergebnis-Statistik. Bei totalem Fehlschlag: fehler-Feld gesetzt,
 *          felder_geschrieben=0, personen_geschrieben=0.
 */
export async function schreibeSturmInCaseState(args: {
  fall_id: string;
  beleg_id: string;
  mandant_id?: string | null;
  steuerjahr: number;
  output: SturmOutput;
  optionen?: SchreibeOptionen;
}): Promise<SchreibeErgebnis> {
  const caseId = leiteCaseIdAb(args.fall_id, args.mandant_id, args.steuerjahr);
  const actor: Actor = args.optionen?.actor ?? "system";
  const actorId = args.optionen?.actor_id ?? "sturm.client";
  const defaultKonfidenz = args.optionen?.defaultKonfidenz ?? 0.95;

  const ergebnis: SchreibeErgebnis = {
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
    console.error(`[applyToCaseState] case_state-Init fehlgeschlagen fuer ${caseId}:`, e);
    return ergebnis;
  }

  const werte = Array.isArray(args.output?.alle_werte) ? args.output.alle_werte : [];
  const erkannteAnlagen = werte.length > 0
    ? Array.from(new Set(werte.map((w) => w.anlage).filter((a): a is string => Boolean(a))))
    : Object.keys(args.output?.per_anlage ?? {});

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
    console.error(`[applyToCaseState] BELEG_ANGENOMMEN fehlgeschlagen fuer ${caseId}:`, e);
    return ergebnis;
  }

  // ─── 3) BELEG_KLASSIFIZIERT ─────────────────────────────────────────────
  try {
    const anlagenHints: Record<string, number> = {};
    for (const a of erkannteAnlagen) anlagenHints[a] = 1.0;
    await applyTool({
      case_id: caseId,
      tool: "BELEG_KLASSIFIZIERT",
      actor,
      actor_id: actorId,
      payload: {
        beleg_id: args.beleg_id,
        typ: "einkommensteuererklaerung",
        doc_typ_konfidenz: 0.95,
        steuerjahr_des_belegs: args.steuerjahr,
        primaere_anlage: erkannteAnlagen.includes("ESt1A") ? "ESt1A" : (erkannteAnlagen[0] ?? null),
        anlagen_hints: anlagenHints,
      },
    });
  } catch (e: any) {
    console.error(`[applyToCaseState] BELEG_KLASSIFIZIERT fehlgeschlagen fuer ${caseId}:`, e);
    // weiter — Klassifikation ist nice-to-have, BELEG_EXTRAHIERT wichtiger.
  }

  // ─── 4) BELEG_EXTRAHIERT ────────────────────────────────────────────────
  try {
    const idnrA = getIdnrFuerPerson(werte, "A");
    const idnrB = getIdnrFuerPerson(werte, "B");

    const felder = werte
      .filter((w) => w.eCode && (w.wert !== null && w.wert !== undefined))
      .map((w) => {
        const code = w.eCode as string;
        const anlage = w.anlage ?? "sonstige";
        const personId = w.person === "A" ? "p_a" : w.person === "B" ? "p_b" : null;
        const personIdnr = personId === "p_a" ? idnrA : personId === "p_b" ? idnrB : null;
        return {
          domain_pfad: deriveDomainPfad(code, anlage),
          person_id: personId,
          primaerer_elster_code: code,
          elster_code_aliase: [],
          anlagen: [anlage],
          primaere_anlage: anlage,
          value_type: deriveValueType(w.format),
          wert: w.wert as string | number | boolean,
          konfidenz: defaultKonfidenz,
          label: w.beschreibung ?? w.drucktext ?? null,
          person_idnr: personIdnr,
        };
      });

    if (felder.length > 0) {
      await applyTool({
        case_id: caseId,
        tool: "BELEG_EXTRAHIERT",
        actor,
        actor_id: actorId,
        payload: {
          beleg_id: args.beleg_id,
          felder,
          extraktions_quelle: "sturm_pass2",
          konfidenz_durchschnitt: defaultKonfidenz,
        },
      });
      ergebnis.felder_geschrieben = felder.length;
    }
  } catch (e: any) {
    console.error(`[applyToCaseState] BELEG_EXTRAHIERT fehlgeschlagen fuer ${caseId}:`, e);
    ergebnis.fehler = (ergebnis.fehler ? ergebnis.fehler + "; " : "") +
      `BELEG_EXTRAHIERT: ${e?.message ?? String(e)}`;
  }

  // ─── 5) PERSON_HINZUFUEGEN ──────────────────────────────────────────────
  try {
    const personen = aggregierePersonenAusWerten(werte);
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
            anschrift: p.anschrift
              ? {
                  strasse: p.anschrift.strasse,
                  hausnummer: p.anschrift.hausnummer,
                  plz: p.anschrift.plz,
                  ort: p.anschrift.ort,
                  land: p.anschrift.land,
                }
              : null,
            iban: p.iban ?? null,
            bic: null,
            konfidenz_identitaet: defaultKonfidenz,
            quelle_beleg_id: args.beleg_id,
          },
        });
        ergebnis.personen_geschrieben += 1;
      } catch (e: any) {
        console.error(
          `[applyToCaseState] PERSON_HINZUFUEGEN ${p.rolle} fehlgeschlagen fuer ${caseId}:`,
          e,
        );
      }
    }
  } catch (e: any) {
    console.error(`[applyToCaseState] Personen-Aggregation fehlgeschlagen:`, e);
  }

  console.log(
    `[applyToCaseState] case_state ${caseId}: ` +
    `${ergebnis.felder_geschrieben} Felder + ${ergebnis.personen_geschrieben} Personen geschrieben ` +
    `(beleg=${args.beleg_id})`,
  );

  return ergebnis;
}
