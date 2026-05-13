# Whole-Eye Operating System (0711 × OCULUS) — Sprint-Ready Task-Katalog

**Stand**: 2026-05-13
**Scope**: 24-Monats-Umsetzungsplan zur Transformation der bestehenden 0711-STURM-Workflow-Engine in das Whole-Eye OS (8-Schichten-Architektur L0–L7, MDR Klasse IIa/IIb/III, IEC 62304 Klasse A/B/C).
**Anker**: Whitepaper §1–§6. Diese Liste verfeinert §5 (Arbeitspakete 1–4) und ergänzt sie um Querschnitts-, Test-, Regulatorik-, DevSecOps-, Datenmanagement- und Go-to-Market-Pakete.

---

## Lese-Konventionen

| Feld | Bedeutung |
|---|---|
| **ID** | `WE-<WP>.<Task>` — eindeutig, Jira-fähig |
| **L** | Architektur-Schicht (L0–L7) |
| **62304** | IEC 62304 Sicherheitsklasse (A / B / C) |
| **MDR** | EU-MDR-Risikoklasse (—, I, IIa, IIb, III) |
| **Sprint** | S1…S24 (je 1 Monat), Meilenstein M1–M8 |
| **Deps** | Vorgänger-Task-IDs |
| **DoD** | Definition of Done (zusätzlich zu Akzeptanzkriterien) |

**Querschnitts-DoD für alle Tasks**:
1. Code review durch ≥1 Senior-Engineer.
2. Unit-Coverage ≥80 % (Klasse A/B) bzw. ≥95 % + MC/DC für Klasse C.
3. Trace-Link Jira-ID ↔ Commit ↔ Test (siehe WE-9.2).
4. Eintrag im Risk-Management-Akte (ISO 14971).
5. Dokumentation in `/docs/architecture/<layer>/<task-id>.md`.

---

## Meilenstein-Übersicht (24-Monats-Raster)

```
2026                                  2027                                  2028
  Q3        Q4        Q1        Q2        Q3        Q4        Q1        Q2        Q3
  S1-S3     S4-S6     S7-S9     S10-S12   S13-S15   S16-S18   S19-S21   S22-S24
   [M1]      [M2]      [M3]      [M4]      [M5]      [M6]      [M7]      [M8]
  Pilot    MDR-Sub   Beta-1    Pharma-P   1k-Prx   BreakEv   US-Pilot  Reimburs
   3 Prx    Atlas-KC  L4 KC/    L5-API    Atlas-    EBITDA    FDA       EBM-Z /
            Notif.B.  Myopia    +Atlas-   Glauc/    +0/SaaS   gRPC      CPT-AI
                      Beta      DryEye    DryEye    deckt    +ISO       AuditAaS
                                          Beta      OpEx      13485
```

---

# Arbeitspaket 1 — Device Connectors & Ingestion (L1)

**Ziel**: Universeller Capture-Gateway für 6 ophthalmologische Domänen (Cornea-Tomography, Refraktiv-Wave, Topographie, Myopia-Length, Perimetrie, Dry-Eye/Meibo) mit ≤150 LoC pro neuem Gerätemodell.

| ID | Titel | L | 62304 | MDR | Sprint | Deps |
|---|---|---|---|---|---|---|
| **WE-1.1** | gRPC/REST Multi-Domain Ingestion-Endpoint (`POST /v1/ingest/scan`) | L1 | B | IIa | S1 | — |
| **WE-1.2** | `chain.scan`-Schema-Migration mit `domain` ENUM (6 Werte) | L1/L3 | B | IIa | S1 | — |
| **WE-1.3** | Plugin-SDK „150-LoC-Connector-Contract" (TypeScript-Interface + Codegen-Template) | L1 | A | — | S2 | WE-1.1 |
| **WE-1.4** | Connector: Pentacam HR / AXL Wave (Cornea-Tomography) | L1 | B | IIa | S2 | WE-1.3 |
| **WE-1.5** | Connector: Keratograph 5M (Topographie + Meibo + TF-Scan) | L1 | B | IIa | S3 | WE-1.3 |
| **WE-1.6** | Connector: Myopia Master (axiale Länge + Refraktion) | L1 | B | IIb | S3 | WE-1.3 |
| **WE-1.7** | Connector: Easyfield / Octopus-Perimeter (Gesichtsfeld) | L1 | C | IIb | S4 | WE-1.3 |
| **WE-1.8** | Connector: BIOM (Vitreoretinal-OP-Visualisierung) | L1 | B | IIa | S5 | WE-1.3 |
| **WE-1.9** | JSON/XML-Schema-Repo pro Domäne (versioniert, signiert) | L1 | B | IIa | S2 | WE-1.1 |
| **WE-1.10** | Lokales Capture-Tool (Windows-MSI, Watch-Folder, Auto-Upload) | L1 | B | IIa | S3 | WE-1.4, WE-1.5 |
| **WE-1.11** | Backpressure + Resume-Upload bei DSL-Abriss (S3-Multipart-Pattern) | L1 | B | IIa | S6 | WE-1.10 |
| **WE-1.12** | Lasttest: 1.000 parallele Praxen × 50 Scans/Tag (k6-Suite) | L1 | B | — | S7 | WE-1.10 |

## Task-Details (Auswahl)

