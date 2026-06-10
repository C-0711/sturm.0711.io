# Elster-Quantum Extraktions-Workflow

Generischer Workflow, der **beliebige Steuer-Belege/Rechnungen** gegen den
ELSTER-Quantum-Container matcht und für jedes Feld liefert:

- **Elster eCode** (`E0200201`, …)
- **Drucktext** (kanonische Bezeichnung)
- **Bezeichnung** (BMF-XML-Wert)
- **Anlage** (N, KAP, SA, …)
- **Wert vom Beleg** (rohe OCR-Form)
- **Normalisierter Wert** (cents / int / `TT.MM.JJJJ` / string)
- **Vordruckzeile**
- **Range / Regex** (`minLaenge`, `maxLaenge`, `formatRegex`)
- **§EStG-Paragraph** (über `paragraph_estg.json`-Mapping)
- **Quelle** (Datei + Zeilennummer im OCR-Text)
- **Alternativen** (gleichwertige eCodes mit identischem Drucktext im selben
  Anlagen-Kontext werden als `alternatives[]` aufgelistet, statt sie als
  separate Treffer zu emittieren)

## Wichtig

Nichts ist hardcoded: keine Werte, keine Belegtypen, keine Steuerzahler-Daten.
Das Skript kennt nur das, was im Container steht (atoms.json, paragraph_estg.json,
disambiguation_hints.json). Belege werden ausschließlich über OCR + Container-Index
extrahiert.

## Aufruf

```bash
python3 elster_extract.py \
  --container <pfad/zum/container_ordner> \
  --input     <pfad/zum/belege_ordner> \
  --out       <pfad/zum/ausgabe_ordner>
```

- `--container` muss `atoms.json` enthalten (optional `paragraph_estg.json`,
  `disambiguation_hints.json`, `container.json`).
- `--input` darf beliebig viele `.pdf`, `.jpg`, `.jpeg`, `.png`, `.tif`,
  `.tiff`, `.bmp` enthalten. Der Container-Ordner wird automatisch
  ausgeschlossen, falls er innerhalb von `--input` liegt.
- `--out` wird angelegt; enthält danach:
  - `ocr/` — Roh-OCR-Output pro Datei
  - `hits/<beleg>.hits.json` — Treffer pro Beleg
  - `REPORT.md` — aggregierter Markdown-Report pro Anlage
  - `REPORT.json` — maschinenlesbar (alle Treffer + Container-Meta)

## Abhängigkeiten

```
brew install poppler tesseract tesseract-lang
```

(stellt `pdftotext`, `pdftoppm`, `tesseract` mit `deu+eng` zur Verfügung)

## Pipeline-Stufen (alle aus dem Container gespeist)

1. **Container laden** — atoms, §EStG-Mapping, Klassifikations-Hinweise.
2. **Index bauen** — pro Atom Such-Tokens aus `metadata.drucktext` + `value`
   (normalisiert: lowercased, Diakritika entfernt, Whitespace kollabiert).
3. **OCR** — PDF: `pdftotext -layout`, Fallback `pdftoppm` + `tesseract`.
   Bilder: `tesseract -l deu+eng`.
4. **Anlagen-Kontext-Tracking** — `Anlage X` in Headings setzt sticky
   `current_anlage`. Treffer werden bevorzugt aus dieser Anlage gezogen.
5. **Label-Matching** — pro OCR-Zeile alle Atom-Labels als Teilstring suchen,
   längster Label-Treffer gewinnt. Generische Labels (`Summe`, `Betrag`, …)
   nur mit Anlagen-Kontext akzeptieren.
6. **Wert-Extraktion** — datentyp-abhängig:
   - `currency` mit Komma-Regex → Cents
   - `currency` ohne Komma im formatRegex → Ganzzahl
   - `date` → `TT.MM.JJJJ` normalisiert
   - `string` → roh + getrimmt
7. **Regex-Validierung** — Wert muss `metadata.formatRegex` matchen,
   sonst Treffer verworfen (Halluzinations-Stop).
8. **Deduplizierung + Alternatives-Gruppierung** —
   gleiche (drucktext, anlage, wert, zeile) → erstem Treffer als
   `alternatives[]` angehängt.
9. **Report** — Markdown nach Anlagen gruppiert + JSON für nachgelagerte
   Pipelines (retrieval-verify, Rules-Engine).

## Beispiel-Ausgabe (Auszug)

```
| eCode (Alt.)                      | Drucktext                      | Wert (Beleg) | Normalisiert | Range/Regex                        | §EStG                  |
| `E0200501` · alt: `E0200502`, …   | Kirchensteuer des Arbeitnehmers| 302,37       | 30237 (cents)| len 4–15 `…\d{1,12}(,\d{2,2})$`    | §19 Abs.1 Nr.1 EStG    |
| `E0203503`                        | aufgesucht an Tagen            | 220          | 220 (int)    | len 1–3 `\d{1,3}$`                 | §9 EStG (Werbungskosten)|
| `E0500701`                        | Geburtsdatum                   | 27.05.1963   | 27.05.1963   | `\d\d\.\d\d\.\d\d\d\d`             | §32 EStG (Kind-Angaben) |
```

## Erweiterungspunkte (nicht implementiert)

- Cascade-Lookup über `embeddings.gemma4.*` für unscharfe OCR-Phrasen
  (für seltene Drucktexte, die per Substring nicht treffen).
- Layer-1-Output gegen `nested_schemas/*.json` per strict json_schema
  (z.B. `lohnsteuerbescheinigung_extraction`) — der Markdown-Report ersetzt
  das nicht, sondern liefert die rohen eCode-Treffer als Ground Truth.
- Disambiguierung mehrerer Atome mit identischem Drucktext+Anlage über
  `vordruckzeile`-Heuristik (Zeilenzahl im OCR-Output abgleichen).
