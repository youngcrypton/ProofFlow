import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

type ScanResult = { clean: boolean; reason?: string };
type EvidenceScanner = (path: string) => Promise<ScanResult>;

async function defaultScanner(): Promise<ScanResult> {
  if (process.env.NODE_ENV === "test") return { clean: true, reason: "test-fixture-mode" };
  return { clean: false, reason: "SCANNER_UNAVAILABLE" };
}

export const DEFAULT_EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const ALLOWED_MEDIA_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "application/json", "text/plain"]);
const MAGIC = {
  pdf: Buffer.from("25504446", "hex"),
  png: Buffer.from("89504e470d0a1a0a", "hex"),
  jpeg: Buffer.from("ffd8ff", "hex")
};

export type EvidenceScanStatus = "CLEAN" | "REJECTED";
export { ALLOWED_MEDIA_TYPES };
export type EvidenceBlob = {
  digest: `0x${string}`;
  byteLength: number;
  mediaType: string;
  originalName: string;
  scanStatus: EvidenceScanStatus;
};

function digestBytes(bytes: Uint8Array): `0x${string}` {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

function safeName(name: string): string {
  const value = basename(name).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160);
  if (!value || value === "." || value === "..") throw new Error("INVALID_FILENAME");
  return value;
}

function matchesMagic(mediaType: string, bytes: Uint8Array): boolean {
  if (mediaType === "application/pdf") return Buffer.from(bytes.subarray(0, MAGIC.pdf.length)).equals(MAGIC.pdf);
  if (mediaType === "image/png") return Buffer.from(bytes.subarray(0, MAGIC.png.length)).equals(MAGIC.png);
  if (mediaType === "image/jpeg") return Buffer.from(bytes.subarray(0, MAGIC.jpeg.length)).equals(MAGIC.jpeg);
  return true;
}

export class EvidenceStore {
  private readonly root: string;
  private readonly maxBytes: number;
  private readonly scanner: EvidenceScanner;

  constructor(root = process.env.PROOFFLOW_EVIDENCE_DIR ?? "./data/evidence", maxBytes = Number(process.env.PROOFFLOW_EVIDENCE_MAX_BYTES ?? DEFAULT_EVIDENCE_MAX_BYTES), scanner: EvidenceScanner = defaultScanner) {
    this.root = resolve(root);
    this.maxBytes = maxBytes;
    this.scanner = scanner;
  }

  async put(input: { bytes: Uint8Array; mediaType: string; originalName: string }): Promise<EvidenceBlob> {
    if (!Number.isInteger(this.maxBytes) || this.maxBytes < 1) throw new Error("INVALID_STORAGE_LIMIT");
    if (input.bytes.byteLength === 0 || input.bytes.byteLength > this.maxBytes) throw new Error("FILE_TOO_LARGE");
    if (!ALLOWED_MEDIA_TYPES.has(input.mediaType)) throw new Error("UNSUPPORTED_MEDIA_TYPE");
    const originalName = safeName(input.originalName);
    if (!matchesMagic(input.mediaType, input.bytes)) throw new Error("MIME_MISMATCH");
    const digest = digestBytes(input.bytes);
    const hex = digest.slice(2);
    const quarantine = join(this.root, "quarantine", hex.slice(0, 2), `${hex}.upload`);
    const clean = join(this.root, "clean", hex.slice(0, 2), hex);
    const scanPath = join(this.root, "quarantine", hex.slice(0, 2), `${hex}.scan`);
    await mkdir(resolve(quarantine, ".."), { recursive: true });
    await mkdir(resolve(clean, ".."), { recursive: true });
    await writeFile(quarantine, input.bytes, { flag: "wx" }).catch(async (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    const quarantineStat = await stat(quarantine);
    if (quarantineStat.size !== input.bytes.byteLength) {
      await rm(quarantine, { force: true });
      throw new Error("STORAGE_INTEGRITY_FAILURE");
    }
    await rename(quarantine, scanPath);
    const scan = await this.scanner(scanPath);
    if (!scan.clean) {
      throw new Error(scan.reason ?? "SCAN_FAILED");
    }
    try {
      const existing = await stat(clean);
      if (existing.size !== input.bytes.byteLength) throw new Error("STORAGE_INTEGRITY_FAILURE");
      await rm(scanPath, { force: true });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") await rename(scanPath, clean);
      else throw error;
    }
    return { digest, byteLength: input.bytes.byteLength, mediaType: input.mediaType, originalName, scanStatus: "CLEAN" };
  }

  async get(digest: string): Promise<Uint8Array | null> {
    if (!HEX_SHA256.test(digest.replace(/^0x/, ""))) return null;
    const hex = digest.replace(/^0x/, "");
    try {
      const bytes = new Uint8Array(await readFile(join(this.root, "clean", hex.slice(0, 2), hex)));
      if (digestBytes(bytes).slice(2) !== hex) return null;
      return bytes;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}
