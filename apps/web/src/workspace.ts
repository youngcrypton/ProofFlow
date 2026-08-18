import { normalizeEvmAddress } from "@proofflow/domain";
import type { Agreement, WorkspaceRole } from "@proofflow/domain";

export const WORKSPACE_ROLE_KEY = "proofflow_workspace_role";
const WORKSPACE_ROLES: WorkspaceRole[] = ["client", "contractor"];
type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function readWorkspaceRole(storage?: StorageLike): WorkspaceRole | null {
  if (typeof window === "undefined" && !storage) return null;
  const source = storage ?? window.localStorage;
  const value = source.getItem(WORKSPACE_ROLE_KEY);
  return value && WORKSPACE_ROLES.includes(value as WorkspaceRole) ? value as WorkspaceRole : null;
}

export function persistWorkspaceRole(storage: StorageLike, role: WorkspaceRole): void {
  storage.setItem(WORKSPACE_ROLE_KEY, role);
}

export function workspaceRoleLabel(role: WorkspaceRole): string {
  return role === "client" ? "Client" : "Contractor";
}

export function workspaceQuery(role: WorkspaceRole | null, walletAddress: string | null): string {
  return role && walletAddress ? `?role=${role}` : "";
}

export function canFundAgreement(agreement: Agreement, walletAddress: string | null): boolean {
  return agreement.state === "AWAITING_FUNDING" && Boolean(agreement.vaultAddress) && Boolean(walletAddress) && normalizeEvmAddress(agreement.payer) === normalizeEvmAddress(walletAddress!);
}

export function canSubmitEvidence(agreement: Agreement, walletAddress: string | null): boolean {
  return agreement.state === "FUNDED" && Boolean(walletAddress) && normalizeEvmAddress(agreement.recipient) === normalizeEvmAddress(walletAddress!);
}
