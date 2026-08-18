import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { AgreementSchema, AuditEventSchema, EvidenceManifestSchema, ReviewRunSchema, SettlementIntentSchema, normalizeEvmAddress } from "@proofflow/domain";
import type { Agreement, AuditEvent, EvidenceManifest, ReviewRun, SettlementIntent } from "@proofflow/domain";

export type StoredAuditEvent = AuditEvent & { payload: unknown };
import { VaultAssociationError } from "./repository";
import type { AuditEventInput, ProofFlowRepository, VaultAssociationInput } from "./repository";

function copy<T>(value: T): T { return structuredClone(value); }

const ZERO_HASH = `0x${"0".repeat(64)}`;

function hash(value: string): `0x${string}` {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

export class SqliteRepository implements ProofFlowRepository {
  private readonly db: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS agreements (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS manifests (agreement_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS review_runs (id TEXT PRIMARY KEY, agreement_id TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settlement_intents (id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit_events (aggregate_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_hash TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, PRIMARY KEY (aggregate_id, sequence));
    `);
    this.migrateAgreementVaultAddresses();
  }

  private migrateAgreementVaultAddresses(): void {
    const columns = this.db.query("PRAGMA table_info(agreements)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "vault_address")) this.db.exec("ALTER TABLE agreements ADD COLUMN vault_address TEXT");
    const migrate = this.db.transaction(() => {
      const rows = this.db.query("SELECT id, payload FROM agreements ORDER BY rowid ASC").all() as Array<{ id: string; payload: string }>;
      const assigned = new Map<string, string>();
      for (const row of rows) {
        const agreement = AgreementSchema.parse(JSON.parse(row.payload));
        if (!agreement.vaultAddress) continue;
        const normalized = normalizeEvmAddress(agreement.vaultAddress);
        const existing = assigned.get(normalized);
        if (existing && existing !== agreement.id) throw new Error(`Existing agreements ${existing} and ${agreement.id} share vault ${normalized}`);
        assigned.set(normalized, agreement.id);
        const normalizedAgreement = AgreementSchema.parse({ ...agreement, vaultAddress: normalized });
        this.db.query("UPDATE agreements SET payload = ?1, vault_address = ?2 WHERE id = ?3").run(JSON.stringify(normalizedAgreement), normalized, agreement.id);
      }
      this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS agreements_vault_address_unique ON agreements(vault_address) WHERE vault_address IS NOT NULL");
    });
    migrate();
  }

  listAgreements(): Agreement[] {
    return this.db.query("SELECT payload FROM agreements ORDER BY rowid ASC").all().map((row) => AgreementSchema.parse(JSON.parse((row as { payload: string }).payload)));
  }

  getAgreement(id: string): Agreement | undefined {
    const row = this.db.query("SELECT payload FROM agreements WHERE id = ?1").get(id) as { payload: string } | null;
    return row ? AgreementSchema.parse(JSON.parse(row.payload)) : undefined;
  }

  saveAgreement(agreement: Agreement): void {
    const vaultAddress = agreement.vaultAddress ? normalizeEvmAddress(agreement.vaultAddress) : null;
    const normalized = AgreementSchema.parse({ ...agreement, vaultAddress: vaultAddress ?? undefined });
    try {
      this.db.query("INSERT INTO agreements (id, payload, vault_address) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, vault_address = excluded.vault_address").run(normalized.id, JSON.stringify(normalized), vaultAddress);
    } catch (error) {
      if (isVaultUniqueConstraint(error)) throw new VaultAssociationError("VAULT_ALREADY_ASSIGNED", "This vault is already assigned to another agreement.");
      throw error;
    }
  }

  associateVault(input: VaultAssociationInput): Agreement {
    const associate = this.db.transaction(() => {
      const row = this.db.query("SELECT payload FROM agreements WHERE id = ?1").get(input.agreementId) as { payload: string } | null;
      if (!row) throw new VaultAssociationError("AGREEMENT_NOT_FOUND", "Agreement not found.");
      const agreement = AgreementSchema.parse(JSON.parse(row.payload));
      if (agreement.updatedAt !== input.expectedUpdatedAt) throw new VaultAssociationError("AGREEMENT_STALE", "Agreement changed before vault association completed.");
      const vaultAddress = normalizeEvmAddress(input.vaultAddress);
      if (agreement.vaultAddress) {
        if (normalizeEvmAddress(agreement.vaultAddress) === vaultAddress) return agreement;
        throw new VaultAssociationError("VAULT_ALREADY_CONFIGURED", "This agreement already has a different vault.");
      }
      const updated = AgreementSchema.parse({ ...agreement, vaultAddress, updatedAt: input.updatedAt });
      try {
        const result = this.db.query("UPDATE agreements SET payload = ?1, vault_address = ?2 WHERE id = ?3 AND vault_address IS NULL AND json_extract(payload, '$.updatedAt') = ?4").run(JSON.stringify(updated), vaultAddress, agreement.id, input.expectedUpdatedAt);
        if (Number(result.changes) !== 1) throw new VaultAssociationError("AGREEMENT_STALE", "Agreement changed before vault association completed.");
      } catch (error) {
        if (isVaultUniqueConstraint(error)) throw new VaultAssociationError("VAULT_ALREADY_ASSIGNED", "This vault is already assigned to another agreement.");
        throw error;
      }
      this.appendAuditEventRow(input.audit.input, input.audit.payload);
      return updated;
    });
    return associate();
  }

  getManifest(agreementId: string): EvidenceManifest | undefined {
    const row = this.db.query("SELECT payload FROM manifests WHERE agreement_id = ?1").get(agreementId) as { payload: string } | null;
    return row ? EvidenceManifestSchema.parse(JSON.parse(row.payload)) : undefined;
  }

  saveManifest(manifest: EvidenceManifest): void {
    this.db.query("INSERT INTO manifests (agreement_id, payload) VALUES (?1, ?2) ON CONFLICT(agreement_id) DO UPDATE SET payload = excluded.payload").run(manifest.agreementId, JSON.stringify(manifest));
  }

  getLatestReviewRun(agreementId: string): ReviewRun | undefined {
    const row = this.db.query("SELECT payload FROM review_runs WHERE agreement_id = ?1 ORDER BY created_at DESC LIMIT 1").get(agreementId) as { payload: string } | null;
    return row ? ReviewRunSchema.parse(JSON.parse(row.payload)) : undefined;
  }

  saveReviewRun(reviewRun: ReviewRun): void {
    this.db.query("INSERT INTO review_runs (id, agreement_id, created_at, payload) VALUES (?1, ?2, ?3, ?4)").run(reviewRun.id, reviewRun.agreementId, reviewRun.createdAt, JSON.stringify(reviewRun));
  }

  getSettlementIntent(id: string): SettlementIntent | undefined {
    const row = this.db.query("SELECT payload FROM settlement_intents WHERE id = ?1").get(id) as { payload: string } | null;
    return row ? SettlementIntentSchema.parse(JSON.parse(row.payload)) : undefined;
  }

  getSettlementIntentByIdempotencyKey(key: string): SettlementIntent | undefined {
    const row = this.db.query("SELECT payload FROM settlement_intents WHERE idempotency_key = ?1").get(key) as { payload: string } | null;
    return row ? SettlementIntentSchema.parse(JSON.parse(row.payload)) : undefined;
  }

  getSettlementIntentByAgreementId(agreementId: string): SettlementIntent | undefined {
    const row = this.db.query("SELECT payload FROM settlement_intents WHERE json_extract(payload, '$.agreementId') = ?1 ORDER BY rowid DESC LIMIT 1").get(agreementId) as { payload: string } | null;
    return row ? SettlementIntentSchema.parse(JSON.parse(row.payload)) : undefined;
  }

  listSettlementIntents(): SettlementIntent[] {
    return this.db.query("SELECT payload FROM settlement_intents ORDER BY rowid ASC").all().map((row) => SettlementIntentSchema.parse(JSON.parse((row as { payload: string }).payload)));
  }

  saveSettlementIntent(intent: SettlementIntent): void {
    this.db.query("INSERT INTO settlement_intents (id, idempotency_key, payload) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload").run(intent.id, intent.idempotencyKey, JSON.stringify(intent));
  }

  confirmSettlement(intent: SettlementIntent, agreement: Agreement, audit: { input: AuditEventInput; payload: unknown }): void {
    const commit = this.db.transaction(() => {
      this.db.query("INSERT INTO settlement_intents (id, idempotency_key, payload) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload").run(intent.id, intent.idempotencyKey, JSON.stringify(intent));
      this.db.query("INSERT INTO agreements (id, payload) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload").run(agreement.id, JSON.stringify(agreement));
      this.appendAuditEvent(audit.input, audit.payload);
    });
    commit();
  }

  listAuditEvents(aggregateId: string): StoredAuditEvent[] {
    return this.db.query("SELECT payload FROM audit_events WHERE aggregate_id = ?1 ORDER BY sequence ASC").all(aggregateId).map((row) => { const stored = JSON.parse((row as { payload: string }).payload) as { payload?: unknown }; const { payload, ...event } = stored; return { ...AuditEventSchema.parse(event), payload }; });
  }

  appendAuditEvent(input: AuditEventInput, payload: unknown): StoredAuditEvent {
    const append = this.db.transaction(() => this.appendAuditEventRow(input, payload));
    return append();
  }

  private appendAuditEventRow(input: AuditEventInput, payload: unknown): StoredAuditEvent {
    const previous = this.db.query("SELECT event_hash FROM audit_events WHERE aggregate_id = ?1 ORDER BY sequence DESC LIMIT 1").get(input.aggregateId) as { event_hash: string } | null;
    const count = this.db.query("SELECT COUNT(*) AS count FROM audit_events WHERE aggregate_id = ?1").get(input.aggregateId) as { count: number };
    const previousEventHash = previous?.event_hash ?? ZERO_HASH;
    const eventId = `evt_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const sequence = Number(count.count) + 1;
    const payloadHash = hash(JSON.stringify(payload));
    const eventHash = hash(JSON.stringify({ ...input, eventId, sequence, payloadHash, previousEventHash }));
    const event = { ...AuditEventSchema.parse({ ...input, id: eventId, sequence, payloadHash, previousEventHash, eventHash }), payload: copy(payload) };
    this.db.query("INSERT INTO audit_events (aggregate_id, sequence, event_hash, payload) VALUES (?1, ?2, ?3, ?4)").run(input.aggregateId, sequence, eventHash, JSON.stringify(event));
    return event;
  }

  close(): void {
    this.db.close();
  }
}

function isVaultUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed: agreements\.vault_address/i.test(error.message);
}
