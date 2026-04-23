// Mistral Playground — Drop file, see OCR, optionally run an LLM on it.
//
// Chain: Upload → Mistral OCR → (optional) LLM with custom prompt → Result
//
// Endpoints:
//   POST /api/ocr       — multipart file → { text, pages, model, ms }
//   POST /api/llm       — { text, prompt, provider, model } → { output, ms }
//   GET  /api/models    — list available providers/models
//   GET  /uploads/*     — static view of uploaded files
//
// Start:  MISTRAL_API_KEY=... node server.mjs
// Port:   PORT env (default 7800)

import express from "express";
import multer from "multer";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { kickoffAnlagenDetection, leseAnlagenStatus } from "./lib/anlagenDetector.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const PORT = Number(process.env.PORT || 7800);
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

// ─────────────────────────────────────────────────────────────
// ELSTER-Schema-Katalog (beim Start einmal laden)
// ─────────────────────────────────────────────────────────────
const ELSTER_PATH = path.join(__dirname, "public", "elster_schemas.json");
let elsterCatalog = null;
try {
  elsterCatalog = JSON.parse(fs.readFileSync(ELSTER_PATH, "utf8"));
  console.log(`  ELSTER catalog: ${elsterCatalog.anlagen_count} Anlagen aus Jahr ${elsterCatalog.year}`);
} catch (e) {
  console.warn(`  ELSTER catalog: konnte ${ELSTER_PATH} nicht laden — ${e.message}`);
  console.warn(`  → scripts/build_elster_schemas.py ausfuehren um zu erzeugen`);
}

// ─────────────────────────────────────────────────────────────
// BMF-Felder-Katalog (Jahresdokumentation) — Pflicht + Format-Regex
// ─────────────────────────────────────────────────────────────
const BMF_PATH = path.join(__dirname, "public", "elster_felder_2024.json");
let bmfCatalog = null;
let bmfCodeIndex = null;          // E-Code → feld (global)
let bmfCodeIndexPerAnlage = null; // anlage → code → feld
let bmfLabelIndex = null;         // V2-Hybrid Label-Index (unten initialisiert)
try {
  bmfCatalog = JSON.parse(fs.readFileSync(BMF_PATH, "utf8"));
  bmfCodeIndex = new Map();
  bmfCodeIndexPerAnlage = new Map();
  for (const [anlage, a] of Object.entries(bmfCatalog.anlagen)) {
    const perAnlage = new Map();
    for (const [code, feld] of Object.entries(a.felder)) {
      perAnlage.set(code, feld);
      const bestehend = bmfCodeIndex.get(code);
      if (!bestehend || (feld.pflicht && !bestehend.pflicht)) bmfCodeIndex.set(code, feld);
    }
    bmfCodeIndexPerAnlage.set(anlage, perAnlage);
  }
  console.log(`  BMF catalog: ${bmfCatalog.anlagen_count} Anlagen · ${bmfCatalog.fields_count} E-Codes · ${bmfCatalog.pflicht_count} Pflichtfelder`);
  baueBmfLabelIndex();
} catch (e) {
  console.warn(`  BMF catalog: konnte ${BMF_PATH} nicht laden — ${e.message}`);
  console.warn(`  → scripts/build_bmf_felder.py ausfuehren um zu erzeugen`);
}

// ─── Label-Index für deterministische Kuration (V2-Hybrid) ──────────────
// Dreifach-Index aus dem BMF-Katalog:
//   1. byZeile       — (anlage, vordruckzeile, drucktext_norm) → {code}
//   2. byDrucktext   — (anlage, kontext_norm, drucktext_norm)   → [{code}]
//   3. byBeschreib   — beschreibung_norm → [{code, anlage, kontext}]
// Damit kann eine Regel-Engine Mistral-Rohtext-Zeilen (die vordruckzeile + drucktext enthalten)
// und Vision-JSON-Keys (die oft der beschreibung entsprechen) exakt auf E-Codes mappen.

function normLabel(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[^\wÄÖÜäöüß\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function baueBmfLabelIndex() {
  if (!bmfCatalog) return;
  const byZeile = new Map();
  const byDrucktext = new Map();
  const byBeschreib = new Map();
  for (const [anlage, a] of Object.entries(bmfCatalog.anlagen)) {
    for (const [code, feld] of Object.entries(a.felder)) {
      const kontext = normLabel(feld.kontext);
      const dt = normLabel(feld.drucktext);
      const be = normLabel(feld.beschreibung);
      const zeile = String(feld.vordruckzeile || "").trim();

      if (zeile && dt) {
        const k = `${anlage}|${zeile}|${dt}`;
        if (!byZeile.has(k)) byZeile.set(k, { code, anlage, kontext: feld.kontext });
      }
      if (dt) {
        const k = `${anlage}|${kontext}|${dt}`;
        if (!byDrucktext.has(k)) byDrucktext.set(k, []);
        byDrucktext.get(k).push({ code, anlage, kontext: feld.kontext });
      }
      if (be) {
        if (!byBeschreib.has(be)) byBeschreib.set(be, []);
        byBeschreib.get(be).push({ code, anlage, kontext: feld.kontext });
      }
    }
  }
  bmfLabelIndex = { byZeile, byDrucktext, byBeschreib };
  console.log(`  BMF Label-Index: byZeile=${byZeile.size} byDrucktext=${byDrucktext.size} byBeschreib=${byBeschreib.size}`);
}

function bmfFeldFuerCode(code, anlage) {
  if (!bmfCodeIndex) return null;
  if (anlage && bmfCodeIndexPerAnlage.has(anlage)) {
    const inAnlage = bmfCodeIndexPerAnlage.get(anlage).get(code);
    if (inAnlage) return inAnlage;
  }
  return bmfCodeIndex.get(code) || null;
}

function bmfPflichtFelderFuerKombi(anlagen) {
  const alle = [];
  const gesehen = new Set();
  for (const a of (anlagen || [])) {
    const perAnlage = bmfCodeIndexPerAnlage?.get(a);
    if (!perAnlage) continue;
    for (const f of perAnlage.values()) {
      if (f.pflicht && !gesehen.has(f.name)) {
        alle.push(f);
        gesehen.add(f.name);
      }
    }
  }
  return alle;
}

function bmfValidiereWert(code, wert, anlage) {
  const feld = bmfFeldFuerCode(code, anlage);
  if (!feld) return null;
  const regex = (feld.format_regex || "").trim();
  if (!regex) {
    if (feld.min_laenge !== null || feld.max_laenge !== null) {
      const len = String(wert).length;
      const minOk = feld.min_laenge === null || len >= feld.min_laenge;
      const maxOk = feld.max_laenge === null || len <= feld.max_laenge;
      return {
        ok: minOk && maxOk,
        format: feld.format || "",
        details: (minOk && maxOk) ? null
          : `Laenge ${len}, erwartet ${feld.min_laenge || 0}..${feld.max_laenge || "∞"}`,
      };
    }
    return null;
  }
  let ok;
  try {
    ok = new RegExp("^(?:" + regex + ")$").test(String(wert));
  } catch {
    return null;
  }
  return {
    ok,
    format: feld.format || "",
    details: ok ? null : `"${String(wert).slice(0, 40)}" passt nicht zum BMF-Format: ${feld.format}`,
  };
}

const MIME = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff",
};

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use("/uploads", express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, "public")));

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => {
    const stamp = Date.now();
    const safe = file.originalname.replace(/[^\w.\-() ]+/g, "_");
    cb(null, `${stamp}_${safe}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// ─────────────────────────────────────────────────────────────
// Mistral OCR
// ─────────────────────────────────────────────────────────────
async function mistralOcr(filePath, filename, jsonSchema = null, schemaName = "Extraction") {
  if (!MISTRAL_API_KEY) throw new Error("MISTRAL_API_KEY not set");
  const ext = path.extname(filename).toLowerCase();
  const mime = MIME[ext] || "application/octet-stream";
  const isImage = mime.startsWith("image/");
  const buf = await fsp.readFile(filePath);
  const b64 = buf.toString("base64");
  const dataUri = `data:${mime};base64,${b64}`;

  const t0 = Date.now();
  const document = isImage
    ? { type: "image_url", image_url: dataUri }
    : { type: "document_url", document_url: dataUri };

  const body = { model: "mistral-ocr-latest", document };
  if (jsonSchema) {
    body.document_annotation_format = {
      type: "json_schema",
      json_schema: {
        name: schemaName || "Extraction",
        schema: jsonSchema,
        strict: true,
      },
    };
  }

  const resp = await fetch("https://api.mistral.ai/v1/ocr", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${MISTRAL_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  const ms = Date.now() - t0;
  const txt = await resp.text();
  let json;
  try { json = JSON.parse(txt); } catch { json = { raw: txt }; }

  if (!resp.ok) {
    throw new Error(`Mistral OCR HTTP ${resp.status}: ${txt.slice(0, 400)}`);
  }

  const pages = (json.pages || []).map((p, i) => ({
    index: p.index ?? i,
    markdown: p.markdown || p.text || "",
    chars: (p.markdown || p.text || "").length,
  }));
  const fullText = pages.map(p => p.markdown).join("\n\n");

  let annotation = null;
  if (json.document_annotation) {
    // Mistral liefert document_annotation als JSON-String; manche Gateways
    // escapen doppelt. Bis zu 3x parsen, bis wir ein Objekt haben.
    annotation = json.document_annotation;
    for (let i = 0; i < 3 && typeof annotation === "string"; i++) {
      try {
        annotation = JSON.parse(annotation);
      } catch {
        break;
      }
    }
  }

  return {
    model: json.model || "mistral-ocr-latest",
    pages,
    text: fullText,
    chars: fullText.length,
    annotation,
    ms,
    usage: json.usage_info || json.usage || null,
  };
}

// ─────────────────────────────────────────────────────────────
// LLM chain (Claude / Mistral / Ollama)
// ─────────────────────────────────────────────────────────────
async function runClaude(model, system, user, opts = {}) {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  const { maxTokens = 2048 } = opts;
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: system || undefined,
      messages: [{ role: "user", content: user }],
    }),
  });
  const txt = await resp.text();
  if (!resp.ok) throw new Error(`Claude HTTP ${resp.status}: ${txt.slice(0, 400)}`);
  const json = JSON.parse(txt);
  const output = (json.content || []).map(c => c.text || "").join("").trim();
  return { output, usage: json.usage, stop_reason: json.stop_reason };
}

async function runMistralChat(model, system, user, opts = {}) {
  if (!MISTRAL_API_KEY) throw new Error("MISTRAL_API_KEY not set");
  const { maxTokens = 4096, responseFormat = null } = opts;
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: user });
  const body = { model, messages, temperature: 0.2, max_tokens: maxTokens };
  if (responseFormat) body.response_format = responseFormat;
  const resp = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${MISTRAL_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const txt = await resp.text();
  if (!resp.ok) throw new Error(`Mistral HTTP ${resp.status}: ${txt.slice(0, 400)}`);
  const json = JSON.parse(txt);
  const output = (json.choices?.[0]?.message?.content || "").trim();
  return { output, usage: json.usage, finish_reason: json.choices?.[0]?.finish_reason };
}

async function runOllama(model, system, user) {
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: user });
  const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: false }),
  });
  const txt = await resp.text();
  if (!resp.ok) throw new Error(`Ollama HTTP ${resp.status}: ${txt.slice(0, 400)}`);
  const json = JSON.parse(txt);
  const output = (json.message?.content || "").trim();
  return { output, usage: { total_duration_ms: Math.round((json.total_duration || 0) / 1e6) } };
}

// ─────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────
app.get("/api/models", async (_req, res) => {
  const models = [
    { provider: "claude", id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 (fast)" },
    { provider: "claude", id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { provider: "claude", id: "claude-opus-4-7", label: "Claude Opus 4.7" },
    { provider: "mistral", id: "mistral-large-latest", label: "Mistral Large" },
    { provider: "mistral", id: "mistral-small-latest", label: "Mistral Small" },
  ];
  // Probe Ollama for local models
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`);
    if (r.ok) {
      const j = await r.json();
      for (const m of j.models || []) {
        models.push({ provider: "ollama", id: m.name, label: `Ollama · ${m.name}` });
      }
    }
  } catch { /* ollama not running — ignore */ }
  res.json({
    models,
    keys: {
      mistral: Boolean(MISTRAL_API_KEY),
      anthropic: Boolean(ANTHROPIC_API_KEY),
      ollama_url: OLLAMA_URL,
    },
  });
});

// Pure Upload ohne OCR — für die Pipeline-Seite, die OCR selbst via refine-stream triggert.
// Nebenbei: Fire-and-Forget Anlagen-Detektion startet direkt auf dem Upload-Pfad.
// Das Ergebnis landet in uploads/<file>.anlagen.json und kann via GET /api/anlagen/:file
// gelesen werden. refine-stream nutzt die Datei, falls sie bis dahin fertig ist.
app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "keine Datei" });
  kickoffAnlagenDetection({
    filePath: req.file.path,
    originalName: req.file.originalname,
    mistralApiKey: MISTRAL_API_KEY,
    elsterCatalog,
  });
  res.json({
    stored: path.basename(req.file.path),
    original: req.file.originalname,
    size: req.file.size,
    mime: req.file.mimetype,
    url: `/uploads/${path.basename(req.file.path)}`,
    anlagen_detection: "running",
  });
});

// Lesezugriff auf das Anlagen-Detektor-Ergebnis (Polling vom Frontend).
// Liefert { status, erkannte_anlagen?, ms?, ... } oder 404, wenn nie getriggert.
app.get("/api/anlagen/:stored", (req, res) => {
  const filePath = path.join(UPLOAD_DIR, path.basename(req.params.stored));
  const status = leseAnlagenStatus(filePath);
  if (!status) return res.status(404).json({ error: "keine Anlagen-Detektion fuer diese Datei" });
  res.json(status);
});

