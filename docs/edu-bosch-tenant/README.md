# Patch-Pack: Bosch als zweiter Tenant in edu.0711.io

**Ziel:** edu.0711.io um Container-Import erweitern, Bosch als zweiten Tenant neben hoor anlegen. Bestehende Hoor-Flows bleiben unangetastet — die Erweiterung ist additiv.

**Ziel-Repo:** `0711-Academy` (Verzeichnis auf h200v heißt `/home/christoph.bertsch/0711/hoor/` aus historischen Gründen — der Git-Remote ist `gitlab.mediacockpit.dev/0711/0711-academy.git`).

## Architektur-Annahmen (verifiziert aus dem h200v-Code-Read)

- `PlatformConfig.domain = "edu.0711.io"` — die Plattform.
- `Tenant` ist Multi-Tenant-Row mit eigenem `slug`, `domain`, `customDomain`, Branding, Stripe-Keys, AI-Keys.
- `Course → Module → Lesson` Hierarchie mit `generationStatus`.
- `CourseProject` existiert als Pre-Course-Staging-Area (Endpoints: `/api/admin/course-projects/{,[id]}`).
- `course-generator.ts` nutzt Google Gemini, BullMQ Workers (`course-worker`, `module-worker`).

## Was dieses Patch-Pack ändert

Phase 1 (dieses Pack):

1. **Schema-Erweiterung** an `CourseProject` für Container-Connect
2. **Seed-Script** das Bosch als Tenant anlegt
3. **API-Route** `POST /api/admin/course-projects/import-container` zum Container-Import
4. **Generischer Container-Reader** (liest Atoms aus `atoms.json` + `embeddings.fp32.bin` über URI)

Phase 2 (später, separater Branch):

5. Grounded-Mode in `course-generator.ts` (zwingt `atom_citations[]` im Output)
6. `Citation` Table + Audit-Score
7. Frontend-Wizard-Schritte für Container-Connect
8. Audience-Auto-Detection vor Generation

## Anwenden (Feature-Branch)

```bash
# im 0711-Academy Repo
git checkout -b feat/container-import-and-bosch-tenant

# 1) Schema-Delta in prisma/schema.prisma einfügen
cat docs/edu-bosch-tenant/01-prisma-schema-additions.prisma >> prisma/schema.prisma
npx prisma migrate dev --name add_container_source_to_course_project

# 2) Seed-Script ablegen
cp docs/edu-bosch-tenant/02-seed-bosch-tenant.ts prisma/seed-bosch-tenant.ts
# Dry-Run, schaut was passiert ohne zu schreiben
npx tsx prisma/seed-bosch-tenant.ts --dry-run
# Echtes Anlegen erst nach Sichtprüfung
npx tsx prisma/seed-bosch-tenant.ts

# 3) Container-Import API-Route ablegen
mkdir -p src/app/api/admin/course-projects/import-container
cp docs/edu-bosch-tenant/03-import-container-route.ts \
   src/app/api/admin/course-projects/import-container/route.ts

# 4) Container-Reader-Lib ablegen
cp docs/edu-bosch-tenant/04-container-reader.ts src/lib/containers/reader.ts

# Build + Test
npm run build
npm test  # falls vorhanden

# Lokal manuell testen (Bosch-Container)
curl -X POST http://localhost:3000/api/admin/course-projects/import-container \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <admin-token>" \
  -d '{
    "containerId": "0711:product:bosch:8738213487",
    "anchor": { "chain": "base-mainnet", "block": 45427604 },
    "merkleRoot": "e1fbac913d14…"
  }'
```

## Nicht-destruktive Garantien

- **Prisma-Migration ist additiv** — neue Spalten haben Default-Werte oder sind nullable. Keine bestehenden Rows betroffen.
- **Seed-Script** prüft erst ob Bosch-Tenant existiert (idempotent). `--dry-run` zeigt was passieren würde.
- **API-Route** ist neu — überschreibt nichts.
- **Container-Reader** ist neue Datei.

## Was es NICHT macht

- Triggert keine Course-Generierung — nur den Import-Hook.
- Macht keinen Anchor on-chain — der Container ist als reference gespeichert, kein neuer Container wird erzeugt.
- Touched bestehende `course-generator.ts` nicht. Der Citation-grounded-Mode kommt in Phase 2.
- Erzeugt keine Master-Class Inhalte automatisch — Admin muss nach Import explizit Course-Generierung anstoßen.

## Verifikation nach dem Apply

```sql
-- Bosch-Tenant da?
SELECT id, slug, domain, primaryColor FROM "Tenant" WHERE slug = 'bosch-academy';

-- Schema-Erweiterung sichtbar?
SELECT column_name FROM information_schema.columns
WHERE table_name = 'CourseProject' AND column_name LIKE 'source%';
```

## Phase 2 Roadmap

Wenn Phase 1 lebt und ein Container importiert ist, der zweite PR liefert:

```ts
// course-generator.ts Erweiterung
export interface GroundedModuleInput extends ... {
  containerAtoms: Atom[];          // gelieferte Atoms aus dem Container
  requireCitations: true;          // Pflicht für jeden Claim
}

export async function generateGroundedModuleContent(
  input: GroundedModuleInput
): Promise<GroundedModuleContent> {
  // Gemini mit json_schema response_format der citation_atom_ids[] zwingt
  // Audit-Score = % cited claims of total claims
  // Below threshold → throw, blockt Publish
}
```

Plus eine `Citation` Tabelle, Frontend-Wizard-Erweiterung, und optional Course-as-Sub-Container Anchoring.
