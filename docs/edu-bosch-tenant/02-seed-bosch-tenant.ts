/**
 * Seed-Script: Bosch als zweiter Tenant in edu.0711.io.
 *
 * Idempotent: prüft erst ob Tenant existiert, kein doppeltes INSERT.
 * --dry-run zeigt was passieren würde ohne DB-Write.
 *
 * Anwenden:
 *   npx tsx prisma/seed-bosch-tenant.ts --dry-run
 *   npx tsx prisma/seed-bosch-tenant.ts
 *
 * ENV-Vars (optional, fallback in Defaults):
 *   BOSCH_TENANT_GOOGLE_API_KEY   — Gemini key für Bosch-Tenant
 *   BOSCH_TENANT_DOMAIN           — Default "bosch.edu.0711.io"
 *   BOSCH_TENANT_CUSTOM_DOMAIN    — z.B. "academy.bosch.de"
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const BOSCH_TENANT = {
  slug: "bosch-academy",
  name: "Bosch Academy",
  domain: process.env.BOSCH_TENANT_DOMAIN ?? "bosch.edu.0711.io",
  customDomain: process.env.BOSCH_TENANT_CUSTOM_DOMAIN ?? null,
  tagline: "Wärmepumpen-Schulungen — Installateur, Elektriker, Service",
  description:
    "Bosch-zertifizierte Schulungsplattform. Inhalte basieren auf signierten " +
    "Produkt-Containern mit on-chain Provenance.",
  primaryColor: "#EA0029", // Bosch-Rot
  language: "de",
  chatAssistantName: "Bosch Wärmepumpen-Assistent",
  chatSystemPrompt:
    "Du beantwortest Fragen zu Bosch-Wärmepumpen ausschließlich auf Basis " +
    "der angeschlossenen Produkt-Container. Wenn eine Frage außerhalb des " +
    "Containers liegt, gib das ehrlich zurück.",
  googleApiKey: process.env.BOSCH_TENANT_GOOGLE_API_KEY ?? null,
  anthropicApiKey: null,
  courseCredits: 50, // Start-Kontingent
  stripeConnectOnboarded: false,
} as const;

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  console.log(`[seed-bosch-tenant] dryRun=${dryRun}`);

  // 1) Tenant suchen
  const existing = await prisma.tenant.findUnique({
    where: { slug: BOSCH_TENANT.slug },
  });

  if (existing) {
    console.log(
      `[seed-bosch-tenant] Tenant '${BOSCH_TENANT.slug}' existiert schon ` +
        `(id=${existing.id}). Skip.`,
    );
    return;
  }

  console.log(`[seed-bosch-tenant] Tenant '${BOSCH_TENANT.slug}' wird angelegt:`);
  console.log(JSON.stringify(BOSCH_TENANT, null, 2));

  if (dryRun) {
    console.log("[seed-bosch-tenant] --dry-run: kein DB-Write.");
    return;
  }

  const tenant = await prisma.tenant.create({ data: BOSCH_TENANT });
  console.log(`[seed-bosch-tenant] Tenant angelegt: id=${tenant.id}`);

  // 2) Platzhalter-CourseProject als Onboarding-Aufhänger
  const project = await prisma.courseProject.create({
    data: {
      tenantId: tenant.id,
      name: "Compress CS5800iAW — Schulungs-Familie",
      status: "DRAFT",
    },
  });
  console.log(`[seed-bosch-tenant] CourseProject angelegt: id=${project.id}`);

  console.log(
    "[seed-bosch-tenant] Fertig. Nächster Schritt: Container importieren via " +
      "POST /api/admin/course-projects/import-container",
  );
}

main()
  .catch((e) => {
    console.error("[seed-bosch-tenant] FATAL:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