### WE-1.1 — Multi-Domain Ingestion Endpoint
**Kontext**: §5.1 Task 1.1. Erweiterung der bestehenden `src/server.ts`-Route auf Multi-Domain.
**Akzeptanzkriterien**:
- `POST /v1/ingest/scan` (multipart): `metadata` (JSON) + `payload` (binary) + Header `X-Device-Domain ∈ {cornea_tomography, refractive_wave, topography, myopia_length, perimetry, dry_eye}`.
- Schema-Validator pro Domäne → bei Verstoß `422` mit `error_signature_id`.
- UUIDv4-Scan-UID + SHA-256-Payload-Hash + Event auf Kafka-Topic `ingest.scan.received`.
- p95 Latenz ≤ 200 ms bei 5 MB Payload.
**Regulatorik**: MDR GSPR 14.5 (Interoperabilität), IEC 62304 §5.5 Coverage ≥90 %.
**DoD**: OpenAPI-Spec in `schemas/ingest.openapi.yaml` signiert via GitChain (WE-2.1).

### WE-1.2 — `chain.scan` ENUM + FK auf `chain.audit_trail`
**SQL-DDL**:
```sql
CREATE TYPE chain.domain_t AS ENUM (
  'cornea_tomography','refractive_wave','topography',
  'myopia_length','perimetry','dry_eye'
);
ALTER TABLE chain.scan
  ADD COLUMN domain chain.domain_t NOT NULL,
  ADD COLUMN audit_block_hash bytea NOT NULL
    REFERENCES chain.audit_trail(block_hash);
CREATE INDEX idx_scan_domain_ts ON chain.scan(domain, ingestion_timestamp DESC);
```
**Akzeptanz**: Insert-p95 ≤ 30 ms bei 1.000 parallelen Verbindungen (pgbench-Profil mitliefern).

### WE-1.3 — 150-LoC-Connector-Contract
**Plugin-Interface** (`src/verticals/oculus/connectors/contract.ts`):
```ts
export interface OculusConnector<RawT, NormT> {
  domain: Domain;
  deviceModel: string;
  parse(raw: Buffer): RawT;            // hersteller-spezifisch
  normalize(raw: RawT): NormT;          // Atlas-kanonisch
  validate(norm: NormT): ValidationResult;
  schemaVersion: string;                // semver, signiert
}
```
**Akzeptanz**: Referenz-Connector (Pentacam) in 142 LoC; CI-Job `lines-per-connector` schlägt bei >150 fehl (`scripts/check-connector-budget.sh`).

---

# Arbeitspaket 2 — Kryptographische Fundierung (L0, L2, L2.5)

**Ziel**: Zero-Knowledge-Provenance + WebAuthn-Patient-Consent + automatisierter Audit-Trail. Aufbauend auf bestehender GitChain-Integration (`src/lib/gitchain-client.ts`, siehe `GITCHAIN-INTEGRATION-NOTES.md`).

| ID | Titel | L | 62304 | MDR | Sprint | Deps |
|---|---|---|---|---|---|---|
| **WE-2.1** | `gitchain-indexer`-Daemon (Rust): Ed25519-Sig + RFC-3161-TSA | L0 | B | IIa | S2 | — |
| **WE-2.2** | Merkle-Verkettungs-Block: `H_n = SHA256(H_{n-1} ‖ H_payload ‖ T_RFC3161)` | L0 | B | IIa | S2 | WE-2.1 |
| **WE-2.3** | `GET /v1/audit/verify/{scan_uid}` — Kettenintegritäts-Endpoint | L0 | B | IIa | S3 | WE-2.2 |
| **WE-2.4** | SOC-Alert-Pipeline bei Tamper-Evidence (PagerDuty + SIEM) | L0 | B | IIa | S4 | WE-2.3 |
| **WE-2.5** | WebAuthn-Consent-Gateway `POST /v2/consent/authorize` | L2 | B | IIa | S3 | — |
| **WE-2.6** | Scoped JWT (RS256) mit `scope: read:<domain>` | L2 | B | IIa | S4 | WE-2.5 |
| **WE-2.7** | Dynamic-Consent-UI (Patient-Portal: Widerruf, History, Scope-Auswahl) | L2 | A | IIa | S5 | WE-2.6 |
| **WE-2.8** | Consent-Revocation-Propagation (Token-Blacklist + Cache-Invalidate) | L2 | B | IIa | S6 | WE-2.6 |
| **WE-2.9** | Audit-v2 GitChain-Replikation auf 2 unabhängige Geo-Sites | L2.5 | B | IIa | S7 | WE-2.2 |
| **WE-2.10** | HSM-Integration (AWS CloudHSM / Thales) für Geräte-Signaturschlüssel | L0/L1 | B | IIa | S5 | WE-2.1 |
| **WE-2.11** | FIPS-140-3-validierte Krypto-Bibliotheks-Audit (BoringSSL-FIPS) | L0–L4 | B | IIa | S6 | WE-2.10 |
| **WE-2.12** | PHI/PII-Leak-Scanner als Pre-Commit-Hook (Regex + Entropie + Named-Entity) | L0 | A | — | S2 | — |

### WE-2.1 — `gitchain-indexer`-Daemon
**Implementierungspfad**: Erweiterung der bestehenden `src/core/artifacts-gitchain.ts` um separaten Worker (`packages/gitchain-indexer/`, Rust, da Performance-kritisch und Speichersicherheit für sensitive Krypto-Ops).
**Akzeptanz**:
- Kafka-Topic `ingest.scan.received` → Ed25519-Sig über `{scan_uid, payload_hash, device_serial, timestamp}` mit Geräte-Private-Key (HSM-gestützt).
- RFC-3161-Timestamp von qualifizierter TSA (z. B. Bundesdruckerei oder GlobalSign).
- Throughput ≥ 500 Blocks/s auf c5.2xlarge.
- Backup-TSA-Failover (3 Anbieter) — TSA-Single-Point-of-Failure ist Bug.