// Re-trigger fuer den Anlagen-Detector bei bereits hochgeladener Datei.
// Fire-and-Forget wie beim Upload; ueberschreibt anlagen.json mit fresh status=running.
app.post("/api/anlagen/:stored/trigger", (req, res) => {
  const storedBasename = path.basename(req.params.stored);
  const filePath = path.join(UPLOAD_DIR, storedBasename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Datei nicht im uploads/-Ordner" });
  kickoffAnlagenDetection({
    filePath,
    originalName: req.body?.original || storedBasename,
    mistralApiKey: MISTRAL_API_KEY,
    elsterCatalog,
  });
  res.json({ triggered: true, stored: storedBasename });
});

app.post("/api/ocr", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "no file uploaded" });
  let schema = null;
  let schemaName = "Extraction";
  if (req.body.schema) {
    try {
      schema = typeof req.body.schema === "string" ? JSON.parse(req.body.schema) : req.body.schema;
      schemaName = req.body.schemaName || schema.title || "Extraction";
    } catch (e) {
      return res.status(400).json({ error: `invalid schema JSON: ${e.message}` });
    }
  }
  try {
    const out = await mistralOcr(req.file.path, req.file.originalname, schema, schemaName);
    res.json({
      file: {
        name: req.file.originalname,
        stored: path.basename(req.file.path),
        size: req.file.size,
        mimetype: req.file.mimetype,
        url: `/uploads/${path.basename(req.file.path)}`,
      },
      ocr: out,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Re-run OCR on an already-uploaded file with a new schema (no re-upload).
app.post("/api/ocr-rerun", async (req, res) => {
  const { storedFilename, originalName, schema, schemaName } = req.body || {};
  if (!storedFilename) return res.status(400).json({ error: "storedFilename required" });
  const filePath = path.join(UPLOAD_DIR, path.basename(storedFilename));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "file not found" });
  try {
    const out = await mistralOcr(filePath, originalName || storedFilename, schema || null, schemaName || "Extraction");
    res.json({ ocr: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Smart schema builder: NL description (+ optional OCR context) → Pydantic + JSON Schema
app.post("/api/schema/build", async (req, res) => {
  const { prompt = "", ocrText = "", model = "claude-haiku-4-5-20251001" } = req.body || {};
  if (!prompt && !ocrText) return res.status(400).json({ error: "prompt or ocrText required" });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  const systemPrompt = `Du bist ein Schema-Architekt für deutsche Steuer-/Dokumentdaten.
Aufgabe: Aus einer Beschreibung (und ggf. OCR-Text) erzeugst du PRÄZISE zwei Artefakte:
1) eine Python Pydantic v2 Klasse
2) ein JSON-Schema das 1:1 dazu passt (für Mistral OCR document_annotation_format).

Regeln:
- Alle Feldnamen snake_case.
- Deutsche description bei jedem Field.
- Numerische Beträge: float (nicht Decimal — Mistral OCR liefert Zahlen).
- Datumsfelder: str mit Hinweis "TT.MM.JJJJ" in description.
- Optional nur wenn wirklich optional; sonst required.
- KEIN additionalProperties.
- JSON-Schema MUSS die Keys haben: type=object, properties, required, additionalProperties=false, title.
- Antworte NUR mit diesem JSON (kein Fließtext, keine Codefences):
{"pydantic_code": "from pydantic import BaseModel, Field\\n\\nclass Name(BaseModel):\\n    ...", "json_schema": {...}, "title": "SchemaName", "kurz": "1-Satz Zusammenfassung"}`;

  const userMsg = ocrText
    ? `Beschreibung:\n${prompt || "(keine Beschreibung)"}\n\nOCR-Text (zum Kalibrieren welche Felder wirklich vorkommen):\n${ocrText.slice(0, 8000)}`
    : `Beschreibung:\n${prompt}`;

  const t0 = Date.now();
  try {
    const { output, stop_reason, usage } = await runClaude(model, systemPrompt, userMsg, { maxTokens: 8192 });
    const parsed = extrahiereJson(output);
    if (!parsed) {
      const abgeschnitten = stop_reason === "max_tokens";
      return res.status(500).json({
        error: abgeschnitten
          ? `Claude-Antwort wurde bei max_tokens (8192) abgeschnitten — Schema zu gross. Reduziere den Prompt oder splitte die Anlage. Stop-Reason: ${stop_reason}`
          : `Claude hat kein parsebares JSON geliefert (stop_reason=${stop_reason}). Antwort-Auszug: ` + output.slice(0, 400),
        stop_reason,
        usage,
        ms: Date.now() - t0,
      });
    }
    res.json({ ...parsed, ms: Date.now() - t0, model });
  } catch (e) {
    res.status(500).json({ error: e.message, ms: Date.now() - t0 });
  }
});

// Hilfsfunktion: greift JSON aus LLM-Antworten (auch mit Codefences oder Prolog).
function extrahiereJson(text) {
  if (!text || typeof text !== "string") return null;
  let t = text.trim();
  // 1. Codefence mit Closing ``` (```json ... ```)
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  else {
    // 1b. Oeffnender Fence ohne Closing — Antwort wurde abgeschnitten
    const fenceOffen = t.match(/```(?:json)?\s*([\s\S]*)$/);
    if (fenceOffen) t = fenceOffen[1].trim();
  }
  // 2. Direkt parsen
  try { return JSON.parse(t); } catch { /* weiter */ }
  // 3. Erstes `{` — bei jedem weiteren `{`/`}` den Zaehler fuehren, beim 0-Stand Ende nehmen.
  //    Respektiert Strings (keine Zaehlung innerhalb) und Escape-Sequenzen.
  const start = t.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; }
        }
      }
    }
  }
  return null;
}

// Batch OCR (no schema) for schema induction.
// Runs Mistral OCR on multiple files in parallel with a concurrency cap.
app.post("/api/ocr-batch", upload.array("files", 50), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: "no files uploaded" });
  const CONC = 4;
  const results = new Array(files.length);
  let idx = 0;
  const tStart = Date.now();

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= files.length) return;
      const f = files[i];
      try {
        const out = await mistralOcr(f.path, f.originalname);
        results[i] = {
          name: f.originalname,
          stored: path.basename(f.path),
          url: `/uploads/${path.basename(f.path)}`,
          size: f.size,
          text: out.text,
          chars: out.chars,
          pages: out.pages.length,
          ms: out.ms,
          error: null,
        };
      } catch (e) {
        results[i] = { name: f.originalname, error: e.message };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONC, files.length) }, worker));
  res.json({
    count: files.length,
    total_ms: Date.now() - tStart,
    results,
  });
});

// Schema induction: many OCR texts + topic → one canonical Pydantic + JSON-Schema
// with frequency stats per field.
app.post("/api/schema/induce", async (req, res) => {
  const { topic = "", ocrResults = [], model = "claude-opus-4-7" } = req.body || {};
  if (!ocrResults.length) return res.status(400).json({ error: "ocrResults required" });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  // Build the corpus, keep it bounded
  const MAX_CHARS_PER_DOC = 4000;
  const corpus = ocrResults
    .filter(r => r && r.text)
    .map((r, i) => `=== Dokument ${i + 1}: ${r.name} ===\n${(r.text || "").slice(0, MAX_CHARS_PER_DOC)}`)
    .join("\n\n");

  const system = `Du bist ein Schema-Induktions-Experte für deutsche Dokumentdaten.

Aufgabe: Analysiere ${ocrResults.length} OCR-Texte desselben Themas und destilliere EIN kanonisches Schema das ALLE beobachteten Felder vereint — auch wenn einzelne Belege sie nicht enthalten.

Vorgehensweise:
1. Identifiziere den Dokumenttyp und die stabilen Felder (kommen in allen Dokumenten vor) → required
2. Erkenne Varianz-Felder (nur in manchen Dokumenten) → optional
3. Erkenne Listen-Strukturen (z.B. Positionszeilen, Buchungen) → array of object
4. Konsolidiere Synonyme unter ein einheitliches Feld (z.B. "Mehrwertsteuer" = "USt" = "Umsatzsteuer" → mwst)
5. Für jedes Feld: zähle in wievielen Dokumenten es auftauchte

Output-Regeln:
- Alle Feldnamen snake_case
- Deutsche description
- Beträge: float
- Datum: str "TT.MM.JJJJ"
- Listen: proper nested object mit eigenen properties
- additionalProperties: false
- required nur wenn das Feld in mindestens 80% der Belege vorkam
- JSON-Schema-Keys: type=object, properties, required, additionalProperties=false, title

Antworte NUR mit diesem JSON (keine Codefences):
{
  "title": "CanonicalSchemaName",
  "doc_type": "lohnsteuerbescheinigung|rechnung|steuerbescheid|...",
  "kurz": "1-Satz Zusammenfassung",
  "anzahl_dokumente": N,
  "felder_statistik": [
    {"feld": "bruttoarbeitslohn", "seen_in": 10, "total": 10, "required": true, "typ": "float", "beispiel_werte": ["34172.08", "30558.32"]},
    {"feld": "versorgungsbezuege", "seen_in": 2, "total": 10, "required": false, "typ": "float", "beispiel_werte": ["1200.00"]},
    ...
  ],
  "pydantic_code": "from pydantic import BaseModel, Field\\nfrom typing import Optional\\n\\nclass ...",
  "json_schema": {...}
}`;

  const user = topic
    ? `Thema/Kontext: ${topic}\n\n${corpus}`
    : corpus;

  const t0 = Date.now();
  try {
    const { output, usage, stop_reason } = await runClaude(model, system, user, { maxTokens: 16384 });
    const parsed = extrahiereJson(output);
    if (!parsed) {
      const abgeschnitten = stop_reason === "max_tokens";
      return res.status(500).json({
        error: abgeschnitten
          ? `Claude-Antwort wurde bei max_tokens (16384) abgeschnitten — Korpus zu gross oder zu viele Felder. Reduziere die Anzahl Dokumente. Stop-Reason: ${stop_reason}`
          : `Claude hat kein parsebares JSON geliefert (stop_reason=${stop_reason}). Antwort-Auszug: ` + output.slice(0, 400),
        stop_reason,
        usage,
        ms: Date.now() - t0,
      });
    }
    res.json({ ...parsed, ms: Date.now() - t0, model, usage, stop_reason });
  } catch (e) {
    res.status(500).json({ error: e.message, ms: Date.now() - t0 });
  }
});

// Built-in presets
app.get("/api/schema/presets", (_req, res) => {
  res.json({
    presets: [
      { id: "lohnsteuerbescheinigung", label: "Lohnsteuerbescheinigung",
        prompt: "Deutsche elektronische Lohnsteuerbescheinigung mit allen nummerierten Feldern: Bruttoarbeitslohn, einbehaltene Lohnsteuer, Solidaritätszuschlag, Kirchensteuer, Steuerklasse, Steuer-ID, Versorgungsbezüge, RV-Beitrag AN/AG, KV/PV/AV-Beiträge, Zeitraum, Arbeitgeber, Steuerjahr." },
      { id: "steuerbescheid", label: "Steuerbescheid",
        prompt: "Einkommensteuer-Bescheid eines deutschen Finanzamts: Steuernummer, Veranlagungsjahr, zu versteuerndes Einkommen, festgesetzte Einkommensteuer, Solidaritätszuschlag, Kirchensteuer, bereits gezahlte Beträge, Erstattung oder Nachzahlung, Bescheiddatum, Steuerpflichtige(r)/Ehegatte Namen, Festsetzungs-Adresse." },
      { id: "rechnung", label: "Rechnung / Beleg",
        prompt: "Deutsche Rechnung/Quittung: Rechnungsnummer, Datum, Aussteller (Name + Adresse + USt-ID falls vorhanden), Empfänger, Positionen (Liste mit Beschreibung/Menge/Einzelpreis/Gesamtpreis), Nettosumme, MwSt-Satz, MwSt-Betrag, Bruttosumme, Zahlungsart." },
      { id: "einkommensteuererklaerung", label: "Einkommensteuererklärung",
        prompt: "Ausgefüllte deutsche Einkommensteuererklärung: Steuerpflichtige(r)/Ehegatte (Name, IdNr, Geburtsdatum, Religion, Beruf), Anschrift, IBAN, Anlagen (Liste), Bruttoarbeitslohn, Werbungskosten-Posten (mit Typ+Betrag), Vorsorgeaufwendungen, Sonderausgaben, außergewöhnliche Belastungen, Steuerjahr." },
      { id: "kontoauszug", label: "Kontoauszug",
        prompt: "Deutscher Kontoauszug: Kontoinhaber, IBAN, BIC, Kontonummer, Zeitraum, Anfangssaldo, Endsaldo, Buchungen (Liste mit Datum/Verwendungszweck/Betrag/Typ soll/haben), Summe Eingänge, Summe Ausgänge." },
    ],
  });
});

app.post("/api/llm", async (req, res) => {
  const { text = "", prompt = "", provider = "claude", model = "claude-haiku-4-5-20251001" } = req.body || {};
  if (!text && !prompt) return res.status(400).json({ error: "provide text and/or prompt" });
  const system = "Du bist ein präziser Analyse-Assistent. Antworte knapp und strukturiert auf Deutsch, es sei denn die Frage ist auf Englisch.";
  const user = prompt
    ? `${prompt}\n\n---\nOCR-Extraktion:\n${text}`
    : `Fasse die folgende OCR-Extraktion strukturiert zusammen:\n\n${text}`;
  const t0 = Date.now();
  try {
    let result;
    if (provider === "claude") result = await runClaude(model, system, user);
    else if (provider === "mistral") result = await runMistralChat(model, system, user);
    else if (provider === "ollama") result = await runOllama(model, system, user);
    else return res.status(400).json({ error: `unknown provider: ${provider}` });
    res.json({ provider, model, ms: Date.now() - t0, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message, ms: Date.now() - t0 });
  }
});

// ─────────────────────────────────────────────────────────────
// ELSTER-Routen — XSD-abgeleitete Schemata pro Anlage
// ─────────────────────────────────────────────────────────────
app.get("/api/elster/anlagen", (_req, res) => {
  if (!elsterCatalog) return res.status(503).json({ error: "ELSTER-Katalog nicht geladen. scripts/build_elster_schemas.py ausfuehren." });
  const list = Object.values(elsterCatalog.anlagen).map(a => ({
    code: a.code,
    label: a.label,
    root_type: a.root_type,
    max_occurs: a.max_occurs,
    leaf_count: a.leaf_count,
    elster_code_count: a.elster_code_count,
  }));
  list.sort((a, b) => a.code.localeCompare(b.code));
  res.json({ year: elsterCatalog.year, count: list.length, anlagen: list });
});

// Liefert das JSON-Schema + Pydantic-Code fuer eine oder mehrere Anlagen.
// /api/elster/schema?anlage=N
// /api/elster/schema?anlage=N,ESt1A  -> gemergtes Wrapper-Schema { N: ..., ESt1A: ... }
app.get("/api/elster/schema", (req, res) => {
  if (!elsterCatalog) return res.status(503).json({ error: "ELSTER-Katalog nicht geladen" });
  const raw = (req.query.anlage || "").toString().trim();
  if (!raw) return res.status(400).json({ error: "Query-Param 'anlage' erforderlich (z.B. ?anlage=N oder ?anlage=N,ESt1A)" });
  const codes = raw.split(",").map(s => s.trim()).filter(Boolean);
  const missing = codes.filter(c => !elsterCatalog.anlagen[c]);
  if (missing.length) return res.status(404).json({ error: `Unbekannte Anlage(n): ${missing.join(", ")}` });

  if (codes.length === 1) {
    const a = elsterCatalog.anlagen[codes[0]];
    return res.json({
      title: a.code,
      label: a.label,
      json_schema: a.json_schema,
      pydantic_code: a.pydantic_code,
      leaf_count: a.leaf_count,
      elster_code_count: a.elster_code_count,
      max_occurs: a.max_occurs,
    });
  }

  // Merge: wir bauen ein Wrapper-Objekt { <code>: <anlage_schema> }
  const props = {};
  const required = [];
  let totalLeaves = 0;
  let totalECodes = 0;
  const pydParts = [];
  for (const c of codes) {
    const a = elsterCatalog.anlagen[c];
    props[c] = a.json_schema;
    required.push(c);
    totalLeaves += a.leaf_count;
    totalECodes += a.elster_code_count;
    pydParts.push(`# --- Anlage ${c} ---\n${a.pydantic_code}`);
  }
  const merged = {
    type: "object",
    title: `ELSTER_${codes.join("_")}`,
    description: `ELSTER-Einkommensteuererklaerung ${elsterCatalog.year} — Branches: ${codes.join(", ")}`,
    properties: props,
    required,
    additionalProperties: false,
  };

  res.json({
    title: merged.title,
    label: `Kombiniert: ${codes.join(" + ")}`,
    json_schema: merged,
    pydantic_code: pydParts.join("\n\n"),
    leaf_count: totalLeaves,
    elster_code_count: totalECodes,
    branches: codes,
  });
});

// ═════════════════════════════════════════════════════════════════════════
// ELSTER Refinement-Loop: OCR → Evaluator → Opus-Hinweise → OCR-Retry
// ═════════════════════════════════════════════════════════════════════════
//
// Der Loop iteriert max 3x:
//   1. Mistral OCR mit JSON-Schema (document_annotation_format)
//   2. Evaluator misst Coverage Pflichtfelder + Konsistenz deterministisch
//   3. Opus sieht Originaldokument + Annotation, gibt konkrete Hinweise
//      wie man den Schema-`description`-Text für die nächste Runde anpasst
//   4. Wenn Score >= SCHWELLE_OK → fertig, sonst Schema anreichern und
//      Runde 2 bzw. 3 starten
//
// Der Prompt-Cache (in-Memory für die Playground-Sandbox) persistiert die
// Hinweise pro (schema_hash) — beim nächsten Aufruf des gleichen Schemas
// startet der Loop mit den gelernten Hinweisen und braucht oft nur 1 Runde.

const SCHWELLE_OK = 0.85;
const MAX_ITERATIONEN = 3;

// ─── Code → Anlagen Reverse-Index ─────────────────────────────────────────
// Für Cross-Check: welche Anlagen enthalten einen gegebenen E-Code?
let codeIndex = null;
function baueCodeIndex() {
  if (codeIndex || !elsterCatalog) return codeIndex;
  const idx = new Map();
  const walk = (node, anlage) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(x => walk(x, anlage)); return; }
    for (const [k, v] of Object.entries(node)) {
      if (/^E\d{7}$/.test(k)) {
        let s = idx.get(k);
        if (!s) { s = new Set(); idx.set(k, s); }
        s.add(anlage);
      }
      walk(v, anlage);
    }
  };
  for (const [code, a] of Object.entries(elsterCatalog.anlagen)) {
    walk(a.json_schema, code);
  }
  codeIndex = idx;
  console.log(`  ELSTER code-index: ${idx.size} distinct E-codes reverse-indexed`);
  return idx;
}

function sammleElsterCodes(anno, out = new Set()) {
  if (!anno || typeof anno !== "object") return out;
  if (Array.isArray(anno)) { for (const x of anno) sammleElsterCodes(x, out); return out; }
  for (const [k, v] of Object.entries(anno)) {
    if (/^E\d{7}$/.test(k) && v !== null && v !== undefined && v !== "") {
      if (typeof v !== "object" || (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0)) {
        out.add(k);
      }
    }
    if (v && typeof v === "object") sammleElsterCodes(v, out);
  }
  return out;
}

// ─── Pflichtfelder aus Schema sammeln ─────────────────────────────────────
function sammlePflichtfelder(schema, vorsatz = []) {
  const out = [];
  if (!schema || typeof schema !== "object") return out;
  if (schema.type === "object" && schema.properties) {
    const req = schema.required || [];
    for (const key of req) {
      const sub = schema.properties[key];
      if (!sub) continue;
      const pfad = [...vorsatz, key];
      if (sub.type === "object" && sub.properties) {
        out.push(...sammlePflichtfelder(sub, pfad));
      } else if (sub.type === "array" && sub.items) {
        out.push(...sammlePflichtfelder(sub.items, [...pfad, "[]"]));
      } else {
        out.push({
          pfad: pfad.join("."),
          elster_code: /^E\d{7}$/.test(key) ? key : null,
          typ: sub.type || "string",
          description: sub.description || "",
        });
      }
    }
  }
  return out;
}

function leseAusPfad(obj, pfad) {
  if (!obj) return undefined;
  let cur = obj;
  for (const seg of pfad.split(".")) {
    if (seg === "[]") {
      if (!Array.isArray(cur) || cur.length === 0) return undefined;
      cur = cur[0];
      continue;
    }
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[seg];
  }
  return cur;
}

function istBelegt(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (typeof v === "number") return true;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

// ─── Deterministische Konsistenz (BMF-Regex autoritativ) ─────────────────
function pruefeKonsistenz(annotation) {
  const befunde = [];
  const flat = [];
  (function walk(o, p) {
    if (o === null || o === undefined) return;
    if (typeof o !== "object") { flat.push([p.join("."), o]); return; }
    if (Array.isArray(o)) { o.forEach((x, i) => walk(x, [...p, String(i)])); return; }
    for (const [k, v] of Object.entries(o)) walk(v, [...p, k]);
  })(annotation, []);

  for (const [pfad, wert] of flat) {
    if (wert === "" || wert === null || wert === undefined) continue;
    const teile = pfad.split(".");
    const letztes = teile[teile.length - 1] || "";
    if (!/^E\d{7}$/.test(letztes)) continue;

    // Anlage aus erstem Pfadsegment raten (bei Wrapper-Schemas z.B. "ESt1A")
    const anlageKandidat = teile[0] && /^[A-Za-z_0-9]+$/.test(teile[0]) ? teile[0] : undefined;
    const check = bmfValidiereWert(letztes, String(wert), anlageKandidat);
    if (!check) continue;
    befunde.push({
      regel: `BMF ${pfad} (${check.format})`,
      ok: check.ok,
      details: check.details,
    });
  }
  return befunde;
}

// ─── Opus-Evaluator (semantisch) ──────────────────────────────────────────
async function opusEvaluierung(storedFilename, originalName, annotation, fehlendePflicht, model) {
  if (!ANTHROPIC_API_KEY) {
    return { score: 0.5, begruendung: "ANTHROPIC_API_KEY fehlt", hinweise: [], ms: 0 };
  }
  const filePath = path.join(UPLOAD_DIR, path.basename(storedFilename));
  const buf = await fsp.readFile(filePath);
  const mime = MIME[path.extname(originalName || storedFilename).toLowerCase()] || "application/pdf";
  const b64 = buf.toString("base64");

  const system = `Du bist Qualitaets-Pruefer fuer Mistral-OCR-Extraktionen aus deutschen
Steuerdokumenten. Du siehst das Originaldokument (Bild oder PDF) und die Annotation.
Deine Aufgabe:
  1. Pruefe jeden Wert in der Annotation gegen das Dokument.
  2. Identifiziere uebersehene Felder (Liste "fehlende Pflichtfelder" beruecksichtigen).
  3. Erkenne Halluzinationen (Felder die im Dokument nicht stehen).
  4. Gib KONKRETE Prompt-Hinweise fuer den naechsten Mistral-Lauf. Jeder Hinweis
     wird als 'description'-Ergaenzung an ein Schema-Feld angehaengt.

PFLICHT-REGELN fuer Hinweise:
  - Jeder Hinweis betrifft GENAU EIN Feld. Betrifft ein Problem mehrere Felder
    (z.B. IBAN + BIC + Kontoinhaber), gib mehrere Hinweise aus.
  - Jeder Hinweis MUSS "elster_code" als genau 8 Zeichen im Format E+7-Ziffern
    enthalten (z.B. "E0100402"). Kein Hinweis ohne elster_code.
  - "feld_pfad" = vollstaendiger JSON-Pfad inklusive des E-Codes am Ende
    (z.B. "ESt1A.Allg.A.E0100402"). Keine abstrakten Gruppennamen ohne E-Code.

ANTWORTE NUR MIT EINEM JSON-OBJEKT (keine Code-Fences, kein Fliesstext):
{
  "opus_score": 0..1,
  "begruendung": "<1-3 Saetze>",
  "hinweise": [
    {"elster_code": "E0200201", "feld_pfad": "N.E0200201", "problem": "<kurz>", "anweisung": "<konkreter Hinweis>"}
  ]
}
Max 8 Hinweise. Leere Liste wenn alles passt.`;

  const annoKurz = JSON.stringify(annotation).slice(0, 10000);
  const fehlendKurz = (fehlendePflicht || []).slice(0, 20).map(f => `- ${f.pfad}`).join("\n");

  const content = [];
  // Bei PDF: Seite(n) direkt als document, bei Bild: image_url
  if (mime === "application/pdf") {
    content.push({
      type: "document",
      source: { type: "base64", media_type: mime, data: b64 },
    });
  } else {
    content.push({
      type: "image",
      source: { type: "base64", media_type: mime, data: b64 },
    });
  }
  content.push({
    type: "text",
    text:
      `Dokument: ${originalName || storedFilename}\n\n` +
      `Mistral-Annotation (JSON, gekuerzt):\n\`\`\`json\n${annoKurz}\n\`\`\`\n\n` +
      (fehlendKurz ? `Pflichtfelder die Mistral NICHT belegt hat:\n${fehlendKurz}\n\n` : "") +
      `Emittiere dein JSON-Urteil.`,
  });

  const t0 = Date.now();
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: model || "claude-opus-4-7",
      max_tokens: 1500,
      system,
      messages: [{ role: "user", content }],
    }),
  });
  const ms = Date.now() - t0;
  if (!resp.ok) {
    const t = await resp.text();
    return { score: 0.5, begruendung: `Opus HTTP ${resp.status}: ${t.slice(0, 200)}`, hinweise: [], ms };
  }
  const j = await resp.json();
  const text = (j.content || []).map(c => c.text || "").join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { score: 0.5, begruendung: "Opus ohne JSON", hinweise: [], ms };
  let parsed;
  try { parsed = JSON.parse(m[0]); } catch { return { score: 0.5, begruendung: "Opus JSON invalid", hinweise: [], ms }; }
  const score = typeof parsed.opus_score === "number" ? Math.max(0, Math.min(1, parsed.opus_score)) : 0.5;
  const hinweise = Array.isArray(parsed.hinweise) ? parsed.hinweise.slice(0, 8).map(h => {
    const pfad = String(h.feld_pfad || "");
    // elster_code: zuerst explizites Feld, sonst Fallback: letztes E+7-Stueck aus dem Pfad.
    let code = String(h.elster_code || "").trim();
    if (!/^E\d{7}$/.test(code)) {
      const m = pfad.match(/E\d{7}/g);
      code = m ? m[m.length - 1] : "";
    }
    return {
      elster_code: code,
      feld_pfad: pfad,
      problem: String(h.problem || "").slice(0, 200),
      anweisung: String(h.anweisung || "").slice(0, 400),
    };
  }).filter(h => h.anweisung && h.elster_code) : [];
  return { score, begruendung: String(parsed.begruendung || "").slice(0, 600), hinweise, ms };
}

// ─── V2-Hybrid: Regel-Engine für deterministische Kuration ────────────────
// Aus Mistral-Rohtext + Sonnet-Vision-Output mappt Felder auf E-Codes.
// Keine LLM-Calls — nur Label-Matching gegen den BMF-Katalog.

// Baut die Anlage-Header-Regex-Liste primaer aus elsterCatalog.anlagen[*].label.
// Pro Anlage werden ALLE erreichbaren Namen gesammelt:
//   a) Kurzcode ("N", "KAP", "KAP-INV")
//   b) Langname nach em-dash ("Sonderausgaben", "Einkuenfte aus Kapitalvermoegen")
//   c) Aliase aus data/anlagen_aliase.json fuer Fälle die der Katalog nicht liefert (z.B. VOR → Vorsorgeaufwand).
// Jeder Name bekommt Umlaut-tolerante Regex (ae↔ä, ss↔ß), sortiert nach Spezifitaet.

let _anlagenHeaderMapCache = null;
let _anlagenAliaseCache = null;

function ladeAnlagenAliase() {
  if (_anlagenAliaseCache !== null) return _anlagenAliaseCache;
  const pfad = path.join(__dirname, "data", "anlagen_aliase.json");
  try {
    const raw = fs.readFileSync(pfad, "utf8");
    const parsed = JSON.parse(raw);
    _anlagenAliaseCache = parsed?.aliases || {};
    console.log(`  Anlagen-Aliase: ${Object.keys(_anlagenAliaseCache).length} Eintraege aus ${pfad}`);
  } catch (e) {
    console.warn(`  Anlagen-Aliase: konnte ${pfad} nicht laden — ${e.message}`);
    _anlagenAliaseCache = {};
  }
  return _anlagenAliaseCache;
}

function umlautToleranteRegex(name) {
  // Erzeuge Variante mit Umlauten aus ae/oe/ue/ss und umgekehrt, verknuepfe beide.
  const mitAe = name;
  const mitUml = mitAe
    .replace(/([aA])e/g, (m, a) => a + (a === "A" ? "Ä" : "ä")).replace(/[aA][äÄ]/g, m => m[0] === "A" ? "Ä" : "ä")
    .replace(/([oO])e/g, (m, a) => a + (a === "O" ? "Ö" : "ö")).replace(/[oO][öÖ]/g, m => m[0] === "O" ? "Ö" : "ö")
    .replace(/([uU])e/g, (m, a) => a + (a === "U" ? "Ü" : "ü")).replace(/[uU][üÜ]/g, m => m[0] === "U" ? "Ü" : "ü")
    .replace(/ss/g, "ß");
  const mitAsciiUml = mitAe
    .replace(/ä/g, "ae").replace(/Ä/g, "Ae")
    .replace(/ö/g, "oe").replace(/Ö/g, "Oe")
    .replace(/ü/g, "ue").replace(/Ü/g, "Ue")
    .replace(/ß/g, "ss");
  const varianten = new Set([mitAe, mitUml, mitAsciiUml]);
  const escaped = [...varianten].map(v =>
    v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\?[-\s]+/g, "[-\\s]?")
  );
  return new RegExp(`(?:${escaped.join("|")})`, "i");
}

function baueAnlagenHeaderMap() {
  if (_anlagenHeaderMapCache) return _anlagenHeaderMapCache;
  if (!elsterCatalog?.anlagen) { _anlagenHeaderMapCache = []; return _anlagenHeaderMapCache; }
  const aliase = ladeAnlagenAliase();
  const entries = [];

  for (const [code, meta] of Object.entries(elsterCatalog.anlagen)) {
    const label = String(meta?.label || "");
    const namen = new Set();

    if (/^Hauptvordruck\b/i.test(label)) {
      namen.add("Hauptvordruck");
      namen.add("ESt 1 A");
    }
    // Kurzname aus "Anlage X — ..."
    const kurz = label.match(/^Anlage\s+([A-Za-zÄÖÜäöüß0-9][A-Za-zÄÖÜäöüß0-9\-\s]*?)(?:\s*(?:—|–|\s-\s)|$)/i);
    if (kurz) namen.add(kurz[1].trim());
    // Langname NACH em-dash, bis "(" oder "§" oder Ende
    const lang = label.match(/(?:—|–)\s*(.+?)(?:\s*[(§]|$)/);
    if (lang) namen.add(lang[1].trim());
    // Zusatz-Aliase aus data/anlagen_aliase.json
    for (const a of (aliase[code] || [])) namen.add(a);

    for (const n of namen) {
      if (!n) continue;
      // Hauptvordruck ohne "Anlage "-Prefix matchen; sonst mit "Anlage " davor.
      const regex = /^Hauptvordruck|ESt\s*1\s*A/i.test(n)
        ? umlautToleranteRegex(n)
        : new RegExp(`Anlage\\s+${umlautToleranteRegex(n).source}\\b`, "i");
      entries.push({ regex, code, spez: n.length, name: n });
    }
  }
  entries.sort((a, b) => b.spez - a.spez);
  _anlagenHeaderMapCache = entries.map(e => [e.regex, e.code]);
  return _anlagenHeaderMapCache;
}

// Parse Mistral-Markdown: finde aktive Anlage (aus "# Anlage X"-Headern),
// aktiven Personen-Kontext ("Person A/B", "Ehefrau", "Ehemann"),
// dann zeilenweise alle "(zeile) (drucktext) (wert)"-Muster.
function parseMistralText(text) {
  const fundstellen = [];
  const lines = (text || "").split("\n");
  let aktuelleAnlage = "ESt1A";
  let aktuellerPersonenCtx = null;

  // Anlage-Header-Regex wird aus dem ELSTER-Katalog zur Laufzeit gebaut —
  // kein Hardcoden von Anlagen-Namen oder Sonderfaellen.
  // Fuer jeden Anlage-Code und sein label extrahieren wir ein moeglichst spezifisches Pattern.
  const anlagenMap = baueAnlagenHeaderMap();
  // Personen-Kontext-Regex bleibt minimal, weil Begriffe wie "Person A"/"Ehemann"
  // nicht im BMF-Katalog stehen — deutsche Formular-Konvention.
  const personRe = [
    [/Person\s+A\b|Ehemann|Steuerpflichtige(?:\s+Person)?/i, "A"],
    [/Person\s+B\b|Ehefrau|Ehegattin|Ehegatte(?!n)/i, "B"],
  ];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Header-Regel: egal ob #, ##, ### — ein Header wechselt die Anlage
    // genau dann, wenn er mit "Anlage X" oder "Hauptvordruck" BEGINNT.
    // Subsection-Titles wie "## Steuerabzugsbeträge ... Anlage KAP-INV"
    // wechseln NICHT (der Anlage-Name steht mitten im Satz, nicht am Anfang).
    // Alle Header aktualisieren aber den Personen-Kontext.
    if (/^#{1,3}\s+/.test(line)) {
      const inhalt = line.replace(/^#{1,3}\s*/, "").trim();
      if (/^(Anlage\s+|Hauptvordruck\b)/i.test(inhalt)) {
        for (const [re, code] of anlagenMap) {
          if (re.test(inhalt)) { aktuelleAnlage = code; break; }
        }
      }
      for (const [re, p] of personRe) {
        if (re.test(inhalt)) { aktuellerPersonenCtx = p; break; }
      }
      continue;
    }

    // Zeile mit Zeilennr-Prefix: "<zeile> <label> <wert>"
    const m = line.match(/^(?:[-*]\s+)?(\d{1,3})\s+(.+?)(?:\s{2,}|\s)([A-Za-z0-9][^]*?)$/);
    if (m) {
      const zeile = m[1];
      const rest = m[2] + " " + m[3];
      let drucktextCand, wert;

      // BUG-2-FIX: IBAN mit Leerzeichen erkennen (DE08 5735 1030 0105 0569 49)
      const ibanM = rest.match(/\b([A-Z]{2}\d{2}[\s\d]{18,26})\b/);
      if (ibanM && (ibanM[1].replace(/\s+/g, "").length >= 20)) {
        drucktextCand = rest.slice(0, ibanM.index).trim();
        wert = ibanM[1].replace(/\s+/g, "");
      } else {
        // Generelle Heuristik: bis erster Zahl/Datum/Betrag → Label, dahinter → Wert.
        const werteRe = /\b(\d{1,3}(?:\.\d{3})*(?:,\d+)?|\d+[,.]?\d*|\d{2}\.\d{2}\.\d{4}|\d{11}|\d{5}\s*[A-Za-z-]+)\b/;
        const wm = rest.match(werteRe);
        if (wm && wm.index > 0) {
          drucktextCand = rest.slice(0, wm.index).trim();
          wert = rest.slice(wm.index).trim();
        } else {
          drucktextCand = rest.trim(); wert = "";
        }

        // BUG-3-FIX: "laut Nr. X ... der Lohnsteuerbescheinigung YYY"
        // → Label um den Verweis erweitern, Wert = letzte Zahl in der Zeile.
        if (/laut\s+Nr\.?\s*$/i.test(drucktextCand) || /laut\s+Nr\.?\s+\d/i.test(drucktextCand + " " + wert)) {
          const final = wert.match(/^(.+?)\s+(-?\d{1,3}(?:\.\d{3})*(?:,\d+)?|-?\d+(?:,\d+)?)\s*$/);
          if (final) {
            drucktextCand = `${drucktextCand} ${final[1]}`.replace(/\s+/g, " ").trim();
            wert = final[2];
          }
        }
      }

      fundstellen.push({
        anlage: aktuelleAnlage,
        personen_ctx: aktuellerPersonenCtx,
        zeile,
        drucktext_cand: drucktextCand,
        wert,
        raw: line.slice(0, 160),
      });
      continue;
    }
  }
  return fundstellen;
}

// Ordnet eine Mistral-Fundstelle einem E-Code zu (nutzt byZeile, byDrucktext).
function mappeFundstelle(fund, index = bmfLabelIndex) {
  if (!index) return null;
  const dtNorm = normLabel(fund.drucktext_cand);
  if (!dtNorm) return null;

  // 1. byZeile (exakter Match: anlage + zeile + drucktext)
  const k1 = `${fund.anlage}|${fund.zeile}|${dtNorm}`;
  if (index.byZeile.has(k1)) {
    return { ...index.byZeile.get(k1), match: "zeile+drucktext", konfidenz: 1.0 };
  }
  // 1b. byZeile mit gekürztem drucktext (nur die ersten 3 Wörter des Kandidaten)
  const dtKurz = dtNorm.split(" ").slice(0, 5).join(" ");
  if (dtKurz !== dtNorm) {
    for (const [k, v] of index.byZeile.entries()) {
      if (!k.startsWith(`${fund.anlage}|${fund.zeile}|`)) continue;
      const ctxDt = k.split("|")[2];
      if (ctxDt && (dtNorm.startsWith(ctxDt) || ctxDt.startsWith(dtKurz))) {
        return { ...v, match: "zeile+drucktext(fuzzy)", konfidenz: 0.9 };
      }
    }
  }
  // 2. byDrucktext mit harter Personen-Kontext-Filterung
  const ctxHint = fund.personen_ctx;
  const istPerson = (cand, p) => {
    const k = (cand.kontext || "").toLowerCase();
    const suffix = k.split("/").pop();
    if (p === "A") return suffix === "a" || k.endsWith("/a") || /^allg\/a/.test(k);
    if (p === "B") return suffix === "b" || k.endsWith("/b") || /^allg\/b/.test(k);
    return false;
  };

  const alleKandidaten = [];
  for (const [k, lst] of index.byDrucktext.entries()) {
    if (!k.startsWith(`${fund.anlage}|`)) continue;
    const parts = k.split("|");
    if (parts[2] !== dtNorm) continue;
    alleKandidaten.push(...lst);
  }
  if (alleKandidaten.length === 0) return null;

  const fuerA = alleKandidaten.filter(c => istPerson(c, "A"));
  const fuerB = alleKandidaten.filter(c => istPerson(c, "B"));
  const neutral = alleKandidaten.filter(c => !istPerson(c, "A") && !istPerson(c, "B"));

  if (ctxHint === "A") {
    if (fuerA.length) return { ...fuerA[0], match: "drucktext+ctxA", konfidenz: 0.9 };
    if (neutral.length) return { ...neutral[0], match: "drucktext(neutral)", konfidenz: 0.75 };
    return null;
  }
  if (ctxHint === "B") {
    if (fuerB.length) return { ...fuerB[0], match: "drucktext+ctxB", konfidenz: 0.9 };
    if (neutral.length) return { ...neutral[0], match: "drucktext(neutral)", konfidenz: 0.75 };
    return null;
  }
  if (neutral.length) return { ...neutral[0], match: "drucktext", konfidenz: 0.7 };
  if (fuerA.length) return { ...fuerA[0], match: "drucktext(A)", konfidenz: 0.6 };
  if (fuerB.length) return { ...fuerB[0], match: "drucktext(B)", konfidenz: 0.6 };
  return null;
}

// Normalisiert eine Vision-JSON-Struktur in flache Kandidaten.
// Trickreich: Vision-Keys entsprechen meist der "beschreibung" oder dem
// "drucktext" — nicht der vordruckzeile.
function flatteneVision(obj, pfad = [], aus = []) {
  if (obj === null || obj === undefined) return aus;
  if (typeof obj !== "object") {
    aus.push({ pfad: pfad.join("."), wert: obj });
    return aus;
  }
  if (Array.isArray(obj)) {
    obj.forEach((x, i) => flatteneVision(x, [...pfad, String(i)], aus));
    return aus;
  }
  for (const [k, v] of Object.entries(obj)) {
    flatteneVision(v, [...pfad, k], aus);
  }
  return aus;
}

function mappeVisionKandidat(kand, index = bmfLabelIndex, visionExtract = null) {
  if (!index) return null;
  // Letztes Pfad-Segment ist der Schlüssel; suche in beschreibung.
  const segments = kand.pfad.split(".");
  const key = segments[segments.length - 1];
  const keyNorm = normLabel(key.replace(/_/g, " "));
  if (!keyNorm) return null;

  // Personen-Kontext aus Pfad (z.B. "personen.0.name" oder "person_a.name")
  let ctxHint = null;
  for (let idx = 0; idx < segments.length; idx++) {
    const seg = segments[idx];
    if (/^a$|_a$|person_?a|person[_\. ]*a|ehemann|steuerpflichtig/i.test(seg)) ctxHint = "A";
    if (/^b$|_b$|person_?b|person[_\. ]*b|ehefrau|ehegatt/i.test(seg)) ctxHint = "B";
    // Fall: personen.0.xxx oder personen.1.xxx - Array-Index bestimmt Rolle
    if (seg === "personen" && idx + 1 < segments.length) {
      const next = segments[idx + 1];
      if (next === "0") ctxHint = "A";
      else if (next === "1") ctxHint = "B";
      // Feinbestimmung: falls vision-extract verfuegbar, lese rolle-Feld
      if (visionExtract && Array.isArray(visionExtract.personen)) {
        const p = visionExtract.personen[parseInt(next, 10)];
        if (p && typeof p.rolle === "string") {
          if (p.rolle.toUpperCase() === "A") ctxHint = "A";
          if (p.rolle.toUpperCase() === "B") ctxHint = "B";
        }
      }
    }
  }

  const cands = index.byBeschreib.get(keyNorm) || [];
  if (cands.length === 0) return null;

  // Kontext-Bucketing: person-spezifisch (A / B) vs neutral.
  const istPerson = (cand, p) => {
    const k = (cand.kontext || "").toLowerCase();
    const suffix = k.split("/").pop();  // "a" oder "b" am Ende
    if (p === "A") return suffix === "a" || k.endsWith("/a") || /^allg\/a/.test(k);
    if (p === "B") return suffix === "b" || k.endsWith("/b") || /^allg\/b/.test(k);
    return false;
  };
  const fuerA = cands.filter(c => istPerson(c, "A"));
  const fuerB = cands.filter(c => istPerson(c, "B"));
  const neutral = cands.filter(c => !istPerson(c, "A") && !istPerson(c, "B"));

  // Harte Personenlogik: wenn Vision einen Personen-Hint gibt, nehmen wir NUR den passenden Bucket.
  // Gibt es nur gegenteilige Kandidaten (z.B. Hint=B, Katalog hat nur A-Codes), verwerfen.
  if (ctxHint === "A") {
    if (fuerA.length) return { ...fuerA[0], match: "vision+beschreibung+ctxA", konfidenz: 0.9 };
    if (neutral.length) return { ...neutral[0], match: "vision+beschreibung(neutral)", konfidenz: 0.7 };
    return null;
  }
  if (ctxHint === "B") {
    if (fuerB.length) return { ...fuerB[0], match: "vision+beschreibung+ctxB", konfidenz: 0.9 };
    if (neutral.length) return { ...neutral[0], match: "vision+beschreibung(neutral)", konfidenz: 0.7 };
    return null;
  }

  // Ohne Hint: neutral bevorzugen (person-agnostische Felder wie Finanzamt),
  // sonst ersten Kandidaten.
  if (neutral.length) return { ...neutral[0], match: "vision+beschreibung", konfidenz: 0.7 };
  if (fuerA.length) return { ...fuerA[0], match: "vision+beschreibung(A)", konfidenz: 0.6 };
  if (fuerB.length) return { ...fuerB[0], match: "vision+beschreibung(B)", konfidenz: 0.6 };
  return null;
}

// Haupteinstieg: Mistral-Text + Vision-JSON → Kuration.
function regelBasierteKuration(mistralText, visionExtract) {
  const fundstellen = parseMistralText(mistralText);
  const visionFlach = flatteneVision(visionExtract || {});

  // Schritt 1: sammle die Anlagen, die Mistral im Roh-Text explizit erwaehnt.
  const mistralAnlagen = new Set();
  for (const f of fundstellen) mistralAnlagen.add(f.anlage);
  if (Array.isArray(visionExtract?.erkannte_anlagen)) {
    for (const a of visionExtract.erkannte_anlagen) {
      if (typeof a === "string" && elsterCatalog?.anlagen?.[a]) mistralAnlagen.add(a);
    }
  }
  const erlaubt = mistralAnlagen;

  // BUG-4-FIX: Match-Key enthaelt Personen-Kontext, damit Person A/B nicht kollidieren.
  // Fuer person-agnostische Codes (z.B. Finanzamt) ist ctx leer und der Key ist stabil.
  const proCode = new Map();
  const verworfen_mistral = [];
  const verworfen_vision = [];
  const keyFuerCode = (code, ctx) => `${code}|${ctx || ""}`;

  for (const f of fundstellen) {
    const m = mappeFundstelle(f);
    if (!m) {
      if (f.drucktext_cand && f.wert) {
        verworfen_mistral.push({
          zeile: f.zeile, anlage: f.anlage, personen_ctx: f.personen_ctx,
          drucktext_cand: f.drucktext_cand, wert: f.wert,
          grund: "kein Label-Match im BMF-Katalog",
          raw: f.raw,
        });
      }
      continue;
    }
    if (!erlaubt.has(m.anlage)) {
      verworfen_mistral.push({
        zeile: f.zeile, anlage: f.anlage, drucktext_cand: f.drucktext_cand, wert: f.wert,
        grund: `Anlage ${m.anlage} nicht in erkannten Dokument-Anlagen`,
        kandidat_code: m.code,
      });
      continue;
    }
    const key = keyFuerCode(m.code, f.personen_ctx);
    const entry = proCode.get(key) || { code: m.code, anlage: m.anlage, kontext: m.kontext, personen_ctx: f.personen_ctx };
    entry.mistral = { wert: f.wert, konfidenz: m.konfidenz, raw: f.raw, match: m.match };
    proCode.set(key, entry);
  }

  for (const v of visionFlach) {
    if (v.wert === null || v.wert === undefined || v.wert === "") continue;
    if (/^_\w/.test(v.pfad.split(".").pop() || "")) continue;
    const m = mappeVisionKandidat(v, bmfLabelIndex, visionExtract);
    if (!m) {
      verworfen_vision.push({
        pfad: v.pfad, wert: v.wert,
        grund: "kein beschreibung-Match im BMF-Katalog",
      });
      continue;
    }
    if (!erlaubt.has(m.anlage)) {
      verworfen_vision.push({
        pfad: v.pfad, wert: v.wert,
        grund: `Anlage ${m.anlage} nicht in erkannten Dokument-Anlagen`,
        kandidat_code: m.code,
      });
      continue;
    }
    // Personen-Kontext aus Vision-Pfad ziehen (personen.0 / personen.1 / rolle)
    let visionCtx = null;
    const segs = v.pfad.split(".");
    for (let idx = 0; idx < segs.length; idx++) {
      const s = segs[idx];
      if (/^a$|_a$|person_?a|ehemann|steuerpflichtig/i.test(s)) visionCtx = "A";
      if (/^b$|_b$|person_?b|ehefrau|ehegatt/i.test(s)) visionCtx = "B";
      if (s === "personen" && idx + 1 < segs.length) {
        if (segs[idx + 1] === "0") visionCtx = "A";
        else if (segs[idx + 1] === "1") visionCtx = "B";
      }
    }
    const key = keyFuerCode(m.code, visionCtx);
    const entry = proCode.get(key) || { code: m.code, anlage: m.anlage, kontext: m.kontext, personen_ctx: visionCtx };
    entry.vision = { wert: v.wert, konfidenz: m.konfidenz, pfad: v.pfad, match: m.match };
    proCode.set(key, entry);
  }

  // Kategorisiere: eindeutig / konflikt / unklarheit.
  const eindeutig = [];
  const konflikte = [];
  const unklarheiten = [];

  for (const [mapKey, e] of proCode.entries()) {
    const code = e.code || mapKey.split("|")[0];
    const hatM = !!e.mistral;
    const hatV = !!e.vision;
    const mW = e.mistral?.wert ?? null;
    const vW = e.vision?.wert ?? null;
    const gleich = hatM && hatV && wertGleich(mW, vW);

    const eintrag = { code, anlage: e.anlage, kontext: e.kontext, personen_ctx: e.personen_ctx, mistral: e.mistral || null, vision: e.vision || null };

    if (hatM && hatV && gleich) {
      eintrag.wert = mW;
      eintrag.quelle = "beide";
      eintrag.konfidenz = Math.max(e.mistral.konfidenz, e.vision.konfidenz);
      // BMF-Regex-Validierung
      const v = bmfValidiereWert(code, String(mW), e.anlage);
      eintrag.bmf_regex_ok = v?.ok ?? null;
      if (v && !v.ok) unklarheiten.push({ ...eintrag, grund: "BMF-Regex bricht", details: v.details });
      else eindeutig.push(eintrag);
    } else if (hatM && !hatV) {
      eintrag.wert = mW;
      eintrag.quelle = "mistral";
      eintrag.konfidenz = e.mistral.konfidenz;
      const v = bmfValidiereWert(code, String(mW), e.anlage);
      eintrag.bmf_regex_ok = v?.ok ?? null;
      if (v && !v.ok) unklarheiten.push({ ...eintrag, grund: "BMF-Regex bricht", details: v.details });
      else eindeutig.push(eintrag);
    } else if (!hatM && hatV) {
      eintrag.wert = vW;
      eintrag.quelle = "vision";
      eintrag.konfidenz = e.vision.konfidenz;
      const v = bmfValidiereWert(code, String(vW), e.anlage);
      eintrag.bmf_regex_ok = v?.ok ?? null;
      if (v && !v.ok) unklarheiten.push({ ...eintrag, grund: "BMF-Regex bricht", details: v.details });
      else eindeutig.push(eintrag);
    } else if (hatM && hatV && !gleich) {
      konflikte.push({ ...eintrag, grund: "Werte unterschiedlich", mistral_wert: mW, vision_wert: vW });
    }
  }

  // Anlagen-Set aus eindeutig + konflikt + unklar
  const anlagenSet = new Set();
  for (const e of [...eindeutig, ...konflikte, ...unklarheiten]) anlagenSet.add(e.anlage);

  return {
    eindeutig,
    konflikte,
    unklarheiten,
    anlagen: [...anlagenSet],
    verworfen_mistral,
    verworfen_vision,
    alle_fundstellen_mistral: fundstellen,
    alle_fundstellen_vision: visionFlach.filter(v => v.wert !== null && v.wert !== "" && !/^_\w/.test((v.pfad.split(".").pop() || ""))),
    stats: {
      fundstellen_mistral: fundstellen.length,
      fundstellen_vision: visionFlach.length,
      eindeutig_count: eindeutig.length,
      konflikt_count: konflikte.length,
      unklarheit_count: unklarheiten.length,
      verworfen_mistral_count: verworfen_mistral.length,
      verworfen_vision_count: verworfen_vision.length,
    },
  };
}

function wertGleich(a, b) {
  if (a === b) return true;
  const na = String(a ?? "").replace(/\s+/g, "").replace(/[,.]/g, "").toLowerCase();
  const nb = String(b ?? "").replace(/\s+/g, "").replace(/[,.]/g, "").toLowerCase();
  return na && nb && na === nb;
}

// Baut die Baseline-Annotation aus den finalen V3-Codes.
// Wenn eine Anlage max_occurs > 1 hat UND mehrere Personen-Instanzen belegt sind,
// wird sie als Array von Instanzen ausgegeben (eine pro Person).
function baueBaselineAnnotation(finalCodes) {
  const anno = {};
  // Gruppiere nach (anlage, personen_ctx)
  const gruppen = new Map();
  for (const c of finalCodes) {
    if (!c?.code || !c?.anlage) continue;
    if (!gruppen.has(c.anlage)) gruppen.set(c.anlage, new Map());
    const perAnl = gruppen.get(c.anlage);
    const ctx = c.personen_ctx || "_";
    if (!perAnl.has(ctx)) perAnl.set(ctx, []);
    perAnl.get(ctx).push(c);
  }

  for (const [anlage, perAnl] of gruppen.entries()) {
    const catAnl = elsterCatalog?.anlagen?.[anlage];
    if (!catAnl) continue;
    const maxOcc = catAnl.max_occurs || 1;
    const personen = [...perAnl.keys()].filter(c => c !== "_");

    if (maxOcc > 1 && personen.length > 1) {
      // Array: eine Instanz pro Person, Person-Marker gesetzt.
      anno[anlage] = [];
      for (const ctx of personen) {
        const inst = { Person: ctx === "A" ? "PersonA" : "PersonB" };
        for (const c of (perAnl.get(ctx) || [])) {
          const pfad = findeCodePfadImSchema(catAnl.json_schema, c.code);
          const wert = normalizeWert(c.wert);
          if (pfad) setzeAnPfad(inst, pfad, c.code, wert);
          else inst[c.code] = wert;
        }
        // Auch ctx="_"-Codes (ohne Personen-Kontext) in die erste Instanz packen
        anno[anlage].push(inst);
      }
      // Personen-lose Codes einmal in Instanz 0 einpflegen
      const neutral = perAnl.get("_") || [];
      if (neutral.length && anno[anlage][0]) {
        for (const c of neutral) {
          const pfad = findeCodePfadImSchema(catAnl.json_schema, c.code);
          const wert = normalizeWert(c.wert);
          if (pfad) setzeAnPfad(anno[anlage][0], pfad, c.code, wert);
          else anno[anlage][0][c.code] = wert;
        }
      }
    } else {
      // Single-instance object
      anno[anlage] = {};
      for (const [, codes] of perAnl.entries()) {
        for (const c of codes) {
          const pfad = findeCodePfadImSchema(catAnl.json_schema, c.code);
          const wert = normalizeWert(c.wert);
          if (pfad) setzeAnPfad(anno[anlage], pfad, c.code, wert);
          else anno[anlage][c.code] = wert;
        }
      }
    }
  }
  return anno;
}

// Findet im finalAnnotation die richtige Schreib-Position fuer einen Code:
// Wenn die Anlage ein Array ist, wird die Instanz mit passendem Person-Marker gesucht
// (oder neu angelegt). Sonst Direktzugriff.
function findeOderErstelleAnlageInstanz(finalAnnotation, anlage, personenCtx) {
  if (!finalAnnotation[anlage]) finalAnnotation[anlage] = personenCtx ? [] : {};
  const aktuell = finalAnnotation[anlage];
  if (Array.isArray(aktuell)) {
    const personMarker = personenCtx === "A" ? "PersonA" : personenCtx === "B" ? "PersonB" : null;
    if (personMarker) {
      let inst = aktuell.find(x => x?.Person === personMarker);
      if (!inst) { inst = { Person: personMarker }; aktuell.push(inst); }
      return inst;
    }
    // Kein Personen-Kontext, Array existiert: in die erste Instanz einpflegen,
    // statt eine neue leere Instanz anzulegen.
    if (aktuell.length > 0) return aktuell[0];
    const inst = {};
    aktuell.push(inst);
    return inst;
  }
  return aktuell;
}

// Sucht rekursiv den Pfad (ohne den Code selbst am Ende) für einen bestimmten E-Code.
function findeCodePfadImSchema(schema, gesuchterCode, pfad = []) {
  if (!schema || typeof schema !== "object") return null;
  if (schema.type === "array" && schema.items) {
    return findeCodePfadImSchema(schema.items, gesuchterCode, pfad);
  }
  if (schema.type === "object" && schema.properties) {
    if (schema.properties[gesuchterCode]) return pfad;
    for (const [k, v] of Object.entries(schema.properties)) {
      if (/^E\d{7}$/.test(k)) continue;
      const sub = findeCodePfadImSchema(v, gesuchterCode, [...pfad, k]);
      if (sub) return sub;
    }
  }
  return null;
}

function setzeAnPfad(root, pfad, code, wert) {
  let cur = root;
  for (const seg of pfad) {
    if (!cur[seg]) cur[seg] = {};
    cur = cur[seg];
  }
  cur[code] = wert;
}

// Wandelt Werte zum Mindest-JSON-Typ (Zahlen werden Zahl, alles andere String).
function normalizeWert(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === "") return "";
  // Zahl im deutschen Format: "63.559,90" oder "63559,90" → 63559.9
  const dm = s.match(/^-?\d{1,3}(?:\.\d{3})*(?:,\d+)?$|^-?\d+(?:,\d+)?$/);
  if (dm) {
    const num = parseFloat(s.replace(/\./g, "").replace(/,/g, "."));
    if (!isNaN(num)) return num;
  }
  return s;
}

// Prunt ein Katalog-Schema rekursiv auf nur die Codes in belegtSet.
// Nicht-E-Code-Blaetter (z.B. Enums wie {Person: ["A","B"]}) werden ebenfalls
// weggeworfen, damit das Schema keine required-Platzhalter enthaelt, die
// Mistral dazu zwingen, leere Wrapper wie "Rel_Wechs": [{"Person":"PersonA"}]
// zu erzeugen.
function pruneSchemaAufBelegt(node, belegtSet) {
  if (!node || typeof node !== "object") return null;
  if (node.type === "array" && node.items) {
    const p = pruneSchemaAufBelegt(node.items, belegtSet);
    return p ? { ...node, items: p } : null;
  }
  if (node.type === "object" && node.properties) {
    const props = {}; const required = [];
    for (const [k, v] of Object.entries(node.properties)) {
      if (/^E\d{7}$/.test(k)) {
        if (belegtSet.has(k)) { props[k] = v; required.push(k); }
      } else {
        const pv = pruneSchemaAufBelegt(v, belegtSet);
        if (pv) { props[k] = pv; required.push(k); }
      }
    }
    if (Object.keys(props).length === 0) return null;
    return { ...node, properties: props, required, additionalProperties: false };
  }
  // Leaf schemas ohne E-Code-Gehalt verwerfen — sonst bleiben
  // Person-Enums und aehnliches als required stehen.
  return null;
}

// Entfernt Klassifizierungs-Enums (viele Codewerte wie Religion) aus dem Schema,
// damit Mistral den Klartext aus dem Dokument schreiben kann statt einen Default
// aus der Enum-Liste zu raten. Kleine Enums (z.B. Steuerklasse 1..6) bleiben erhalten.
function entferneGrosseEnums(node, schwelle = 8) {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(n => entferneGrosseEnums(n, schwelle));
  const out = { ...node };
  if (Array.isArray(out.enum) && out.enum.length > schwelle) {
    delete out.enum;
    out.description = `${out.description || ""} · Klartext aus Dokument — wird nachtraeglich auf BMF-Code normalisiert.`.trim();
  }
  if (out.properties) {
    const np = {};
    for (const [k, v] of Object.entries(out.properties)) np[k] = entferneGrosseEnums(v, schwelle);
    out.properties = np;
  }
  if (out.items) out.items = entferneGrosseEnums(out.items, schwelle);
  return out;
}

// Opus-Konfliktlöser: NUR für die Konflikt- und Unklarheits-Fälle der Regel-Engine.
// Minimaler Kontext: je Fall die zwei Kandidaten + ein Dokument-Auszug um die Fundstelle.
async function opusKonfliktloeser(konflikte, unklarheiten, mistralText, model = "claude-opus-4-7") {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  const faelle = [
    ...konflikte.map(k => ({ typ: "konflikt", ...k })),
    ...unklarheiten.map(u => ({ typ: "unklarheit", ...u })),
  ].slice(0, 20);
  if (!faelle.length) return [];

  const system = `Du bist Opus und loest deterministisch Feld-Konflikte aus einer deutschen Steuererklaerung.
Du bekommst eine Liste von Faellen. Pro Fall zwei Kandidaten-Werte oder ein Wert der den BMF-Regex verletzt.
Entscheide jeweils:
  - welcher Wert korrekt ist (oder 'null' wenn keiner klar passt)
  - kurze Begruendung (1 Satz)

ANTWORTE NUR JSON, kein Fliesstext:
{"aufloesungen": [
  {"code": "E0000000", "entscheidung": "<Wert>", "begruendung": "<warum dieser Kandidat laut Dokument korrekt ist, max 1 Satz>"}
]}`;

  const faelleKompakt = faelle.map((f, i) => {
    const text = [`#${i+1} [${f.code}] anlage=${f.anlage} kontext=${f.kontext || "?"}`];
    if (f.typ === "konflikt") {
      text.push(`  Mistral-Wert: ${JSON.stringify(f.mistral_wert)}  (${f.mistral?.raw?.slice(0,120) || ""})`);
      text.push(`  Vision-Wert:  ${JSON.stringify(f.vision_wert)}  (pfad: ${f.vision?.pfad || ""})`);
    } else {
      text.push(`  Wert:   ${JSON.stringify(f.wert)}  quelle=${f.quelle}`);
      text.push(`  Grund:  ${f.grund}  details=${f.details || ""}`);
    }
    return text.join("\n");
  }).join("\n\n");

  const user = `=== DOKUMENT-AUSZUG (ersten 10k Zeichen) ===\n${(mistralText || "").slice(0, 10000)}\n\n=== FAELLE ===\n${faelleKompakt}\n\nEmittiere jetzt das JSON.`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 2048, system, messages: [{ role: "user", content: user }] }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Opus Konfliktloeser HTTP ${resp.status}: ${t.slice(0, 200)}`);
  }
  const j = await resp.json();
  const text = (j.content || []).map(c => c.text || "").join("");
  const parsed = extrahiereJson(text);
  const aufloesungen = !parsed?.aufloesungen ? [] : parsed.aufloesungen.map(a => {
    const fall = faelle.find(f => f.code === a.code);
    return {
      code: a.code,
      anlage: fall?.anlage || null,
      entscheidung: a.entscheidung === null || a.entscheidung === "null" ? null : a.entscheidung,
      begruendung: String(a.begruendung || "").slice(0, 300),
    };
  }).filter(a => a.anlage);
  aufloesungen.__prompt = { system, user };
  return aufloesungen;
}

// ─── Claude Sonnet 4.6 Vision: freie Extraktion aus dem Dokumentbild ──────
async function claudeVisionExtract(storedFilename, originalName, model = "claude-sonnet-4-6") {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  const filePath = path.join(UPLOAD_DIR, path.basename(storedFilename));
  const buf = await fsp.readFile(filePath);
  const mime = MIME[path.extname(originalName || storedFilename).toLowerCase()] || "application/pdf";
  const b64 = buf.toString("base64");

  const system = `Du bist Sonnet-Vision und liest deutsche Steuerdokumente.
Deine Aufgabe: Extrahiere ALLES was du im Dokument siehst — ohne vorgegebenes Schema, frei strukturiert.
Fokus: Personenangaben, Beschaeftigungsdaten, Finanzamt, Bankverbindung, Sozialversicherungsdaten, Renteneinkuenfte,
Kapitaleinkuenfte, Vermietung, Sonderausgaben, Werbungskosten, Vorsorgeaufwendungen, Kirchensteuer, Religionszugehoerigkeit.
Wichtig: Wenn ein Feld mehrere Personen hat (Steuerpflichtige A, Ehegatte B), Person-Label IMMER mitfuehren.
Achte auf Angaben auf allen Seiten — Belege und Anlagen folgen nach dem Hauptvordruck.

ANTWORTE NUR mit einem JSON-Objekt. Struktur frei, aber konsistent:
{
  "dokument_typ": "<z.B. Einkommensteuererklaerung 2023>",
  "jahr": <number>,
  "personen": [{ "rolle": "A"|"B", "name": ..., "vorname": ..., "idnr": ..., "geburtsdatum": ..., "religion": ..., "anschrift": {...}, ... }],
  "finanzamt": { "name": ..., "steuernr_alt": ..., "steuernr_neu": ... },
  "bankverbindung": { "iban": ..., "bic": ..., "kontoinhaber": ... },
  "einkuenfte": {
    "nichtselbst_arbeit": [{ "person": "A", "arbeitgeber": ..., "bruttolohn": ..., "lohnsteuer": ..., "soli": ..., "kist": ..., ... }],
    "renten": [...],
    "kapital": [...],
    "vermietung": [...]
  },
  "vorsorge": { "rv_pflicht_an": ..., "kv": ..., "pv": ..., ... },
  "sonderausgaben": { ... },
  "aussergewoehnliche_belastungen": { ... },
  "kirchensteuer": { "gezahlt": ..., "erstattet": ... },
  "sonstiges": [ ... ],
  "quelle_seite": { "<feldname>": <seitennr> },
  "erkannte_anlagen": ["ESt1A", "N", "VOR", ...]
}
Felder ausfalten wie du sie siehst. Wenn ein Feld nicht im Dokument ist: weglassen (nicht null, nicht ""). Keine Halluzinationen.`;

  const content = [];
  if (mime === "application/pdf") {
    content.push({ type: "document", source: { type: "base64", media_type: mime, data: b64 } });
  } else {
    content.push({ type: "image", source: { type: "base64", media_type: mime, data: b64 } });
  }
  content.push({ type: "text", text: `Dokument: ${originalName || storedFilename}\n\nExtrahiere jetzt alle steuerrelevanten Daten. Emittiere NUR das JSON.` });

  const t0 = Date.now();
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 8192, system, messages: [{ role: "user", content }] }),
  });
  const ms = Date.now() - t0;
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Sonnet Vision HTTP ${resp.status}: ${t.slice(0, 300)}`);
  }
  const j = await resp.json();
  const text = (j.content || []).map(c => c.text || "").join("");
  const parsed = extrahiereJson(text);
  return {
    model,
    extraction: parsed || { _raw: text.slice(0, 2000), _parse_error: true },
    stop_reason: j.stop_reason,
    usage: j.usage,
    ms,
    raw_chars: text.length,
    prompt: {
      system,
      user_text_trailing: `Dokument: ${originalName || storedFilename}\n\nExtrahiere jetzt alle steuerrelevanten Daten. Emittiere NUR das JSON.`,
      dokument_anhang: `<${mime}, ${buf.length} bytes als base64>`,
    },
  };
}

