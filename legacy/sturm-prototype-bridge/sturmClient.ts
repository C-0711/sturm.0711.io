// sturmClient.ts — Adapter: CTAX Pro delegiert Dokument-Extraktion an STURM.
//
// Warum: STURM (sturm.0711.io) hat eine saubere, normalisierte Pipeline für
// ELSTER-Anlagen-Erkennung und Feldextraktion. Statt in cb-ctax eine eigene
// (inferiore) Kopie mit Loop + Markdown-Renderer zu pflegen, rufen wir
// die STURM-API auf und mappen die Events 1:1 auf die bereits etablierten
// system_log / opus_fakt Channels. Die UI bleibt unverändert.
//
// Signatur ist API-kompatibel zu extrahiereMitStrukturLoop:
//   liefert ein MistralBefunde-Objekt (kern_werte[], steuerjahr, erkannte_anlagen).
// Zusätzlich schreibt der Client den Markdown-Report (fall_summary/report.md)
// in ctax_documents.opus_interpretation.

import type { Response } from "express";
import { createReadStream } from "fs";
import { statSync } from "fs";
import { basename } from "path";
import FormData from "form-data";
import http from "http";
import https from "https";
import type { MistralBefunde, MistralWert } from "./mistralStream.js";
import { getPool } from "./sessionStore.js";
import { schreibeSturmInCaseState } from "./src/sturm/applyToCaseState.js";
import { schreibePass1InCaseState } from "./src/sturm/schreibePass1InCaseState.js";

const STURM_URL = process.env.STURM_URL || "http://localhost:7800";
const STURM_WORKFLOW = process.env.STURM_WORKFLOW || "elster-v1";

export interface SturmClientOptionen {
  onBefund?: (obj: any) => void;
  docTypeHint?: string;
  taxYearHint?: number;
  /**
   * Wenn gesetzt, schreibt der Client das STURM-Ergebnis (Werte + Personen)
   * via applyToCaseState/applyTool() in case_state. Soft-Fail: Persistenz-
   * Exceptions werden geloggt aber nicht propagiert — STURM-Upload bleibt
   * erfolgreich, auch wenn case_state-Schreibung scheitert.
   */
  fallId?: string;
  /** Optionaler Mandant-Schluessel fuer die case_id-Synthese in applyToCaseState. */
  mandantId?: string | null;
  /** Originaler Dateiname fuer BELEG_ANGENOMMEN.dateiname (statt sturm-<docId>). */
  originalDateiname?: string;
}

/**
 * Konsumiert den SSE-Stream vom STURM-Server und mappt ihn auf
 * emitSystemLog / emitOpusFakt — die UI sieht Verarbeitung live.
 *
 * Gibt das finale run-Ergebnis zurück:
 *   - werte: alle extrahierten ELSTER-Werte (flach, mit anlage/person)
 *   - befund: Ein-Satz-Zusammenfassung
 *   - hinweise: steuerliche Optimierungshinweise
 *   - report_md: vollständiger Markdown-Report
 *   - erkannte_anlagen: Liste der Anlagen-Codes
 *   - steuerjahr: aus Datumsfeldern ermittelt
 */
