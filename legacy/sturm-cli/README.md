# STURM-Workflow `elster-v1` — Drop-in-Paket

Dieses Verzeichnis ist ein **Drop-in-Replacement** für `src/workflows/elster/`
im STURM-Repo. Vollständige Spec siehe `SPEC.md` (nach §5-Template aus
`WORKFLOW_TEMPLATE.md`).

## Was geliefert wird

```
sturm-workflow/
├── SPEC.md                                          ← Spec zum Drüberlesen
├── README.md                                        ← diese Datei
└── src/workflows/elster/                            ← direkt nach STURM kopieren
    ├── index.ts                                     Workflow + Stage-Registrierung
    ├── stages/
    │   ├── klassifizierung.ts                       Regex + LLM-Fallback
    │   └── extraktion.ts                            Per-Anlage Mistral-Chat, parallelisiert
    ├── lib/
    │   ├── mistral-chat.ts                          chatJson()-Wrapper, nutzt MISTRAL_API_KEY
    │   └── anlagen-katalog.ts                       loadKatalog() / loadFelder() mit Cache
    └── data/
        ├── anlagen.json                             35 Anlagen (VZ 2024, ERiC 42.4.4.0)
        └── felder/*.json                            35 Feldschemas (2569 Felder gesamt)
```

## Einchecken

Vom STURM-Repo-Root (Pfad anpassen):

```sh
# 1. Alten Workflow sichern (optional)
git mv src/workflows/elster src/workflows/elster.bak

# 2. Neuen Workflow kopieren
cp -r /Users/christophbertsch/mistral-ocr/sturm-workflow/src/workflows/elster \
      src/workflows/elster

# 3. Typecheck — muss grün sein
npx tsc --noEmit

# 4. Diff prüfen
git status
git diff --stat src/workflows/elster

# 5. Commit
git add src/workflows/elster
git rm -r src/workflows/elster.bak   # falls wirklich ersetzt
git commit -m "elster-v1: Replace with fast pipeline (regex-first classification, parallel per-Anlage extraction)"

# 6. Engine neu laden
pm2 restart sturm
pm2 logs sturm --lines 20 | grep -i elster

# 7. Smoke
curl -s https://sturm.0711.io/api/workflows/elster-v1 | jq .stages
open "https://sturm.0711.io/pipeline.html?workflow=elster-v1"
```

## Was unverändert bleibt

- `src/workflows/index.ts` — wir behalten die Exportnamen
  `registerElsterStages` und `buildElsterWorkflowWithSchema`, der Import dort
  muss nicht angefasst werden.
- `src/core/*` — keine Änderung
- `src/stages/mistral-ocr.ts` — wird weiter als generische Stage genutzt

## Was für den Speed-Gewinn sorgt

1. **Regex-first-Klassifizierung**: 80–90% der Läufe brauchen kein LLM —
   Regex-Match gegen Drucktexte reicht (<50 ms statt 1–2 s für einen
   LLM-Call).
2. **Per-Anlage-Parallelität**: Extraktion läuft mit `concurrency: 3`. Bei 6
   erkannten Anlagen statt 6× sequenziell → 2 Runden parallel = ~3× schneller.
3. **Ein einziger OCR-Call**: nicht pro Anlage erneut. Der OCR-Output (`text`)
   wird von Klassifizierung und Extraktion gemeinsam genutzt.
4. **`mistral-small-latest` statt groß**: sowohl Klassifizierung als auch
   Extraktion laufen auf dem kleinen Modell mit `temperature: 0`.

## Voraussetzungen auf der STURM-Seite

- `MISTRAL_API_KEY` in der Engine-Env gesetzt (wird von der bestehenden
  `mistral-ocr`-Stage auch schon genutzt → sollte da sein).
- Generische Stage `mistral-ocr` registriert (Default in STURM).
- Node kann JSON-Imports nicht per `import`-Statement lesen — wir lesen die
  Daten-JSONs deshalb per `readFile` in `lib/anlagen-katalog.ts`. Die
  `data/`-Dateien müssen mitkopiert werden (kein Bundle-Schritt nötig).

## Rollback

Wenn was schiefgeht:

```sh
git mv src/workflows/elster src/workflows/elster.new
git mv src/workflows/elster.bak src/workflows/elster
pm2 restart sturm
```

## Smoke-Test (manuell)

Nach dem Deploy:

```sh
# Bekannte Einkommensteuer-PDF hochladen
curl -F "file=@tests/fixtures/est_2024_sample.pdf" \
     https://sturm.0711.io/api/workflows/elster-v1/runs

# Antwort enthält runId
curl https://sturm.0711.io/api/runs/<runId>/_result.json | jq .state
# → "ok"

# Erkannte Anlagen
curl https://sturm.0711.io/api/runs/<runId>/klassifizierung/output.json | jq .erkannte_anlagen

# Felder für Anlage N
curl https://sturm.0711.io/api/runs/<runId>/extraktion/output.json | jq '.per_anlage.N.values'
```

## Offen

- Keine Tests im Paket (STURM-Repo hat wahrscheinlich eigene Test-Konventionen
  — die kenne ich nicht, bitte bei Bedarf anpassen).
- `data/felder/*.json` enthält alle Spalten aus der ELSTER-Jahresdokumentation,
  nicht nur die für den Prompt gebrauchten. Kann später verschlankt werden,
  falls Repo-Größe stört (aktuell ~2 MB).