### WE-2.5 — WebAuthn FIDO2 Consent Gateway
**Akzeptanz**:
- Server validiert `authenticatorData`, `clientDataJSON`, `signature` gegen registrierte CredentialID.
- JWT-Token TTL ≤ 5 min, Scope-Granularität pro Domäne (`read:cornea_tomography`).
- Revoke-Endpoint `DELETE /v2/consent/{credential_id}` propagiert in ≤ 1 s an alle L3-Atlas-Replicas.
- Negative-Test: Abfrage ohne Token → 403; mit abgelaufenem Token → 401; mit Wrong-Scope → 403.
**Regulatorik**: DSGVO Art. 7 (Widerruf), HIPAA §164.508, MDR GSPR 17.2.

---

# Arbeitspaket 3 — Atlas Datalake (L3)

**Ziel**: Modalitätenübergreifender, versionierter Längsschnitt-Datensatz „Atlas Patient Profile" über 6 Domänen × Patient-Lifetime (12–80 J.).

| ID | Titel | L | 62304 | MDR | Sprint | Deps |
|---|---|---|---|---|---|---|
| **WE-3.1** | Object-Store-Layout (S3 / MinIO): `s3://atlas/<tenant>/<patient_pseudo>/<domain>/<scan_uid>` | L3 | B | IIa | S3 | WE-1.2 |
| **WE-3.2** | AES-256-GCM at-rest mit HSM-verwalteten DEK/KEK (Envelope) | L3 | B | IIa | S4 | WE-2.10 |
| **WE-3.3** | Atlas-Patient-Profile-View (Postgres-Materialized-View, refresh on insert) | L3 | B | IIa | S5 | WE-3.1 |
| **WE-3.4** | Kanonisches Daten-Modell pro Domäne (z. B. `cornea_topography_v1.proto`) | L3 | B | IIa | S4 | WE-1.9 |
| **WE-3.5** | Time-Travel-Query: „alle Pentacam-Scans Patient X 2020–2026" mit ETag-basiertem Caching | L3 | A | — | S6 | WE-3.3 |
| **WE-3.6** | Patient-Re-Linking-Service (HMAC-SHA-256 mit per-tenant Pepper) | L3 | C | IIb | S5 | WE-3.1 |
| **WE-3.7** | Schema-Evolution-Migrationen mit Rückwärtskompatibilität (Buf / Protobuf-Breaking-Check) | L3 | B | IIa | S7 | WE-3.4 |
| **WE-3.8** | Cold-Storage-Tiering (Scans > 7 Jahre → S3 Glacier mit `legal_hold`) | L3 | A | — | S12 | WE-3.1 |
| **WE-3.9** | DICOM-Konformer Export (DICOMweb QIDO/WADO) für Klinik-PACS-Anbindung | L3 | B | IIa | S10 | WE-3.4 |
| **WE-3.10** | FHIR-R4-Mapping `Observation` + `ImagingStudy` für KIS-Integration | L3 | B | IIa | S11 | WE-3.4 |

---

# Arbeitspaket 4 — SaMD Inference Runtime (L4)

**Ziel**: Isolierte, zustandslose KI-Inferenz für 6 Atlas-Module mit Safe-State, MC/DC-Coverage und Model-Lifecycle-Management. **Höchste Risikoklasse — alle Tasks IEC 62304 Klasse C wenn nicht anders markiert.**

| ID | Titel | L | 62304 | MDR | Sprint | Deps |
|---|---|---|---|---|---|---|
| **WE-4.1** | Kubernetes-Namespace `samd-inference-zone` mit NodeAffinity + NetworkPolicy | L4 | C | IIb | S4 | — |
| **WE-4.2** | gRPC-Inference-Service-Template (Python + ONNX-Runtime + TensorRT) | L4 | C | IIb | S5 | WE-4.1 |
| **WE-4.3** | `Safe-State-Safeguard`-Interceptor (Sanity-Check, Timeout 1500 ms, NaN/Inf-Guard) | L4 | C | IIb | S5 | WE-4.2 |
| **WE-4.4** | Model-Registry mit Signatur-Verifikation (Sigstore / cosign) | L4 | B | IIa | S6 | — |
| **WE-4.5** | A/B-Shadow-Inference (neues Modell läuft parallel, Antwort nicht zum Patienten) | L4 | B | IIa | S8 | WE-4.2 |
| **WE-4.6** | Model-Drift-Monitor (Population-Drift-PSI + Concept-Drift-KL) | L4 | B | IIa | S9 | WE-4.5 |
| **WE-4.7** | Pay-per-Scan-Metering (Stripe-Usage-Records, idempotent) | L4 | A | — | S10 | WE-4.2 |
| **WE-4.8** | **Atlas-KC** (Keratokonus-Score) Inferenz | L4 | C | IIa | S6 | WE-4.3, WE-1.4 |
| **WE-4.9** | **Atlas-IOL** (Intraokularlinsen-Berechnung) Inferenz | L4 | C | **IIb** | S8 | WE-4.3, WE-1.4 |
| **WE-4.10** | **Atlas-Myopia** (Progressions-Prädiktion) Inferenz | L4 | C | IIb | S9 | WE-4.3, WE-1.6 |
| **WE-4.11** | **Atlas-DryEye** (Tränenfilm-Score) Inferenz | L4 | C | IIa | S10 | WE-4.3, WE-1.5 |
| **WE-4.12** | **Atlas-Glaucoma** (Gesichtsfeld-Progression) Inferenz | L4 | C | **IIb** | S11 | WE-4.3, WE-1.7 |
| **WE-4.13** | **Atlas-VitreoRetinal** (Chirurgie-Decision-Support) Inferenz | L4 | C | **III** | S15 | WE-4.3, WE-1.8 |
| **WE-4.14** | Klinisches UI-Pattern für „Safe-State"-Anzeige (Rot-Banner, Manual-Override-Log) | L4 | B | IIa | S6 | WE-4.3 |
| **WE-4.15** | Inference-Audit-Log mit Eingangs-Hash + Modell-Version + Output-Hash | L4 | C | IIb | S6 | WE-2.1 |