export async function extrahiereMitSturm(
  filePath: string,
  filename: string,
  mimetype: string,
  docId: string,
  res: Response,
  opt?: SturmClientOptionen,
): Promise<MistralBefunde> {
  const { emitSystemLog, emitOpusFakt, updateSystemLog } = await import("./eventEmitter.js");

  // Pipeline-Konsolidierung: ein einziger Chip mit Stage-Liste, der ueber
  // updateSystemLog progressiv geupdated wird. Statt 5+ einzelne Chips fuer
  // ocr/klassifizierung/extraktion/seitenChips/anreicherung sieht der Berater
  // EIN STURM-Karte mit ankreuzbaren Stages.
  const pipelineId = `sturm-${docId}-${Date.now()}`;
  const STAGES_INITIAL = [
    { name: "ocr", status: "pending" as const },
    { name: "klassifizierung", status: "pending" as const },
    { name: "extraktion", status: "pending" as const },
    { name: "seitenChips", status: "pending" as const },
    { name: "anreicherung", status: "pending" as const },
  ];
  const stages = [...STAGES_INITIAL];
  emitSystemLog(res, {
    icon: "", text: `STURM-Pipeline läuft — ${filename}`,
    refType: "pipeline", refId: docId,
    severity: "info",
    pipelineId,
    pipelineStages: stages,
  });
  function setzeStage(name: string, status: "pending" | "running" | "done" | "error") {
    const i = stages.findIndex(s => s.name === name);
    if (i < 0) return;
    stages[i] = { ...stages[i], status };
    updateSystemLog(res, { pipelineId }, { pipelineStages: [...stages] });
  }

  // Multipart-Body bauen
  const form = new FormData();
  form.append("file", createReadStream(filePath), {
    filename,
    contentType: mimetype,
    knownLength: statSync(filePath).size,
  });

  const url = new URL(`${STURM_URL}/api/workflows/${STURM_WORKFLOW}/run`);
  const isHttps = url.protocol === "https:";
  const agent = isHttps ? https : http;

  const req = agent.request({
    method: "POST",
    host: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname,
    headers: form.getHeaders(),
  });

  // Accumulator für die Pipeline-Ergebnisse
  let erkannteAnlagen: string[] = [];
  let werte: any[] = [];
  let befund = "";
  let hinweise: string[] = [];
  let reportMd = "";
  let steuerjahr: number | null = opt?.taxYearHint || null;

  // SSE-Stream parsen
  const done = new Promise<void>((resolve, reject) => {
    req.on("response", (response) => {
      if (response.statusCode && response.statusCode >= 400) {
        reject(new Error(`STURM HTTP ${response.statusCode}`));
        return;
      }

      let buffer = "";
      response.setEncoding("utf-8");

      response.on("data", (chunk: string) => {
        buffer += chunk;
        // SSE-Frames sind durch \n\n getrennt
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          handleFrame(frame);
        }
      });

      response.on("end", () => resolve());
      response.on("error", (err) => reject(err));
    });

    req.on("error", (err) => reject(err));
  });

  function handleFrame(frame: string) {
    // Zeilen aufteilen: event: <name>\ndata: <json>
    let evName = "";
    let dataRaw = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) evName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataRaw = line.slice(5).trim();
    }
    if (!dataRaw) return;

    let env: any;
    try { env = JSON.parse(dataRaw); } catch { return; }
    const payload = env.payload || {};

    switch (evName) {
      case "stage_start":
        setzeStage(env.stageId, "running");
        break;

      case "stage_done":
      case "stage_complete":
        setzeStage(env.stageId, "done");
        break;

      case "ocr_pages":
        // Bug-Fix: payload.pages kann undefined sein wenn STURM keine Seiten-
        // Zaehlung mitschickt — dann "?" statt "undefined Seiten" zeigen.
        {
          const pages = payload.pages != null ? payload.pages : "?";
          const chars = payload.chars || 0;
          updateSystemLog(res, { pipelineId }, {
            text: `STURM · ${filename} — OCR: ${pages} Seiten, ${chars} Zeichen`,
          });
        }
        setzeStage("ocr", "done");
        break;

      case "anlage_start":
        // optional: spezifische Anlagen-Info im Chip-Text
        updateSystemLog(res, { pipelineId }, {
          text: `STURM · ${filename} — Extraktion: ${payload.anlage}`,
        });
        break;

      case "anlage_done":
        // keine eigene Chip-Spam mehr; Stages bleiben die Anker.
        break;

      case "anreicherung_done":
        setzeStage("anreicherung", "done");
        break;

      case "gate_ergaenzung":
        // Quality-Gate-Hinweise als eigenstaendiger warn-Chip (selten,
        // nicht in der Pipeline-Karte versteckt).
        emitSystemLog(res, {
          icon: "", text: `Quality-Gate: ${payload.text || payload.meldung || "Ergänzung"}`,
          refType: "berechnung", refId: docId,
          severity: "warn",
        });
        break;

      case "fall_befund":
        befund = payload.befund || "";
        hinweise = Array.isArray(payload.hinweise) ? payload.hinweise : [];
        if (hinweise.length > 0) {
          for (const h of hinweise) {
            emitSystemLog(res, {
              icon: "⚠", text: h,
              refType: "dokument", refId: docId,
              severity: "warn",
            });
          }
        }
        break;

      case "run_done":
        // Final-Update der Pipeline-Karte erfolgt unten (output.json gelesen),
        // hier nur Stages auf done falls nicht schon passiert.
        for (const s of stages) if (s.status === "running" || s.status === "pending") s.status = "done";
        updateSystemLog(res, { pipelineId }, { pipelineStages: [...stages] });
        break;

      case "run_meta":
        // runId merken für Report-Abruf (wird nach run_done geholt)
        (handleFrame as any).runId = env.runId;
        break;
    }

  }

  form.pipe(req);
  await done;

  // Nach run_done: output.json und report.md vom STURM-Server holen.
  const runId = (handleFrame as any).runId;
  if (runId) {
    try {
      const out = await holeAnreicherungsOutput(runId);
      if (out) {
        werte = Array.isArray(out.alle_werte) ? out.alle_werte : [];
        erkannteAnlagen = Object.keys(out.per_anlage || {});
        const erfolg = werte.length > 0;
        // Final-Update der Pipeline-Karte: Severity + KPI-Vorschau + Action.
        // Ohne Werte ist es eine Sackgasse (warn) MIT Aktion "Im Workspace
        // ansehen" — der Berater kommt direkt zur Mistral-Small-KPI-Sicht.
        const kpiPreview = erfolg
          ? werte.slice(0, 3).map((w: any) => ({
              key: String(w.beschreibung || w.drucktext || w.feld || w.eCode || "Wert"),
              value: String(w.wert ?? ""),
            }))
          : undefined;
        const actions = erfolg
          ? undefined
          : [{ label: "Im STURM-Workspace ansehen", action: "open_run", args: { runId } }];
        updateSystemLog(res, { pipelineId }, {
          text: erfolg
            ? `STURM fertig — ${werte.length} Werte aus ${erkannteAnlagen.length} Anlagen`
            : `STURM fertig — keine ELSTER-Werte erkannt (Belege-Workspace verfügbar)`,
          severity: erfolg ? "success" : "warn",
          kpiPreview,
          actions,
          workspaceUrl: `${STURM_URL.replace(/^http/, "https").replace(":7800", "")}/run.html?run=${encodeURIComponent(runId)}`,
        });
        // Opus-Fakt-Chips für die ersten 60 Werte
        for (const w of werte.slice(0, 60)) {
          emitOpusFakt(res, {
            thema: w.anlage || "Sonstiges",
            person: w.person || null,
            feld: w.beschreibung || w.drucktext || w.eCode,
            wert: String(w.wert),
            elster_code: w.eCode,
            dokId: docId,
          });
        }
        // Callback für narrator
        if (opt?.onBefund) {
          for (const w of werte) {
            try { opt.onBefund({ typ: "wert", ...w }); } catch {}
          }
        }
      }
    } catch (e: any) {
      emitSystemLog(res, {
        icon: "", text: `Werte-Laden fehlgeschlagen: ${e.message}`,
        refType: "dokument", refId: docId,
      });
    }
    try {
      reportMd = await holeReportMd(runId);
    } catch (e: any) {
      emitSystemLog(res, {
        icon: "", text: `Report.md konnte nicht geladen werden: ${e.message}`,
        refType: "dokument", refId: docId,
      });
    }
  }

  // Befund+Hinweise an den Report-md voranstellen — das wird die
  // DetailSheet-Zusammenfassung.
  let interpretation = reportMd;
  if (!interpretation && (befund || hinweise.length > 0)) {
    interpretation = `## Befund\n${befund}\n\n## Hinweise\n${hinweise.map(h => `- ${h}`).join("\n")}`;
  }

  if (interpretation) {
    try {
      const pool = getPool();
      await pool.query(
        `UPDATE ag_catalog.ctax_documents SET opus_interpretation = $1 WHERE id = $2`,
        [interpretation, docId],
      );
    } catch (e: any) {
      console.warn(`[SturmClient] Report-Persist fehlgeschlagen: ${e.message}`);
    }
  }

  // Steuerjahr aus Datumsfeldern ziehen, falls nicht gesetzt
  if (!steuerjahr) {
    steuerjahr = ermittleSteuerjahr(werte);
  }

  // Mapping auf MistralBefunde — kompatibel mit bestehender Persistenz
  const kernWerte: MistralWert[] = werte.map((w) => ({
    anlage: w.anlage || "Sonstiges",
    person: (w.person === "A" || w.person === "B") ? w.person : undefined,
    feld: w.beschreibung || w.drucktext || w.eCode,
    wert: String(w.wert),
    elster_code: w.eCode,
  }));

  const befundeReturn: MistralBefunde = {
    doc_type: (opt?.docTypeHint as any) || "einkommensteuererklaerung",
    kurz_beschreibung: befund || `${werte.length} ELSTER-Werte aus ${erkannteAnlagen.length} Anlagen extrahiert`,
    steuerjahr: steuerjahr || new Date().getFullYear() - 1,
    vertrauen: 0.95,
    personen: [],
    anlagen: erkannteAnlagen,
    kern_werte: kernWerte,
    rohZeilen: [],
  };
  console.log(`[SturmClient] returning befunde: ${kernWerte.length} kern_werte, ${erkannteAnlagen.length} anlagen, befund='${befund.slice(0, 50)}'`);

  // ─── STURM-Output → case_state via applyTool ────────────────────────────
  // Soft-Fail: Persistenz-Exceptions werden geloggt aber nicht propagiert.
  if (opt?.fallId && werte.length > 0) {
    try {
      const ergebnis = await schreibeSturmInCaseState({
        fall_id: opt.fallId,
        beleg_id: docId,
        mandant_id: opt.mandantId ?? null,
        steuerjahr: befundeReturn.steuerjahr,
        output: { alle_werte: werte as any },
        optionen: {
          dateiname: opt.originalDateiname ?? filename,
          mime: mimetype,
          actor: "system",
          actor_id: "sturm.client",
          defaultKonfidenz: 0.95,
        },
      });
      console.log(
        `[SturmClient] case_state ${ergebnis.case_id}: ` +
        `${ergebnis.felder_geschrieben} Felder + ${ergebnis.personen_geschrieben} Personen`,
      );
    } catch (e: any) {
      console.error(`[SturmClient] case_state-Schreibung gescheitert: ${e?.message ?? String(e)}`);
    }
  }

  return befundeReturn;
}

