import { describe, expect, it } from "vitest";
import { JobState, PolicySchema, evaluatePolicy, evaluateReleaseGate } from "./index";

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
  minimumConfidenceBps: 8_000,
  releaseAmountBaseUnits: "1000000",
  deadline: "2099-08-07T00:00:00.000Z"
});

describe("evaluatePolicy", () => {
  it("passes complete, high-confidence evidence", () => {
    expect(evaluatePolicy({
      policy: basePolicy,
      observation: baseObservation,
      manifestTypes: ["invoice"],
      manifestIntegrity: true,
      evaluatedAt: "2026-08-07T00:00:00.000Z"
    })).toMatchObject({ outcome: "PASS", reasons: [] });
  });

  it("blocks missing required evidence", () => {
    expect(evaluatePolicy({
      policy: basePolicy,
      observation: baseObservation,
      manifestTypes: [],
      manifestIntegrity: true,
      evaluatedAt: "2026-08-07T00:00:00.000Z"
    }).outcome).toBe("BLOCK");
  });

  it("requires review for uncertain AI output", () => {
    expect(evaluatePolicy({
      policy: basePolicy,
      observation: { ...baseObservation, confidenceBps: 8_400 },
      manifestTypes: ["invoice"],
      manifestIntegrity: true,
      evaluatedAt: "2026-08-07T00:00:00.000Z"
    }).outcome).toBe("NEEDS_REVIEW");
  });
});

describe("evaluateReleaseGate", () => {
  it("passes a funded reviewed agreement", () => {
    expect(evaluateReleaseGate({
      manifestIntegrity: true,
      observation: baseObservation,
      deterministicRulesPass: true,
      agreementState: JobState.FUNDED,
      milestoneStatus: "REVIEWED",
      humanOverride: false,
      policyVersion: "invoice-v1",
      evaluatedAt: "2026-08-07T00:00:00.000Z"
    })).toMatchObject({ outcome: "PASS", reasons: [] });
  });

  it("blocks every non-funded agreement", () => {
    expect(evaluateReleaseGate({
      manifestIntegrity: true,
      observation: baseObservation,
      deterministicRulesPass: true,
      agreementState: JobState.DRAFT,
      milestoneStatus: "REVIEWED",
      humanOverride: false,
      policyVersion: "invoice-v1",
      evaluatedAt: "2026-08-07T00:00:00.000Z"
    }).outcome).toBe("BLOCK");
  });
});