### WE-4.3 — Safe-State-Safeguard (kritischer Pfad)
**Verbindlich für alle Klasse-C-Module**:
- gRPC-Interceptor in `samd-inference-zone` fängt alle Responses ab.
- Sanity-Checks: `score ∈ [0,1]`, kein NaN/Inf, Konfidenz vorhanden, Modell-Version matched Registry.
- Timeout 1500 ms (konfigurierbar pro Modul) → Pipeline-Abbruch.
- Bei Fail: strukturierte Fehler-Response + UI zeigt „Berechnung abgebrochen — manuelle klinische Überprüfung erforderlich" + persistenter Eintrag in `safety_event_log`.
- 15-Tages-MDR-Vigilance-Trigger automatisch (Email + Ticket an QM).
**MC/DC-Coverage**: 100 % verpflichtend, Nachweis als Artefakt im Release-Build.

### Class-C-Entwicklungs-Vorgaben (gelten für WE-4.8 bis WE-4.13)
1. Detailliertes Design-Dokument pro Software-Unit (`docs/architecture/L4/<module>/design.md`).
2. 100 % MC/DC-Code-Coverage (gcovr / coverage.py mit `--branch` + manuelles MC/DC-Review).
3. Unabhängiges Test-Team (nicht Implementierungs-Team).
4. Modell-Validierung gegen Held-Out-Klinikkohorte ≥ 1.000 Patienten pro Pathologie.
5. Clinical-Evaluation-Plan (MEDDEV 2.7/1 rev.4) + statistischer Plan signiert vor Datenerhebung.
6. Re-Validierung bei jedem Model-Update (kein Continuous-Training in Prod).

---

# Arbeitspaket 5 — Pharma Data Marketplace (L5)

**Ziel**: B2B-Data-API mit garantierter De-Identifikation und Lizenz-Enforcement.

| ID | Titel | L | 62304 | MDR | Sprint | Deps |
|---|---|---|---|---|---|---|
| **WE-5.1** | `GET /v1/marketplace/rwe/query` mit ABAC + mTLS-Client-Zert | L5 | B | — | S10 | WE-3.3 |
| **WE-5.2** | HIPAA-18-Identifier-Stripper (Safe-Harbor-Method) | L5 | B | — | S10 | WE-5.1 |
| **WE-5.3** | Geburtsdatum → Alter@Scan-Transformation (Edge-Cases <2 J., >89 J.) | L5 | B | — | S10 | WE-5.2 |
| **WE-5.4** | HMAC-SHA-256-Pseudonymisierung mit Per-Customer-Salt | L5 | B | — | S10 | WE-5.2 |
| **WE-5.5** | Rate-Limit 100 records / query + täglich-Quota pro API-Key | L5 | A | — | S10 | WE-5.1 |
| **WE-5.6** | k-Anonymity-Guard (k≥5) auf Query-Ergebnissen, sonst 451-Response | L5 | B | — | S11 | WE-5.2 |
| **WE-5.7** | Lizenz-Server: Vertrags-Scope-Modell (Domäne × Region × Zeitfenster) | L5 | A | — | S11 | — |
| **WE-5.8** | Audit-Log jeder externen Abfrage (DSGVO Art. 30 VVT) | L5 | B | — | S10 | WE-2.2 |
| **WE-5.9** | Customer-Onboarding-Workflow (DUA-Signatur, BAA, Pen-Test-Nachweis) | L5 | A | — | S12 | — |
| **WE-5.10** | Pharma-Sandbox-Tenant mit synthetischen Daten (für Trial-Phase) | L5 | A | — | S11 | WE-5.1 |

---

# Arbeitspaket 6 — Academy + Tender (L6, L7)

**Ziel**: Niedrig-regulierte Ökosystem-Module, strikt segregiert von L3/L4 (IEC 62304 §5.3).

| ID | Titel | L | 62304 | MDR | Sprint | Deps |
|---|---|---|---|---|---|---|
| **WE-6.1** | Academy-Frontend (React, Stateless, eigener K8s-Namespace) | L6 | A | — | S7 | — |
| **WE-6.2** | CME-Zertifikats-Issuer mit qualifizierter Signatur | L6 | A | — | S8 | — |
| **WE-6.3** | Industrie-Sponsoring-Tracking (Compliance: §32 Heilberufekammer-G) | L6 | A | — | S9 | — |
| **WE-6.4** | Pentacam-Gold-Status-Workflow (Prüfung, Wiederholung, Verfall) | L6 | A | — | S9 | WE-6.2 |
| **WE-7.1** | Tender-Engine: Ausschreibungs-Aggregator (TED, NHS, US-VA) | L7 | A | — | S12 | — |
| **WE-7.2** | Hospital-Procurement-Workflow (RFI/RFP/RFQ) | L7 | A | — | S13 | WE-7.1 |
| **WE-7.3** | Bid-Decision-Support (Win-Probability-Modell, **kein** SaMD) | L7 | A | — | S14 | WE-7.1 |
| **WE-9.10** | **Architektonische Trennung** L6/L7 von L3/L4 (separate Cluster, separate IAM) | — | A | — | S6 | — |

