import { describe, expect, it } from "vitest";
import { agreementMatchesWorkspace, AgreementSchema, JobState } from "@proofflow/domain";
import { persistWorkspaceRole, readWorkspaceRole, workspaceQuery, WORKSPACE_ROLE_KEY } from "./workspace";

const agreement = AgreementSchema.parse({
  id: "agr_role_test",
  title: "Role test",
  description: "Role matching",
  payer: "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD",
  recipient: "0x1234567890123456789012345678901234567890",
  tokenAddress: "0x0000000000000000000000000000000000000003",
  amountBaseUnits: "1000",
  deadline: "2099-01-01T00:00:00.000Z",
  policy: { version: "role-v1", requiredEvidence: ["invoice"], minimumConfidenceBps: 9000, releaseAmountBaseUnits: "1000", deadline: "2099-01-01T00:00:00.000Z" },
  policyHash: `0x${"a".repeat(64)}`,
  state: JobState.AWAITING_FUNDING,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z"
});

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value)
  };
}

describe("workspace role behavior", () => {
  it("persists and validates client and contractor roles", () => {
    const store = storage();
    expect(readWorkspaceRole(store)).toBeNull();
    persistWorkspaceRole(store, "client");
    expect(store.values.get(WORKSPACE_ROLE_KEY)).toBe("client");
    expect(readWorkspaceRole(store)).toBe("client");
    persistWorkspaceRole(store, "contractor");
    expect(readWorkspaceRole(store)).toBe("contractor");
    store.setItem(WORKSPACE_ROLE_KEY, "admin");
    expect(readWorkspaceRole(store)).toBeNull();
  });

  it("matches client and contractor agreements case-insensitively", () => {
    expect(agreementMatchesWorkspace(agreement, "client", agreement.payer.toLowerCase())).toBe(true);
    expect(agreementMatchesWorkspace(agreement, "contractor", agreement.recipient.toUpperCase())).toBe(true);
    expect(agreementMatchesWorkspace(agreement, "client", agreement.recipient)).toBe(false);
    expect(agreementMatchesWorkspace(agreement, "contractor", "0x9999999999999999999999999999999999999999")).toBe(false);
  });

  it("sends only the selected role because the backend derives wallet ownership from the signed session", () => {
    expect(workspaceQuery("contractor", agreement.recipient)).toBe("?role=contractor");
    expect(workspaceQuery("client", agreement.payer)).toBe("?role=client");
    expect(workspaceQuery(null, agreement.payer)).toBe("");
  });
});
