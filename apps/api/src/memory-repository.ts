import { createHash, randomUUID } from "node:crypto";
import { AuditEventSchema } from "@proofflow/domain";
import type { Agreement, AuditEvent, EvidenceManifest, ReviewRun, SettlementIntent } from "@proofflow/domain";
import type { AuditEventInput, ProofFlowRepository } from "./repository";

const ZERO_HASH = `0x${"0".repeat(64)}`;

function hash(value: string): `0x${string}` {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryRepository implements ProofFlowRepository {
  private readonly agreements = new Map<string, Agreement>();
  private readonly manifests = new Map<string, EvidenceManifest>();
  private readonly reviewRuns = new Map<string, ReviewRun[]>();
  private readonly settlementIntents = new Map<string, SettlementIntent>();
  private readonly auditEvents = new Map<string, AuditEvent[]>();

  listAgreements(): Agreement[] {
    return [...this.agreements.values()].map(copy);
  }

  getAgreement(id: string): Agreement | undefined {
    const agreement = this.agreements.get(id);
    return agreement ? copy(agreement) : undefined;
  }

  saveAgreement(agreement: Agreement): void {
    this.agreements.set(agreement.id, copy(agreement));
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

  listAuditEvents(aggregateId: string): AuditEvent[] {
    return (this.auditEvents.get(aggregateId) ?? []).map(copy);
  }

  appendAuditEvent(input: AuditEventInput, payload: unknown): AuditEvent {
    const events = this.auditEvents.get(input.aggregateId) ?? [];
    const previousEventHash = events.at(-1)?.eventHash ?? ZERO_HASH;
    const eventId = `evt_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const sequence = events.length + 1;
    const payloadHash = hash(JSON.stringify(payload));
    const eventHash = hash(JSON.stringify({ ...input, eventId, sequence, payloadHash, previousEventHash }));
    const event = AuditEventSchema.parse({ ...input, id: eventId, sequence, payloadHash, previousEventHash, eventHash });
    this.auditEvents.set(input.aggregateId, [...events, event]);
    return copy(event);
  }
}