**Wichtig WE-9.10**: Diese Tasks dürfen niemals direkten Zugriff auf `chain.scan` / Atlas Datalake erhalten. Datenfluss nur via aggregierter, anonymisierter Reporting-API.

---

# Arbeitspaket 7 — Regulatorik & Quality Management

**Ziel**: Markt­zulassung MDR Klasse IIa (Atlas-KC, Atlas-DryEye) Q4 2026, Klasse IIb (Atlas-IOL, Atlas-Myopia, Atlas-Glaucoma) Q2 2027, Klasse III (Atlas-VitreoRetinal) Q4 2027. ISO 13485 + ISO 14971 + IEC 62304 + IEC 82304-1.

| ID | Titel | Sprint | Deps |
|---|---|---|---|
| **WE-7.1Q** | QMS-Aufbau ISO 13485:2016 (SOPs, Records, Mgmt-Review) | S1–S6 | — |
| **WE-7.2Q** | Risk-Management-File ISO 14971:2019 (FMEA pro Modul) | S2–S9 | — |
| **WE-7.3Q** | Software-Lifecycle-Process IEC 62304:2006+A1:2015 (Plan + SOUP-Liste) | S1 | — |
| **WE-7.4Q** | Usability-Engineering IEC 62366-1 (Use-Specification, Formative + Summative Eval) | S5–S11 | WE-4.14 |
| **WE-7.5Q** | Cybersecurity-Risk-Management nach IEC 81001-5-1 / FDA-Guidance | S3–S9 | — |
| **WE-7.6Q** | Clinical-Evaluation-Plan + Report (MEDDEV 2.7/1 rev.4) pro Modul | S6–S14 | — |
| **WE-7.7Q** | Post-Market-Surveillance-Plan (PMS) + PSUR + Vigilance (MDR Art. 83–87) | S8 (Vorbereitung), kontinuierlich ab M2 | WE-4.6 |
| **WE-7.8Q** | Benannte Stelle: Selektion (BSI / TÜV-SÜD / DEKRA / IMQ), Kick-off | S2 | — |
| **WE-7.9Q** | Technische Dokumentation Anhang II + III MDR (pro Modul) | S6–S13 | — |
| **WE-7.10Q** | UDI-Vergabe + EUDAMED-Registrierung | S10 | WE-7.9Q |
| **WE-7.11Q** | EU-Bevollmächtigter + Schweiz-Authorized-Rep (CH-MEP) | S4 | — |
| **WE-7.12Q** | FDA-Vorbereitung: Pre-Submission (Q-Sub) für US-Pilot M7 | S15 | WE-7.6Q |
| **WE-7.13Q** | UK-MHRA-UKCA-Pfad (post-Brexit) | S18 | WE-7.9Q |
| **WE-7.14Q** | DSGVO-DPIA pro Modul + Datenschutzbeauftragter | S2 | — |
| **WE-7.15Q** | HIPAA-Compliance-Audit (für US-Markt) | S16 | WE-2.5 |
| **WE-7.16Q** | Schweizer-HFG + IVDR-Abgrenzungs-Gutachten (Atlas ist MD, nicht IVD) | S3 | — |

### Modul-zu-MDR-Klassen-Matrix

| Modul | MDR-Regel | Klasse | Begründung |
|---|---|---|---|
| Atlas-KC | Regel 11 §1 | **IIa** | Diagnose-Support, Fehler reversibel (klinische Re-Eval möglich) |
| Atlas-DryEye | Regel 11 §1 | **IIa** | Therapie-Support, keine irreversible Schädigung bei Fehler |
| Atlas-IOL | Regel 11 §2 | **IIb** | Fehlentscheidung → chirurgische Re-OP (Linsenaustausch) erzwungen |
| Atlas-Myopia | Regel 11 §2 | **IIb** | False-Negative → unbehandelte Progression → höhere Hochmyopie-Folgerisiken |
| Atlas-Glaucoma | Regel 11 §2 | **IIb** | False-Negative → irreversible Gesichtsfeldausfälle / Teilerblindung |
| Atlas-VitreoRetinal | Regel 11 §3 | **III** | Direkter intraoperativer Decision-Support, lebenswichtige Funktion |

---

# Arbeitspaket 8 — Test-Architektur

| ID | Titel | Sprint | Deps |
|---|---|---|---|
| **WE-8.1** | Unit-Test-Framework + Coverage-Gates pro Klasse (A:80 / B:90 / C:100+MC/DC) | S1 | — |
| **WE-8.2** | Property-Based-Tests für Connector-Parser (fast-check / Hypothesis) | S3 | WE-1.3 |
| **WE-8.3** | Integration-Tests gegen reale Geräte-Export-Samples (`tests/fixtures/oculus/`) | S4 | WE-1.4 |
| **WE-8.4** | Synthetische Ground-Truth-Kohorten pro Modul (≥1.000 Patienten) | S6–S12 | WE-3.4 |
| **WE-8.5** | Chaos-Engineering: Pod-Kill in `samd-inference-zone` (Litmus / Chaos-Mesh) | S9 | WE-4.1 |
| **WE-8.6** | Penetration-Test (extern, OWASP-ASVS L3) jährlich | S10, S22 | WE-2.5 |
| **WE-8.7** | Performance-Baseline pro Modul (p50/p95/p99 Latenz, RPS) | S8 | WE-4.2 |
| **WE-8.8** | Fuzzing der Ingestion-Endpoints (AFL++ / honggfuzz) | S5 | WE-1.1 |
| **WE-8.9** | Klinische Validierungsstudien (multizentrisch, prospektiv) pro Modul | S10–S18 | WE-7.6Q |
| **WE-8.10** | Backup-Restore-Drill Atlas Datalake (Recovery-Point/Time-Objective verifiziert) | S8, quartalsweise | WE-3.2 |