/**
 * Lädt den Markdown-Report des abgeschlossenen Runs vom STURM-Server.
 * STURM persistiert den Report unter runs/<workflow>/<runId>/fall_summary/report.md
 * und exposet ihn unter /api/runs/<runId>/files/fall_summary/report.md (falls
 * die Route existiert); Fallback: via fs, wenn cb-ctax auf derselben Maschine läuft.
 */
async function holeAnreicherungsOutput(runId: string): Promise<any | null> {
  const path = `/home/christoph.bertsch/0711/0711-STURM/runs/${STURM_WORKFLOW}/${runId}/anreicherung/output.json`;
  try {
    const { readFileSync } = await import("fs");
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

async function holeReportMd(runId: string): Promise<string> {
  // Variante A: via STURM REST (wenn implementiert)
  const candidates = [
    `${STURM_URL}/api/runs/${runId}/files/fall_summary/report.md`,
    `${STURM_URL}/api/runs/${runId}/output/fall_summary/report.md`,
    `${STURM_URL}/api/runs/${runId}/fall_summary/report.md`,
  ];
  for (const url of candidates) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.text();
    } catch {}
  }
  // Variante B: Direktes Lesen aus dem Filesystem (cb-ctax + sturm auf gleichem Host)
  const path = `/home/christoph.bertsch/0711/0711-STURM/runs/${STURM_WORKFLOW}/${runId}/fall_summary/report.md`;
  try {
    const { readFileSync } = await import("fs");
    return readFileSync(path, "utf-8");
  } catch {}
  return "";
}

