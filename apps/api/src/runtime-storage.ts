type Environment = Partial<Record<"NODE_ENV" | "PROOFFLOW_DB_PATH" | "PROOFFLOW_EVIDENCE_DIR", string | undefined>>;

type StorageDependencies = {
  getuid: () => number | undefined;
};

export async function prepareProductionStorage(environment: Environment = process.env, dependencies: Partial<StorageDependencies> = {}): Promise<void> {
  if (environment.NODE_ENV !== "production") return;

  if (environment.PROOFFLOW_DB_PATH !== "/data/proofflow.sqlite" || environment.PROOFFLOW_EVIDENCE_DIR !== "/data/evidence") {
    throw new Error("Production storage validation failed: production storage paths must use the mounted /data volume");
  }

  const runtime: StorageDependencies = {
    getuid: () => process.getuid?.(),
    ...dependencies
  };

  const uid = runtime.getuid();
  if (uid === undefined) throw new Error("Production storage validation failed: effective UID is unavailable");
  if (uid === 0) throw new Error("Production storage validation failed: API process must not run as root");
}