---

# Arbeitspaket 9 — DevSecOps & Compliance-Automatisierung

| ID | Titel | Sprint | Deps |
|---|---|---|---|
| **WE-9.1** | CI/CD-Pipeline (GitLab CI) mit Pflicht-Stages: lint → typecheck → test → coverage → SBOM → sign | S1 | — |
| **WE-9.2** | `compliance-artifact-generator`-Plugin (Jira ↔ Commit ↔ Test ↔ Anforderung) | S3 | WE-9.1 |
| **WE-9.3** | SBOM-Generierung (CycloneDX) + Signatur via Sigstore | S2 | WE-9.1 |
| **WE-9.4** | Trivy / Grype Dependency-Scan + License-Compliance-Check | S2 | WE-9.1 |
| **WE-9.5** | Git-Tag → GitChain-Verankerung (jeder Release immutable) | S3 | WE-2.2 |
| **WE-9.6** | Traceability-Matrix-Generator (PDF/A + JSON) | S4 | WE-9.2 |
| **WE-9.7** | Audit-as-a-Service-Tenant-Setup (200 €/Monat Praxis-Tier) | S14 | WE-9.6 |
| **WE-9.8** | Secret-Scanning + Pre-Commit-Hook (gitleaks + custom PHI-Regex) | S1 | WE-2.12 |
| **WE-9.9** | Infrastructure-as-Code (Terraform + ArgoCD) für reproduzierbare Deploys | S2 | — |
| **WE-9.10** | Cluster-Segregation L3/L4 ↔ L6/L7 (separate VPCs, separates IAM) | S6 | WE-4.1 |
| **WE-9.11** | Observability: OpenTelemetry-Traces + Prometheus-Metrics + Loki-Logs | S2 | WE-9.9 |
| **WE-9.12** | SLO-Definition pro Modul (Inferenz p95, Verfügbarkeit, Datenfrische) | S4 | WE-9.11 |
| **WE-9.13** | DR-Plan: 2 Geo-Regionen, RTO ≤ 4h, RPO ≤ 15 min für L3 | S10 | WE-9.9 |
| **WE-9.14** | Zero-Trust-Netzwerk (Tailscale/Cloudflare-Access für Admin-Zugriffe) | S3 | — |
| **WE-9.15** | Konformitäts-Dashboard für Geschäftsführung (Live-MDR-Readiness) | S8 | WE-9.6 |

### WE-9.2 — Compliance Artifact Generator
**Pipeline-Plugin** (`scripts/ci/compliance-artifact-generator.ts`):
- Parser für Commit-Messages → extrahiert `WE-X.Y`-IDs.
- Validiert: jeder Code-Commit referenziert ≥ 1 Jira-Task.
- Aggregiert JUnit-XML aus allen Test-Pipelines.
- Generiert PDF/A-2b + JSON-LD Traceability-Matrix.
- Signiert Artefakt mit Release-Tag-SHA-256 + Sigstore.
- Push in `audit-repo` (separates Git-Repo, GitChain-verankert).
**DoD**: Audit-Prüfer kann Frage „Welcher Test verifiziert Anforderung WE-4.3?" in < 30 s beantworten.

---

# Arbeitspaket 10 — Daten, Modelle, Wissenschaft

| ID | Titel | Sprint | Deps |
|---|---|---|---|
| **WE-10.1** | Datenethik-Board (intern + extern, je 1 Klinik / Patientenvertreter) | S3 | — |
| **WE-10.2** | Trainings-Daten-Kuratierung Atlas-KC (≥10k Pentacam-Scans, multizentrisch) | S5 | WE-3.1 |
| **WE-10.3** | Trainings-Daten Atlas-IOL (Postop-Outcomes ≥ 5k Augen, ≥ 3 IOL-Hersteller) | S7 | WE-3.1 |
| **WE-10.4** | Trainings-Daten Atlas-Myopia (Längsschnitt ≥ 3 J., ≥ 2k Kinder) | S8 | WE-3.1 |
| **WE-10.5** | Trainings-Daten Atlas-DryEye (TF-Scan + Meibo ≥ 5k Augen) | S9 | WE-3.1 |
| **WE-10.6** | Trainings-Daten Atlas-Glaucoma (Perimetrie-Längsschnitt ≥ 4 J., ≥ 2k Augen) | S10 | WE-3.1 |
| **WE-10.7** | Fairness-Audit pro Modul (Performance-Parity über Alter / Geschlecht / Ethnie) | S12+ | je Modul |
| **WE-10.8** | Externe Validierung mit unabhängiger Kohorte (anderer Kontinent) | S14+ | je Modul |
| **WE-10.9** | Publikations-Plan (≥ 1 peer-reviewed paper pro Klasse-IIb-Modul) | S10–S20 | WE-10.8 |
| **WE-10.10** | Real-World-Performance-Monitoring nach Markteinführung (Drift-Tracking) | ab M2 | WE-4.6 |

---

# Arbeitspaket 11 — Go-to-Market & Commercial

