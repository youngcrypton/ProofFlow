import { constants } from "node:fs";
import { access, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const REQUIRED_PRODUCTION_VARIABLES = [
  "PROOFFLOW_SESSION_SECRET",
  "PROOFFLOW_API_TOKEN",
  "PROOFFLOW_METRICS_TOKEN",
  "PROOFFLOW_AI_API_KEY",
  "PROOFFLOW_AI_API_URL",
  "XLAYER_RPC_URL",
  "XLAYER_CHAIN_ID",
  "PROOFFLOW_VAULT_ADDRESS",
  "PROOFFLOW_ALLOWED_ORIGIN",
  "PROOFFLOW_DB_PATH",
  "PROOFFLOW_EVIDENCE_DIR",
  "PROOFFLOW_CLAMSCAN_PATH",
  "PROOFFLOW_ALLOW_UNSCANNED_EVIDENCE",
  "PROOFFLOW_EVIDENCE_REQUIRE_AUTH",
  "PROOFFLOW_EVIDENCE_MAX_BYTES"
] as const;

type ProductionVariable = typeof REQUIRED_PRODUCTION_VARIABLES[number];
type Environment = Partial<Record<ProductionVariable | "NODE_ENV", string | undefined>>;

type RuntimeDependencies = {
  access: typeof access;
  mkdir: typeof mkdir;
  readdir: (path: string) => Promise<string[]>;
  writeFile: typeof writeFile;
  rm: typeof rm;
  runScanner: (executable: string, path: string) => Promise<{ exitCode: number; output: string }>;
};

export function validateProductionEnvironment(environment: Environment = process.env): void {
  if (environment.NODE_ENV !== "production") return;
  const errors = REQUIRED_PRODUCTION_VARIABLES
    .filter((name) => !environment[name]?.trim())
    .map((name) => `${name} is required`);

  const chainId = environment.XLAYER_CHAIN_ID?.trim();
  if (chainId && chainId !== "1952") errors.push("XLAYER_CHAIN_ID must be 1952 for the current X Layer testnet release");
  const rpcUrl = environment.XLAYER_RPC_URL?.trim();
  if (rpcUrl && !isHttpsUrl(rpcUrl)) errors.push("XLAYER_RPC_URL must be a valid HTTPS URL");
  const aiApiUrl = environment.PROOFFLOW_AI_API_URL?.trim();
  if (aiApiUrl && !isHttpsUrl(aiApiUrl)) errors.push("PROOFFLOW_AI_API_URL must be a valid HTTPS URL");
  const vaultAddress = environment.PROOFFLOW_VAULT_ADDRESS?.trim();
  if (vaultAddress && !/^0x[a-fA-F0-9]{40}$/.test(vaultAddress)) errors.push("PROOFFLOW_VAULT_ADDRESS must be a valid EVM address");
  if (environment.PROOFFLOW_DB_PATH?.trim() !== "/data/proofflow.sqlite") errors.push("PROOFFLOW_DB_PATH must be /data/proofflow.sqlite in production");
  if (environment.PROOFFLOW_EVIDENCE_DIR?.trim() !== "/data/evidence") errors.push("PROOFFLOW_EVIDENCE_DIR must be /data/evidence in production");
  if (environment.PROOFFLOW_CLAMSCAN_PATH?.trim() !== "/usr/bin/clamscan") errors.push("PROOFFLOW_CLAMSCAN_PATH must be /usr/bin/clamscan in production");
  if (environment.PROOFFLOW_ALLOW_UNSCANNED_EVIDENCE?.trim() !== "false") errors.push("PROOFFLOW_ALLOW_UNSCANNED_EVIDENCE must be false in production");
  if (environment.PROOFFLOW_EVIDENCE_REQUIRE_AUTH?.trim() !== "true") errors.push("PROOFFLOW_EVIDENCE_REQUIRE_AUTH must be true in production");
  if (environment.PROOFFLOW_EVIDENCE_MAX_BYTES?.trim() !== "10485760") errors.push("PROOFFLOW_EVIDENCE_MAX_BYTES must be 10485760 in production");

  if (errors.length > 0) throw new Error(`Invalid production configuration:\n- ${errors.join("\n- ")}`);
}

export async function validateProductionRuntime(environment: Environment = process.env, dependencies: Partial<RuntimeDependencies> = {}): Promise<void> {
  if (environment.NODE_ENV !== "production") return;
  const runtime: RuntimeDependencies = {
    access,
    mkdir,
    readdir: (path) => readdir(path),
    writeFile,
    rm,
    runScanner: runClamScan,
    ...dependencies
  };
  const databasePath = environment.PROOFFLOW_DB_PATH!;
  const evidenceDirectory = environment.PROOFFLOW_EVIDENCE_DIR!;
  const scannerPath = environment.PROOFFLOW_CLAMSCAN_PATH!;

  try {
    await runtime.access(scannerPath, constants.X_OK);
  } catch {
    throw new Error(`Production readiness failed: clamscan is unavailable or not executable at ${scannerPath}`);
  }

  let definitionFiles: string[];
  try {
    definitionFiles = await runtime.readdir("/var/lib/clamav");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Production readiness failed: ClamAV database directory is unavailable at /var/lib/clamav: ${message}`);
  }
  if (!definitionFiles.some((name) => /\.(?:cvd|cld|cud)$/i.test(name))) {
    throw new Error("Production readiness failed: no supported ClamAV database files found in /var/lib/clamav");
  }

  await verifyWritableDirectory("persistent storage", "/data", runtime);
  await verifyWritableDirectory("SQLite directory", dirname(databasePath), runtime);
  await verifyWritableDirectory("evidence directory", evidenceDirectory, runtime);

  const quarantineDirectory = join(evidenceDirectory, "quarantine", "startup");
  await runtime.mkdir(quarantineDirectory, { recursive: true });
  const scanProbe = join(quarantineDirectory, `.readiness-${process.pid}-${Date.now()}.txt`);
  try {
    await runtime.writeFile(scanProbe, "ProofFlow ClamAV production readiness check.\n", { flag: "wx" });
    const scan = await runtime.runScanner(scannerPath, scanProbe);
    if (scan.exitCode !== 0) {
      throw new Error(`Production readiness failed: ClamAV could not scan with loaded definitions (exit ${scan.exitCode})${scan.output ? `: ${scan.output}` : ""}`);
    }
  } finally {
    await runtime.rm(scanProbe, { force: true });
  }
}

async function verifyWritableDirectory(label: string, path: string, runtime: RuntimeDependencies): Promise<void> {
  try {
    await runtime.mkdir(path, { recursive: true });
    const probe = join(path, `.proofflow-write-check-${process.pid}-${Date.now()}`);
    await runtime.writeFile(probe, "ready", { flag: "wx" });
    await runtime.rm(probe, { force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Production readiness failed: ${label} is not writable at ${path}: ${message}`);
  }
}

async function runClamScan(executable: string, path: string): Promise<{ exitCode: number; output: string }> {
  const processHandle = Bun.spawn([executable, "--no-summary", "--stdout", path], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text()
  ]);
  return { exitCode, output: `${stdout}\n${stderr}`.trim().slice(0, 500) };
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