function ermittleSteuerjahr(werte: any[]): number | null {
  const jahre = new Map<number, number>();
  const heute = new Date().getFullYear();
  for (const w of werte) {
    const m = String(w.wert || "").match(/\b(\d{2})\.(\d{2})\.(20\d{2})\b/);
    if (m) {
      const y = parseInt(m[3]);
      if (y >= 2000 && y <= 2100 && y !== heute) {
        jahre.set(y, (jahre.get(y) || 0) + 1);
      }
    }
  }
  if (jahre.size === 0) return null;
  const sorted = [...jahre.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  return sorted[0][0];
}

export function istSturmAktiv(): boolean {
  return process.env.STURM_EXTRAKTION === "1";
}

// ═══════════════════════════════════════════════════════════════════════════
// STURM Workspace-Brücke (Auto-Anlage pro cb-chat-Fall)
// ═══════════════════════════════════════════════════════════════════════════
// Bei jedem Pro-Upload spiegeln wir die Datei in einen STURM-Workspace, damit
// der Berater dort die Mistral-Small-KPI-Sicht + Schema-Bindung nutzen kann
// (siehe c-pro / Option 1). Workspace-ID wird deterministisch aus fall_id
// abgeleitet, damit der Aufruf idempotent ist.

export function istAutoWorkspaceAktiv(): boolean {
  // Bearer-Token ist optional: wenn STURM keinen erzwingt (env nicht gesetzt
  // auf der STURM-Seite), funktioniert der Client ohne Token. Wenn STURM
  // einen erzwingt, MUSS cb-chat denselben Token in STURM_BEARER_TOKEN haben.
  return process.env.STURM_AUTO_WORKSPACE === "1";
}

function authHeader(): Record<string, string> {
  const t = process.env.STURM_BEARER_TOKEN;
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/** Deterministischer Slug aus fall_id — stabil über alle Uploads desselben Falls. */
export function workspaceSlugFuerFall(fallId: string): string {
  // STURM-slugify normalisiert NFKD + entfernt non-word, daher reicht der
  // erste UUID-Teil als eindeutige Kennung pro Fall.
  return `fall-${fallId.replace(/-/g, "").slice(0, 12)}`;
}

/**
 * Idempotente Workspace-Anlage. Erster Call legt einen neuen Workspace an,
 * weitere Calls geben den bestehenden zurueck (STURM-Server prueft den slug).
 * Optional bindet der Aufruf das tax-de-2024@v0-Pipeline-Vokabular an die
 * Workspace, damit auto-Routing nach Klassifikation funktioniert.
 */
export async function ensureWorkspace(
  fallId: string,
  opt: { name: string; pipelineBinding?: string },
): Promise<{ wsId: string; created: boolean }> {
  const slug = workspaceSlugFuerFall(fallId);
  const resp = await fetch(`${STURM_URL}/api/workspaces`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify({ name: opt.name, slug }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`STURM Workspace-Anlage HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  const data: any = await resp.json();
  const wsId = data?.id;
  if (!wsId) throw new Error(`STURM Workspace-Antwort ohne id: ${JSON.stringify(data).slice(0, 200)}`);
  const created = !data?.reused;
  // Pipeline-Binding nur beim ersten Anlegen — überschreibt sonst
  // ggf. eine andere bewusst gewaehlte Pipeline.
  if (created && opt.pipelineBinding) {
    const [pipelineId, version] = opt.pipelineBinding.split("@");
    try {
      await fetch(`${STURM_URL}/api/workspaces/${encodeURIComponent(wsId)}/binding`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader() },
        body: JSON.stringify({ pipelineId, version: version || "v0" }),
      });
    } catch (e: any) {
      console.warn(`[SturmClient] Pipeline-Binding fehlgeschlagen: ${e.message}`);
    }
  }
  return { wsId, created };
}

/**
 * Liest das STURM-Doc-Meta-Sidecar (Klassifikation, KPIs, fileId, currentPath)
 * via JSON-API. Wird nach dem Upload mit kurzer Verzoegerung gepollt, damit
 * Mistral-Small Zeit hatte zu klassifizieren.
 */
export async function holeWorkspaceDocMeta(
  wsId: string,
  docUuid: string,
): Promise<any | null> {
  try {
    const resp = await fetch(
      `${STURM_URL}/api/workspaces/${encodeURIComponent(wsId)}/documents/${encodeURIComponent(docUuid)}`,
      { headers: { ...authHeader() } },
    );
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

/**
 * Wartet bis STURM Mistral-Small-Klassifikation fertig ist und gibt das Meta
 * mit gefuellten kpis zurueck. Polling im 1-Sekunden-Takt, max ~12 s.
 */
export async function warteAufKlassifikation(
  wsId: string,
  docUuid: string,
  maxMs = 12000,
): Promise<any | null> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const meta = await holeWorkspaceDocMeta(wsId, docUuid);
    if (meta?.classification?.kpis) return meta;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return await holeWorkspaceDocMeta(wsId, docUuid);
}



/**
 * Wartet bis STURM AUCH Pass-2 (elster_extract) fertig hat. Fuer Timing-
 * Logs verwendet — non-blocking aufrufen (fire-and-forget) damit der
 * Upload-Stream nicht haengt.
 *
 * Polling 2-Sekunden-Takt, default max 120 s. Liefert das Meta sobald
 * meta.elsterExtract vorhanden ist (oder null nach Timeout).
 */
export async function holeFinalSturmMeta(
  wsId: string,
  docUuid: string,
  maxMs = 120000,
): Promise<any | null> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const meta = await holeWorkspaceDocMeta(wsId, docUuid);
    if (meta?.elsterExtract?.totalMs !== undefined) return meta;
    // Wenn keine recommendedAnlagen → kein Pass-2, klassifikation reicht
    const ra = meta?.classification?.recommendedAnlagen;
    if (Array.isArray(ra) && ra.length === 0 && meta?.classification?.kpis) return meta;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return await holeWorkspaceDocMeta(wsId, docUuid);
}

// ═══════════════════════════════════════════════════════════════════════════
// V2-Helper: STRUKTURIERT-Person → synthetische SturmRohWerte
// ═══════════════════════════════════════════════════════════════════════════
//
// Smart-Schema-Service liefert STRUKTURIERT-Bucket-Eintraege wie
//   {key: "Vorname Person A", value: "Rainer", ziel_pfad: "person.vorname"}
//   {key: "Identifikationsnummer Person B", value: "5412...", ziel_pfad: "person.idnr"}
//
// Damit applyToCaseState.aggregierePersonenAusWerten() Personen ableitet,
// brauchen wir ELSTER-Stammdaten-eCodes (E0100*). Diese Tabelle bildet
// (ziel_pfad, personHint) auf den eCode ab.
const SYNTH_PERSON_PFADE: Record<
  string,
  Record<"A" | "B" | "gemeinsam", string | null>
> = {
  "person.vorname":              { A: "E0100301", B: "E0100801", gemeinsam: null },
  "person.nachname":             { A: "E0100201", B: "E0100901", gemeinsam: null },
  "person.idnr":                 { A: "E0100081", B: "E0100082", gemeinsam: null },
  "person.geburtsdatum":         { A: "E0100401", B: "E0101001", gemeinsam: null },
  "person.religion":             { A: "E0100402", B: "E0101002", gemeinsam: null },
  "person.titel":                { A: "E0100302", B: "E0100802", gemeinsam: null },
  "person.anschrift.strasse":    { A: "E0101104", B: "E0101104", gemeinsam: "E0101104" },
  "person.anschrift.hausnummer": { A: "E0101206", B: "E0101206", gemeinsam: "E0101206" },
  "person.anschrift.plz":        { A: "E0100601", B: "E0100601", gemeinsam: "E0100601" },
  "person.anschrift.ort":        { A: "E0100602", B: "E0100602", gemeinsam: "E0100602" },
};

const PERSON_B_REGEX = /\b(person\s*b|partner|ehepartner|ehegatte)\b/i;
const PERSON_A_REGEX = /\b(person\s*a)\b/i;
// Globale Form fuer den onClassifyDone-Handler (lokale Funktion oben).
const PERSON_B_REGEX_GLOBAL = /\b(person\s*b|partner|ehepartner|ehegatte)\b/i;
const PERSON_A_REGEX_GLOBAL = /\b(person\s*a)\b/i;

function detektierePersonAusKey(key: string): "A" | "B" | "gemeinsam" {
  if (PERSON_B_REGEX.test(key)) return "B";
  if (PERSON_A_REGEX.test(key)) return "A";
  return "gemeinsam";
}

function baueSyntheticPersonenWerte(
  strukturiert: Array<{ key: string; value: string; ziel_pfad: string }>,
): Array<{
  eCode: string;
  wert: string;
  anlage: string;
  drucktext: string | null;
  vordruckzeile: string | null;
  person: "A" | "B" | null;
}> {
  const out: Array<any> = [];
  for (const item of strukturiert) {
    if (!item.ziel_pfad?.startsWith("person.")) continue;
    const map = SYNTH_PERSON_PFADE[item.ziel_pfad];
    if (!map) continue;
    const pHint = detektierePersonAusKey(item.key);
    const eCode = map[pHint];
    if (!eCode) continue;
    const isAddress = item.ziel_pfad.startsWith("person.anschrift");
    out.push({
      eCode,
      wert: item.value,
      anlage: "ESt1A",
      drucktext: item.key,
      vordruckzeile: null,
      person: isAddress ? null : (pHint === "gemeinsam" ? null : pHint),
    });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// V2-Pipeline (Workspace-Upload mit Pass 1 + Pass 2)
// ═══════════════════════════════════════════════════════════════════════════
//
// Ablauf (durch STURM SSE-Events getrieben):
//   ingested        — Datei in inbox/<uuid>.pdf
//   classify_started — Mistral-Small Pass 1 los
//   classify_done   — {label, summary, kpis, recommendedAnlagen, ...}
//   elster_extract_started — Pass 2 startet fuer recommendedAnlagen
//   elster_extract_anlage_done — pro Anlage Progress
//   elster_extract_done    — alle ELSTER-Werte mit elster_code/anlage/drucktext/vordruckzeile
//   routed                 — Datei wandert nach <label>/
//   done                   — Sidecar final
//
// Die Funktion mappt die Events 1:1 auf cb-ctax UI-Events
// (emitSystemLog/emitOpusFakt) und persistiert die Pass-2-Werte ueber
// applyToCaseState/applyTool() in den case_state.

export interface SturmV2Befund {
  label: string;
  confidence: number;
  summary: string;
  recommendedAnlagen: string[];
  kpis: Array<{ key: string; value: string }>;
  values: Array<{
    elster_code: string;
    value: string;
    anlage: string;
    drucktext?: string;
    vordruckzeile?: string;
  }>;
  perAnlage: Array<{
    anlage: string;
    fieldsInSchema: number;
    valuesReturned: number;
    ms: number;
    error?: string;
  }>;
  steuerjahr: number;
  docUuid: string;
}

/**
 * Streamt einen Workspace-Upload und konsumiert alle SSE-Events.
 *
 * Anders als uploadToWorkspace() (das nur die uuid greift) parst diese
 * Variante alle Events, ruft handlers, und liefert das aggregierte Pass-1+2
 * Ergebnis. Verwendet vom V2-Orchestrator extrahiereV2MitSturm().
 */
export async function streamWorkspaceUpload(
  wsId: string,
  filePath: string,
  filename: string,
  mimeType: string,
  handlers: {
    onIngested?: (p: { uuid: string }) => void;
    onClassifyStarted?: () => void;
    onClassifyDone?: (p: any) => void;
    onElsterExtractStarted?: (p: { anlagen: string[] }) => void;
    onElsterExtractAnlageDone?: (p: any) => void;
    onElsterExtractDone?: (p: any) => void;
    onRouted?: (p: { from: string; to: string; classification: string }) => void;
    onError?: (p: { message: string }) => void;
  },
): Promise<{
  uuid: string;
  classification: any | null;
  elsterExtract: any | null;
  routed: { from: string; to: string; classification: string } | null;
}> {
  const form = new FormData();
  const stat = statSync(filePath);
  form.append("file", createReadStream(filePath), {
    filename,
    contentType: mimeType || "application/octet-stream",
    knownLength: stat.size,
  });
  const isHttps = STURM_URL.startsWith("https://");
  const url = new URL(`${STURM_URL}/api/workspaces/${encodeURIComponent(wsId)}/upload`);

  return new Promise((resolve, reject) => {
    const opts = {
      method: "POST",
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      headers: { ...form.getHeaders(), ...authHeader() },
    };

    const result = {
      uuid: "" as string,
      classification: null as any | null,
      elsterExtract: null as any | null,
      routed: null as any | null,
    };

    const req = (isHttps ? https : http).request(opts, (resp) => {
      if (resp.statusCode && resp.statusCode >= 400) {
        reject(new Error(`STURM Workspace-Upload HTTP ${resp.statusCode}`));
        return;
      }
      let buffer = "";
      resp.setEncoding("utf-8");
      resp.on("data", (chunk: string) => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let evName = "";
          let dataRaw = "";
          for (const line of frame.split(/\r?\n/)) {
            if (line.startsWith("event:")) evName = line.slice(6).trim();
            else if (line.startsWith("data:")) dataRaw = line.slice(5).trim();
          }
          if (!dataRaw) continue;
          let data: any;
          try { data = JSON.parse(dataRaw); } catch { continue; }
          switch (evName) {
            case "ingested":
              result.uuid = data.uuid;
              handlers.onIngested?.(data);
              break;
            case "classify_started":
              handlers.onClassifyStarted?.();
              break;
            case "classify_done":
              result.classification = data;
              handlers.onClassifyDone?.(data);
              break;
            case "elster_extract_started":
              handlers.onElsterExtractStarted?.(data);
              break;
            case "elster_extract_anlage_done":
              handlers.onElsterExtractAnlageDone?.(data);
              break;
            case "elster_extract_done":
              result.elsterExtract = data;
              handlers.onElsterExtractDone?.(data);
              break;
            case "elster_extract_error":
              handlers.onError?.(data);
              break;
            case "routed":
              result.routed = data;
              handlers.onRouted?.(data);
              break;
            case "error":
              handlers.onError?.(data);
              break;
          }
        }
      });
      resp.on("end", () => {
        if (!result.uuid) {
          reject(new Error("STURM Workspace-Upload: kein 'ingested'-Event erhalten"));
          return;
        }
        resolve(result);
      });
      resp.on("error", reject);
    });
    req.on("error", reject);
    form.pipe(req);
  });
}

/**
 * V2-Orchestrator: ersetzt extrahiereMitSturm() fuer alle Aufrufe die das
 * neue Pass-1+Pass-2-Schema nutzen wollen.
 *
 * Ablauf:
 *   1) ensureWorkspace fuer den Fall
 *   2) streamWorkspaceUpload — Pass 1 + Pass 2 in einem Stream
 *   3) Pass-2-Werte via applyToCaseState ins case_state schreiben
 *   4) MistralBefunde-kompatible Antwort fuer Legacy-Konsumenten
 */
export async function extrahiereV2MitSturm(
  filePath: string,
  filename: string,
  mimetype: string,
  docId: string,
  res: Response,
  opt?: SturmClientOptionen,
): Promise<MistralBefunde> {
  const { emitSystemLog, emitOpusFakt, updateSystemLog } = await import("./eventEmitter.js");

  if (!opt?.fallId) {
    throw new Error("extrahiereV2MitSturm: opt.fallId erforderlich (Workspace-Slug-Synthese)");
  }

  // ─── Pipeline-Karte (1 Chip mit Stages) ─────────────────────────────────
  const pipelineId = `sturmv2-${docId}-${Date.now()}`;
  const stages: Array<{ name: string; status: "pending" | "running" | "done" | "error" }> = [
    { name: "ingest", status: "pending" },
    { name: "klassifizierung", status: "pending" },
    { name: "elster_extraktion", status: "pending" },
  ];
  function setzeStage(name: string, status: "pending" | "running" | "done" | "error") {
    const i = stages.findIndex((s) => s.name === name);
    if (i < 0) return;
    stages[i] = { ...stages[i], status };
    updateSystemLog(res, { pipelineId }, { pipelineStages: [...stages] });
  }
  emitSystemLog(res, {
    icon: "",
    text: `STURM-Pipeline läuft — ${filename}`,
    refType: "pipeline",
    refId: docId,
    severity: "info",
    pipelineId,
    pipelineStages: stages,
  });

  // ─── Workspace sicherstellen ────────────────────────────────────────────
  const ws = await ensureWorkspace(opt.fallId, {
    name: opt.fallId,
    pipelineBinding: process.env.STURM_PIPELINE_BINDING || undefined,
  });
  setzeStage("ingest", "running");

  // ─── Stream konsumieren ─────────────────────────────────────────────────
  // Lazy-import buildStages damit wir die Phasen Erkannt/Werte zuordnen
  // direkt vom STURM-Frame an den uploadChipStream-Chip pushen — damit
  // Frontend live sieht wenn Pass-1 startet und wenn Pass-2 startet.
  const { buildStages } = await import("./uploadChipStream.js");
  const uploadChipPipelineId = `up-${docId}`;

  const stream = await streamWorkspaceUpload(ws.wsId, filePath, filename, mimetype, {
    onIngested: () => {
      setzeStage("ingest", "done");
      setzeStage("klassifizierung", "running");
      // OCR ist durch — Pass-1 startet jetzt. UI auf "Erkannt = running" setzen.
      try {
        updateSystemLog(res, { pipelineId: uploadChipPipelineId }, {
          pipelineStages: buildStages("Erkannt"),
        });
      } catch { /* noop */ }
    },
    onClassifyStarted: () => {
      updateSystemLog(res, { pipelineId }, {
        text: `STURM · ${filename} — Mistral-Small klassifiziert…`,
      });
    },
    onClassifyDone: (data) => {
      setzeStage("klassifizierung", "done");
      updateSystemLog(res, { pipelineId }, {
        text:
          `STURM · ${filename} — Pass 1: ${data.label} ` +
          `(${(data.kpis ?? []).length} Werte erkannt)`,
      });
      // Pass-1 fertig — Pass-2 startet jetzt. UI auf "Werte zuordnen = running".
      try {
        updateSystemLog(res, { pipelineId: uploadChipPipelineId }, {
          pipelineStages: buildStages("Werte zuordnen"),
        });
      } catch { /* noop */ }

      // STURM-doc_type in DB persistieren — sonst rendert die LeseplanKarte
      // weiter "Unklassifiziert" obwohl Pass-1 das Doc längst eingeordnet
      // hat. Nur ueberschreiben wenn DB-Spalte leer/sonstiges ist (manuelle
      // Korrekturen bleiben erhalten). Async ohne await — feuern und gehen.
      if (data?.label && data.label !== "sonstiges" && docId) {
        (async () => {
          try {
            const { getPool } = await import("./sessionStore.js");
            await getPool().query(
              `UPDATE ag_catalog.ctax_documents SET doc_type = $2
                 WHERE id = $1
                   AND (doc_type IS NULL OR doc_type IN ('', 'sonstiges', 'unbekannt', 'unknown'))`,
              [docId, data.label],
            );
          } catch (e: any) {
            console.warn(`[sturmClient] doc_type-Persist fehlgeschlagen ${docId}: ${e?.message}`);
          }
        })();
      }

      // ─── Granulare LogChipStream-Events (Frame 05b) ─────────────────────
      // Jeder Pipeline-Step ein eigener Chip mit Source-Pill. Frontend
      // rendert die in der LogChipStream-Komponente unter der
      // Pipeline-Karte. Im Gegensatz zu updateSystemLog sind das EIGENE
      // System-Log-Eintraege (refId mit Suffix damit kein Update-Match).
      const klassifKonfidenz = typeof data.confidence === "number"
        ? ` (Konfidenz ${data.confidence.toFixed(2)})`
        : "";
      emitSystemLog(res, {
        icon: "",
        text: `Pass 1: ${data.label}${klassifKonfidenz}`,
        refType: "dokument",
        refId: `${docId}-classify`,
        source: "CLASSIFY",
        severity: "success",
      });

      // KPIs erkannt + Personen
      const kpiCount = (data.kpis ?? []).length;
      const personenAusKpis = new Set<string>();
      for (const kpi of (data.kpis ?? [])) {
        if (PERSON_B_REGEX_GLOBAL.test(kpi.key)) personenAusKpis.add("B");
        else if (PERSON_A_REGEX_GLOBAL.test(kpi.key)) personenAusKpis.add("A");
      }
      emitSystemLog(res, {
        icon: "",
        text: `${kpiCount} Werte erkannt · ${personenAusKpis.size} Person(en) identifiziert`,
        refType: "dokument",
        refId: `${docId}-kpis`,
        source: "KPIs",
        severity: "success",
        kpiPreview: (data.kpis ?? []).slice(0, 3).map((k: any) => ({
          key: k.key, value: String(k.value),
        })),
      });

      // Phase A: Pass-1-KPIs als opusFakt-Karten ans UI streamen.
      // Theme = doc_type-Label.
      const themaLabel = data.label || "Dokument";
      for (const kpi of (data.kpis ?? []).slice(0, 80)) {
        const personHint: "A" | "B" | "gemeinsam" = PERSON_B_REGEX_GLOBAL.test(kpi.key)
          ? "B"
          : PERSON_A_REGEX_GLOBAL.test(kpi.key) ? "A" : "gemeinsam";
        emitOpusFakt(res, {
          thema: themaLabel,
          person: personHint,
          feld: kpi.key,
          wert: String(kpi.value),
          dokId: docId,
        });
      }
      // Pass 2 (ELSTER-Mapping) ist Phase B — in dieser Welle ignoriert.
      setzeStage("elster_extraktion", "done");
    },
    onElsterExtractStarted: (data) => {
      updateSystemLog(res, { pipelineId }, {
        text:
          `STURM · ${filename} — Pass 2 (ELSTER-Schema) ` +
          `für ${data.anlagen.length} Anlage(n)…`,
      });
    },
    onElsterExtractAnlageDone: (data) => {
      const status = data.error ? "Fehler" : `${data.valuesReturned}/${data.fieldsInSchema} Werte`;
      emitSystemLog(res, {
        icon: "",
        text: `Anlage ${data.anlage}: ${status}`,
        refType: "dokument",
        refId: docId,
        severity: data.error ? "warn" : "info",
      });
    },
    onElsterExtractDone: (_data) => {
      setzeStage("elster_extraktion", "done");
      // Phase A: Pass-2-Werte werden NICHT als opusFakt emittiert. Mistral-
      // Mapping kommt in Phase B. Wir behalten den Stage-Indicator.
    },
    onRouted: () => {
      // Routing-Schritt nur intern interessant.
    },
    onError: (data) => {
      emitSystemLog(res, {
        icon: "",
        text: `STURM-Fehler: ${data.message}`,
        refType: "dokument",
        refId: docId,
        severity: "error",
      });
    },
  });

  // ─── Final-Update der Pipeline-Karte (Phase A: Pass-1-Werte zaehlen) ────
  const pass1Count = (stream.classification?.kpis ?? []).length;
  const erfolg = pass1Count > 0;
  updateSystemLog(res, { pipelineId }, {
    text: erfolg
      ? `STURM fertig — ${pass1Count} Werte aus ${stream.classification?.label ?? "Dokument"}`
      : `STURM fertig — keine Werte erkannt (Belege-Workspace verfügbar)`,
    severity: erfolg ? "success" : "warn",
    workspaceUrl: `${STURM_URL.replace(/^http/, "https").replace(":7800", "")}/workspace.html?ws=${encodeURIComponent(ws.wsId)}`,
  });

  // ─── case_state-Bridge (Phase A: Pass 1 only) ───────────────────────────
  // Pass 2 (ELSTER-Mapping) ist in dieser Welle ausgeschaltet. Wir nehmen
  // die Roh-KPIs aus Pass 1 und schreiben sie als generische Felder mit
  // domain_pfad `sturm.<slug>` ins case_state — kein Mapping, kein
  // /klassifiziere-kpis. Personen werden aus Key-Pattern (Person A/B)
  // aggregiert (Vorname/Nachname/IdNr/Religion).

  // Steuerjahr: aus Pass-1-Summary heuristisch, sonst Vorjahr.
  const sj =
    opt.taxYearHint ??
    (() => {
      const m = String(stream.classification?.summary ?? "").match(/\b(20\d{2})\b/);
      return m ? Number(m[1]) : new Date().getFullYear() - 1;
    })();

  const pass1Kpis: Array<{ key: string; value: string; citation?: any }> = stream.classification?.kpis ?? [];
  const docTypeLabel = stream.classification?.label ?? "";

  // Pass-2-Output (eCode-keyed) — vorhanden wenn STURM_PASS_2_ENABLED=1 in
  // STURM und Pass-1 Anlagen empfohlen hat. Schema:
  //   { values: [{elster_code, value, anlage, drucktext, vordruckzeile}, ...] }
  // Wenn vorhanden, ist das die authoritative Quelle fuer ELSTER-Codes —
  // schreibePass1InCaseState merged Pass-1 + Pass-2 und nimmt Pass-2-eCodes
  // wo der Drucktext zum KPI-Key matched.
  const pass2Values: Array<{
    elster_code: string; value: string; anlage: string;
    drucktext?: string; vordruckzeile?: string;
  }> = stream.elsterExtract?.values ?? [];

  // Sprint 2: Pass-1's recommendedAnlagen durchreichen (wird in schreibePass1
  // gegen den Anlagen-Validator gesendet — Halluzinationen weg, Pflicht ergaenzt).
  const recommendedAnlagen: string[] = stream.classification?.recommendedAnlagen ?? [];

  if (pass1Kpis.length > 0) {
    try {
      const ergebnis = await schreibePass1InCaseState({
        fall_id: opt.fallId,
        beleg_id: docId,
        mandant_id: opt.mandantId ?? null,
        steuerjahr: sj,
        doc_type_label: docTypeLabel,
        kpis: pass1Kpis,
        pass2Values,
        recommendedAnlagen,
        optionen: {
          dateiname: opt.originalDateiname ?? filename,
          mime: mimetype,
          actor: "system",
          actor_id: "sturm.client.v2.pass1",
          defaultKonfidenz: 0.95,
        },
      });
      console.log(
        `[SturmClientV2/Phase-A] case_state ${ergebnis.case_id}: ` +
        `${ergebnis.felder_geschrieben} Felder + ${ergebnis.personen_geschrieben} Personen ` +
        `(${pass1Kpis.length} Pass-1-KPIs)`,
      );

      // ─── Phase 2.1: Bank-KAP-Aggregator (Algo, kein Opus) ────────────
      // Vor dem Opus-Trigger: aggregiere Kapitalerträge aus N Banken auf
      // einen Wert. Standard-Tax-Logik, kein Klärungsthema. Spart Opus-Calls.
      try {
        const { aggregiereKapitalertraege } = await import("./src/sturm/aggregateKapitalertraege.js");
        const aggResults = await aggregiereKapitalertraege(ergebnis.case_id);
        if (aggResults.length > 0) {
          console.log(
            `[Aggregator/KAP] case=${ergebnis.case_id} ` +
            `${aggResults.length} ELSTER-Codes aggregiert: ` +
            aggResults.map(r => `${r.ecode}=${r.summe}(Σ${r.beleg_count})`).join(", "),
          );
        }
      } catch (e: any) {
        console.warn(`[Aggregator/KAP] fehlgeschlagen: ${e?.message ?? e}`);
      }

      // ─── Phase 2.2 + 2.3: Auto-Meta (Steuerjahr + Veranlagungsart) ───
      try {
        const { autoMeta } = await import("./src/sturm/autoMeta.js");
        const meta = await autoMeta(ergebnis.case_id);
        if (meta.steuerjahr_gesetzt || meta.veranlagungsart_gesetzt) {
          console.log(
            `[autoMeta] case=${ergebnis.case_id} ` +
            (meta.steuerjahr_gesetzt ? `Steuerjahr=${meta.steuerjahr_gesetzt} ` : "") +
            (meta.veranlagungsart_gesetzt ? `Veranlagungsart=${meta.veranlagungsart_gesetzt}` : ""),
          );
        }
      } catch (e: any) {
        console.warn(`[autoMeta] fehlgeschlagen: ${e?.message ?? e}`);
      }

      // ─── Phase 2.4: Vorjahres-Stammdaten-Übernahme ─────────────────────
      // Wenn ein Vorjahres-Bucket existiert: Stammdaten + Pendler-km
      // automatisch übernehmen (niedrige Prio, aktuelle Belege gewinnen).
      try {
        const { uebernehmeVorjahresStammdaten } = await import("./src/sturm/vorjahresUebernahme.js");
        await uebernehmeVorjahresStammdaten(ergebnis.case_id);
      } catch (e: any) {
        console.warn(`[vorjahres] fehlgeschlagen: ${e?.message ?? e}`);
      }

      // ─── Aktenpruefung-Trigger: Opus-Steuerberater pruefen lassen ───
      // Hier ist der DEFINITIVE Zeitpunkt, an dem case_state mit Pass-1-
      // Werten gefuellt ist. Race-frei (im Gegensatz zum Trigger in
      // server.ts der parallel zur Schreibung lief).
      try {
        const { pruefungNachBeleg } = await import("./aktenpruefung.js");
        const aktion = await pruefungNachBeleg(ergebnis.case_id, {
          beleg_id: docId,
          dateiname: opt.originalDateiname ?? filename,
          doc_type: docTypeLabel,
          kpis: pass1Kpis.length,
          ecodes: pass2Values?.length ?? 0,
        });
        if (aktion) {
          const inp = aktion.tool_input ?? {};
          const fragetext = String(inp.frage ?? inp.zusammenfassung ?? "");
          const replies: string[] = Array.isArray(inp.quick_replies)
            ? inp.quick_replies
            : (Array.isArray(inp.werte)
                ? inp.werte.map((w: any) => `${w.wert}${w.dateiname ? ` (${w.dateiname})` : ""}`)
                : (Array.isArray(inp.jahre)
                    ? inp.jahre.map((j: any) => String(j))
                    : (Array.isArray(inp.vorschlaege) ? inp.vorschlaege : [])));
          console.log(`[Aktenpruefung] case=${ergebnis.case_id} tool=${aktion.tool_name} frage="${fragetext.slice(0, 80)}"`);
          // SSE: assistant message + quick replies an offenen Upload-Stream
          if (res && !res.writableEnded) {
            try {
              res.write(`data: ${JSON.stringify({
                type: "aktenpruefung_frage",
                tool: aktion.tool_name,
                tool_use_id: aktion.tool_use_id,
                case_id: ergebnis.case_id,
                frage: fragetext,
                quick_replies: replies,
              })}\n\n`);
            } catch { /* noop */ }
          }
        }
      } catch (e: any) {
        console.warn(`[Aktenpruefung] Trigger fehlgeschlagen: ${e?.message ?? String(e)}`);
      }

      // ─── LogChipStream-Events (Frame 05b): CASE + PERSONS ─────────────
      emitSystemLog(res, {
        icon: "",
        text:
          `BELEG_ANGENOMMEN + BELEG_KLASSIFIZIERT in case_state ` +
          `(${ergebnis.felder_geschrieben} Felder)`,
        refType: "dokument",
        refId: `${docId}-case`,
        source: "CASE",
        severity: "success",
      });
      if (ergebnis.personen_geschrieben > 0) {
        emitSystemLog(res, {
          icon: "",
          text:
            `${ergebnis.personen_geschrieben} Person(en) im Fall ` +
            `aggregiert + via PERSON_HINZUFUEGEN persistiert`,
          refType: "dokument",
          refId: `${docId}-persons`,
          source: "PERSONS",
          severity: "success",
        });
      }
    } catch (e: any) {
      console.error(`[SturmClientV2/Phase-A] case_state-Schreibung gescheitert: ${e?.message ?? String(e)}`);
      emitSystemLog(res, {
        icon: "",
        text: `case_state-Schreibung gescheitert: ${e?.message ?? "unbekannter Fehler"}`,
        refType: "dokument",
        refId: `${docId}-case-error`,
        source: "CASE",
        severity: "error",
      });
    }
  }

  // ─── MistralBefunde-kompatible Rueckgabe fuer Legacy-Konsumenten ──────────
  // Phase A: kern_werte werden aus den Pass-1-KPIs gebaut. KEIN ELSTER-Code,
  // KEINE Anlage-Zuordnung. narrationsLoop verwendet das fuer artifact.fields.
  const kernWerte: MistralWert[] = pass1Kpis
    .filter((k) => (k.value ?? "").toString().trim().length > 0)
    .map((k) => {
      const personHint: "A" | "B" | undefined =
        PERSON_B_REGEX_GLOBAL.test(k.key) ? "B"
        : PERSON_A_REGEX_GLOBAL.test(k.key) ? "A"
        : undefined;
      return {
        anlage: "Sonstiges",
        person: personHint,
        feld: k.key,
        wert: String(k.value),
        elster_code: undefined,
      };
    });

  return {
    doc_type: (docTypeLabel as any) || "einkommensteuererklaerung",
    kurz_beschreibung:
      stream.classification?.summary ??
      `${pass1Count} Werte erkannt`,
    steuerjahr: sj,
    vertrauen: stream.classification?.confidence ?? 0.95,
    personen: [],
    anlagen: [],
    kern_werte: kernWerte,
    rohZeilen: [],
  };
}

/**
 * Datei in den Workspace-Inbox schieben. STURM streamt SSE — uns interessieren
 * nur die `ingested`/`done`-Frames, alles andere wird verworfen. Liefert die
 * erzeugte Doc-UUID (sturm_doc_uuid).
 */
export async function uploadToWorkspace(
  wsId: string,
  filePath: string,
  filename: string,
  mimeType: string,
): Promise<{ uuid: string }> {
  const form = new FormData();
  const stat = statSync(filePath);
  form.append("file", createReadStream(filePath), {
    filename,
    contentType: mimeType || "application/octet-stream",
    knownLength: stat.size,
  });
  // node-Form-Data + http: weil fetch kein form-data multipart ohne Workaround macht.
  const isHttps = STURM_URL.startsWith("https://");
  const url = new URL(`${STURM_URL}/api/workspaces/${encodeURIComponent(wsId)}/upload`);
  return new Promise((resolve, reject) => {
    const opts = {
      method: "POST",
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      headers: { ...form.getHeaders(), ...authHeader() },
    };
    const req = (isHttps ? https : http).request(opts, (resp) => {
      let buffer = "";
      let docUuid: string | null = null;
      resp.setEncoding("utf-8");
      resp.on("data", (chunk: string) => {
        buffer += chunk;
        // SSE-Frames enden mit "\n\n", innerhalb gibt es "event: <name>\n"
        // und/oder "data: <json>\n"-Zeilen. Wir suchen pro Frame die data-
        // Zeile, parsen JSON und merken die erste auftretende `uuid`.
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of frame.split(/\r?\n/)) {
            if (!line.startsWith("data:")) continue;
            try {
              const obj = JSON.parse(line.slice(5).trim());
              if (obj?.uuid && !docUuid) docUuid = String(obj.uuid);
            } catch { /* still */ }
          }
        }
      });
      resp.on("end", () => {
        if (resp.statusCode && resp.statusCode >= 400) {
          reject(new Error(`STURM Upload HTTP ${resp.statusCode}`));
          return;
        }
        if (!docUuid) { reject(new Error("STURM Upload-Response ohne uuid")); return; }
        resolve({ uuid: docUuid });
      });
      resp.on("error", reject);
    });
    req.on("error", reject);
    form.pipe(req);
  });
}
