import { describe, expect, it } from "vitest";
import {
  AgreementCreateInputSchema,
  AgreementSchema,
  EvmAddressSchema,
  JobState,
  PolicySchema,
  canonicalizePolicy,
  evaluatePolicy,
  evaluateReleaseGate,
  normalizeEvmAddress
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
  const body = "a9D6d8B8ba0EFa9a825CA4618427843C54665eD6";

  it.each(["0x", "XKO", "xko", "Xko"])("accepts %s address input and normalizes it to standard EVM form", (prefix) => {
    expect(EvmAddressSchema.parse(`${prefix}${body}`)).toBe(`0x${body}`);
  });

  it("compares 0x and XKO representations as the same account", () => {
    expect(normalizeEvmAddress(`XKO${body}`)).toBe(normalizeEvmAddress(`0x${body}`));
  });

  it.each(["XKO123", `XKO${"a".repeat(39)}g`, `0x${"a".repeat(39)}g`, `OKB${"a".repeat(40)}`])("rejects malformed address %s", (value) => {
    expect(EvmAddressSchema.safeParse(value).success).toBe(false);
  });

  it("persists XKO agreement addresses in standard EVM form", () => {
    const parsed = AgreementCreateInputSchema.parse({
      title: "XKO agreement", description: "", payer: `XKO${body}`, recipient: `xko${"b".repeat(40)}`,
      tokenAddress: `0x${"c".repeat(40)}`, amountBaseUnits: "100", deadline: "2026-12-31T00:00:00.000Z", policy: basePolicy
    });
    expect(parsed.payer).toBe(`0x${body}`);
    expect(parsed.recipient).toBe(`0x${"b".repeat(40)}`);
    expect(() => AgreementSchema.parse({ ...parsed, id: "agr_xko", policyHash: `0x${"1".repeat(64)}`, state: JobState.DRAFT, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" })).not.toThrow();
  });

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
