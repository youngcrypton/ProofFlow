import { z } from "zod";

export const XLAYER_TESTNET_CHAIN_ID = 1952 as const;
export const XLAYER_TESTNET_CHAIN_HEX = "0x7a0" as const;
export const XLAYER_TESTNET_RPC_URL = "https://testrpc.xlayer.tech/terigon" as const;
export const XLAYER_TESTNET_EXPLORER_URL = "https://www.okx.com/web3/explorer/xlayer-test" as const;
export const XLAYER_MAINNET_CHAIN_ID = 196 as const;

export const XLAYER_TESTNET = {
  id: XLAYER_TESTNET_CHAIN_ID,
  hexId: XLAYER_TESTNET_CHAIN_HEX,
  name: "X Layer Testnet",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrl: XLAYER_TESTNET_RPC_URL,
  explorerUrl: XLAYER_TESTNET_EXPLORER_URL
} as const;
export type WorkspaceRole = "client" | "contractor";

export function normalizeEvmAddress(value: string): string {
  return value.toLowerCase();
}
export const MIN_PASS_CONFIDENCE_BPS = 9_000 as const;

export enum JobState {
  DRAFT = "DRAFT",
  AWAITING_FUNDING = "AWAITING_FUNDING",
  FUNDED = "FUNDED",
  EVIDENCE_SUBMITTED = "EVIDENCE_SUBMITTED",
  UNDER_REVIEW = "UNDER_REVIEW",
  REVIEWED = "REVIEWED",
  READY_TO_RELEASE = "READY_TO_RELEASE",
  RELEASE_PENDING = "RELEASE_PENDING",
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

export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;

export const PolicySchema = z.object({
  version: z.string().min(1).max(64),
  requiredEvidence: z.array(EvidenceTypeSchema).min(1).max(12),
  minimumConfidenceBps: z.number().int().min(0).max(10_000),
  releaseAmountBaseUnits: DecimalIntegerSchema,
  deadline: IsoDateSchema
}).superRefine((policy, ctx) => {
  if (new Set(policy.requiredEvidence).size !== policy.requiredEvidence.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["requiredEvidence"], message: "Required evidence types must be unique." });
  }
});

export type Policy = z.infer<typeof PolicySchema>;

export const AgreementCreateInputSchema = z.object({
  title: z.string().min(1).max(120),
  description: z.string().max(1_000).default(""),
  acceptanceCriteria: z.string().max(2_000).default(""),
  payer: EvmAddressSchema,
  recipient: EvmAddressSchema,
  tokenAddress: EvmAddressSchema,
  amountBaseUnits: DecimalIntegerSchema,
  deadline: IsoDateSchema,
  policy: PolicySchema
}).superRefine((value, ctx) => {
  if (BigInt(value.policy.releaseAmountBaseUnits) > BigInt(value.amountBaseUnits)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["policy", "releaseAmountBaseUnits"], message: "Release amount cannot exceed agreement amount" });
  }
});

export const AgreementSchema = z.object({
  title: z.string().min(1).max(120),
  description: z.string().max(1_000),
  acceptanceCriteria: z.string().max(2_000).default(""),
  payer: EvmAddressSchema,
  recipient: EvmAddressSchema,
  tokenAddress: EvmAddressSchema,
  amountBaseUnits: DecimalIntegerSchema,
  deadline: IsoDateSchema,
  policy: PolicySchema,
  id: z.string().min(1),
  policyHash: Hash32Schema,
  vaultAddress: EvmAddressSchema.optional(),
  state: z.nativeEnum(JobState),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema
});

export const AgreementCreateRequestSchema = AgreementCreateInputSchema;

export type AgreementCreateInput = z.infer<typeof AgreementCreateInputSchema>;

export type Agreement = z.infer<typeof AgreementSchema>;

export function agreementMatchesWorkspace(agreement: Agreement, role: WorkspaceRole, walletAddress: string): boolean {
  const normalizedWallet = normalizeEvmAddress(walletAddress);
  const identity = role === "client" ? agreement.payer : agreement.recipient;
  return normalizeEvmAddress(identity) === normalizedWallet;
}

export function canonicalizePolicy(policy: Policy): string {
  const parsed = PolicySchema.parse(policy);
  return JSON.stringify({
    version: parsed.version,
    requiredEvidence: [...parsed.requiredEvidence].sort(),
    minimumConfidenceBps: parsed.minimumConfidenceBps,
    releaseAmountBaseUnits: parsed.releaseAmountBaseUnits,
    deadline: parsed.deadline
  });
}

