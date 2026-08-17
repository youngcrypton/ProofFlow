import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { EvidenceStore } from "./evidence-store";

describe("evidence quarantine promotion", () => {
  it("promotes only an explicit clean verdict", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofflow-evidence-"));
    try {
      const store = new EvidenceStore(root, 10 * 1024 * 1024, async () => ({ clean: true }));
      const blob = await store.put({ bytes: new TextEncoder().encode("clean"), mediaType: "text/plain", originalName: "clean.txt" });
      expect(await store.get(blob.digest)).toEqual(new TextEncoder().encode("clean"));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps scanner failures quarantined and outside clean storage", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofflow-evidence-"));
    try {
      const bytes = new TextEncoder().encode("unknown");
      const store = new EvidenceStore(root, 10 * 1024 * 1024, async () => ({ clean: false, reason: "SCANNER_FAILED" }));
      await expect(store.put({ bytes, mediaType: "text/plain", originalName: "unknown.txt" })).rejects.toThrow("SCANNER_FAILED");
      const scanFiles = await import("node:fs/promises").then(({ readdir }) => readdir(join(root, "quarantine"), { recursive: true }));
      expect(scanFiles.some((name) => String(name).endsWith(".scan"))).toBe(true);
      const digest = createHash("sha256").update(bytes).digest("hex");
      await expect(readFile(join(root, "clean", digest.slice(0, 2), digest.slice(2)))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
