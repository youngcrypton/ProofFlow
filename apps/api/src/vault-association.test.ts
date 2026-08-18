import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgreementSchema, JobState } from "@proofflow/domain";
import { MemoryRepository } from "./memory-repository";

const vault = "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD";
const normalizedVault = vault.toLowerCase();
const concurrencyVault = "0x00000000000000000000000000000000000000ee";

function agreement(id: string, updatedAt = "2026-08-01T00:00:00.000Z", vaultAddress?: string) {
  return AgreementSchema.parse({
    id,
    title: id,
    description: "Vault association test",
    payer: "0x0000000000000000000000000000000000000001",
    recipient: "0x0000000000000000000000000000000000000002",
    tokenAddress: "0x0000000000000000000000000000000000000003",
    amountBaseUnits: "1000",
    deadline: "2099-01-01T00:00:00.000Z",
    policy: { version: "vault-v1", requiredEvidence: ["invoice"], minimumConfidenceBps: 9000, releaseAmountBaseUnits: "1000", deadline: "2099-01-01T00:00:00.000Z" },
    policyHash: `0x${"1".repeat(64)}`,
    vaultAddress,
    state: JobState.AWAITING_FUNDING,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt
  });
}

function association(id: string, expectedUpdatedAt = "2026-08-01T00:00:00.000Z", address = vault) {
  const updatedAt = "2026-08-02T00:00:00.000Z";
  return {
    agreementId: id,
    vaultAddress: address,
    expectedUpdatedAt,
    updatedAt,
    audit: {
      input: { aggregateType: "AGREEMENT" as const, aggregateId: id, eventType: "AGREEMENT_VAULT_CONFIGURED", actor: "operator", occurredAt: updatedAt, correlationId: id },
      payload: { vaultAddress: address.toLowerCase() }
    }
  };
}

