import { z } from "zod";

export const XLAYER_TESTNET_CHAIN_ID = 1952 as const;
export const XLAYER_MAINNET_CHAIN_ID = 196 as const;

export const ReleaseGateResultSchema = z.object({
  outcome: z.enum(["PASS", "BLOCK", "NEEDS_REVIEW"]),
  reasons: z.array(z.string()),
  policyVersion: z.string().min(1),
  evaluatedAt: z.string().datetime()
});

export enum JobState {
  DRAFT = "DRAFT",
  FUNDED = "FUNDED",
  EVIDENCE_SUBMITTED = "EVIDENCE_SUBMITTED",
  UNDER_REVIEW = "UNDER_REVIEW",
  REVIEWED = "REVIEWED",
  RELEASED = "RELEASED",
  DISPUTED = "DISPUTED",
  CANCELLED = "CANCELLED"
}

export const AgreementSchema = z.object({
  payer: z.string().min(1),
  recipient: z.string().min(1),
  amountWei: z.string().regex(/^\d+$/),
  deadline: z.string().datetime(),
  policyVersion: z.string().min(1),
  policyHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/)
});

export const EvidenceManifestSchema = z.object({
  agreementId: z.string().min(1),
  submittedBy: z.string().min(1),
  submittedAt: z.string().datetime(),
  items: z.array(z.object({
    name: z.string().min(1),
    mediaType: z.string().min(1),
    sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
    uri: z.string().url()
  })).min(1),
  manifestHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/)
});

export type EvidenceManifest = z.infer<typeof EvidenceManifestSchema>;

export interface ReviewObservation {
  requiredEvidencePresent: boolean;
  extractedFacts: Array<{ key: string; value: string; source: string }>;
  contradictions: string[];
  missingItems: string[];
  confidence: number;
}

export interface ReleaseGateInput {
  manifestIntegrity: boolean;
  observation: ReviewObservation;
  deterministicRulesPass: boolean;
  agreementState: JobState;
  milestoneStatus: "REVIEWED" | "RELEASED" | "DISPUTED";
  humanOverride: boolean;
  policyVersion: string;
  evaluatedAt: string;
}

export type ReleaseGateResult = z.infer<typeof ReleaseGateResultSchema>;

export function evaluateReleaseGate(input: ReleaseGateInput): ReleaseGateResult {
  const reasons: string[] = [];
  if (!input.manifestIntegrity) reasons.push("Evidence manifest integrity could not be verified.");
  if (!input.observation.requiredEvidencePresent) reasons.push("Required evidence is missing.");
  if (input.observation.contradictions.length > 0) reasons.push("Evidence contains contradictions.");
  if (input.observation.missingItems.length > 0) reasons.push("Evidence review identified missing items.");
  if (!input.deterministicRulesPass) reasons.push("Deterministic policy rules did not pass.");
  if (input.agreementState !== JobState.FUNDED) reasons.push("Agreement is not funded.");
  if (input.milestoneStatus !== "REVIEWED") reasons.push("Milestone is not in a releasable reviewed state.");
  if (input.humanOverride) reasons.push("A human override requires explicit review before settlement.");

  const outcome = reasons.length > 0
    ? "BLOCK"
    : input.observation.confidence < 0.85
      ? "NEEDS_REVIEW"
      : "PASS";

  return ReleaseGateResultSchema.parse({ outcome, reasons, policyVersion: input.policyVersion, evaluatedAt: input.evaluatedAt });
}
