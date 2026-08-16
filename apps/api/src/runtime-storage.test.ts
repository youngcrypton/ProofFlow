import { describe, expect, it, vi } from "vitest";
import { prepareProductionStorage } from "./runtime-storage";

describe("production storage validation", () => {
  it("does nothing outside production", async () => {
    const getuid = vi.fn(() => 0);
    await prepareProductionStorage({ NODE_ENV: "development" }, { getuid });
    expect(getuid).not.toHaveBeenCalled();
  });

  it("accepts the expected production paths when the API is non-root", async () => {
    await expect(prepareProductionStorage({
      NODE_ENV: "production",
      PROOFFLOW_DB_PATH: "/data/proofflow.sqlite",
      PROOFFLOW_EVIDENCE_DIR: "/data/evidence"
    }, { getuid: () => 1000 })).resolves.toBeUndefined();
  });

  it("rejects production storage outside the mounted /data volume", async () => {
    await expect(prepareProductionStorage({
      NODE_ENV: "production",
      PROOFFLOW_DB_PATH: "/data/proofflow.sqlite",
      PROOFFLOW_EVIDENCE_DIR: "/tmp/untrusted"
    }, { getuid: () => 1000 })).rejects.toThrow(/mounted \/data volume/);
  });

  it("fails closed when the effective UID is unavailable", async () => {
    await expect(prepareProductionStorage({
      NODE_ENV: "production",
      PROOFFLOW_DB_PATH: "/data/proofflow.sqlite",
      PROOFFLOW_EVIDENCE_DIR: "/data/evidence"
    }, { getuid: () => undefined })).rejects.toThrow(/effective UID is unavailable/);
  });

  it("fails closed when the API process is still root", async () => {
    await expect(prepareProductionStorage({
      NODE_ENV: "production",
      PROOFFLOW_DB_PATH: "/data/proofflow.sqlite",
      PROOFFLOW_EVIDENCE_DIR: "/data/evidence"
    }, { getuid: () => 0 })).rejects.toThrow(/must not run as root/);
  });
});
