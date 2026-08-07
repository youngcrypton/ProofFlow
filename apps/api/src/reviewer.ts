import { createHash, randomUUID } from "node:crypto";
import { ReviewObservationSchema, ReviewRunSchema } from "@proofflow/domain";
import type { EvidenceManifest, ReviewObservation, ReviewRun } from "@proofflow/domain";

export interface ReviewRequest {
  agreementId: string;
  manifest: EvidenceManifest;
  evidenceText: string;
}

export interface ReviewProvider {
  readonly name: string;
  readonly model: string;
  readonly promptVersion: string;
  review(request: ReviewRequest): Promise<ReviewObservation>;
}

function sha256(value: string): `0x${string}` {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

function sanitizeEvidenceText(value: string): string {
  return value.replaceAll(/\u0000/g, "").slice(0, 40_000);
}

export class DeterministicDemoReviewer implements ReviewProvider {
  readonly name = "proofflow-demo-reviewer";
  readonly model = "deterministic-fixture";
  readonly promptVersion = "review-v1";

  async review(request: ReviewRequest): Promise<ReviewObservation> {
    const text = sanitizeEvidenceText(request.evidenceText).toLowerCase();
    const itemTypes = new Set(request.manifest.items.map((item) => item.type));
    const hasRequiredEvidence = request.manifest.items.length > 0;
    const contradictions = text.includes("ignore previous instructions") || text.includes("override policy")
      ? ["Evidence contains instruction-like content and requires human review."]
      : [];
    const missingItems = hasRequiredEvidence ? [] : ["evidence_item"];
    return ReviewObservationSchema.parse({
      requiredEvidencePresent: hasRequiredEvidence,
      extractedFacts: [{ key: "evidence_types", value: [...itemTypes].join(","), source: "manifest" }],
      contradictions,
      missingItems,
      confidenceBps: contradictions.length > 0 ? 2_000 : 9_500
    });
  }
}

export async function runReview(provider: ReviewProvider, request: ReviewRequest): Promise<ReviewRun> {
  const createdAt = new Date().toISOString();
  const inputHash = sha256(JSON.stringify({ agreementId: request.agreementId, manifest: request.manifest, evidenceText: sanitizeEvidenceText(request.evidenceText) }));
  try {
    const observation = await provider.review(request);
    const status = observation.contradictions.length > 0 || observation.confidenceBps < 9_000 ? "NEEDS_REVIEW" : "SUCCEEDED";
    const completedAt = new Date().toISOString();
    const outputHash = sha256(JSON.stringify(observation));
    return ReviewRunSchema.parse({ id: `rev_${randomUUID().replaceAll("-", "").slice(0, 16)}`, agreementId: request.agreementId, evidenceManifestHash: request.manifest.manifestHash, provider: { provider: provider.name, model: provider.model, promptVersion: provider.promptVersion }, observation, inputHash, outputHash, status, createdAt, completedAt });
  } catch {
    return ReviewRunSchema.parse({ id: `rev_${randomUUID().replaceAll("-", "").slice(0, 16)}`, agreementId: request.agreementId, evidenceManifestHash: request.manifest.manifestHash, provider: { provider: provider.name, model: provider.model, promptVersion: provider.promptVersion }, observation: { requiredEvidencePresent: false, extractedFacts: [], contradictions: [], missingItems: ["review_failed"], confidenceBps: 0 }, inputHash, outputHash: sha256("review_failed"), status: "FAILED", createdAt, completedAt: new Date().toISOString(), errorCode: "REVIEW_FAILED" });
  }
}
