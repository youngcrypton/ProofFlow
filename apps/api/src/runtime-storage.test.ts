import { describe, expect, it, vi } from "vitest";
import { prepareProductionStorage } from "./runtime-storage";

describe("production storage preparation", () => {
  it("does nothing outside production", async () => {
    const chownData = vi.fn(async () => ({ exitCode: 0, output: "" }));
    await prepareProductionStorage({ NODE_ENV: "development" }, { chownData });
    expect(chownData).not.toHaveBeenCalled();
  });

  it("leaves an existing non-root runtime for fail-closed writable validation", async () => {
    const chownData = vi.fn(async () => ({ exitCode: 0, output: "" }));
    await prepareProductionStorage({ NODE_ENV: "production", PROOFFLOW_DB_PATH: "/data/proofflow.sqlite", PROOFFLOW_EVIDENCE_DIR: "/data/evidence" }, { getuid: () => 1000, chownData });
    expect(chownData).not.toHaveBeenCalled();
  });

  it("rejects unvalidated production storage paths before privileged filesystem access", async () => {
    const mkdir = vi.fn(async () => undefined);
    const chownData = vi.fn(async () => ({ exitCode: 0, output: "" }));
    await expect(prepareProductionStorage({
      NODE_ENV: "production",
      PROOFFLOW_DB_PATH: "/data/proofflow.sqlite",
      PROOFFLOW_EVIDENCE_DIR: "/tmp/untrusted"
    }, { getuid: () => 0, mkdir, chownData })).rejects.toThrow(/storage paths must be validated/);
    expect(mkdir).not.toHaveBeenCalled();
    expect(chownData).not.toHaveBeenCalled();
  });

  it("prepares the mounted volume and drops root privileges before API startup", async () => {
    let uid = 0;
    const mkdir = vi.fn(async () => undefined);
    const initgroups = vi.fn();
    const setgid = vi.fn();
    const setuid = vi.fn(() => { uid = 1000; });
    await prepareProductionStorage({ NODE_ENV: "production", PROOFFLOW_DB_PATH: "/data/proofflow.sqlite", PROOFFLOW_EVIDENCE_DIR: "/data/evidence" }, {
      getuid: () => uid,
      mkdir,
      chownData: async () => ({ exitCode: 0, output: "" }),
      initgroups,
      setgid,
      setuid
    });
    expect(mkdir).toHaveBeenCalledWith("/data/evidence/quarantine", { recursive: true });
    expect(mkdir).toHaveBeenCalledWith("/data/evidence/clean", { recursive: true });
    expect(initgroups).toHaveBeenCalledWith("bun", "bun");
    expect(setgid).toHaveBeenCalledWith("bun");
    expect(setuid).toHaveBeenCalledWith("bun");
  });

  it("fails closed when mounted-volume ownership cannot be assigned", async () => {
    await expect(prepareProductionStorage({ NODE_ENV: "production", PROOFFLOW_DB_PATH: "/data/proofflow.sqlite", PROOFFLOW_EVIDENCE_DIR: "/data/evidence" }, {
      getuid: () => 0,
      mkdir: async () => undefined,
      chownData: async () => ({ exitCode: 1, output: "Operation not permitted" })
    })).rejects.toThrow(/could not assign \/data/);
  });

  it.each([
    ["initgroups", { initgroups: () => { throw new Error("EPERM"); } }],
    ["setgid", { initgroups: () => undefined, setgid: () => { throw new Error("EPERM"); } }],
    ["setuid", { initgroups: () => undefined, setgid: () => undefined, setuid: () => { throw new Error("EPERM"); } }]
  ] as const)("fails closed when %s fails", async (_step, failingDependency) => {
    await expect(prepareProductionStorage({ NODE_ENV: "production", PROOFFLOW_DB_PATH: "/data/proofflow.sqlite", PROOFFLOW_EVIDENCE_DIR: "/data/evidence" }, {
      getuid: () => 0,
      mkdir: async () => undefined,
      chownData: async () => ({ exitCode: 0, output: "" }),
      ...failingDependency
    })).rejects.toThrow(/could not drop privileges/);
  });

  it("fails closed when setuid returns without changing the effective UID", async () => {
    await expect(prepareProductionStorage({ NODE_ENV: "production", PROOFFLOW_DB_PATH: "/data/proofflow.sqlite", PROOFFLOW_EVIDENCE_DIR: "/data/evidence" }, {
      getuid: () => 0,
      mkdir: async () => undefined,
      chownData: async () => ({ exitCode: 0, output: "" }),
      initgroups: () => undefined,
      setgid: () => undefined,
      setuid: () => undefined
    })).rejects.toThrow(/remained root after privilege drop/);
  });
});
