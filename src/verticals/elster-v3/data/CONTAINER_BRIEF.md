# ELSTER-Container Agent-Brief

**Container-ID:** `0711:elster:bmf:jahresdok-2024:v1`
**Quelle:** BMF Jahresdokumentation 10/2024 (`Jahresdokumentation_10_2024 1.xml`)
**Inhalt:** 2287 ELSTER eCodes über 35 Anlagen, BMF primary-source, trust_level=verified
**Schwester-Container (Embeddings):** `0711:elster:gemma4-tq:embeddings:v1` —
EmbeddingGemma-300m + Matryoshka×TurboQuant-Kaskade

Dieses Dokument wird beim Start jedes LLM-Calls als erster Prompt-Block
geladen. Du musst es einmal lesen, danach wirst du die anderen Daten
(atoms.json, paragraph_estg.json, disambiguation_hints.json) korrekt
interpretieren können.

---

## 1. Atom-Schema — was jedes Element im Container hat

Jedes der 2287 Atome beschreibt **genau ein ELSTER-Feld**:

| Feld | Bedeutung | Beispiel |
|---|---|---|
| `field_name` | Der eCode — kanonischer Schlüssel | `E0200201` |
| `value` (Bezeichnung) | Name aus dem BMF-XML | `"Bruttoarbeitslohn"` |
| `metadata.drucktext` | Wie das Feld auf dem Vordruck gedruckt steht | `"Bruttoarbeitslohn"` |
| `metadata.anlage` | ELSTER-Vordruck (Anlage N/SA/R/KAP/V/G/S/L/VOR/Kind/AgB/HA_35a/AV/ESt1A/…) | `"N"` |
| `metadata.datentyp` | `"string"` \| `"date"` \| `"currency"` | `"currency"` |
| `metadata.formatRegex` | ELSTER-Submission-Format-Regex (nach Normalisierung) | `^(?=.{1,12}$)…\d{1,12}$` |
| `metadata.formatkennzeichen` | BMF-Kompakt-Typ: N (number), D (date), X (string) | `"N"` |
| `metadata.maxLaenge` / `minLaenge` | Längen-Grenzen nach Normalisierung | `12` / `1` |
| `metadata.pflicht` | Muss in der Steuererklärung gefüllt sein? | `false` |
| `metadata.vordruckzeile` | Zeile auf dem offiziellen Vordruck (Rechts-Zitat-Anker) | `"5"` |
| `metadata.kontextPaths` | BMF-Aufwandsblöcke — *die Einkunftsart-Taxonomie* | `["ArbL/LStB_1_5_Sum"]` |
| `citation_document` | Quell-XML | `"Jahresdokumentation_10_2024 1.xml"` |
| `citation_section` | Sektion im XML | `"N - Felder"` |
| `trust_level` | `"verified"` für BMF primary-source | `"verified"` |

## 2. §EStG-Framework — wie kontextPaths zu Steuerrecht mappen

Der **Prefix vor dem ersten `/` in `kontextPaths[0]`** ist die kanonische
BMF-Bezeichnung der Einkunftsart bzw. des Aufwandsblocks. Wir verwenden DIESE
Prefixes — kein paralleles Enum.

**Beispiele für die häufigsten Prefixes:**

| Prefix | Bedeutung | §EStG | Anlagen |
|---|---|---|---|
| `ArbL` | Arbeitslohn | §19 Abs.1 Nr.1 | N |
| `Wk` | Werbungskosten | §9 | N, R, V |
| `Leibr_gesetzl` | gesetzliche Leibrente (DRV) | §22 Nr.1a EStG | R |
| `Leibr_priv` | private Leibrente | §22 Nr.1a aa EStG | R |
| `KapErt_inl_StAbz` | KapErt mit inländ. Steuerabzug | §20 i.V.m. §43 | KAP |
| `Obj` / `Einn` | V&V-Objekt / Einnahmen | §21 | V, V_FeWo |
| `Gewinn` | Gewinneinkünfte | §13/§15/§18 | G, S, L |
| `AVor` | Altersvorsorge | §10 Abs.1 Nr.2 | VOR, AV |
| `Beitr_g_KV_PV_Inl` | Basis-KV/PV Inland | §10 Abs.1 Nr.3 | VOR |
| `KiSt` | Kirchensteuer | §10 Abs.1 Nr.4 | SA |
| `Zuw` | Zuwendungen / Spenden | §10b | SA |
| `KBK` | Kinderbetreuungskosten | §32 Abs.6 | Kind |
| `EfA` | Entlastungsbetrag Alleinerziehende | §24b | Kind |
| `And_Aufw` | außergewöhnliche Belastungen (allg.) | §33 | AgB |
| `Beh` / `Pflege_PB` / `Hinterbl` | Behinderten- / Pflege- / Hinterbliebenen-Pauschbetrag | §33b | AgB |
| `St_Erm` | Steuerermäßigung (haushaltsnah/Handwerker) | §35a | HA_35a |
| `DHHF` | doppelte Haushaltsführung | §9 Abs.1 Nr.5 | N |

