import { describe, expect, it } from "vitest";
import {
  AgreementCreateInputSchema,
  JobState,
  PolicySchema,
  canonicalizePolicy,
  evaluatePolicy,
  evaluateReleaseGate
} from "./index";

const baseObservation = {
  requiredEvidencePresent: true,
  extractedFacts: [],
  contradictions: [],
  missingItems: [],
  confidenceBps: 9_500
};

const basePolicy = PolicySchema.parse({
  version: "invoice-v1",
  requiredEvidence: ["invoice"],
  minimumConfidenceBps: 9_000,
  releaseAmountBaseUnits: "100",
  deadline: "2026-12-31T00:00:00.000Z"
});

describe("agreement validation", () => {
  it("rejects a policy that releases more than the agreement amount", () => {
    const result = AgreementCreateInputSchema.safeParse({
      title: "Invalid agreement",
      payer: "0x0000000000000000000000000000000000000001",
      recipient: "0x0000000000000000000000000000000000000002",
      tokenAddress: "0x0000000000000000000000000000000000000003",
      amountBaseUnits: "99",
      deadline: "2026-12-31T00:00:00.000Z",
      policy: { ...basePolicy, releaseAmountBaseUnits: "100" }
    });
    expect(result.success).toBe(false);
  });

  it("canonicalizes policy evidence order deterministically", () => {
    expect(canonicalizePolicy(basePolicy)).toBe(canonicalizePolicy({ ...basePolicy, requiredEvidence: ["invoice"] }));
  });
});

describe("evaluatePolicy", () => {
  it("passes complete high-confidence evidence", () => {
    expect(evaluatePolicy({ policy: basePolicy, policyHash: `0x${"1".repeat(64)}`, observation: baseObservation, manifestTypes: ["invoice"], manifestIntegrity: true, evaluatedAt: "2026-08-07T00:00:00.000Z" }).outcome).toBe("PASS");
  });

  it("blocks missing required evidence", () => {
    expect(evaluatePolicy({ policy: basePolicy, policyHash: `0x${"1".repeat(64)}`, observation: baseObservation, manifestTypes: [], manifestIntegrity: true, evaluatedAt: "2026-08-07T00:00:00.000Z" }).outcome).toBe("BLOCK");
  });

  it("requires review for uncertain AI output", () => {
    expect(evaluatePolicy({ policy: { ...basePolicy, minimumConfidenceBps: 8_500 }, policyHash: `0x${"1".repeat(64)}`, observation: { ...baseObservation, confidenceBps: 8_600 }, manifestTypes: ["invoice"], manifestIntegrity: true, evaluatedAt: "2026-08-07T00:00:00.000Z" }).outcome).toBe("NEEDS_REVIEW");
  });
});

describe("evaluateReleaseGate", () => {
  it("blocks an unfunded agreement", () => {
    expect(evaluateReleaseGate({ manifestIntegrity: true, observation: baseObservation, deterministicRulesPass: true, agreementState: JobState.DRAFT, milestoneStatus: "REVIEWED", humanOverride: false, policyVersion: "invoice-v1", evaluatedAt: "2026-08-07T00:00:00.000Z" }).outcome).toBe("BLOCK");
  });
});
