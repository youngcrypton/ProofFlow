import { z } from "zod";

export const XLAYER_TESTNET_CHAIN_ID = 1952 as const;
export const XLAYER_MAINNET_CHAIN_ID = 196 as const;

export enum JobState {
  DRAFT = "DRAFT",
  AWAITING_FUNDING = "AWAITING_FUNDING",
  FUNDED = "FUNDED",
  EVIDENCE_SUBMITTED = "EVIDENCE_SUBMITTED",
  UNDER_REVIEW = "UNDER_REVIEW",
  REVIEWED = "REVIEWED",
  READY_TO_RELEASE = "READY_TO_RELEASE",
  RELEASED = "RELEASED",
  BLOCKED = "BLOCKED",
  DISPUTED = "DISPUTED",
  EXPIRED = "EXPIRED",
  CANCELLED = "CANCELLED"
}

export const EvmAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid EVM address");
export const Hash32Schema = z.string().regex(/^0x[a-fA-F0-9]{64}$/, "Invalid 32-byte hash");
export const DecimalIntegerSchema = z.string().regex(/^\d+$/, "Expected a non-negative integer string");
export const IsoDateSchema = z.string().datetime({ offset: true });

export const EvidenceTypeSchema = z.enum([
  "invoice",
  "purchase_order",
  "delivery_receipt",
  "signed_approval",
  "api_response",
  "status_update"
]);

export const PolicySchema = z.object({
  version: z.string().min(1).max(64),
  requiredEvidence: z.array(EvidenceTypeSchema).min(1).max(12),
  minimumConfidenceBps: z.number().int().min(0).max(10_000),
  releaseAmountBaseUnits: DecimalIntegerSchema,
  deadline: IsoDateSchema
});

export type Policy = z.infer<typeof PolicySchema>;

export const AgreementSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(120),
  description: z.string().max(1_000),
  payer: EvmAddressSchema,
  recipient: EvmAddressSchema,
  tokenAddress: EvmAddressSchema,
  amountBaseUnits: DecimalIntegerSchema,
  deadline: IsoDateSchema,
  policy: PolicySchema,
  policyHash: Hash32Schema,
  state: z.nativeEnum(JobState),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema
});

export type Agreement = z.infer<typeof AgreementSchema>;

export const AgreementCreateInputSchema = z.object({
  title: z.string().min(1).max(120),
  description: z.string().max(1_000).default(""),
  payer: EvmAddressSchema,
  recipient: EvmAddressSchema,
  tokenAddress: EvmAddressSchema,
  amountBaseUnits: DecimalIntegerSchema,
  deadline: IsoDateSchema,
  policy: PolicySchema
});

export type AgreementCreateInput = z.infer<typeof AgreementCreateInputSchema>;

export const EvidenceItemSchema = z.object({
  type: EvidenceTypeSchema,
  name: z.string().min(1).max(160),
  mediaType: z.string().min(1).max(120),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/, "Invalid SHA-256 digest"),
  uri: z.string().url()
});

export const EvidenceManifestSchema = z.object({
  agreementId: z.string().min(1),
  submittedBy: EvmAddressSchema,
  submittedAt: IsoDateSchema,
  items: z.array(EvidenceItemSchema).min(1).max(50),
  manifestHash: Hash32Schema
});

export type EvidenceManifest = z.infer<typeof EvidenceManifestSchema>;

export const ReviewObservationSchema = z.object({
  requiredEvidencePresent: z.boolean(),
  extractedFacts: z.array(z.object({
    key: z.string().min(1).max(120),
    value: z.string().min(1).max(500),
    source: z.string().min(1).max(160)
  })).max(100),
  contradictions: z.array(z.string().min(1).max(500)).max(50),
  missingItems: z.array(z.string().min(1).max(160)).max(50),
  confidenceBps: z.number().int().min(0).max(10_000)
});

export type ReviewObservation = z.infer<typeof ReviewObservationSchema>;

export const PolicyDecisionSchema = z.object({
  outcome: z.enum(["PASS", "BLOCK", "NEEDS_REVIEW"]),
  reasons: z.array(z.string()),
  policyVersion: z.string().min(1),
  policyHash: Hash32Schema,
  evaluatedAt: IsoDateSchema
});

export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export interface PolicyEvaluationInput {
  policy: Policy;
  observation: ReviewObservation;
  manifestTypes: string[];
  manifestIntegrity: boolean;
  evaluatedAt: string;
}

export function evaluatePolicy(input: PolicyEvaluationInput): PolicyDecision {
  const reasons: string[] = [];
  const required = new Set(input.policy.requiredEvidence);
  const supplied = new Set(input.manifestTypes);
  const missingRequired = [...required].filter((type) => !supplied.has(type));

  if (!input.manifestIntegrity) reasons.push("Evidence manifest integrity could not be verified.");
  if (missingRequired.length > 0) reasons.push(`Required evidence is missing: ${missingRequired.join(", ")}.`);
  if (!input.observation.requiredEvidencePresent) reasons.push("AI review did not confirm required evidence.");
  if (input.observation.contradictions.length > 0) reasons.push("Evidence contains contradictions.");
  if (input.observation.missingItems.length > 0) reasons.push("AI review identified missing items.");
  if (input.observation.confidenceBps < input.policy.minimumConfidenceBps) reasons.push("Review confidence is below the policy threshold.");
  if (BigInt(input.policy.releaseAmountBaseUnits) <= 0n) reasons.push("Release amount must be greater than zero.");
  if (new Date(input.policy.deadline).getTime() < new Date(input.evaluatedAt).getTime()) reasons.push("Policy deadline has passed.");

  const outcome = reasons.length > 0
    ? "BLOCK"
    : input.observation.confidenceBps < 8_500
      ? "NEEDS_REVIEW"
      : "PASS";

  return PolicyDecisionSchema.parse({
    outcome,
    reasons,
    policyVersion: input.policy.version,
    policyHash: "0x" + "0".repeat(64),
    evaluatedAt: input.evaluatedAt
  });
}

export const ReleaseGateResultSchema = z.object({
  outcome: z.enum(["PASS", "BLOCK", "NEEDS_REVIEW"]),
  reasons: z.array(z.string()),
  policyVersion: z.string().min(1),
  evaluatedAt: IsoDateSchema
});

export type ReleaseGateResult = z.infer<typeof ReleaseGateResultSchema>;

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
    : input.observation.confidenceBps < 8_500
      ? "NEEDS_REVIEW"
      : "PASS";

  return ReleaseGateResultSchema.parse({ outcome, reasons, policyVersion: input.policyVersion, evaluatedAt: input.evaluatedAt });
}
