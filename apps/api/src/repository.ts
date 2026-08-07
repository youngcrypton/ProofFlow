import type { Agreement, AuditEvent, EvidenceManifest, ReviewRun, SettlementIntent } from "@proofflow/domain";

export type AuditEventInput = Omit<AuditEvent, "id" | "sequence" | "payloadHash" | "previousEventHash" | "eventHash">;

export interface ProofFlowRepository {
  listAgreements(): Agreement[];
  getAgreement(id: string): Agreement | undefined;
  saveAgreement(agreement: Agreement): void;
  getManifest(agreementId: string): EvidenceManifest | undefined;
  saveManifest(manifest: EvidenceManifest): void;
  getLatestReviewRun(agreementId: string): ReviewRun | undefined;
  saveReviewRun(reviewRun: ReviewRun): void;
  getSettlementIntent(id: string): SettlementIntent | undefined;
  getSettlementIntentByIdempotencyKey(key: string): SettlementIntent | undefined;
  saveSettlementIntent(intent: SettlementIntent): void;
  listAuditEvents(aggregateId: string): AuditEvent[];
  appendAuditEvent(input: AuditEventInput, payload: unknown): AuditEvent;
}
