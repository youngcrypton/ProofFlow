import { describe, expect, it } from "vitest";
import { JobState, evaluateReleaseGate } from "./index";

const baseInput = {
  manifestIntegrity: true,
  observation: {
    requiredEvidencePresent: true,
    extractedFacts: [],
    contradictions: [],
    missingItems: [],
    confidence: 0.95
  },
  deterministicRulesPass: true,
  agreementState: JobState.FUNDED,
  milestoneStatus: "REVIEWED" as const,
  humanOverride: false,
  policyVersion: "invoice-v1",
  evaluatedAt: "2026-08-07T00:00:00.000Z"
};

describe("evaluateReleaseGate", () => {
  it("passes complete, high-confidence evidence", () => {
    expect(evaluateReleaseGate(baseInput)).toMatchObject({ outcome: "PASS", reasons: [] });
  });

  it("blocks when evidence integrity fails", () => {
    expect(evaluateReleaseGate({ ...baseInput, manifestIntegrity: false }).outcome).toBe("BLOCK");
  });

  it("blocks when policy rules fail", () => {
    expect(evaluateReleaseGate({ ...baseInput, deterministicRulesPass: false }).reasons).toContain("Deterministic policy rules did not pass.");
  });

  it("requires review for uncertain AI output", () => {
    expect(evaluateReleaseGate({ ...baseInput, observation: { ...baseInput.observation, confidence: 0.84 } }).outcome).toBe("NEEDS_REVIEW");
  });

  it("blocks every non-funded agreement", () => {
    expect(evaluateReleaseGate({ ...baseInput, agreementState: JobState.DRAFT }).outcome).toBe("BLOCK");
  });
});