export const EvidenceItemSchema = z.object({
  type: EvidenceTypeSchema,
  name: z.string().min(1).max(160),
  mediaType: z.string().min(1).max(120),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/, "Invalid SHA-256 digest"),
  uri: z.string().refine((value) => value.startsWith("/api/v1/evidence/blobs/") || /^https?:\/\//.test(value), "Evidence URI must be an HTTPS/HTTP URL or ProofFlow blob path")
});

export const EvidenceManifestContentSchema = z.object({
  agreementId: z.string().min(1),
  submittedBy: EvmAddressSchema,
  submittedAt: IsoDateSchema,
  explanation: z.string().max(10_000).optional(),
  notes: z.string().max(5_000).optional(),
  items: z.array(EvidenceItemSchema).min(1).max(50)
});

export const EvidenceManifestSchema = EvidenceManifestContentSchema.extend({ manifestHash: Hash32Schema });
export type EvidenceManifestContent = z.infer<typeof EvidenceManifestContentSchema>;
export type EvidenceManifest = z.infer<typeof EvidenceManifestSchema>;

export function canonicalizeEvidenceManifest(manifest: EvidenceManifestContent): string {
  const parsed = EvidenceManifestContentSchema.parse(manifest);
  return JSON.stringify({
    agreementId: parsed.agreementId,
    submittedBy: parsed.submittedBy.toLowerCase(),
    submittedAt: parsed.submittedAt,
    explanation: parsed.explanation ?? "",
    notes: parsed.notes ?? "",
    items: [...parsed.items].sort((a, b) => `${a.type}:${a.name}:${a.sha256}`.localeCompare(`${b.type}:${b.name}:${b.sha256}`))
  });
}

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

export const ReviewerProviderSchema = z.object({
  provider: z.string().min(1).max(80),
  model: z.string().min(1).max(160),
  modelVersion: z.string().min(1).max(160),
  promptVersion: z.string().min(1).max(80),
  promptHash: Hash32Schema
});

export const ReviewRunSchema = z.object({
  id: z.string().min(1),
  agreementId: z.string().min(1),
  evidenceManifestHash: Hash32Schema,
  provider: ReviewerProviderSchema,
  observation: ReviewObservationSchema,
  inputHash: Hash32Schema,
  outputHash: Hash32Schema,
  status: z.enum(["SUCCEEDED", "NEEDS_REVIEW", "FAILED"]),
  createdAt: IsoDateSchema,
  completedAt: IsoDateSchema.optional(),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/).optional()
});

export type ReviewerProvider = z.infer<typeof ReviewerProviderSchema>;
export type ReviewRun = z.infer<typeof ReviewRunSchema>;

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
  policyHash: string;
  observation: ReviewObservation;
  manifestTypes: EvidenceType[];
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
    : input.observation.confidenceBps < MIN_PASS_CONFIDENCE_BPS
      ? "NEEDS_REVIEW"
      : "PASS";

  return PolicyDecisionSchema.parse({
    outcome,
    reasons,
    policyVersion: input.policy.version,
    policyHash: input.policyHash,
    evaluatedAt: input.evaluatedAt
  });
}

export const SettlementIntentSchema = z.object({
  id: z.string().min(1),
  agreementId: z.string().min(1),
  idempotencyKey: z.string().min(8).max(128),
  amountBaseUnits: DecimalIntegerSchema,
  recipient: EvmAddressSchema,
  tokenAddress: EvmAddressSchema,
  policyHash: Hash32Schema,
  evidenceManifestHash: Hash32Schema,
  transactionHash: Hash32Schema.optional(),
  authorizedBy: EvmAddressSchema.optional(),
  chainId: z.number().int().positive().optional(),
  state: z.enum(["CREATED", "AWAITING_AUTHORIZATION", "SUBMITTED", "CONFIRMED", "FAILED", "UNKNOWN"]),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema
});

export type SettlementIntent = z.infer<typeof SettlementIntentSchema>;

export const AuditEventSchema = z.object({
  id: z.string().min(1),
  sequence: z.number().int().positive(),
  aggregateType: z.enum(["AGREEMENT", "EVIDENCE", "POLICY_DECISION", "SETTLEMENT_INTENT"]),
  aggregateId: z.string().min(1),
  eventType: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
  actor: z.string().min(1).max(120),
  occurredAt: IsoDateSchema,
  correlationId: z.string().min(1).max(120),
  payloadHash: Hash32Schema,
  previousEventHash: Hash32Schema,
  eventHash: Hash32Schema
});

export type AuditEvent = z.infer<typeof AuditEventSchema>;

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
    : input.observation.confidenceBps < MIN_PASS_CONFIDENCE_BPS
      ? "NEEDS_REVIEW"
      : "PASS";

  return ReleaseGateResultSchema.parse({ outcome, reasons, policyVersion: input.policyVersion, evaluatedAt: input.evaluatedAt });
}
