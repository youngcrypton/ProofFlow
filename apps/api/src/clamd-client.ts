import { connect } from "node:net";

export type ClamdScanResult = "CLEAN" | "MALWARE";

let scanTail: Promise<void> = Promise.resolve();

function withScanLock<T>(work: () => Promise<T>): Promise<T> {
  const run = scanTail.then(work, work);
  scanTail = run.then(() => undefined, () => undefined);
  return run;
}

function request(command: Buffer, expected: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(clamdSocketPath());
    let output = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("CLAMD_TIMEOUT")); }, clamdTimeoutMs());
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(command));
    socket.on("data", (chunk: string) => {
      output += chunk;
      if (output.includes("\0") || output.includes("\n")) {
        clearTimeout(timer); socket.end();
        const response = output.replaceAll("\0", "").trim();
        if (!expected.test(response)) reject(new Error("CLAMD_MALFORMED_RESPONSE"));
        else resolve(response);
      }
    });
    socket.on("error", () => { clearTimeout(timer); reject(new Error("CLAMD_UNAVAILABLE")); });
    socket.on("close", () => clearTimeout(timer));
  });
}

export async function clamdPing(): Promise<void> {
  const response = await request(Buffer.from("PING\0"), /^PONG$/);
  if (response !== "PONG") throw new Error("CLAMD_NOT_READY");
}

export function scanFile(path: string): Promise<ClamdScanResult> {
  return withScanLock(async () => {
    const { readFile } = await import("node:fs/promises");
    const bytes = await readFile(path);
    const chunks: Buffer[] = [];
    const socket = connect(clamdSocketPath());
    return await new Promise<ClamdScanResult>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("CLAMD_TIMEOUT")); }, clamdTimeoutMs());
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write("zINSTREAM\0");
        for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
          const chunk = bytes.subarray(offset, offset + 64 * 1024);
          const header = Buffer.alloc(4); header.writeUInt32BE(chunk.length);
          socket.write(header); socket.write(chunk);
        }
        socket.end(Buffer.alloc(4));
      });
      socket.on("data", (chunk: string) => { output += chunk; });
      socket.on("close", () => {
        clearTimeout(timer);
        const response = output.replaceAll("\0", "").trim();
        if (/stream: OK$/i.test(response)) resolve("CLEAN");
        else if (/FOUND$/i.test(response)) resolve("MALWARE");
        else reject(new Error(response ? "CLAMD_MALFORMED_RESPONSE" : "CLAMD_UNAVAILABLE"));
      });
      socket.on("error", () => { clearTimeout(timer); reject(new Error("CLAMD_UNAVAILABLE")); });
    });
  });
}

export function clamdSocketPath(): string {
  return process.env.PROOFFLOW_CLAMD_SOCKET ?? "/run/clamav/clamd.ctl";
}

function clamdTimeoutMs(): number {
  const value = Number(process.env.PROOFFLOW_CLAMD_TIMEOUT_MS ?? 30_000);
  return Number.isFinite(value) && value > 0 ? value : 30_000;
}