| ID | Titel | Sprint | Deps |
|---|---|---|---|
| **WE-11.1** | 3 Pilot-Praxen-Verträge (Q3 2026, **M1**) | S1 | — |
| **WE-11.2** | Pricing-Engine (3 Cloud-Tiers + Pay-per-Scan + Pharma-API) | S6 | — |
| **WE-11.3** | Self-Service-Onboarding-Flow für Praxen | S9 | WE-11.2 |
| **WE-11.4** | Pharma-Partner-Akquise: 24 Top-Tier-Targets (Alcon, J&J, Zeiss, EssilorLuxottica…) | S6–S15 | — |
| **WE-11.5** | EBM-Z-Antrag DE (Bewertungsausschuss + GBA-Anhörung) | S12 | WE-7.9Q |
| **WE-11.6** | CPT-AI-add-on-Antrag US (AMA + CMS) | S18 | WE-7.12Q |
| **WE-11.7** | Hardware-Vertriebs-Integration mit OCULUS-Außendienst (Co-Selling-Schulung) | S5 | — |
| **WE-11.8** | Customer-Success-Team-Aufbau (1 CSM per 100 Praxen) | S10+ | — |
| **WE-11.9** | Erlös-Reporting + Revenue-Share-Engine OCULUS↔0711 (75/25, 70/30, 60/40) | S6 | WE-4.7 |
| **WE-11.10** | Series-A-Vorbereitung (Datenraum, Pitch-Deck, Audit-Bestätigung) | S22 | WE-9.15 |

---

# Sprint-Allokation (Verdichtet)

## Phase 1 — Foundation (S1–S6, Q3/26 – Q4/26, **M1 + M2**)
**Hauptlieferungen**: 3 Pilot-Praxen live, Ingestion + GitChain + Consent funktional, MDR-Submission Atlas-KC.

- S1: WE-1.1, WE-1.2, WE-7.1Q, WE-7.3Q, WE-9.1, WE-9.8, WE-8.1, WE-11.1
- S2: WE-1.3, WE-1.9, WE-2.1, WE-2.2, WE-2.12, WE-3.4, WE-7.2Q, WE-7.8Q, WE-7.14Q, WE-7.16Q, WE-9.3, WE-9.4, WE-9.9, WE-9.11
- S3: WE-1.5, WE-1.6, WE-1.10, WE-2.3, WE-2.5, WE-3.1, WE-7.5Q, WE-8.2, WE-9.2, WE-9.5, WE-9.14, WE-10.1
- S4: WE-1.7, WE-2.4, WE-2.6, WE-3.2, WE-3.4 (cont.), WE-7.11Q, WE-8.3, WE-9.6, WE-9.12, WE-4.1
- S5: WE-1.8, WE-2.7, WE-2.10, WE-3.3, WE-3.6, WE-4.2, WE-4.3, WE-7.4Q, WE-8.8, WE-10.2, WE-11.7
- S6: WE-1.11, WE-2.8, WE-2.11, WE-3.5, WE-4.4, WE-4.8 (**Atlas-KC Beta**), WE-4.14, WE-4.15, WE-7.6Q, WE-7.9Q, WE-9.10, WE-11.2, WE-11.4, WE-11.9

## Phase 2 — Beta-Skalierung (S7–S12, Q1/27 – Q2/27, **M3 + M4**)
**Hauptlieferungen**: 300 → 500 Praxen, Atlas-DryEye + Atlas-IOL + Atlas-Myopia Beta, Pharma-API live, Pay-per-Scan aktiviert.

- S7: WE-1.12, WE-2.9, WE-3.7, WE-6.1, WE-8.9 (Start)
- S8: WE-4.5, WE-4.9 (**Atlas-IOL Beta**), WE-6.2, WE-7.7Q (Plan), WE-8.7, WE-8.10, WE-9.15, WE-10.3
- S9: WE-4.6, WE-4.10 (**Atlas-Myopia Beta**), WE-6.3, WE-6.4, WE-7.5Q (cont.), WE-8.5, WE-10.4, WE-11.3
- S10: WE-3.9, WE-4.7, WE-4.11 (**Atlas-DryEye Beta**), WE-5.1–WE-5.5, WE-5.8, WE-7.10Q, WE-8.6, WE-9.13, WE-10.5, WE-10.10 (Setup), WE-11.8
- S11: WE-3.10, WE-4.12 (**Atlas-Glaucoma Beta**), WE-5.6, WE-5.7, WE-5.10, WE-10.6
- S12: WE-3.8, WE-5.9, WE-7.1, WE-10.7 (Start), WE-11.5

## Phase 3 — Commercial Scale (S13–S18, Q3/27 – Q4/27, **M5 + M6**)
**Hauptlieferungen**: 1k → 2k Praxen, EBITDA-Break-even, Audit-as-a-Service-GA, FDA-Vorbereitung.

- S13–S14: WE-7.2, WE-7.3, WE-9.7, WE-10.8, WE-11.4 (cont.)
- S15: WE-4.13 (**Atlas-VitreoRetinal Beta** — höchste Vorsicht), WE-7.12Q
- S16: WE-7.15Q, FDA-Q-Sub eingereicht
- S17–S18: WE-7.13Q, Audit-AaS-Skalierung, Pharma-Top-24 angeschlossen

## Phase 4 — Global Expansion + Reimbursement (S19–S24, Q1/28 – Q2/28, **M7 + M8**)
**Hauptlieferungen**: US-Pilot, ISO 13485 Re-Zertifizierung, CPT-AI-add-on, EBM-Z gelistet, Series-A.

- S19–S21: WE-7.12Q FDA-510(k) / De Novo Submission, WE-11.6, US-Pilot 50 Praxen
- S22: WE-8.6 (Re-PenTest), WE-11.10
- S23–S24: EUDAMED Re-Cert, Series-A Closing

---

# Kritische Pfad-Risiken (Top-10)

