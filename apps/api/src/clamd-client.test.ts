import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { clamdPing, scanFile } from "./clamd-client";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); delete process.env.PROOFFLOW_CLAMD_SOCKET; delete process.env.PROOFFLOW_CLAMD_TIMEOUT_MS; });

async function fixture(response: string, delay = 0) {
  const root = await mkdtemp(join(tmpdir(), "proofflow-clamd-"));
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\proofflow-clamd-${crypto.randomUUID()}` : join(root, "clamd.sock");
  const file = join(root, "evidence.txt");
  await writeFile(file, "safe evidence");
  const server = createServer((socket) => {
    let input = Buffer.alloc(0); let replied = false;
    socket.on("data", (chunk) => {
      input = Buffer.concat([input, chunk]);
      const complete = input.equals(Buffer.from("PING\0")) || (input.length > 14 && input.subarray(-4).equals(Buffer.alloc(4)));
      if (complete && !replied) { replied = true; setTimeout(() => socket.end(`${response}\0`), delay); }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  process.env.PROOFFLOW_CLAMD_SOCKET = socketPath;
  cleanup.push(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  return file;
}

describe("clamd Unix socket client", () => {
  it("requires an explicit PONG readiness response", async () => {
    await fixture("PONG");
    await expect(clamdPing()).resolves.toBeUndefined();
  });

  it("fails closed when the socket is unavailable", async () => {
    process.env.PROOFFLOW_CLAMD_SOCKET = process.platform === "win32" ? `\\\\.\\pipe\\missing-${crypto.randomUUID()}` : join(tmpdir(), `missing-${crypto.randomUUID()}.sock`);
    await expect(clamdPing()).rejects.toThrow("CLAMD_UNAVAILABLE");
  });

  it("fails closed on timeout and malformed responses", async () => {
    process.env.PROOFFLOW_CLAMD_TIMEOUT_MS = "5";
    const delayed = await fixture("stream: OK", 50);
    await expect(scanFile(delayed)).rejects.toThrow("CLAMD_TIMEOUT");
    await cleanup.pop()!();
    process.env.PROOFFLOW_CLAMD_TIMEOUT_MS = "1000";
    const malformed = await fixture("unexpected response");
    await expect(scanFile(malformed)).rejects.toThrow("CLAMD_MALFORMED_RESPONSE");
  });

  it("distinguishes explicit clean and malware verdicts", async () => {
    const clean = await fixture("stream: OK");
    await expect(scanFile(clean)).resolves.toBe("CLEAN");
    await cleanup.pop()!();
    const malware = await fixture("stream: Eicar-Signature FOUND");
    await expect(scanFile(malware)).resolves.toBe("MALWARE");
  });

  it("serializes concurrent scans", async () => {
    let active = 0; let maximum = 0;
    const root = await mkdtemp(join(tmpdir(), "proofflow-clamd-serial-"));
    const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\proofflow-clamd-${crypto.randomUUID()}` : join(root, "clamd.sock");
    const file = join(root, "evidence.txt"); await writeFile(file, "safe");
    const server = createServer((socket) => {
      let input = Buffer.alloc(0); let started = false;
      socket.on("data", (chunk) => {
        input = Buffer.concat([input, chunk]);
        if (!started && input.length > 14 && input.subarray(-4).equals(Buffer.alloc(4))) {
          started = true; active++; maximum = Math.max(maximum, active);
          setTimeout(() => { active--; socket.end("stream: OK\0"); }, 20);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve)); process.env.PROOFFLOW_CLAMD_SOCKET = socketPath;
    cleanup.push(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
    await Promise.all([scanFile(file), scanFile(file), scanFile(file)]);
    expect(maximum).toBe(1);
  });
});
