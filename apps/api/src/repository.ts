import type { Agreement, AuditEvent, EvidenceManifest, ReviewRun, SettlementIntent } from "@proofflow/domain";

export type AuditEventInput = Omit<AuditEvent, "id" | "sequence" | "payloadHash" | "previousEventHash" | "eventHash">;

export type VaultAssociationErrorCode = "AGREEMENT_NOT_FOUND" | "VAULT_ALREADY_ASSIGNED" | "VAULT_ALREADY_CONFIGURED" | "AGREEMENT_STALE";

export class VaultAssociationError extends Error {
  constructor(readonly code: VaultAssociationErrorCode, message: string) {
    super(message);
    this.name = "VaultAssociationError";
  }
}

export interface VaultAssociationInput {
  agreementId: string;
  vaultAddress: string;
  expectedUpdatedAt: string;
  updatedAt: string;
  audit: { input: AuditEventInput; payload: unknown };
}

export interface ProofFlowRepository {
  listAgreements(): Agreement[];
  getAgreement(id: string): Agreement | undefined;
  saveAgreement(agreement: Agreement): void;
  associateVault(input: VaultAssociationInput): Agreement;
  getManifest(agreementId: string): EvidenceManifest | undefined;
  saveManifest(manifest: EvidenceManifest): void;
  getLatestReviewRun(agreementId: string): ReviewRun | undefined;
  saveReviewRun(reviewRun: ReviewRun): void;
  getSettlementIntent(id: string): SettlementIntent | undefined;
  getSettlementIntentByIdempotencyKey(key: string): SettlementIntent | undefined;
  getSettlementIntentByAgreementId(agreementId: string): SettlementIntent | undefined;
  listSettlementIntents(): SettlementIntent[];
  saveSettlementIntent(intent: SettlementIntent): void;
  confirmSettlement(intent: SettlementIntent, agreement: Agreement, audit: { input: AuditEventInput; payload: unknown }): void;
  listAuditEvents(aggregateId: string): AuditEvent[];
  appendAuditEvent(input: AuditEventInput, payload: unknown): AuditEvent;
}