1. **Notified-Body-Kapazität** — Bottleneck post-MDR. Mitigation: WE-7.8Q in S2, parallele Anfrage bei 3 NBs.
2. **Trainings-Daten-Verfügbarkeit Atlas-IOL** — benötigt postop. Outcomes, oft fragmentiert. Mitigation: Frühe Pharma-Daten-Partnerschaft (WE-11.4).
3. **DSGVO-Kindermyopie-Daten** — § 8 DSGVO + Elternzustimmung-Workflow. Mitigation: WE-2.7 mit Kind/Eltern-Doppel-Signatur.
4. **TSA-Single-Point-of-Failure** — RFC-3161-Anbieter-Ausfall blockt L0. Mitigation: 3-Anbieter-Failover (WE-2.1 Akzeptanz).
5. **Model-Drift in Prod** — kontinuierliches Re-Training ist nicht MDR-konform ohne Re-Cert. Mitigation: WE-4.5 + WE-4.6 + festgefrorene Modelle pro Release.
6. **Klinische Validierungsstudien-Dauer** — Glaukom + Myopie brauchen Längsschnitt ≥ 3 J. Mitigation: Retrospektive Kohorten + bestehende OCULUS-Datenbestände nutzen (Ethikvotum).
7. **EBM-Z / CPT-AI Reimbursement-Timing** — politisch unsicher. Mitigation: Pay-per-Scan-Modell als Brücken-Finanzierung (WE-4.7).
8. **L4 Class-C MC/DC-Coverage** — sehr hoher Aufwand. Mitigation: Hot-Spot-Refactoring + Tool-Wahl (LDRA / VectorCAST) ab S5.
9. **Cyberangriff auf Pharma-API** — hochsensible Daten, lukratives Ziel. Mitigation: WE-5.5 + WE-5.6 + WE-8.6 + Bug-Bounty.
10. **Akquise-Risiko durch Konkurrenten (Zeiss, Heidelberg)** — kann Time-to-Market killen. Mitigation: Exklusivität-Vertrag (5 Jahre), IP-Hoheit L0 bei 0711, Series-A erst nach M5.

---

# Querschnitts-Regeln (Engineering-Praxis)

1. **Workflow = Daten** (vgl. CLAUDE.md): Jede neue klinische Pipeline ist `defineWorkflow({ … })`, nie ein neuer Server.
2. **Keine Patientendaten in L0**: Pre-Commit-Hook (WE-2.12) + CI-Scanner (WE-9.8) erzwingen.
3. **Deutsche Bezeichner im Code** (KODIERRICHTLINIE), englische Identifier nur an externen Schnittstellen (DICOM, FHIR, HL7).
4. **Kein „Modellname leakt in UI"**: User sieht „Atlas-KC v3.2", nicht „ResNet-50/onnx-v17".
5. **Stages kennen Stages nicht** (CLAUDE.md): Runner orchestriert. Inferenz-Pipelines sind Stage-Ketten.
6. **Connector-Budget 150 LoC** strikt enforced (WE-1.3-CI-Job).
7. **Jeder Class-C-Code geht durch 2-Personen-Review** + unabhängiger Tester.
8. **Releases sind atomar**: Image-Hash + SBOM + Trace-Matrix + GitChain-Tag in einer Transaktion.

---

# Bezug auf bestehendes Repo (Re-Use vs. Neu)

| Bestehend | Wiederverwendung im Whole-Eye OS |
|---|---|
| `src/core/runner.ts`, `stage.ts`, `workflow.ts` | **Direkt** — Workflow-Engine ist domänen-agnostisch. |
| `src/core/artifacts-gitchain.ts` + GitChain-Client | **Erweitern** zu `gitchain-indexer` (WE-2.1). |
| `src/workflows/pentacam-kc/` | **Migrieren** in `src/verticals/oculus/workflows/atlas-kc/` (WE-4.8). |
| `src/workflows/myopia-progression/` | **Migrieren** zu Atlas-Myopia (WE-4.10). |
| `src/verticals/elster*` | **Eingefroren** als Referenz, eigene Verticals-Sub-Org. |
| `schemas/` (JSON-Schema-Repo) | **Erweitern** um Oculus-Domänen-Schemata (WE-1.9). |
| `src/server.ts` (Express + SSE) | **Beibehalten** für UI-Layer; Inferenz separat in K8s (WE-4.1). |
| PM2 `sturm`, Port 7800 | **Beibehalten** für Dev, K8s nur in Stage/Prod. |

---

# Offene Entscheidungen (für nächstes Architecture-Review)

1. **Sprach-Stack `gitchain-indexer`**: Rust (Speicher­sicherheit) vs. Go (Team-Vertrautheit). Empfehlung: **Rust**, weil sicherheitskritisch + bestehendes Ed25519-Ökosystem.
2. **Cloud-Provider**: AWS (CloudHSM, US-Markt) vs. OVH/Hetzner (DE-Souveränität). Empfehlung: **Hybrid** — DE-Tenant auf OVH, US-Tenant auf AWS.
3. **DICOM-Speicherung**: Inline in Atlas vs. separater PACS. Empfehlung: **separater PACS** (Orthanc oder dcm4che) hinter L3-API.
4. **K8s-Distribution**: Vanilla vs. OpenShift vs. EKS. Empfehlung: **EKS** in US, **Vanilla auf bare-metal** in DE.
5. **Pharma-API-Daten-Granularität**: Tabellarisch vs. Patient-Level (k≥5 anonym). Empfehlung: Beide Tiers, Pricing-differenziert.

---

**Verantwortlich (Initial-Allocation)**: siehe `docs/architecture/raci.md` (folgt).
**Review-Kadenz**: alle 2 Sprints, Steering-Committee monatlich.
**Update dieser Liste**: PR an `docs/WHOLE-EYE-OS-TASKLIST.md`, mind. quartalsweise.