**Vollständige Tabelle:** `paragraph_estg.json` (im Container neben dieser Datei).

## 3. Konventionen für die Extraktion

1. **Wert-Normalisierung** vor Regex-Validierung:
   - `currency`: deutsche Notation `1.234,56 €` → ganzzahlige Cents `123456` (Vorzeichen bleibt erhalten).
   - `date`: ISO `2024-12-31` → DE `31.12.2024`. DE-Format wird durchgereicht.
   - `string`: nur trimmen.
2. **Pflicht-Felder** der erwarteten Anlagen **MÜSSEN** befüllt sein wenn im Beleg vorhanden. Wenn sie fehlen → flag als `pflicht_fehlt`.
3. **eCodes niemals erfinden.** Wenn ein Wert keinem Atom zugeordnet werden kann → flag als `unbekannt`. Hallucinated codes brechen die downstream-Anchoring-Kette.
4. **Drucktext ist die kanonische Bezeichnung** für UI/Reviewer — nicht `value` (Bezeichnung) oder field_name (Maschinen-ID).

## 4. Klassifikations-Hinweise pro Belegart

Manche docClass-spezifischen Entscheidungen sind NICHT im atoms.json encodiert
(z.B. Mapping von "LBV NRW" auf `arbeitgeber.art="versorgungstraeger"`). Diese
Hinweise liegen separat in `disambiguation_hints.json`:

- `lohnsteuerbescheinigung` — arbeitgeber.art, arbeitnehmer.konfession
- `spendenquittung` — spenden[].art
- `pension_versorgung` — behandle wie lohnsteuerbescheinigung

## 5. Wie der Workflow dich aufruft

Du läufst innerhalb der elster-v3 Pipeline. Was vor dir passiert ist:

1. **OCR-Fan-out**: mistral-ocr + lighton-ocr + paddleocr-vl
2. **OCR-consensus-merge**: semantische Line-Alignment + confidence-vote
3. **Klassifizierung** (Mistral-Small): liefert `dokumenttyp_id`, `anlagen[]`, `ecodeHintsProAnlage`
4. **quantum-ground**: holt Pflicht-Atome der Anlagen als Scaffold + Cascade-Treffer auf OCR-Phrasen → `kandidatenECodes[]` mit voller Atom-Metadata
5. **DU** (Layer 1): extrahierst nested JSON nach Schema, MUSST die Kandidaten-eCodes bevorzugen
6. **retrieval-verify**: validiert deine Output gegen Cascade + formatRegex + pflicht — emittiert `verdaechtigeFelder[]`
7. **Layer 2 / Rules**: Entity-Resolve + deterministische Projektion

Du bekommst in deinem Prompt:
- Diesen Brief
- Den steuerrechtlichen Rahmen (Anlagen + Einkunftsarten via paragraph_estg)
- Die Kandidaten-eCodes gruppiert nach Anlage (mit ALLEN Metadaten-Spalten)
- Klassifikations-Hinweise (aus disambiguation_hints.json)
- KPI-Hints (falls Mistral-Small welche aus dem Dokument extrahiert hat)
- Das strict json_schema (über response_format=json_schema)
- Den OCR-Volltext

## 6. Output-Erwartung

Du gibst nested JSON nach `schemaName.json` zurück (siehe Anlagen-spezifische
nested_schemas/ im selben Container-Verzeichnis). vLLM/Mistral garantieren
Schema-Compliance via strict-mode response_format.

Wenn du **unsicher** bist welcher eCode passt, lass das Feld lieber leer und
verlass dich auf retrieval-verify zur Eskalation. Falsche eCodes sind teurer
als fehlende.

---

**Versionierung:** dieser Brief ist Teil des Containers und wird über
`container.json.merkle_root` mit-signiert. Änderungen → Container-Bump.
