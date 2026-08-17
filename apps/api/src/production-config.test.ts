import { describe, expect, it } from "vitest";
import { validateProductionEnvironment, validateProductionRuntime } from "./production-config";

const validProductionEnvironment = {
  NODE_ENV: "production",
  PROOFFLOW_SESSION_SECRET: "session-secret",
  PROOFFLOW_API_TOKEN: "api-token",
  PROOFFLOW_METRICS_TOKEN: "metrics-token",
  PROOFFLOW_AI_API_KEY: "ai-key",
  PROOFFLOW_AI_API_URL: "https://ai.example/v1/chat/completions",
  XLAYER_RPC_URL: "https://rpc.example/xlayer",
  XLAYER_CHAIN_ID: "1952",
  PROOFFLOW_VAULT_ADDRESS: `0x${"1".repeat(40)}`,
  PROOFFLOW_ALLOWED_ORIGIN: "https://app.example",
  PROOFFLOW_DB_PATH: "/data/proofflow.sqlite",
  PROOFFLOW_EVIDENCE_DIR: "/data/evidence",
  PROOFFLOW_CLAMD_SOCKET: "/run/clamav/clamd.ctl",
  PROOFFLOW_ALLOW_UNSCANNED_EVIDENCE: "false",
  PROOFFLOW_EVIDENCE_REQUIRE_AUTH: "true",
  PROOFFLOW_EVIDENCE_MAX_BYTES: "10485760"
};

describe("production environment validation", () => {
  it("does not require production credentials outside production", () => {
    expect(() => validateProductionEnvironment({ NODE_ENV: "development" })).not.toThrow();
  });

  it("reports missing required production variables", () => {
    expect(() => validateProductionEnvironment({ NODE_ENV: "production" })).toThrow(/PROOFFLOW_SESSION_SECRET is required/);
    expect(() => validateProductionEnvironment({ NODE_ENV: "production" })).toThrow(/PROOFFLOW_AI_API_KEY is required/);
    expect(() => validateProductionEnvironment({ NODE_ENV: "production" })).toThrow(/PROOFFLOW_VAULT_ADDRESS is required/);
  });

  it("accepts a complete X Layer testnet production configuration", () => {
    expect(() => validateProductionEnvironment(validProductionEnvironment)).not.toThrow();
  });

  it("rejects the wrong chain and malformed service configuration", () => {
    expect(() => validateProductionEnvironment({ ...validProductionEnvironment, XLAYER_CHAIN_ID: "196", XLAYER_RPC_URL: "http://rpc.example", PROOFFLOW_AI_API_URL: "not-a-url", PROOFFLOW_VAULT_ADDRESS: "0x1234" })).toThrow(/XLAYER_CHAIN_ID must be 1952/);
  });

  it("rejects production evidence settings that weaken or bypass scanning", () => {
    expect(() => validateProductionEnvironment({ ...validProductionEnvironment, PROOFFLOW_ALLOW_UNSCANNED_EVIDENCE: "true" })).toThrow(/must be false/);
    expect(() => validateProductionEnvironment({ ...validProductionEnvironment, PROOFFLOW_EVIDENCE_REQUIRE_AUTH: "false" })).toThrow(/must be true/);
    expect(() => validateProductionEnvironment({ ...validProductionEnvironment, PROOFFLOW_CLAMD_SOCKET: "/tmp/clamd.sock" })).toThrow(/must be \/run\/clamav\/clamd\.ctl/);
  });

  it("rejects non-durable production storage paths", () => {
    expect(() => validateProductionEnvironment({ ...validProductionEnvironment, PROOFFLOW_DB_PATH: "./data/proofflow.sqlite" })).toThrow(/must be \/data\/proofflow.sqlite/);
    expect(() => validateProductionEnvironment({ ...validProductionEnvironment, PROOFFLOW_EVIDENCE_DIR: "./data/evidence" })).toThrow(/must be \/data\/evidence/);
  });

  it("requires the production database and evidence storage configuration", () => {
    expect(() => validateProductionEnvironment({ ...validProductionEnvironment, PROOFFLOW_DB_PATH: "" })).toThrow(/PROOFFLOW_DB_PATH is required/);
    expect(() => validateProductionEnvironment({ ...validProductionEnvironment, PROOFFLOW_EVIDENCE_DIR: "" })).toThrow(/PROOFFLOW_EVIDENCE_DIR is required/);
  });
});

describe("production runtime validation", () => {
  const successfulRuntime = {
    mkdir: async () => undefined,
    readdir: async () => ["main.cvd", "daily.cld", "bytecode.cvd"],
    writeFile: async () => undefined,
    rm: async () => undefined,
    pingScanner: async () => undefined,
    runScanner: async () => "CLEAN" as const
  };

  it("checks the scanner and writable storage before startup", async () => {
    const calls: string[] = [];
    await expect(validateProductionRuntime(validProductionEnvironment, {
      ...successfulRuntime,
      pingScanner: async () => { calls.push("ping"); },
      mkdir: async (path) => { calls.push(`mkdir:${path}`); return undefined; },
      runScanner: async (path) => { calls.push(`scan:${path}`); return "CLEAN"; }
    })).resolves.toBeUndefined();
    expect(calls).toContain("ping");
    expect(calls).toContain("mkdir:/data");
    expect(calls).toContain("mkdir:/data/evidence");
    expect(calls.some((call) => call.replaceAll("\\", "/").startsWith("scan:/data/evidence/quarantine/startup/"))).toBe(true);
  });

  it("fails when clamd is unavailable", async () => {
    await expect(validateProductionRuntime(validProductionEnvironment, {
      ...successfulRuntime,
      pingScanner: async () => { throw new Error("ENOENT"); }
    })).rejects.toThrow(/clamd is unavailable/);
  });

  it("fails when ClamAV database definitions are missing", async () => {
    await expect(validateProductionRuntime(validProductionEnvironment, {
      ...successfulRuntime,
      readdir: async () => []
    })).rejects.toThrow(/no supported ClamAV database files/);
  });

  it("fails when the ClamAV readiness scan fails", async () => {
    await expect(validateProductionRuntime(validProductionEnvironment, {
      ...successfulRuntime,
      runScanner: async () => "MALWARE"
    })).rejects.toThrow(/explicit clean verdict/);
  });

  it("fails when production storage is not writable", async () => {
    await expect(validateProductionRuntime(validProductionEnvironment, {
      ...successfulRuntime,
      writeFile: async () => { throw new Error("EACCES"); }
    })).rejects.toThrow(/persistent storage is not writable/);
  });

  it("fails when the evidence directory is not writable", async () => {
    await expect(validateProductionRuntime(validProductionEnvironment, {
      ...successfulRuntime,
      writeFile: async (path) => {
        if (String(path).replaceAll("\\", "/").startsWith("/data/evidence/")) throw new Error("EACCES");
      }
    })).rejects.toThrow(/evidence directory is not writable/);
  });
});
