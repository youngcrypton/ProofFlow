import { createHash, randomUUID } from "node:crypto";
import { AgreementSchema, AuditEventSchema, normalizeEvmAddress } from "@proofflow/domain";
import type { Agreement, AuditEvent, EvidenceManifest, ReviewRun, SettlementIntent } from "@proofflow/domain";

export type StoredAuditEvent = AuditEvent & { payload: unknown };
import { VaultAssociationError } from "./repository";
import type { AuditEventInput, ProofFlowRepository, VaultAssociationInput } from "./repository";

const ZERO_HASH = `0x${"0".repeat(64)}`;

function hash(value: string): `0x${string}` {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function createStoredAuditEvent(events: StoredAuditEvent[], input: AuditEventInput, payload: unknown): StoredAuditEvent {
  const previousEventHash = events.at(-1)?.eventHash ?? ZERO_HASH;
  const eventId = `evt_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const sequence = events.length + 1;
  const payloadHash = hash(JSON.stringify(payload));
  const eventHash = hash(JSON.stringify({ ...input, eventId, sequence, payloadHash, previousEventHash }));
  return { ...AuditEventSchema.parse({ ...input, id: eventId, sequence, payloadHash, previousEventHash, eventHash }), payload: copy(payload) };
}

export class MemoryRepository implements ProofFlowRepository {
  private readonly agreements = new Map<string, Agreement>();
  private readonly manifests = new Map<string, EvidenceManifest>();
  private readonly reviewRuns = new Map<string, ReviewRun[]>();
  private readonly settlementIntents = new Map<string, SettlementIntent>();
  private readonly auditEvents = new Map<string, StoredAuditEvent[]>();

  listAgreements(): Agreement[] {
    return [...this.agreements.values()].map(copy);
  }

  getAgreement(id: string): Agreement | undefined {
    const agreement = this.agreements.get(id);
    return agreement ? copy(agreement) : undefined;
  }

  saveAgreement(agreement: Agreement): void {
    const normalized = agreement.vaultAddress ? normalizeEvmAddress(agreement.vaultAddress) : undefined;
    if (normalized && [...this.agreements.values()].some((item) => item.id !== agreement.id && item.vaultAddress && normalizeEvmAddress(item.vaultAddress) === normalized)) {
      throw new VaultAssociationError("VAULT_ALREADY_ASSIGNED", "This vault is already assigned to another agreement.");
    }
    this.agreements.set(agreement.id, copy(AgreementSchema.parse({ ...agreement, vaultAddress: normalized })));
  }

  associateVault(input: VaultAssociationInput): Agreement {
    const agreement = this.agreements.get(input.agreementId);
    if (!agreement) throw new VaultAssociationError("AGREEMENT_NOT_FOUND", "Agreement not found.");
    if (agreement.updatedAt !== input.expectedUpdatedAt) throw new VaultAssociationError("AGREEMENT_STALE", "Agreement changed before vault association completed.");
    const vaultAddress = normalizeEvmAddress(input.vaultAddress);
    if (agreement.vaultAddress) {
      if (normalizeEvmAddress(agreement.vaultAddress) === vaultAddress) return copy(agreement);
      throw new VaultAssociationError("VAULT_ALREADY_CONFIGURED", "This agreement already has a different vault.");
    }
    if ([...this.agreements.values()].some((item) => item.id !== agreement.id && item.vaultAddress && normalizeEvmAddress(item.vaultAddress) === vaultAddress)) {
      throw new VaultAssociationError("VAULT_ALREADY_ASSIGNED", "This vault is already assigned to another agreement.");
    }
    const updated = AgreementSchema.parse({ ...agreement, vaultAddress, updatedAt: input.updatedAt });
    const events = this.auditEvents.get(input.audit.input.aggregateId) ?? [];
    const event = createStoredAuditEvent(events, input.audit.input, input.audit.payload);
    this.agreements.set(updated.id, copy(updated));
    this.auditEvents.set(input.audit.input.aggregateId, [...events, event]);
    return copy(updated);
  }

  getManifest(agreementId: string): EvidenceManifest | undefined {
    const manifest = this.manifests.get(agreementId);
    return manifest ? copy(manifest) : undefined;
  }

  saveManifest(manifest: EvidenceManifest): void {
    this.manifests.set(manifest.agreementId, copy(manifest));
  }

  getLatestReviewRun(agreementId: string): ReviewRun | undefined {
    const runs = this.reviewRuns.get(agreementId) ?? [];
    const review = runs.at(-1);
    return review ? copy(review) : undefined;
  }

  saveReviewRun(reviewRun: ReviewRun): void {
    const runs = this.reviewRuns.get(reviewRun.agreementId) ?? [];
    this.reviewRuns.set(reviewRun.agreementId, [...runs, copy(reviewRun)]);
  }

  getSettlementIntent(id: string): SettlementIntent | undefined {
    const intent = this.settlementIntents.get(id);
    return intent ? copy(intent) : undefined;
  }

  getSettlementIntentByIdempotencyKey(key: string): SettlementIntent | undefined {
    const intent = [...this.settlementIntents.values()].find((item) => item.idempotencyKey === key);
    return intent ? copy(intent) : undefined;
  }

  getSettlementIntentByAgreementId(agreementId: string): SettlementIntent | undefined {
    const intent = [...this.settlementIntents.values()].find((item) => item.agreementId === agreementId);
    return intent ? copy(intent) : undefined;
  }

  listSettlementIntents(): SettlementIntent[] {
    return [...this.settlementIntents.values()].map(copy);
  }

  saveSettlementIntent(intent: SettlementIntent): void {
    this.settlementIntents.set(intent.id, copy(intent));
  }

  confirmSettlement(intent: SettlementIntent, agreement: Agreement, audit: { input: AuditEventInput; payload: unknown }): void {
    this.settlementIntents.set(intent.id, copy(intent));
    this.agreements.set(agreement.id, copy(agreement));
    this.appendAuditEvent(audit.input, audit.payload);
  }

  listAuditEvents(aggregateId: string): StoredAuditEvent[] {
    return (this.auditEvents.get(aggregateId) ?? []).map(copy);
  }

  appendAuditEvent(input: AuditEventInput, payload: unknown): AuditEvent {
    const events = this.auditEvents.get(input.aggregateId) ?? [];
    const event = createStoredAuditEvent(events, input, payload);
    this.auditEvents.set(input.aggregateId, [...events, event]);
    return copy(event);
  }
}