describe("atomic vault association", () => {
  it("linearizes interleaved synchronous memory associations", async () => {
    const repository = new MemoryRepository();
    repository.saveAgreement(agreement("agr_a"));
    repository.saveAgreement(agreement("agr_b"));
    // associateVault is intentionally synchronous: each call is one atomic
    // in-process linearization point, even when scheduled from separate jobs.
    const results = await Promise.allSettled([
      Promise.resolve().then(() => repository.associateVault(association("agr_a"))),
      Promise.resolve().then(() => repository.associateVault(association("agr_b")))
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(repository.listAgreements().filter((item) => item.vaultAddress === normalizedVault)).toHaveLength(1);
    expect(repository.listAuditEvents("agr_a").length + repository.listAuditEvents("agr_b").length).toBe(1);
    expect((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "VAULT_ALREADY_ASSIGNED" });
  });

  it("normalizes case and rejects duplicate, stale, missing, and conflicting associations", () => {
    const repository = new MemoryRepository();
    repository.saveAgreement(agreement("agr_a"));
    repository.saveAgreement(agreement("agr_b"));
    repository.associateVault(association("agr_a"));
    expect(repository.getAgreement("agr_a")?.vaultAddress).toBe(normalizedVault);
    expect(() => repository.associateVault(association("agr_b", undefined, vault.toUpperCase()))).toThrowError(expect.objectContaining({ code: "VAULT_ALREADY_ASSIGNED" }));
    expect(() => repository.associateVault(association("agr_b", "2026-07-01T00:00:00.000Z", "0x00000000000000000000000000000000000000bb"))).toThrowError(expect.objectContaining({ code: "AGREEMENT_STALE" }));
    expect(() => repository.associateVault(association("missing", undefined, "0x00000000000000000000000000000000000000bb"))).toThrowError(expect.objectContaining({ code: "AGREEMENT_NOT_FOUND" }));
    expect(() => repository.associateVault(association("agr_a", "2026-08-02T00:00:00.000Z", "0x00000000000000000000000000000000000000bb"))).toThrowError(expect.objectContaining({ code: "VAULT_ALREADY_CONFIGURED" }));
  });

  it("keeps the memory association and audit atomic when audit validation fails", () => {
    const repository = new MemoryRepository();
    repository.saveAgreement(agreement("agr_a"));
    const input = association("agr_a");
    (input.audit.input as { eventType: string }).eventType = "invalid";
    expect(() => repository.associateVault(input)).toThrow();
    expect(repository.getAgreement("agr_a")?.vaultAddress).toBeUndefined();
    expect(repository.listAuditEvents("agr_a")).toHaveLength(0);
  });

  it("enforces migration, uniqueness, concurrent writers, stale writes, and audit rollback in SQLite", async () => {
    const directory = mkdtempSync(join(tmpdir(), "proofflow-vault-association-"));
    const databasePath = join(directory, "proofflow.sqlite");
    const script = `
      import { Database } from "bun:sqlite";
      import { SqliteRepository } from "./apps/api/src/sqlite-repository.ts";
      const path = ${JSON.stringify(databasePath)};
      const legacy = new Database(path, { create: true });
      legacy.exec("CREATE TABLE agreements (id TEXT PRIMARY KEY, payload TEXT NOT NULL)");
      const base = ${JSON.stringify(agreement("legacy", "2026-08-01T00:00:00.000Z", vault))};
      legacy.query("INSERT INTO agreements (id, payload) VALUES (?1, ?2)").run(base.id, JSON.stringify(base));
      legacy.close();
      const repository = new SqliteRepository(path);
      const migrated = repository.getAgreement("legacy");
      const second = { ...base, id: "agr_b", vaultAddress: undefined };
      const third = { ...base, id: "agr_c", vaultAddress: undefined };
      const fourth = { ...base, id: "agr_d", vaultAddress: undefined };
      const fifth = { ...base, id: "agr_e", vaultAddress: undefined };
      repository.saveAgreement(second); repository.saveAgreement(third); repository.saveAgreement(fourth); repository.saveAgreement(fifth);
      repository.close();
      const firstWriter = new SqliteRepository(path);
      const secondWriter = new SqliteRepository(path);
      const concurrent = await Promise.allSettled([
        Promise.resolve().then(() => firstWriter.associateVault(${JSON.stringify(association("agr_d", undefined, concurrencyVault))})),
        Promise.resolve().then(() => secondWriter.associateVault(${JSON.stringify(association("agr_e", undefined, concurrencyVault))}))
      ]);
      firstWriter.close(); secondWriter.close();
      const afterConcurrent = new SqliteRepository(path);
      const winning = afterConcurrent.listAgreements().filter((item) => item.vaultAddress === ${JSON.stringify(concurrencyVault)});
      let duplicate = ""; try { afterConcurrent.associateVault(${JSON.stringify(association("agr_b", undefined, vault.toUpperCase()))}); } catch (error) { duplicate = error.code; }
      const unique = afterConcurrent.associateVault(${JSON.stringify(association("agr_b", undefined, "0x00000000000000000000000000000000000000bb"))});
      let stale = ""; try { afterConcurrent.associateVault(${JSON.stringify(association("agr_c", "2026-07-01T00:00:00.000Z", "0x00000000000000000000000000000000000000cc"))}); } catch (error) { stale = error.code; }
      let missing = ""; try { afterConcurrent.associateVault(${JSON.stringify(association("missing", undefined, "0x00000000000000000000000000000000000000dd"))}); } catch (error) { missing = error.code; }
      const badAudit = ${JSON.stringify(association("agr_c", undefined, "0x00000000000000000000000000000000000000cc"))}; badAudit.audit.input.eventType = "invalid";
      let auditFailed = false; try { afterConcurrent.associateVault(badAudit); } catch { auditFailed = true; }
      console.log(JSON.stringify({ migrated: migrated?.vaultAddress, concurrent: concurrent.map((item) => item.status === "fulfilled" ? { status: item.status } : { status: item.status, code: item.reason.code }), concurrentVaultOwners: winning.map((item) => item.id), concurrentAuditCount: afterConcurrent.listAuditEvents("agr_d").length + afterConcurrent.listAuditEvents("agr_e").length, duplicate, unique: unique.vaultAddress, stale, missing, auditFailed, rolledBack: afterConcurrent.getAgreement("agr_c")?.vaultAddress ?? null, auditCount: afterConcurrent.listAuditEvents("agr_c").length }));
      afterConcurrent.close();
    `;
    try {
      const bun = process.platform === "win32"
        ? join(process.env.APPDATA ?? "", "npm", "node_modules", "bun", "bin", "bun.exe")
        : "bun";
      const output = execFileSync(bun, ["-e", script], { cwd: process.cwd(), encoding: "utf8" }).trim();
      const result = JSON.parse(output);
      expect(result.migrated).toBe(normalizedVault);
      expect(result.concurrent).toEqual(expect.arrayContaining([{ status: "fulfilled" }, { status: "rejected", code: "VAULT_ALREADY_ASSIGNED" }]));
      expect(result.concurrentVaultOwners).toHaveLength(1);
      expect(result.concurrentAuditCount).toBe(1);
      expect(result.duplicate).toBe("VAULT_ALREADY_ASSIGNED");
      expect(result.unique).toBe("0x00000000000000000000000000000000000000bb");
      expect(result.stale).toBe("AGREEMENT_STALE");
      expect(result.missing).toBe("AGREEMENT_NOT_FOUND");
      expect(result.auditFailed).toBe(true);
      expect(result.rolledBack).toBeNull();
      expect(result.auditCount).toBe(0);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
