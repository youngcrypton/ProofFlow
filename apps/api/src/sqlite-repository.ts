import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { AgreementSchema, AuditEventSchema, EvidenceManifestSchema, SettlementIntentSchema } from "@proofflow/domain";
import type { Agreement, AuditEvent, EvidenceManifest, SettlementIntent } from "@proofflow/domain";
import type { AuditEventInput, ProofFlowRepository } from "./repository";

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
      CREATE TABLE IF NOT EXISTS settlement_intents (id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit_events (aggregate_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_hash TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, PRIMARY KEY (aggregate_id, sequence));
    `);
  }

  listAgreements(): Agreement[] {
    return this.db.query("SELECT payload FROM agreements ORDER BY rowid ASC").all().map((row) => AgreementSchema.parse(JSON.parse((row as { payload: string }).payload)));
  }

  getAgreement(id: string): Agreement | undefined {
    const row = this.db.query("SELECT payload FROM agreements WHERE id = ?1").get(id) as { payload: string } | null;
    return row ? AgreementSchema.parse(JSON.parse(row.payload)) : undefined;
  }

  saveAgreement(agreement: Agreement): void {
    this.db.query("INSERT INTO agreements (id, payload) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload").run(agreement.id, JSON.stringify(agreement));
  }

  getManifest(agreementId: string): EvidenceManifest | undefined {
    const row = this.db.query("SELECT payload FROM manifests WHERE agreement_id = ?1").get(agreementId) as { payload: string } | null;
    return row ? EvidenceManifestSchema.parse(JSON.parse(row.payload)) : undefined;
  }

  saveManifest(manifest: EvidenceManifest): void {
    this.db.query("INSERT INTO manifests (agreement_id, payload) VALUES (?1, ?2) ON CONFLICT(agreement_id) DO UPDATE SET payload = excluded.payload").run(manifest.agreementId, JSON.stringify(manifest));
  }

  getSettlementIntent(id: string): SettlementIntent | undefined {
    const row = this.db.query("SELECT payload FROM settlement_intents WHERE id = ?1").get(id) as { payload: string } | null;
    return row ? SettlementIntentSchema.parse(JSON.parse(row.payload)) : undefined;
  }

  getSettlementIntentByIdempotencyKey(key: string): SettlementIntent | undefined {
    const row = this.db.query("SELECT payload FROM settlement_intents WHERE idempotency_key = ?1").get(key) as { payload: string } | null;
    return row ? SettlementIntentSchema.parse(JSON.parse(row.payload)) : undefined;
  }

  saveSettlementIntent(intent: SettlementIntent): void {
    this.db.query("INSERT INTO settlement_intents (id, idempotency_key, payload) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload").run(intent.id, intent.idempotencyKey, JSON.stringify(intent));
  }

  listAuditEvents(aggregateId: string): AuditEvent[] {
    return this.db.query("SELECT payload FROM audit_events WHERE aggregate_id = ?1 ORDER BY sequence ASC").all(aggregateId).map((row) => AuditEventSchema.parse(JSON.parse((row as { payload: string }).payload)));
  }

  appendAuditEvent(input: AuditEventInput, payload: unknown): AuditEvent {
    const append = this.db.transaction(() => {
      const previous = this.db.query("SELECT event_hash FROM audit_events WHERE aggregate_id = ?1 ORDER BY sequence DESC LIMIT 1").get(input.aggregateId) as { event_hash: string } | null;
      const count = this.db.query("SELECT COUNT(*) AS count FROM audit_events WHERE aggregate_id = ?1").get(input.aggregateId) as { count: number };
      const previousEventHash = previous?.event_hash ?? ZERO_HASH;
      const eventId = `evt_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const sequence = Number(count.count) + 1;
      const payloadHash = hash(JSON.stringify(payload));
      const eventHash = hash(JSON.stringify({ ...input, eventId, sequence, payloadHash, previousEventHash }));
      const event = AuditEventSchema.parse({ ...input, id: eventId, sequence, payloadHash, previousEventHash, eventHash });
      this.db.query("INSERT INTO audit_events (aggregate_id, sequence, event_hash, payload) VALUES (?1, ?2, ?3, ?4)").run(input.aggregateId, sequence, eventHash, JSON.stringify(event));
      return event;
    });
    return append();
  }

  close(): void {
    this.db.close();
  }
}
