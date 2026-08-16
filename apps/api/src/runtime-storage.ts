import { mkdir } from "node:fs/promises";

type Environment = Partial<Record<"NODE_ENV" | "PROOFFLOW_DB_PATH" | "PROOFFLOW_EVIDENCE_DIR", string | undefined>>;

type StorageDependencies = {
  getuid: () => number | undefined;
  mkdir: typeof mkdir;
  chownData: () => Promise<{ exitCode: number; output: string }>;
  initgroups: (user: string, extraGroup: string | number) => void;
  setgid: (identity: string | number) => void;
  setuid: (identity: string | number) => void;
};

type PosixProcess = typeof process & {
  initgroups: (user: string, extraGroup: string | number) => void;
  setgid: (identity: string | number) => void;
  setuid: (identity: string | number) => void;
};

export async function prepareProductionStorage(environment: Environment = process.env, dependencies: Partial<StorageDependencies> = {}): Promise<void> {
  if (environment.NODE_ENV !== "production") return;

  if (environment.PROOFFLOW_DB_PATH !== "/data/proofflow.sqlite" || environment.PROOFFLOW_EVIDENCE_DIR !== "/data/evidence") {
    throw new Error("Production storage preparation failed: production storage paths must be validated before privileged filesystem preparation");
  }

  const posixProcess = process as PosixProcess;
  const runtime: StorageDependencies = {
    getuid: () => process.getuid?.(),
    mkdir,
    chownData: chownProductionData,
    initgroups: (user, extraGroup) => posixProcess.initgroups(user, extraGroup),
    setgid: (identity) => posixProcess.setgid(identity),
    setuid: (identity) => posixProcess.setuid(identity),
    ...dependencies
  };

  if (runtime.getuid() !== 0) return;

  await runtime.mkdir("/data/evidence/quarantine", { recursive: true });
  await runtime.mkdir("/data/evidence/clean", { recursive: true });

  const ownership = await runtime.chownData();
  if (ownership.exitCode !== 0) {
    throw new Error(`Production storage preparation failed: could not assign /data to the bun runtime user (exit ${ownership.exitCode})${ownership.output ? `: ${ownership.output}` : ""}`);
  }

  try {
    runtime.initgroups("bun", "bun");
    runtime.setgid("bun");
    runtime.setuid("bun");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Production storage preparation failed: could not drop privileges to the bun runtime user: ${message}`);
  }

  if (runtime.getuid() === 0) {
    throw new Error("Production storage preparation failed: API process remained root after privilege drop");
  }
}

async function chownProductionData(): Promise<{ exitCode: number; output: string }> {
  const processHandle = Bun.spawn(["chown", "-R", "bun:bun", "/data"], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text()
  ]);
  return { exitCode, output: `${stdout}\n${stderr}`.trim().slice(0, 500) };
}