// ─── Opus 4.7 Kurator: baut kuratiertes Schema aus Mistral-Rohtext + Vision-Output ──
async function opusKurator(storedFilename, originalName, mistralText, visionExtract, anlagenHint, model = "claude-opus-4-7") {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  if (!elsterCatalog) throw new Error("ELSTER-Katalog nicht geladen");

  // Kompaktes Code-Menue pro Anlage fuer Opus: code + kurze beschreibung
  const menu = {};
  for (const [code, anlage] of Object.entries(elsterCatalog.anlagen)) {
    menu[code] = { label: anlage.label, codes_available: anlage.elster_code_count };
  }

  const system = `Du bist Opus und kuratierst das JSON-Schema fuer Mistral OCR.
Zwei Vorextraktoren haben das Dokument gesehen:
  1. Mistral OCR (Roh-Text, Markdown pro Seite)
  2. Claude Sonnet 4.6 Vision (freie strukturierte Extraktion)

Deine Aufgabe: Auf Basis beider Sichten entscheide,
  a) welche ELSTER-Anlagen fuer dieses Dokument relevant sind
  b) welche konkreten E-Codes (Format E + 7 Ziffern) aus der BMF-Jahresdokumentation belegt sind

Wichtig:
  - Erfinde KEINE E-Codes. Nur aus der BMF-Jahresdokumentation 2024 zulaessige.
  - Leere/optionale Felder die im Dokument nicht stehen: NICHT in die Belegung.
  - Wenn beide Vorextraktoren uneinig sind, vertraue eher Vision (sieht das Bild), nimm Mistral als Korrektiv.
  - Belege pro Feld mit kurzer "quelle": "mistral" | "vision" | "beide".

ANTWORTE NUR mit JSON-Objekt:
{
  "dokument_typ": "<string>",
  "jahr": <number>,
  "anlagen": ["ESt1A","N","VOR"],
  "belegte_codes": [
    {"anlage": "<Code>", "code": "E0000000", "pfad": "<Pfad>", "wert_preview": "<Wert>", "quelle": "beide", "kommentar": "<kurze Bedeutung des Felds>"},
    ...
  ],
  "verworfen": [
    {"code": "E0000000", "grund": "<Grund, z.B. Format passt nicht, Kandidaten-Wert nicht plausibel>"}
  ],
  "begruendung": "<2-4 Saetze>"
}
Max 150 Belege. Keine Fliesstexte, keine Code-Fences.`;

  const visionCompact = JSON.stringify(visionExtract?.extraction || {}).slice(0, 12000);
  const textTrim = (mistralText || "").slice(0, 20000);

  const content = [{
    type: "text",
    text:
      `Dokument: ${originalName || storedFilename}\n\n` +
      `=== VERFUEGBARE ANLAGEN ===\n${Object.entries(menu).map(([c, m]) => `${c.padEnd(12)} ${m.codes_available} Codes · ${m.label}`).join("\n")}\n\n` +
      (anlagenHint?.length ? `=== USER-HINT ANLAGEN ===\n${anlagenHint.join(", ")}\n\n` : "") +
      `=== SONNET VISION JSON ===\n${visionCompact}\n\n` +
      `=== MISTRAL OCR ROHTEXT (gekuerzt) ===\n${textTrim}\n\n` +
      `Kuratiere jetzt. Emittiere NUR das JSON.`,
  }];

  const t0 = Date.now();
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 8192, system, messages: [{ role: "user", content }] }),
  });
  const ms = Date.now() - t0;
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Opus Kurator HTTP ${resp.status}: ${t.slice(0, 300)}`);
  }
  const j = await resp.json();
  const text = (j.content || []).map(c => c.text || "").join("");
  const parsed = extrahiereJson(text);
  if (!parsed) throw new Error("Opus Kurator hat kein parsebares JSON geliefert");

  // Validiere Anlagen und E-Codes gegen Katalog
  const anlagenValid = (parsed.anlagen || []).filter(a => elsterCatalog.anlagen[a]);
  const codeSet = new Set();
  for (const a of anlagenValid) {
    const anl = elsterCatalog.anlagen[a];
    const codes = sammleCodesAusSchema(anl.json_schema);
    for (const c of codes) codeSet.add(`${a}:${c}`);
  }
  const belegteValid = (parsed.belegte_codes || []).filter(b => {
    if (!/^E\d{7}$/.test(b.code)) return false;
    if (!b.anlage || !elsterCatalog.anlagen[b.anlage]) return false;
    return codeSet.has(`${b.anlage}:${b.code}`);
  });

  return {
    model,
    dokument_typ: String(parsed.dokument_typ || ""),
    jahr: parsed.jahr,
    anlagen: anlagenValid,
    belegte_codes: belegteValid,
    verworfen: Array.isArray(parsed.verworfen) ? parsed.verworfen : [],
    begruendung: String(parsed.begruendung || "").slice(0, 800),
    kuratierte_codes_count: belegteValid.length,
    halluzinierte_codes_count: (parsed.belegte_codes || []).length - belegteValid.length,
    ms,
    usage: j.usage,
  };
}

// Baut ein minimales JSON-Schema aus dem Opus-Kurator-Output:
// nur die Anlagen, nur die belegten E-Codes. Behaelt die XSD-Struktur
// (Pfade) bei, filtert aber alles nicht-belegte raus.
function baueKuratiertesSchema(kurator) {
  if (!elsterCatalog) throw new Error("ELSTER-Katalog nicht geladen");
  const anlagen = kurator.anlagen || [];
  const belegtProAnlage = new Map();
  for (const b of kurator.belegte_codes || []) {
    if (!belegtProAnlage.has(b.anlage)) belegtProAnlage.set(b.anlage, new Set());
    belegtProAnlage.get(b.anlage).add(b.code);
  }

  // Rekursiver Prune: behalte nur Teilbaeume, die mindestens einen belegten Code haben.
  function prune(node, belegt) {
    if (!node || typeof node !== "object") return null;
    if (node.type === "array" && node.items) {
      const p = prune(node.items, belegt);
      return p ? { ...node, items: p } : null;
    }
    if (node.type === "object" && node.properties) {
      const props = {}; const required = [];
      for (const [k, v] of Object.entries(node.properties)) {
        if (/^E\d{7}$/.test(k)) {
          if (belegt.has(k)) { props[k] = v; required.push(k); }
        } else {
          const pv = prune(v, belegt);
          if (pv) { props[k] = pv; required.push(k); }
        }
      }
      if (Object.keys(props).length === 0) return null;
      return { ...node, properties: props, required, additionalProperties: false };
    }
    return node;
  }

  if (anlagen.length === 1) {
    const a = elsterCatalog.anlagen[anlagen[0]];
    const belegt = belegtProAnlage.get(anlagen[0]) || new Set();
    return prune(a.json_schema, belegt) || a.json_schema;
  }
  const props = {}; const required = [];
  for (const code of anlagen) {
    const a = elsterCatalog.anlagen[code];
    const belegt = belegtProAnlage.get(code) || new Set();
    const pruned = prune(a.json_schema, belegt);
    if (pruned) { props[code] = pruned; required.push(code); }
  }
  return {
    type: "object",
    title: `ELSTER_kuratiert_${anlagen.join("_")}`,
    description: `Von Opus kuratiert aus Mistral+Vision — nur belegte Felder`,
    properties: props, required, additionalProperties: false,
  };
}

// ─── Bewertung + Schema-Anreicherung ──────────────────────────────────────
// Sammelt alle belegten E-Codes (key + truthy value) rekursiv aus der Annotation.
function sammleBelegteCodes(anno, out = new Set()) {
  if (!anno || typeof anno !== "object") return out;
  if (Array.isArray(anno)) { for (const x of anno) sammleBelegteCodes(x, out); return out; }
  for (const [k, v] of Object.entries(anno)) {
    if (/^E\d{7}$/.test(k) && v !== null && v !== undefined && v !== "") {
      if (typeof v !== "object" || (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0)) {
        out.add(k);
      }
    }
    if (v && typeof v === "object") sammleBelegteCodes(v, out);
  }
  return out;
}

// Sammelt alle E-Codes die im Schema als property-key auftauchen.
function sammleCodesAusSchema(schema, out = new Set()) {
  if (!schema || typeof schema !== "object") return out;
  if (schema.type === "object" && schema.properties) {
    for (const [k, v] of Object.entries(schema.properties)) {
      if (/^E\d{7}$/.test(k)) out.add(k);
      sammleCodesAusSchema(v, out);
    }
  } else if (schema.type === "array" && schema.items) {
    sammleCodesAusSchema(schema.items, out);
  }
  return out;
}

async function bewerteExtraktion(annotation, jsonSchema, storedFilename, originalName, opusModel, ohneOpus, anlagen, emit = () => {}) {
  const pflichtfelder = sammlePflichtfelder(jsonSchema);
  const belegt = [];
  const fehlend = [];
  for (const pf of pflichtfelder) {
    (istBelegt(leseAusPfad(annotation, pf.pfad)) ? belegt : fehlend).push(pf);
  }
  const coverage = pflichtfelder.length > 0 ? belegt.length / pflichtfelder.length : 0;

  // BMF-Pflicht (offizielle Jahresdokumentation)
  const bmfPflicht = bmfPflichtFelderFuerKombi(anlagen || []);
  const belegteCodes = sammleBelegteCodes(annotation);
  const bmfBelegt = bmfPflicht.filter(f => belegteCodes.has(f.name));
  const bmfFehlend = bmfPflicht.filter(f => !belegteCodes.has(f.name));
  const bmf_quote = bmfPflicht.length > 0 ? bmfBelegt.length / bmfPflicht.length : 1;
  emit("bewertung_bmf", { belegt: bmfBelegt.length, gesamt: bmfPflicht.length, quote: bmf_quote });

  // Dichte — wieviel vom Schema hat Mistral belegt
  const schemaCodes = sammleCodesAusSchema(jsonSchema);
  const dichte_belegt = [...schemaCodes].filter(c => belegteCodes.has(c)).length;
  const dichte_score = schemaCodes.size > 0 ? dichte_belegt / schemaCodes.size : 0;
  emit("bewertung_dichte", { belegt: dichte_belegt, gesamt: schemaCodes.size, score: dichte_score });

  const konsistenz = pruefeKonsistenz(annotation);
  const konsistenz_bestanden = konsistenz.filter(k => k.ok).length;
  const konsistenz_score = konsistenz.length > 0 ? konsistenz_bestanden / konsistenz.length : 1;
  emit("bewertung_konsistenz", { bestanden: konsistenz_bestanden, gesamt: konsistenz.length, score: konsistenz_score });

  let opus = null;
  if (!ohneOpus) {
    emit("bewertung_opus_start", {});
    opus = await opusEvaluierung(storedFilename, originalName, annotation, fehlend, opusModel);
    emit("bewertung_opus_done", { score: opus.score, hinweise_count: opus.hinweise.length, hinweise: opus.hinweise, begruendung: opus.begruendung, ms: opus.ms });
  }
  // Neue Gewichtung: BMF-Pflicht + Dichte + Konsistenz + Opus
  const gesamt = opus
    ? 0.25 * bmf_quote + 0.15 * dichte_score + 0.10 * konsistenz_score + 0.50 * opus.score
    : 0.40 * bmf_quote + 0.30 * dichte_score + 0.30 * konsistenz_score;

  return {
    pflicht_belegt: belegt.length,
    pflicht_gesamt: pflichtfelder.length,
    pflicht_fehlend: fehlend.slice(0, 50),
    coverage_score: coverage,
    bmf_pflicht_belegt: bmfBelegt.length,
    bmf_pflicht_gesamt: bmfPflicht.length,
    bmf_pflicht_fehlend: bmfFehlend.slice(0, 30).map(f => ({
      anlage: (f.kontext || "").split(",")[0] || "?",
      code: f.name,
      beschreibung: f.beschreibung,
    })),
    dichte_belegt,
    dichte_gesamt: schemaCodes.size,
    dichte_score,
    konsistenz,
    konsistenz_score,
    opus_score: opus ? opus.score : null,
    opus_begruendung: opus ? opus.begruendung : null,
    opus_hinweise: opus ? opus.hinweise : [],
    opus_ms: opus ? opus.ms : 0,
    gesamt_score: gesamt,
  };
}

function findeSchemaKnoten(schema, pfad) {
  let cur = schema;
  for (const seg of pfad) {
    if (!cur || typeof cur !== "object") return null;
    if (cur.properties && cur.properties[seg]) { cur = cur.properties[seg]; continue; }
    if (cur.type === "array" && cur.items) {
      cur = cur.items;
      if (cur.properties && cur.properties[seg]) { cur = cur.properties[seg]; continue; }
    }
    return null;
  }
  return cur;
}

function reichereSchemaAn(schema, hinweise) {
  const kopie = JSON.parse(JSON.stringify(schema));
  const allgemein = [];
  for (const h of hinweise) {
    const pfad = (h.feld_pfad || "").split(".").filter(Boolean);
    const ziel = pfad.length ? findeSchemaKnoten(kopie, pfad) : null;
    const text = `[Hinweis] ${h.anweisung}`;
    if (ziel) {
      const alt = typeof ziel.description === "string" ? ziel.description : "";
      ziel.description = alt ? `${alt} · ${text}` : text;
    } else {
      allgemein.push(`${h.feld_pfad}: ${h.anweisung}`);
    }
  }
  if (allgemein.length) {
    const alt = typeof kopie.description === "string" ? kopie.description : "";
    kopie.description = `${alt}\n\nAllgemein:\n- ${allgemein.join("\n- ")}`;
  }
  return kopie;
}

// ─── Cross-Check: passen gefundene E-Codes zur Anlagen-Auswahl? ───────────
function crossCheckAnlagen(gewaehlteAnlagen, annotation) {
  baueCodeIndex();
  const idx = codeIndex || new Map();
  const codes = Array.from(sammleElsterCodes(annotation));
  const gewaehlt = new Set(gewaehlteAnlagen);
  const erwartetProAnlage = new Map();
  const unerwartetProAnlage = new Map();
  const ohneZuordnung = [];

  for (const c of codes) {
    const moeglich = idx.get(c);
    if (!moeglich || moeglich.size === 0) { ohneZuordnung.push(c); continue; }
    const ueberlapp = [...moeglich].filter(a => gewaehlt.has(a));
    const repr = ueberlapp.length ? ueberlapp.sort()[0] : [...moeglich].sort()[0];
    const bucket = ueberlapp.length ? erwartetProAnlage : unerwartetProAnlage;
    const liste = bucket.get(repr) || [];
    liste.push(c);
    bucket.set(repr, liste);
  }

  const unerwartet = [...unerwartetProAnlage.entries()].map(([anlage, codes]) => ({ anlage, codes }));
  const gesamt = codes.length;
  const unerwCodes = unerwartet.reduce((s, u) => s + u.codes.length, 0);
  const quote = gesamt > 0 ? unerwCodes / gesamt : 0;

  let empfehlung, begruendung, konfidenz;
  if (gesamt === 0) {
    empfehlung = "uneindeutig";
    begruendung = "Keine ELSTER-Codes in Annotation";
    konfidenz = 0.3;
  } else if (quote === 0) {
    empfehlung = "passt";
    begruendung = `${gesamt} Codes, alle in erwarteten Anlagen (${[...erwartetProAnlage.keys()].join(", ")})`;
    konfidenz = 0.95;
  } else if (quote < 0.15) {
    empfehlung = "passt";
    begruendung = `${gesamt} Codes, ${unerwCodes} vereinzelt ausserhalb (${unerwartet.map(u => u.anlage).join(", ")})`;
    konfidenz = 0.85;
  } else if (quote < 0.5) {
    empfehlung = "erweitern";
    begruendung = `${(quote * 100).toFixed(0)}% Codes in nicht gewaehlten Anlagen: ${unerwartet.map(u => `${u.anlage}(${u.codes.length})`).join(", ")}`;
    konfidenz = 0.6;
  } else {
    empfehlung = "neu_klassifizieren";
    const dom = [...unerwartet].sort((a, b) => b.codes.length - a.codes.length)[0];
    begruendung = `${(quote * 100).toFixed(0)}% der Codes gehoeren zu ${dom?.anlage}, nicht zu ${gewaehlteAnlagen.join(",")}`;
    konfidenz = 0.7;
  }
  return {
    passt: empfehlung === "passt",
    gewaehlte_anlagen: gewaehlteAnlagen,
    gefundene_anlagen: [...new Set([...erwartetProAnlage.keys(), ...unerwartetProAnlage.keys()])],
    erwartet: [...erwartetProAnlage.entries()].map(([anlage, codes]) => ({ anlage, codes })),
    unerwartet,
    ohne_zuordnung: ohneZuordnung,
    gesamt_codes: gesamt,
    quote_unerwartet: quote,
    empfehlung,
    begruendung,
    konfidenz,
  };
}

// ─── Mapper-Shootout: 5 Modelle parallel mappen Dokument-JSON auf ELSTER-E-Codes ──
// Input:  freie Mistral-Permissive-JSON + BMF-Katalog-Auszug
// Output: {dokumenttyp, mappings:[{dokument_pfad, dokument_wert, e_code, anlage, person, konfidenz, begruendung}], ohne_zuordnung:[...]}
// Messwerte: Dauer, Anzahl Mappings, BMF-Regex-Durchfallquote.

let _kompaktKatalog = null;
function baueKompaktKatalog() {
  if (_kompaktKatalog !== null) return _kompaktKatalog;
  if (!bmfCatalog?.anlagen) { _kompaktKatalog = ""; return _kompaktKatalog; }
  const lines = [];
  for (const [anlage, a] of Object.entries(bmfCatalog.anlagen)) {
    for (const [code, feld] of Object.entries(a.felder || {})) {
      const dt = String(feld.drucktext || feld.beschreibung || "").replace(/\s+/g, " ").slice(0, 80);
      const ctx = (feld.kontext || "").slice(0, 30);
      lines.push(`${code}|${anlage}|${ctx}|${dt}`);
    }
  }
  _kompaktKatalog = lines.join("\n");
  return _kompaktKatalog;
}

const SHOOTOUT_SYSTEM_PROMPT = `Du bist ein semantischer Mapper fuer deutsche Steuerdokumente. Du erhaelst:
1) ein freies JSON mit dokumentenspezifischen Keys (aus Vision-OCR),
2) den BMF-ELSTER-Katalog als Tabelle (E-Code | Anlage | Kontext | Drucktext).

