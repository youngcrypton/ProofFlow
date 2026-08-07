import { describe, expect, it } from "vitest";
import { ProofFlowVaultClient, XLayerClient } from "./xlayer";

type Fetcher = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

function mockFetch(result: string, status = 200): Fetcher {
  return async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status, headers: { "content-type": "application/json" } });
}

describe("XLayerClient", () => {
  it("rejects non-HTTPS RPC URLs", () => {
    expect(() => new XLayerClient({ rpcUrl: "http://localhost:8545" })).toThrow("HTTPS");
  });

  it("validates the expected chain before returning status", async () => {
    let calls = 0;
    const fetcher: Fetcher = async (_input, init) => {
      calls += 1;
      const request = JSON.parse(String(init?.body)) as { method: string };
      const result = request.method === "eth_chainId" ? "0x7a0" : "0x10";
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { headers: { "content-type": "application/json" } });
    };
    const status = await new XLayerClient({ rpcUrl: "https://example.com", fetcher }).getStatus();
    expect(status.chainId).toBe(1952);
    expect(status.blockNumber).toBe(16n);
    expect(calls).toBe(2);
  });

  it("fails closed on a wrong chain", async () => {
    await expect(new XLayerClient({ rpcUrl: "https://example.com", fetcher: mockFetch("0xc4") }).assertExpectedNetwork()).rejects.toThrow("Wrong X Layer network");
  });

  it("encodes vault transaction previews with the deployed ABI", () => {
    const client = new ProofFlowVaultClient({ rpcUrl: "https://example.com", vaultAddress: "0x00000000000000000000000000000000000000aa" });
    expect(client.previewFund(1000n)).toEqual({ to: "0x00000000000000000000000000000000000000aa", value: 1000n, data: "0xb60d4288", method: "fund" });
    expect(client.previewCommitEvidence(`0x${"11".repeat(32)}` as `0x${string}`).data).toBe(`0x48942a68${"11".repeat(32)}`);
    expect(client.previewRelease().data).toBe("0x86d1a69f");
    expect(() => client.previewFund(0n)).toThrow("greater than zero");
  });
});
