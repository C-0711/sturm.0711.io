/**
 * POST /api/admin/course-projects/import-container
 *
 * Nimmt eine Container-Referenz entgegen, lädt die Atoms via container-reader,
 * kategorisiert sie, persistiert die Source-Verknüpfung am CourseProject.
 *
 * Triggert KEINE Course-Generierung — das ist ein separater Wizard-Step.
 *
 * Body:
 * {
 *   "courseProjectId": "ckxy…" (optional — wenn nicht gesetzt, wird neuer Project angelegt),
 *   "containerId":     "0711:product:bosch:8738213487",
 *   "containerType":   "product",
 *   "merkleRoot":      "e1fbac913d14…",
 *   "anchor": {
 *     "chain":   "base-mainnet",
 *     "block":   45427604,
 *     "txHash":  "0x…"  // optional
 *   },
 *   "sourceUri":       "https://verifier.0711.io/audit/0711:product:bosch:8738213487"
 * }
 *
 * Response 201:
 * {
 *   "containerSourceId": "…",
 *   "courseProjectId":   "…",
 *   "atomsCount":        72,
 *   "embeddingsCount":   72,
 *   "categories":        { "pdfs": 9, "images": 49, "schematics": 12, "docs": 31 },
 *   "detectedAudiences": [ { audience, confidence, evidence_kinds, atomIds } ]
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import { requireTenantAdmin } from "@/lib/admin/api-auth";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";
import { loadContainer, categorizeAtoms, detectAudiences } from "@/lib/containers/reader";

interface ImportContainerBody {
  courseProjectId?: string;
  containerId: string;
  containerType?: string;
  merkleRoot: string;
  anchor?: { chain?: string; block?: number; txHash?: string };
  sourceUri?: string; // optional — falls Atoms nicht lokal, von wo laden
}

export async function POST(req: NextRequest) {
  const limited = rateLimit(req, { limit: 10, windowMs: 60_000 });
  if (limited) return limited;

  const auth = requireTenantAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const { tenantId } = auth;

  let body: ImportContainerBody;
  try {
    body = (await req.json()) as ImportContainerBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // ── Validate
  if (!body.containerId || !body.merkleRoot) {
    return NextResponse.json(
      { error: "containerId and merkleRoot required" },
      { status: 400 },
    );
  }
  if (!body.containerId.startsWith("0711:")) {
    return NextResponse.json(
      { error: "containerId must use 0711: namespace" },
      { status: 400 },
    );
  }

  // ── Find or create CourseProject
  let courseProjectId = body.courseProjectId;
  if (!courseProjectId) {
    const project = await prisma.courseProject.create({
      data: {
        tenantId,
        name: `Import: ${body.containerId}`,
        status: "DRAFT",
      },
    });
    courseProjectId = project.id;
  } else {
    const existing = await prisma.courseProject.findUnique({
      where: { id: courseProjectId },
      select: { tenantId: true },
    });
    if (!existing) {
      return NextResponse.json(
        { error: "courseProject not found" },
        { status: 404 },
      );
    }
    if (existing.tenantId !== tenantId) {
      return NextResponse.json(
        { error: "courseProject belongs to another tenant" },
        { status: 403 },
      );
    }
  }

  // ── Load container bundle (atoms + embeddings + container.json)
  let bundle;
  try {
    bundle = await loadContainer({
      containerId: body.containerId,
      sourceUri: body.sourceUri,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "Failed to load container",
        message: (err as Error).message,
        containerId: body.containerId,
      },
      { status: 502 },
    );
  }

  // ── Verify merkle root matches what caller claims (defense against drift)
  if (
    bundle.container.merkle_root &&
    bundle.container.merkle_root !== body.merkleRoot
  ) {
    return NextResponse.json(
      {
        error: "Merkle root mismatch",
        expected: body.merkleRoot,
        actual: bundle.container.merkle_root,
      },
      { status: 409 },
    );
  }

  // ── Categorize + Audience-Detect
  const categories = categorizeAtoms(bundle.atoms);
  const detectedAudiences = detectAudiences(bundle.atoms, categories);

  // ── Persist
  const source = await prisma.containerSource.create({
    data: {
      courseProjectId,
      containerId: body.containerId,
      containerType: body.containerType ?? bundle.container.type ?? "unknown",
      namespace: bundle.container.namespace ?? body.containerId.split(":")[1] ?? "unknown",
      displayName: bundle.container.display_name ?? null,

      merkleRoot: bundle.container.merkle_root,
      containerSha256: bundle.container.container_sha256 ?? null,
      anchorChain: body.anchor?.chain ?? bundle.container.anchor_chain ?? null,
      anchorBlock: body.anchor?.block ?? bundle.container.anchor_block_number ?? null,
      anchorTxHash: body.anchor?.txHash ?? bundle.container.anchor_tx_hash ?? null,
      isSealed: bundle.container.signature != null,

      atomsCount: bundle.atoms.length,
      embeddingsCount: bundle.embeddings?.length ?? 0,
      embeddingsDim: bundle.embeddings?.[0]?.vector?.length ?? null,
      categories,
      detectedAudiences,

      lastVerified: new Date(),
    },
  });

  return NextResponse.json(
    {
      containerSourceId: source.id,
      courseProjectId,
      atomsCount: bundle.atoms.length,
      embeddingsCount: bundle.embeddings?.length ?? 0,
      categories,
      detectedAudiences,
    },
    { status: 201 },
  );
}