Deine Aufgabe: Fuer jeden Blatt-Wert im Dokument-JSON identifiziere den semantisch passenden E-Code im Katalog.
Mappe nach **Bedeutung**, nicht nach Text-Gleichheit. Beispiel: "bruttoarbeitslohn" mappt auf E-Code mit Drucktext "Bruttoarbeitslohn".

Antworte AUSSCHLIESSLICH mit JSON (keine Codefences, kein Fliesstext):
{
  "dokumenttyp": "<z.B. Einkommensteuererklaerung 2023 / Lohnsteuerbescheinigung / Rentenbescheid / Spendenbescheinigung>",
  "mappings": [
    {"dokument_pfad": "<JSON-Pfad>", "dokument_wert": "<Wert>", "e_code": "E0000000", "anlage": "N", "person": "A|B|null", "konfidenz": 0.0..1.0, "begruendung": "<kurz>"}
  ],
  "ohne_zuordnung": [
    {"dokument_pfad": "<Pfad>", "dokument_wert": "<Wert>", "grund": "<warum keine ELSTER-Entsprechung>"}
  ]
}
Regeln:
- e_code EXAKT aus Katalog (Format E + 7 Ziffern). Erfinde nichts.
- konfidenz 0.9+ nur bei klarem 1:1-Semantik-Match, sonst niedriger.
- Bei uneindeutiger Personen-Zuordnung: "person": null.
- Max 150 Mappings, aufsteigend nach e_code.`;

function baueShootoutUserPrompt(dokumentJson, katalog) {
  const kompakt = JSON.stringify(dokumentJson).slice(0, 20000);
  const katalogKurz = katalog.length > 80000 ? katalog.slice(0, 80000) + "\n...(gekuerzt)" : katalog;
  return `=== DOKUMENT-JSON (Mistral-Permissive-Output) ===\n${kompakt}\n\n=== BMF-ELSTER-KATALOG (E-Code|Anlage|Kontext|Drucktext) ===\n${katalogKurz}\n\nEmittiere jetzt das Mapping-JSON.`;
}

function validiereShootoutMappings(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const mappings = Array.isArray(parsed.mappings) ? parsed.mappings : [];
  const validE = /^E\d{7}$/;
  const gueltig = []; const ungueltig = []; let regexPass = 0; let regexFail = 0;
  for (const m of mappings) {
    if (!m?.e_code || !validE.test(m.e_code)) { ungueltig.push({ ...m, grund: "e_code invalid" }); continue; }
    if (!m.anlage || !bmfCatalog?.anlagen?.[m.anlage]) { ungueltig.push({ ...m, grund: "anlage invalid" }); continue; }
    const feld = bmfCodeIndexPerAnlage?.get(m.anlage)?.get(m.e_code);
    if (!feld) { ungueltig.push({ ...m, grund: "code in anlage nicht im katalog" }); continue; }
    const v = bmfValidiereWert(m.e_code, String(m.dokument_wert ?? ""), m.anlage);
    if (v?.ok) regexPass++;
    else if (v && !v.ok) regexFail++;
    gueltig.push({ ...m, bmf_regex_ok: v?.ok ?? null });
  }
  return {
    dokumenttyp: String(parsed.dokumenttyp || ""),
    mappings_gueltig: gueltig,
    mappings_ungueltig: ungueltig.slice(0, 20),
    ohne_zuordnung: Array.isArray(parsed.ohne_zuordnung) ? parsed.ohne_zuordnung.slice(0, 50) : [],
    stats: {
      mappings_total: mappings.length,
      gueltig: gueltig.length,
      ungueltig: ungueltig.length,
      regex_pass: regexPass,
      regex_fail: regexFail,
    },
  };
}

// Modell-Definition fuer den Shootout. Anthropic via runClaude, Mistral via runMistralChat.
const SHOOTOUT_MODELS = [
  { key: "haiku",         label: "Claude Haiku 4.5",  provider: "claude",  id: "claude-haiku-4-5-20251001", maxTokens: 16384 },
  { key: "sonnet",        label: "Claude Sonnet 4.6", provider: "claude",  id: "claude-sonnet-4-6",         maxTokens: 16384 },
  { key: "opus",          label: "Claude Opus 4.7",   provider: "claude",  id: "claude-opus-4-7",           maxTokens: 16384 },
  { key: "mistral_small", label: "Mistral Small",     provider: "mistral", id: "mistral-small-latest",      maxTokens: 16384 },
  { key: "mistral_large", label: "Mistral Large",     provider: "mistral", id: "mistral-large-latest",      maxTokens: 16384 },
];

async function rufeMapperModel(modelDef, system, user) {
  const t0 = Date.now();
  try {
    let res;
    if (modelDef.provider === "claude") {
      res = await runClaude(modelDef.id, system, user, { maxTokens: modelDef.maxTokens });
    } else {
      res = await runMistralChat(modelDef.id, system, user, {
        maxTokens: modelDef.maxTokens,
        responseFormat: { type: "json_object" },
      });
    }
    const ms = Date.now() - t0;
    const parsed = extrahiereJson(res.output);
    const validiert = parsed ? validiereShootoutMappings(parsed) : null;
    return {
      ok: !!validiert,
      ms,
      usage: res.usage,
      stop_reason: res.stop_reason || res.finish_reason,
      parse_ok: !!parsed,
      ...validiert,
      raw_preview: parsed ? null : (res.output || "").slice(0, 400),
    };
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - t0,
      error: e.message,
    };
  }
}

// ─── In-Memory Prompt-Cache ───────────────────────────────────────────────
const promptCache = new Map();  // key: `${schema_hash}` → { hinweise, qualitaet, iterationen }
function hashSchema(schema) {
  const s = JSON.stringify(schema);
  let h = 2166136261 >>> 0;  // FNV-1a 32-bit
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ─── Endpoints ─────────────────────────────────────────────────────────────

// Cross-Check: passen die gefundenen E-Codes in der Annotation zur Anlagen-Auswahl?
app.post("/api/elster/cross-check", (req, res) => {
  const { annotation, anlagen } = req.body || {};
  if (!Array.isArray(anlagen) || !anlagen.length) {
    return res.status(400).json({ error: "anlagen (Array) erforderlich" });
  }
  if (!annotation) return res.status(400).json({ error: "annotation erforderlich" });
  try {
    const befund = crossCheckAnlagen(anlagen, annotation);
    res.json(befund);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Evaluate: Coverage + Konsistenz + optional Opus-Bewertung
app.post("/api/elster/evaluate", async (req, res) => {
  const { annotation, json_schema, storedFilename, originalName, opusModel, ohneOpus, anlagen } = req.body || {};
  if (!annotation) return res.status(400).json({ error: "annotation erforderlich" });
  if (!json_schema) return res.status(400).json({ error: "json_schema erforderlich" });
  if (!ohneOpus && !storedFilename) return res.status(400).json({ error: "storedFilename erforderlich fuer Opus-Bewertung" });
  try {
    const t0 = Date.now();
    const bewertung = await bewerteExtraktion(annotation, json_schema, storedFilename, originalName, opusModel, ohneOpus, anlagen);
    res.json({ ...bewertung, ms: Date.now() - t0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Refine: kompletter Loop — OCR + Evaluator + Opus-Hinweise + Schema-Anreicherung,
// max 3 Iterationen, bricht ab wenn gesamt_score >= 0.85 oder Opus keine Hinweise mehr hat.
app.post("/api/elster/refine", async (req, res) => {
  const {
    storedFilename,
    originalName,
    anlagen,              // z.B. ["N", "ESt1A", "VOR"]
    opusModel = "claude-opus-4-7",
    ohneOpus = false,
    ohneCache = false,
    maxIterationen = MAX_ITERATIONEN,
  } = req.body || {};
  if (!storedFilename) return res.status(400).json({ error: "storedFilename erforderlich" });
  if (!elsterCatalog) return res.status(503).json({ error: "ELSTER-Katalog nicht geladen" });

  // Schema aus Anlagen bauen (identisch zur /api/elster/schema-Route)
  let basisSchema;
  let schemaMeta = { leaf_count: 0, elster_code_count: 0, title: "", groesse_bytes: 0 };
  try {
    const codes = Array.isArray(anlagen) ? anlagen.filter(c => elsterCatalog.anlagen[c]) : [];
    if (!codes.length) return res.status(400).json({ error: "anlagen (nicht-leere Liste gueltiger Codes) erforderlich" });
    if (codes.length === 1) {
      const a = elsterCatalog.anlagen[codes[0]];
      basisSchema = a.json_schema;
      schemaMeta = {
        leaf_count: a.leaf_count,
        elster_code_count: a.elster_code_count,
        title: a.code,
        groesse_bytes: Buffer.byteLength(JSON.stringify(a.json_schema), "utf8"),
      };
    } else {
      const props = {}; const required = [];
      let lc = 0, ec = 0;
      for (const c of codes) {
        const a = elsterCatalog.anlagen[c];
        props[c] = a.json_schema;
        required.push(c);
        lc += a.leaf_count; ec += a.elster_code_count;
      }
      basisSchema = {
        type: "object",
        title: `ELSTER_${codes.join("_")}`,
        description: `ELSTER ${elsterCatalog.year} — Branches: ${codes.join(", ")}`,
        properties: props, required, additionalProperties: false,
      };
      schemaMeta = {
        leaf_count: lc, elster_code_count: ec, title: basisSchema.title,
        groesse_bytes: Buffer.byteLength(JSON.stringify(basisSchema), "utf8"),
      };
    }
  } catch (e) {
    return res.status(500).json({ error: `Schema-Bau fehlgeschlagen: ${e.message}` });
  }

  const schemaHash = hashSchema(basisSchema);
  const filePath = path.join(UPLOAD_DIR, path.basename(storedFilename));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Datei nicht gefunden" });

  // Cache-Lookup
  let ausCache = false;
  let kumulierteHinweise = [];
  if (!ohneCache) {
    const cached = promptCache.get(schemaHash);
    if (cached && cached.hinweise && cached.hinweise.length) {
      ausCache = true;
      kumulierteHinweise = cached.hinweise;
    }
  }
  let aktuellesSchema = kumulierteHinweise.length
    ? reichereSchemaAn(basisSchema, kumulierteHinweise)
    : basisSchema;

  const iterationen = [];
  let letzteAnnotation = null;
  let letzteBewertung = null;
  let letzterOcr = null;
  const startZeit = Date.now();

  for (let i = 1; i <= maxIterationen; i++) {
    const runStart = Date.now();
    let ocr;
    try {
      ocr = await mistralOcr(filePath, originalName || storedFilename, aktuellesSchema, schemaMeta.title + `_r${i}`);
    } catch (e) {
      iterationen.push({ nummer: i, mistral_error: e.message, ergebnis: "mistral_fehler", ms: Date.now() - runStart });
      break;
    }
    letzterOcr = ocr;
    letzteAnnotation = ocr.annotation;

    if (!letzteAnnotation || typeof letzteAnnotation !== "object") {
      iterationen.push({
        nummer: i, ergebnis: "keine_annotation", mistral_ms: ocr.ms,
        ms: Date.now() - runStart,
      });
      break;
    }

    const bewertung = await bewerteExtraktion(
      letzteAnnotation, basisSchema,
      storedFilename, originalName, opusModel, ohneOpus, anlagen,
    );
    letzteBewertung = bewertung;

    iterationen.push({
      nummer: i,
      schema_bytes: Buffer.byteLength(JSON.stringify(aktuellesSchema), "utf8"),
      mistral_ms: ocr.ms,
      annotation_bytes: Buffer.byteLength(JSON.stringify(letzteAnnotation), "utf8"),
      pflicht_belegt: bewertung.pflicht_belegt,
      pflicht_gesamt: bewertung.pflicht_gesamt,
      coverage_score: Number(bewertung.coverage_score.toFixed(3)),
      bmf_pflicht_belegt: bewertung.bmf_pflicht_belegt,
      bmf_pflicht_gesamt: bewertung.bmf_pflicht_gesamt,
      dichte_belegt: bewertung.dichte_belegt,
      dichte_gesamt: bewertung.dichte_gesamt,
      dichte_score: Number(bewertung.dichte_score.toFixed(3)),
      konsistenz_score: Number(bewertung.konsistenz_score.toFixed(3)),
      opus_score: bewertung.opus_score !== null ? Number(bewertung.opus_score.toFixed(3)) : null,
      opus_begruendung: bewertung.opus_begruendung,
      opus_hinweise: bewertung.opus_hinweise,
      gesamt_score: Number(bewertung.gesamt_score.toFixed(3)),
      ergebnis: bewertung.gesamt_score >= SCHWELLE_OK ? "ok" : "retry",
      ms: Date.now() - runStart,
    });

    if (bewertung.gesamt_score >= SCHWELLE_OK) break;
    if (i === maxIterationen) break;
    if (bewertung.opus_hinweise.length === 0) break;

    kumulierteHinweise = [...kumulierteHinweise, ...bewertung.opus_hinweise];
    aktuellesSchema = reichereSchemaAn(basisSchema, kumulierteHinweise);
  }

  // Cache nur bei Erfolg
  if (!ohneCache && letzteBewertung && letzteBewertung.gesamt_score >= SCHWELLE_OK) {
    promptCache.set(schemaHash, {
      hinweise: kumulierteHinweise,
      qualitaet: letzteBewertung.gesamt_score,
      iterationen: iterationen.length,
      saved_at: Date.now(),
    });
  }

  // Cross-Check auf finale Annotation
  const crossCheck = letzteAnnotation ? crossCheckAnlagen(anlagen, letzteAnnotation) : null;

  res.json({
    anlagen,
    schema_hash: schemaHash,
    schema_meta: schemaMeta,
    aus_cache: ausCache,
    iterationen,
    final_annotation: letzteAnnotation,
    final_bewertung: letzteBewertung,
    final_ocr_text: letzterOcr ? letzterOcr.text : "",
    cross_check: crossCheck,
    kumulierte_hinweise: kumulierteHinweise,
    dauer_ms: Date.now() - startZeit,
  });
});

// Streaming-Variante des Refine-Loops — emittiert SSE-Events pro Phase.
// Gleiche Semantik wie /api/elster/refine, nur dass Fortschritt sichtbar wird.
app.post("/api/elster/refine-stream", async (req, res) => {
  const {
    storedFilename, originalName, anlagen: anlagenHint,
    opusModel = "claude-opus-4-7",
    visionModel = "claude-sonnet-4-6",
    ohneOpus = false, ohneCache = true,
    maxIterationen = MAX_ITERATIONEN,
  } = req.body || {};

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const emit = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const ende = (event, data) => { emit(event, data); res.end(); };

  if (!storedFilename) return ende("error", { message: "storedFilename erforderlich" });
  if (!elsterCatalog) return ende("error", { message: "ELSTER-Katalog nicht geladen" });

  const filePath = path.join(UPLOAD_DIR, path.basename(storedFilename));
  if (!fs.existsSync(filePath)) return ende("error", { message: "Datei nicht gefunden" });

  emit("start", { storedFilename, anlagenHint, maxIterationen, opusModel });

  // ─── PHASE 1: EIN Mistral-Call mit permissivem Schema ────────────────
  // Liefert in einem Aufruf sowohl Markdown-Text (pages[].markdown) als auch
  // die dokumentenspezifische strukturierte JSON (document_annotation).
  // Der Anlagen-Detector laeuft komplett entkoppelt daneben (siehe
  // lib/anlagenDetector.mjs, /api/upload-Hook, /api/anlagen/:stored) und
  // fuettert die Pipeline NICHT — die Pipeline macht ihre eigene Anlagen-
  // Erkennung im selben Call ueber das erkannte_anlagen-Feld im Schema.
  emit("mistral_raw_start", {});
  const alleAnlagenCodes = Object.keys(elsterCatalog.anlagen || {});
  const permissivSchemaPipeline = {
    type: "object",
    description: "Extrahiere alle steuer-relevanten Felder frei strukturiert. Benutze aussagekraeftige deutsche Keys. Schachtele nach Personen und Themen (Stammdaten, Einkuenfte, Vorsorge, Bank, usw.). Zusaetzlich IMMER das Feld erkannte_anlagen ausfuellen.",
    properties: {
      erkannte_anlagen: {
        type: "array",
        description: "Liste der ELSTER-Anlagen-Codes, fuer die dieses Dokument eindeutig relevante Daten liefert (z. B. 'N' bei einer Lohnsteuerbescheinigung, 'KAP' bei einer Kapitalertragsteuerbescheinigung, 'VOR' bei einer Vorsorgeaufwand-Bescheinigung). Nur Codes aus der enum-Liste verwenden. 'ESt1A' (Hauptvordruck) nur mitnennen, wenn das Dokument Stammdaten des Steuerpflichtigen liefert. Leeres Array wenn keine Anlage eindeutig zuordenbar.",
        items: { type: "string", enum: alleAnlagenCodes },
      },
    },
    additionalProperties: true,
  };
  let mistralRaw;
  try {
    mistralRaw = await mistralOcr(filePath, originalName || storedFilename, permissivSchemaPipeline, "PermissivInfer");
    const erkannteAnlagen = Array.isArray(mistralRaw.annotation?.erkannte_anlagen)
      ? mistralRaw.annotation.erkannte_anlagen.filter(a => elsterCatalog.anlagen[a])
      : [];
    emit("mistral_raw_done", {
      ms: mistralRaw.ms, chars: mistralRaw.chars, pages_count: mistralRaw.pages.length,
      text_preview: mistralRaw.text.slice(0, 4000),
      text: mistralRaw.text,
      annotation: mistralRaw.annotation,
      annotation_bytes: mistralRaw.annotation ? Buffer.byteLength(JSON.stringify(mistralRaw.annotation), "utf8") : 0,
      erkannte_anlagen: erkannteAnlagen,
    });
    mistralRaw.erkannte_anlagen = erkannteAnlagen;
  } catch (e) {
    emit("mistral_raw_done", { error: e.message });
    return ende("error", { message: `Mistral-OCR fehlgeschlagen: ${e.message}` });
  }
  emit("parallel_done", { ms_total: mistralRaw.ms });

  // ─── PHASE 2: Regel-Engine kuratiert deterministisch ─────────
  // Bekommt beides aus dem einen Mistral-Call: Markdown fuer Zeilenparsing
  // (parseMistralText), strukturiertes JSON fuer Label-Matching (flatteneVision).
  emit("regel_engine_start", {});
  const t_regel = Date.now();
  const regel = regelBasierteKuration(mistralRaw.text, mistralRaw.annotation || {});

  // Effektive Anlagen-Menge: Union aus User-Chips (anlagenHint) + Mistral-Urteil
  // (mistralRaw.erkannte_anlagen aus dem Inline-OCR-Call). Fallback auf Regel-Engine
  // wenn beide leer. Die Regel-Engine-Ergebnisse werden hart auf diese Menge
  // gefiltert — Codes aus Anlagen, die weder User noch Mistral als relevant
  // markiert haben, fliegen in verworfen_anlage_nicht_erkannt.
  const userAnlagenNorm = (anlagenHint || []).filter(a => elsterCatalog.anlagen[a]);
  const mistralAnlagenNorm = (mistralRaw.erkannte_anlagen || []).filter(a => elsterCatalog.anlagen[a]);
  const unionAnlagen = [...new Set([...userAnlagenNorm, ...mistralAnlagenNorm])];
  const effektiveAnlagen = unionAnlagen.length ? new Set(unionAnlagen) : new Set(regel.anlagen);

  const verworfenFremdeAnlage = [];
  const filterAufEffektiv = (liste) => liste.filter(c => {
    if (effektiveAnlagen.has(c.anlage)) return true;
    verworfenFremdeAnlage.push({
      code: c.code, anlage: c.anlage, wert: c.wert, kontext: c.kontext,
      grund: `Anlage ${c.anlage} nicht in effektiver Menge`,
    });
    return false;
  });
  regel.eindeutig = filterAufEffektiv(regel.eindeutig);
  regel.konflikte = filterAufEffektiv(regel.konflikte);
  regel.unklarheiten = filterAufEffektiv(regel.unklarheiten);
  regel.anlagen = [...effektiveAnlagen];
  regel.stats.verworfen_anlage_nicht_erkannt_count = verworfenFremdeAnlage.length;

  emit("regel_engine_done", {
    ms: Date.now() - t_regel,
    stats: regel.stats,
    anlagen: regel.anlagen,
    user_anlagen: userAnlagenNorm,
    mistral_erkannte_anlagen: mistralAnlagenNorm,
    eindeutig: regel.eindeutig.slice(0, 150),
    konflikte: regel.konflikte.slice(0, 50),
    unklarheiten: regel.unklarheiten.slice(0, 50),
    verworfen_anlage_nicht_erkannt: verworfenFremdeAnlage.slice(0, 50),
    verworfen_mistral: regel.verworfen_mistral.slice(0, 100),
    verworfen_vision: regel.verworfen_vision.slice(0, 100),
  });

  // ─── PHASE 3: Opus-Konfliktloeser ist DEAKTIVIERT ─────────────
  // Konflikte/Unklarheiten landen in der Reconciliation-Ausgabe und im UI,
  // ohne LLM-Aufloesung. Der Grund: mit Mistral-Permissive als einziger
  // Vorextraktion gibt es deutlich weniger Konflikte als im alten
  // Mistral-roh + Sonnet-Vision-Setup. Das Resteinsparpotenzial von Opus
  // (Format-Normalisierung Religion "Evangelisch"→"EV", Dezimalformate)
  // kommt ggf. spaeter deterministisch oder im cb-ctax Full-Map-Step zurueck.
  const opusAufloesungen = [];

  if (!regel.anlagen.length) return ende("error", { message: "Regel-Engine fand keine zuordenbaren Anlagen" });

  // ─── PHASE 4: Schema nur aus eindeutigen Regel-Engine-Codes bauen ────
  emit("schema_start", {});
  const finalCodes = [
    ...regel.eindeutig,
  ];
  let basisSchema; let schemaMeta;
  let personenProAnlage = new Map();
  try {
    // Struktur: pro Anlage wird der Katalog-Schema-Teilbaum auf nur die belegten Codes geprunt.
    // Dabei: wenn eine mehrfach-erlaubte Anlage (max_occurs > 1) Daten zu MEHREN Personen hat,
    // wird das pruned Schema in einen Array-Wrapper gepackt — sonst ueberschreibt
    // Person B die Person-A-Daten beim Mistral-Call.
    const belegtProAnlage = new Map();
    for (const c of finalCodes) {
      if (!belegtProAnlage.has(c.anlage)) belegtProAnlage.set(c.anlage, new Set());
      belegtProAnlage.get(c.anlage).add(c.code);
      if (!personenProAnlage.has(c.anlage)) personenProAnlage.set(c.anlage, new Set());
      if (c.personen_ctx) personenProAnlage.get(c.anlage).add(c.personen_ctx);
    }
    const anlagenFinal = [...belegtProAnlage.keys()].filter(a => elsterCatalog.anlagen[a]);
    if (!anlagenFinal.length) return ende("error", { message: "Keine kuratierbaren Anlagen im Katalog" });

    const props = {}; const required = [];
    for (const a of anlagenFinal) {
      const catAnl = elsterCatalog.anlagen[a];
      const pruned = pruneSchemaAufBelegt(catAnl.json_schema, belegtProAnlage.get(a));
      if (!pruned) continue;
      const maxOcc = catAnl.max_occurs || 1;
      const personen = personenProAnlage.get(a) || new Set();
      if (maxOcc > 1 && personen.size > 1) {
        // Array-Wrapper: eine Instanz pro Person. Person-Property wird
        // zurueckgefuegt (Prune hat sie als Nicht-E-Code entfernt), damit Mistral
        // pro Instanz explizit PersonA/PersonB setzen MUSS — sonst koennen wir
        // sie beim Merge nicht eindeutig zuordnen.
        const personenValues = [...personen].map(c => c === "A" ? "PersonA" : "PersonB");
        const itemMitPerson = {
          ...pruned,
          properties: {
            Person: { type: "string", enum: personenValues, description: "Person-Instanz-Marker" },
            ...(pruned.properties || {}),
          },
          required: ["Person", ...(pruned.required || [])],
        };
        props[a] = {
          type: "array",
          minItems: personen.size,
          maxItems: Math.max(maxOcc, personen.size),
          items: itemMitPerson,
          description: (pruned.description || `Anlage ${a}`) + ` — ${personen.size} Instanzen`,
        };
      } else {
        props[a] = pruned;
      }
      required.push(a);
    }
    if (anlagenFinal.length === 1) basisSchema = props[anlagenFinal[0]];
    else basisSchema = {
      type: "object", title: `ELSTER_V2_${anlagenFinal.join("_")}`,
      description: `V2-Hybrid kuratiert: ${finalCodes.length} Codes aus ${anlagenFinal.length} Anlagen`,
      properties: props, required, additionalProperties: false,
    };
    schemaMeta = {
      leaf_count: sammlePflichtfelder(basisSchema).length,
      elster_code_count: sammleCodesAusSchema(basisSchema).size,
      title: basisSchema.title || anlagenFinal[0],
      groesse_bytes: Buffer.byteLength(JSON.stringify(basisSchema), "utf8"),
      kuratiert: true,
      v2_stats: { ...regel.stats, opus_aufgeloest: opusAufloesungen.length },
      personen_pro_anlage: Object.fromEntries([...personenProAnlage.entries()].map(([a, s]) => [a, [...s]])),
    };
  } catch (e) { return ende("error", { message: `Schema-Bau fehlgeschlagen: ${e.message}` }); }
  emit("schema_done", { schemaMeta, schema: basisSchema });

  const schemaHash = hashSchema(basisSchema);
  const anlagen = regel.anlagen;

  // ─── PHASE 4b: Mistral-Kuratiert — EIN Pass mit dem tight Schema ────
  // Enum-Felder > 8 Werte (Klassifizierungs-Enums wie Religion) werden vorher
  // entschaerft, damit Mistral Klartext liefert statt einen Default zu raten.
  emit("mistral_kuratiert_start", {});
  const schemaFuerMistral = entferneGrosseEnums(basisSchema, 8);
  let mistralKuratiertAnno = null;
  let mistralKuratiertMs = 0;
  try {
    const t_mk = Date.now();
    const ocr = await mistralOcr(
      filePath, originalName || storedFilename, schemaFuerMistral,
      (schemaMeta.title || "Extraction") + "_kuratiert",
    );
    mistralKuratiertMs = Date.now() - t_mk;
    mistralKuratiertAnno = ocr.annotation;
    emit("mistral_kuratiert_done", {
      ms: mistralKuratiertMs,
      has_annotation: !!(mistralKuratiertAnno && typeof mistralKuratiertAnno === "object"),
      annotation: mistralKuratiertAnno,
      annotation_bytes: mistralKuratiertAnno ? Buffer.byteLength(JSON.stringify(mistralKuratiertAnno), "utf8") : 0,
      schema_bytes: Buffer.byteLength(JSON.stringify(schemaFuerMistral), "utf8"),
    });
  } catch (e) {
    emit("mistral_kuratiert_done", { error: e.message });
  }

  // Cache-Lookup
  let ausCache = false; let kumulierteHinweise = [];
  if (!ohneCache) {
    const cached = promptCache.get(schemaHash);
    if (cached && cached.hinweise && cached.hinweise.length) {
      ausCache = true; kumulierteHinweise = cached.hinweise;
    }
  }
  emit("cache_lookup", { hit: ausCache, hinweise_count: kumulierteHinweise.length, schema_hash: schemaHash });

  const startZeit = Date.now();

  // ─── PHASE 5: Merge — Mistral-Kuratiert primaer, Baseline als Fallback ──
  // Strategie pro E-Code:
  //  1. Mistral-Kuratiert-Wert gewinnt (gesehen das Bild, im schema-frame)
  //  2. Wenn Mistral den Code nicht gefuellt hat → Baseline-Wert (Regel-Engine / Opus-Konflikt)
  //  3. Wenn Mistral einen Enum-Default schrieb (z.B. "11" fuer Religion),
  //     aber Opus-Konfliktloeser hat eine andere Entscheidung → Opus gewinnt
  emit("baseline_start", {});
  const baselineAusRegel = baueBaselineAnnotation(finalCodes);
  const mistralCodes = sammleBelegteCodes(mistralKuratiertAnno || {});
  const opusEntscheidungen = new Map();
  for (const c of finalCodes) {
    if (c.quelle === "opus_konflikt") opusEntscheidungen.set(c.code, c.wert);
  }

  // Merge-Ergebnis: klone mistralKuratiertAnno als Basis, ueberschreibe Opus-Entscheidungen,
  // merge fehlende Baseline-Codes ins entsprechende anlage-object.
  const finalAnnotation = mistralKuratiertAnno && typeof mistralKuratiertAnno === "object"
    ? JSON.parse(JSON.stringify(mistralKuratiertAnno))
    : JSON.parse(JSON.stringify(baselineAusRegel));

  // Opus-Entscheidungen einpflegen — respektiert Array-Struktur bei mehrfach-Anlagen
  let opusUeberschrieben = 0;
  for (const [code, wert] of opusEntscheidungen.entries()) {
    for (const c of finalCodes) {
      if (c.code !== code) continue;
      const catAnl = elsterCatalog?.anlagen?.[c.anlage];
      if (!catAnl) break;
      const pfad = findeCodePfadImSchema(catAnl.json_schema, code);
      if (!pfad) break;
      const ziel = findeOderErstelleAnlageInstanz(finalAnnotation, c.anlage, c.personen_ctx);
      setzeAnPfad(ziel, pfad, code, normalizeWert(wert));
      opusUeberschrieben++;
      break;
    }
  }

  // Fehlende Baseline-Codes ergaenzen (nur wenn Mistral sie nicht hat)
  let baselineErgaenzt = 0;
  for (const c of finalCodes) {
    if (mistralCodes.has(c.code)) continue;
    if (opusEntscheidungen.has(c.code)) continue;
    const catAnl = elsterCatalog?.anlagen?.[c.anlage];
    if (!catAnl) continue;
    const pfad = findeCodePfadImSchema(catAnl.json_schema, c.code);
    const ziel = findeOderErstelleAnlageInstanz(finalAnnotation, c.anlage, c.personen_ctx);
    if (pfad) setzeAnPfad(ziel, pfad, c.code, normalizeWert(c.wert));
    else ziel[c.code] = normalizeWert(c.wert);
    baselineErgaenzt++;
  }

  emit("baseline_done", {
    annotation: finalAnnotation,
    annotation_bytes: Buffer.byteLength(JSON.stringify(finalAnnotation), "utf8"),
    merge_stats: {
      mistral_codes: mistralCodes.size,
      opus_ueberschrieben: opusUeberschrieben,
      baseline_ergaenzt: baselineErgaenzt,
      gesamt: sammleBelegteCodes(finalAnnotation).size,
    },
    quellen: finalCodes.reduce((acc, c) => ({ ...acc, [c.quelle]: (acc[c.quelle] || 0) + 1 }), {}),
  });
  const baselineAnnotation = finalAnnotation;

  // ─── PHASE 6: Einmalige Bewertung der Baseline ────────────────────
  const bewertung = await bewerteExtraktion(
    baselineAnnotation, basisSchema, storedFilename, originalName, opusModel, ohneOpus, anlagen,
    (event, data) => emit(event, { iteration: 1, ...data }),
  );

  const iterData = {
    nummer: 1,
    schema_bytes: Buffer.byteLength(JSON.stringify(basisSchema), "utf8"),
    mistral_ms: 0,
    annotation_bytes: Buffer.byteLength(JSON.stringify(baselineAnnotation), "utf8"),
    bmf_pflicht_belegt: bewertung.bmf_pflicht_belegt,
    bmf_pflicht_gesamt: bewertung.bmf_pflicht_gesamt,
    dichte_belegt: bewertung.dichte_belegt,
    dichte_gesamt: bewertung.dichte_gesamt,
    dichte_score: Number(bewertung.dichte_score.toFixed(3)),
    konsistenz_score: Number(bewertung.konsistenz_score.toFixed(3)),
    opus_score: bewertung.opus_score !== null ? Number(bewertung.opus_score.toFixed(3)) : null,
    opus_begruendung: bewertung.opus_begruendung,
    opus_hinweise: bewertung.opus_hinweise,
    gesamt_score: Number(bewertung.gesamt_score.toFixed(3)),
    ergebnis: bewertung.gesamt_score >= SCHWELLE_OK ? "ok" : "retry",
    ms: Date.now() - startZeit,
    quelle: "V3-Baseline",
  };
  emit("iteration_done", iterData);

  // Cross-Check + Final
  const crossCheck = crossCheckAnlagen(anlagen, baselineAnnotation);
  emit("cross_check", crossCheck);

  // Reconciliation-Report fuer die UI zusammenstellen
  const finalCodesMitDetails = finalCodes.map(c => ({
    code: c.code,
    anlage: c.anlage,
    kontext: c.kontext,
    wert: c.wert,
    quelle: c.quelle,
    konfidenz: c.konfidenz,
    mistral_raw: c.mistral?.raw,
    vision_pfad: c.vision?.pfad,
  }));

  ende("final", {
    anlagen, schema_hash: schemaHash, schema_meta: schemaMeta, aus_cache: ausCache,
    iterationen: [iterData],
    final_annotation: baselineAnnotation,
    final_bewertung: bewertung,
    cross_check: crossCheck,
    kumulierte_hinweise: [],
    dauer_ms: Date.now() - startZeit,
    modus: "V3-Baseline",
    reconciliation: {
      final_codes: finalCodesMitDetails,
      verworfen_mistral: regel.verworfen_mistral,
      verworfen_vision: regel.verworfen_vision,
      stats: {
        mistral_fundstellen: regel.stats.fundstellen_mistral,
        vision_fundstellen: regel.stats.fundstellen_vision,
        final_codes: finalCodes.length,
        verworfen_mistral: regel.verworfen_mistral.length,
        verworfen_vision: regel.verworfen_vision.length,
        quellen_breakdown: finalCodes.reduce((acc, c) => ({ ...acc, [c.quelle]: (acc[c.quelle] || 0) + 1 }), {}),
      },
    },
  });
});

// Mapper-Shootout: ein Mistral-Permissive-OCR-Pass + 5 parallel arbeitende Mapper-LLMs.
// SSE-Events: start, mistral_done, mapper_start (pro Modell), mapper_done (pro Modell), final.
app.post("/api/elster/mapper-shootout", async (req, res) => {
  const { storedFilename, originalName } = req.body || {};
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const emit = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const ende = (event, data) => { emit(event, data); res.end(); };

  if (!storedFilename) return ende("error", { message: "storedFilename erforderlich" });
  const filePath = path.join(UPLOAD_DIR, path.basename(storedFilename));
  if (!fs.existsSync(filePath)) return ende("error", { message: "Datei nicht gefunden" });

  emit("start", { storedFilename, modelle: SHOOTOUT_MODELS.map(m => ({ key: m.key, label: m.label })) });

  // Phase 1: Mistral OCR mit permissivem Schema → dokumentenspezifische freie JSON.
  emit("mistral_start", {});
  const permissivSchema = {
    type: "object",
    description: "Extrahiere alle steuer-relevanten Felder frei strukturiert. Benutze aussagekraeftige deutsche Keys. Schachtele nach Personen und Themen (Stammdaten, Einkuenfte, Vorsorge, Bank, usw.).",
    additionalProperties: true,
  };
  let dokumentJson = null;
  let mistralMs = 0;
  try {
    const tM = Date.now();
    const ocr = await mistralOcr(filePath, originalName || storedFilename, permissivSchema, "PermissivInfer");
    mistralMs = Date.now() - tM;
    dokumentJson = ocr.annotation;
    emit("mistral_done", {
      ms: mistralMs,
      annotation: dokumentJson,
      annotation_bytes: dokumentJson ? Buffer.byteLength(JSON.stringify(dokumentJson), "utf8") : 0,
      pages_count: (ocr.pages || []).length,
    });
    if (!dokumentJson || typeof dokumentJson !== "object") {
      return ende("error", { message: "Mistral-Permissive lieferte kein JSON" });
    }
  } catch (e) {
    return ende("error", { message: `Mistral-OCR fehlgeschlagen: ${e.message}` });
  }

  // Phase 2: Katalog-Kontext + User-Prompt aufbauen (einmal für alle 5 Modelle).
  const katalog = baueKompaktKatalog();
  const userPrompt = baueShootoutUserPrompt(dokumentJson, katalog);
  const katalogBytes = Buffer.byteLength(katalog, "utf8");
  const userBytes = Buffer.byteLength(userPrompt, "utf8");
  emit("shootout_context_ready", { katalog_bytes: katalogBytes, user_prompt_bytes: userBytes });

  // Phase 3: alle Mapper parallel, per-Modell-Events.
  const tShoot = Date.now();
  for (const m of SHOOTOUT_MODELS) emit("mapper_start", { key: m.key, label: m.label, provider: m.provider, id: m.id });
  const resultate = await Promise.all(SHOOTOUT_MODELS.map(async m => {
    const r = await rufeMapperModel(m, SHOOTOUT_SYSTEM_PROMPT, userPrompt);
    emit("mapper_done", { key: m.key, label: m.label, ...r });
    return { key: m.key, label: m.label, provider: m.provider, id: m.id, ...r };
  }));
  const shootMs = Date.now() - tShoot;

  // Phase 4: Konsens-Analyse — welche E-Codes wurden von wievielen Modellen vorgeschlagen?
  const codeVotes = new Map();
  for (const r of resultate) {
    for (const mp of (r.mappings_gueltig || [])) {
      const key = mp.e_code;
      if (!codeVotes.has(key)) codeVotes.set(key, { e_code: mp.e_code, anlage: mp.anlage, stimmen: [], werte: new Set() });
      const slot = codeVotes.get(key);
      slot.stimmen.push({ model: r.key, wert: mp.dokument_wert, konfidenz: mp.konfidenz });
      slot.werte.add(String(mp.dokument_wert));
    }
  }
  const konsens = [...codeVotes.values()].map(c => ({
    ...c, werte: [...c.werte], n_stimmen: c.stimmen.length, werte_einig: c.werte.size === 1,
  })).sort((a, b) => b.n_stimmen - a.n_stimmen);

  ende("final", {
    mistral_ms: mistralMs,
    shootout_ms: shootMs,
    katalog_bytes: katalogBytes,
    user_prompt_bytes: userBytes,
    modelle: resultate,
    konsens,
    gesamt_ms: mistralMs + shootMs,
  });
});

// ─── Zwei-Stufen-Endpoints für Chat-UX ─────────────────────────────────
// /quick-extract: schnelle Mistral-Permissive-Extraktion, ~11 s.
//   → Chat kann dem User sofort "ich habe das Dokument gelesen, sehe X" antworten.
// /full-map: nimmt das Quick-Ergebnis + Opus-Mapping zu ELSTER-E-Codes, ~20 s.
//   → Chat triggert das erst wenn ELSTER-spezifische Aktion (Lane-1-Berechnung, Export) ansteht.
//
// Beide Endpoints liefern JSON synchron. Fehler werden als 4xx/5xx mit {error}-Payload emittiert.

app.post("/api/elster/quick-extract", async (req, res) => {
  const { storedFilename, originalName } = req.body || {};
  if (!storedFilename) return res.status(400).json({ error: "storedFilename erforderlich" });
  const filePath = path.join(UPLOAD_DIR, path.basename(storedFilename));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Datei nicht gefunden" });

  const permissivSchema = {
    type: "object",
    description: "Extrahiere alle steuer-relevanten Felder frei strukturiert. Benutze aussagekraeftige deutsche Keys. Schachtele nach Personen und Themen (Stammdaten, Einkuenfte, Vorsorge, Bank, usw.).",
    additionalProperties: true,
  };

  const t0 = Date.now();
  try {
    const ocr = await mistralOcr(filePath, originalName || storedFilename, permissivSchema, "QuickExtract");
    const ms = Date.now() - t0;
    const dokumentJson = ocr.annotation;
    if (!dokumentJson || typeof dokumentJson !== "object") {
      return res.status(502).json({ error: "Mistral-Permissive lieferte kein JSON", ms, raw_preview: (ocr.text || "").slice(0, 500) });
    }
    return res.json({
      dokument_json: dokumentJson,
      ms,
      annotation_bytes: Buffer.byteLength(JSON.stringify(dokumentJson), "utf8"),
      pages_count: (ocr.pages || []).length,
      text_preview: (ocr.text || "").slice(0, 2000),
      model: "mistral-ocr-latest",
    });
  } catch (e) {
    return res.status(502).json({ error: e.message, ms: Date.now() - t0 });
  }
});

app.post("/api/elster/full-map", async (req, res) => {
  // Default: Mistral Small — im Shootout produktiv beste Qualitaet pro Sekunde & Euro.
  // Fuer Premium/Schiedsgericht: explizit "claude-opus-4-7" uebergeben.
  const { dokument_json, storedFilename, model = "mistral-small-latest" } = req.body || {};
  if (!dokument_json || typeof dokument_json !== "object") {
    return res.status(400).json({ error: "dokument_json (Object) erforderlich" });
  }

  const katalog = baueKompaktKatalog();
  if (!katalog) return res.status(503).json({ error: "BMF-Katalog nicht geladen" });
  const userPrompt = baueShootoutUserPrompt(dokument_json, katalog);

  // Modell-Auswahl: Claude-Familie via runClaude, Mistral via runMistralChat
  const istClaude = /^claude-/i.test(model);
  const t0 = Date.now();
  try {
    let output, stop_reason, usage;
    if (istClaude) {
      const r = await runClaude(model, SHOOTOUT_SYSTEM_PROMPT, userPrompt, { maxTokens: 16384 });
      output = r.output; stop_reason = r.stop_reason; usage = r.usage;
    } else {
      const r = await runMistralChat(model, SHOOTOUT_SYSTEM_PROMPT, userPrompt, { maxTokens: 16384, responseFormat: { type: "json_object" } });
      output = r.output; stop_reason = r.finish_reason; usage = r.usage;
    }
    const ms = Date.now() - t0;
    const parsed = extrahiereJson(output);
    if (!parsed) {
      return res.status(502).json({
        error: `Mapper (${model}) lieferte kein parsebares JSON`,
        stop_reason, usage, ms,
        raw_preview: (output || "").slice(0, 500),
      });
    }
    const validiert = validiereShootoutMappings(parsed);
    return res.json({
      dokumenttyp: validiert?.dokumenttyp || parsed.dokumenttyp,
      elster_mappings: validiert?.mappings_gueltig || [],
      mappings_ungueltig: validiert?.mappings_ungueltig || [],
      ohne_zuordnung: validiert?.ohne_zuordnung || [],
      stats: validiert?.stats,
      ms, stop_reason, usage, model,
    });
  } catch (e) {
    return res.status(502).json({ error: e.message, ms: Date.now() - t0, model });
  }
});

// Cache-Inspektion (Playground-Debug)
app.get("/api/elster/cache", (_req, res) => {
  const entries = [];
  for (const [hash, v] of promptCache.entries()) {
    entries.push({ schema_hash: hash, ...v, hinweise_count: v.hinweise.length });
  }
  res.json({ count: entries.length, entries });
});

app.delete("/api/elster/cache", (_req, res) => {
  const n = promptCache.size;
  promptCache.clear();
  res.json({ cleared: n });
});

app.get("/api/uploads", async (_req, res) => {
  const files = await fsp.readdir(UPLOAD_DIR);
  const rows = await Promise.all(files.map(async f => {
    const st = await fsp.stat(path.join(UPLOAD_DIR, f));
    return { name: f, size: st.size, mtime: st.mtimeMs };
  }));
  rows.sort((a, b) => b.mtime - a.mtime);
  res.json({ files: rows });
});

app.listen(PORT, () => {
  console.log(`Mistral Playground on http://localhost:${PORT}`);
  console.log(`  MISTRAL_API_KEY: ${MISTRAL_API_KEY ? "set (" + MISTRAL_API_KEY.length + " chars)" : "MISSING"}`);
  console.log(`  ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY ? "set" : "missing"}`);
  console.log(`  OLLAMA_URL: ${OLLAMA_URL}`);
  if (elsterCatalog) baueCodeIndex();
});
