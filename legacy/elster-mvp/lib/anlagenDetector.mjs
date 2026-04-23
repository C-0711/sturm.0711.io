// Upload-getriggerter Worker: erkennt die ELSTER-Anlagen eines hochgeladenen
// Dokuments mit einem minimalen Mistral-OCR-Call und persistiert das Ergebnis
// neben der Datei als "<upload>.anlagen.json". Laeuft voellig entkoppelt von
// der Pipeline (refine-stream) — Fire-and-Forget beim Upload.
//
// Output-Schema (uploads/<file>.anlagen.json):
//   { status: "running" | "done" | "error",
//     erkannte_anlagen?: string[],   // nur bei status=done
//     ms?: number,                    // OCR-Dauer
//     model?: string,
//     started_at: ISO-String,
//     finished_at?: ISO-String,
//     error?: string }                // nur bei status=error

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const MIME = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff",
};

export function anlagenJsonPfad(filePath) {
  return `${filePath}.anlagen.json`;
}

function schreibeStatus(statusPfad, daten) {
  try {
    fs.writeFileSync(statusPfad, JSON.stringify(daten, null, 2), "utf8");
  } catch (e) {
    console.warn(`[anlagenDetector] konnte Status nicht schreiben (${statusPfad}): ${e.message}`);
  }
}

// Baut das Mini-Schema, das Mistral OCR nur fuer die Anlagen-Erkennung fuettert.
// Bewusst minimal: kein additionalProperties, nur ein Feld, strict. Dadurch
// kurzer Prompt, kleiner Roundtrip, klar validierbares Ergebnis.
function baueDetectorSchema(alleAnlagenCodes) {
  return {
    type: "object",
    description: "Klassifiziere das Dokument: Welche ELSTER-Anlagen werden durch dieses Dokument eindeutig belegt? Nur Codes aus enum. Leeres Array wenn keine Anlage eindeutig zuordenbar (z. B. Privatrechnung, Werbung).",
    properties: {
      erkannte_anlagen: {
        type: "array",
        description: "Liste der ELSTER-Anlagen-Codes, fuer die dieses Dokument eindeutige Daten liefert. Beispiele: Lohnsteuerbescheinigung -> ['N']; Kapitalertragsteuerbescheinigung -> ['KAP']; Rentenbezugsmitteilung -> ['R']; Vorsorgeaufwand-Bescheinigung -> ['VOR']. 'ESt1A' nur wenn das Dokument Stammdaten des Steuerpflichtigen liefert.",
        items: { type: "string", enum: alleAnlagenCodes },
      },
    },
    required: ["erkannte_anlagen"],
    additionalProperties: false,
  };
}

async function ruftMistralOcr({ filePath, originalName, schema, mistralApiKey }) {
  const ext = path.extname(originalName || filePath).toLowerCase();
  const mime = MIME[ext] || "application/octet-stream";
  const isImage = mime.startsWith("image/");
  const buf = await fsp.readFile(filePath);
  const dataUri = `data:${mime};base64,${buf.toString("base64")}`;

  const t0 = Date.now();
  const document = isImage
    ? { type: "image_url", image_url: dataUri }
    : { type: "document_url", document_url: dataUri };

  const body = {
    model: "mistral-ocr-latest",
    document,
    document_annotation_format: {
      type: "json_schema",
      json_schema: { name: "AnlagenDetect", schema, strict: true },
    },
  };

  const resp = await fetch("https://api.mistral.ai/v1/ocr", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${mistralApiKey}`,
    },
    body: JSON.stringify(body),
  });

  const ms = Date.now() - t0;
  const txt = await resp.text();
  if (!resp.ok) {
    throw new Error(`Mistral OCR HTTP ${resp.status}: ${txt.slice(0, 400)}`);
  }
  const json = JSON.parse(txt);
  let annotation = json.document_annotation;
  for (let i = 0; i < 3 && typeof annotation === "string"; i++) {
    try { annotation = JSON.parse(annotation); } catch { break; }
  }
  return { annotation, ms, model: json.model || "mistral-ocr-latest" };
}

// Kern-Aufruf: fuehrt den Mistral-OCR-Detection-Call aus und persistiert das
// Ergebnis in anlagen.json. Gibt ein Promise zurueck, das mit dem Status-Objekt
// aufloest — so kann der Aufrufer wahlweise awaiten (Pipeline-Parallelworkflow)
// oder nicht (Upload-Fire-and-Forget).
export async function detectAnlagenOnce({ filePath, originalName, mistralApiKey, elsterCatalog }) {
  const statusPfad = anlagenJsonPfad(filePath);
  const startedAt = new Date().toISOString();

  if (!mistralApiKey) {
    const daten = { status: "error", started_at: startedAt, finished_at: startedAt, error: "MISTRAL_API_KEY nicht gesetzt" };
    schreibeStatus(statusPfad, daten);
    return daten;
  }
  if (!elsterCatalog?.anlagen) {
    const daten = { status: "error", started_at: startedAt, finished_at: startedAt, error: "ELSTER-Katalog nicht geladen" };
    schreibeStatus(statusPfad, daten);
    return daten;
  }

  schreibeStatus(statusPfad, { status: "running", started_at: startedAt, original: originalName });

  const schema = baueDetectorSchema(Object.keys(elsterCatalog.anlagen));
  try {
    const { annotation, ms, model } = await ruftMistralOcr({ filePath, originalName, schema, mistralApiKey });
    const roh = Array.isArray(annotation?.erkannte_anlagen) ? annotation.erkannte_anlagen : [];
    const erkannt = roh.filter(a => elsterCatalog.anlagen[a]);
    const daten = {
      status: "done",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      original: originalName,
      erkannte_anlagen: erkannt,
      erkannte_anlagen_roh: roh,
      ms, model,
    };
    schreibeStatus(statusPfad, daten);
    return daten;
  } catch (err) {
    const daten = {
      status: "error",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      original: originalName,
      error: String(err?.message || err).slice(0, 500),
    };
    schreibeStatus(statusPfad, daten);
    return daten;
  }
}

// Fire-and-Forget-Wrapper fuer den Upload-Hook. Kein await noetig, keine
// unhandled rejections (detectAnlagenOnce faengt intern ab).
export function kickoffAnlagenDetection(args) {
  detectAnlagenOnce(args).catch(() => {/* wird in detectAnlagenOnce abgefangen */});
}

// Synchroner Lesezugriff fuer refine-stream: liefert { status, erkannte_anlagen? }
// oder null, wenn keine Statusdatei existiert.
export function leseAnlagenStatus(filePath) {
  const statusPfad = anlagenJsonPfad(filePath);
  if (!fs.existsSync(statusPfad)) return null;
  try {
    return JSON.parse(fs.readFileSync(statusPfad, "utf8"));
  } catch {
    return null;
  }
}
