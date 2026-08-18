import { describe, expect, it } from "vitest";
import { ProofFlowVaultClient, XLayerClient } from "./xlayer";
import { keccak256, toBytes } from "viem";

type Fetcher = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

function mockFetch(result: string, status = 200): Fetcher {
  return async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status, headers: { "content-type": "application/json" } });
}

function vaultSnapshotFetch(overrides: Partial<Record<string, string>> = {}): Fetcher {
  let callIndex = 0;
  const values = [
    `0x${"0".repeat(24)}0000000000000000000000000000000000000001`,
    `0x${"0".repeat(24)}0000000000000000000000000000000000000002`, "0x3e8", "0x0", `0x${"11".repeat(32)}`,
    `0x${"00".repeat(32)}`, "0x0", "0x0", "0x0", "0x0", "0x0"
  ];
  return async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string; params?: Array<{ data?: string }> };
    const result = request.method === "eth_chainId" ? "0x7a0" : request.method === "eth_getBalance" ? "0x0" : values[callIndex++];
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { headers: { "content-type": "application/json" } });
  };
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

  it("resolves vault status when the configured vault matches the agreement", async () => {
    const client = new ProofFlowVaultClient({ rpcUrl: "https://example.com", vaultAddress: "0x00000000000000000000000000000000000000aa", fetcher: vaultSnapshotFetch() });
    const snapshot = await client.assertMatchesAgreement({ payer: "0x0000000000000000000000000000000000000001", recipient: "0x0000000000000000000000000000000000000002", amountBaseUnits: "1000", deadline: "1970-01-01T00:00:00.000Z", policyHash: `0x${"11".repeat(32)}` });
    expect(snapshot.address).toBe("0x00000000000000000000000000000000000000aa");
  });

  it("rejects vault status when the configured vault does not match the agreement", async () => {
    const client = new ProofFlowVaultClient({ rpcUrl: "https://example.com", vaultAddress: "0x00000000000000000000000000000000000000aa", fetcher: vaultSnapshotFetch() });
    await expect(client.assertMatchesAgreement({ payer: "0x0000000000000000000000000000000000000001", recipient: "0x0000000000000000000000000000000000000009", amountBaseUnits: "1000", deadline: "1970-01-01T00:00:00.000Z", policyHash: `0x${"11".repeat(32)}` })).rejects.toThrow("Vault recipient does not match agreement");
  });

  it("fails closed for a vault amount mismatch", async () => {
    const client = new ProofFlowVaultClient({ rpcUrl: "https://example.com", vaultAddress: "0x00000000000000000000000000000000000000aa", fetcher: vaultSnapshotFetch() });
    await expect(client.assertMatchesAgreement({ payer: "0x0000000000000000000000000000000000000001", recipient: "0x0000000000000000000000000000000000000002", amountBaseUnits: "1001", deadline: "1970-01-01T00:00:00.000Z", policyHash: `0x${"11".repeat(32)}` })).rejects.toThrow("Vault amount does not match agreement");
  });

  it("fails closed for a vault policy hash mismatch", async () => {
    const client = new ProofFlowVaultClient({ rpcUrl: "https://example.com", vaultAddress: "0x00000000000000000000000000000000000000aa", fetcher: vaultSnapshotFetch() });
    await expect(client.assertMatchesAgreement({ payer: "0x0000000000000000000000000000000000000001", recipient: "0x0000000000000000000000000000000000000002", amountBaseUnits: "1000", deadline: "1970-01-01T00:00:00.000Z", policyHash: `0x${"22".repeat(32)}` })).rejects.toThrow("Vault policy hash does not match agreement");
  });

  it("fails closed for a vault deadline mismatch", async () => {
    const client = new ProofFlowVaultClient({ rpcUrl: "https://example.com", vaultAddress: "0x00000000000000000000000000000000000000aa", fetcher: vaultSnapshotFetch() });
    await expect(client.assertMatchesAgreement({ payer: "0x0000000000000000000000000000000000000001", recipient: "0x0000000000000000000000000000000000000002", amountBaseUnits: "1000", deadline: "1970-01-01T00:00:01.000Z", policyHash: `0x${"11".repeat(32)}` })).rejects.toThrow("Vault deadline does not match agreement");
  });

  it("rejects funding sent to another agreement vault", async () => {
    const vault = "0x00000000000000000000000000000000000000aa" as const;
    const otherVault = "0x00000000000000000000000000000000000000bb" as const;
    const payer = "0x0000000000000000000000000000000000000001" as const;
    const txHash = `0x${"cd".repeat(32)}` as `0x${string}`;
    const fetcher: Fetcher = async (_input, init) => {
      const method = (JSON.parse(String(init?.body)) as { method: string }).method;
      const result = method === "eth_chainId" ? "0x7a0" : method === "eth_getTransactionByHash" ? { hash: txHash, from: payer, to: otherVault, value: "0x3e8", input: "0xb60d4288" } : { transactionHash: txHash, blockNumber: "0x10", status: "0x1", from: payer, to: otherVault, logs: [] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { headers: { "content-type": "application/json" } });
    };
    await expect(new ProofFlowVaultClient({ rpcUrl: "https://example.com", vaultAddress: vault, fetcher }).verifyFundingTransaction({ transactionHash: txHash, payer, amountBaseUnits: "1000" })).rejects.toThrow("target does not match agreement vault");
  });
  it("verifies an exact successful release transaction", async () => {
    const vault = "0x00000000000000000000000000000000000000aa" as const;
    const payer = "0x0000000000000000000000000000000000000001" as const;
    const recipient = "0x0000000000000000000000000000000000000002" as const;
    const txHash = `0x${"ab".repeat(32)}`;
    const releaseTopic = keccak256(toBytes("Released(address,uint256)"));
    const fetcher: Fetcher = async (_input, init) => {
      const method = (JSON.parse(String(init?.body)) as { method: string }).method;
      const result = method === "eth_chainId"
        ? "0x7a0"
        : method === "eth_getTransactionByHash"
        ? { hash: txHash, from: payer, to: vault, value: "0x0", input: "0x86d1a69f" }
                  : method === "eth_getTransactionReceipt"
          ? { transactionHash: txHash, blockNumber: "0x10", status: "0x1", from: payer, to: vault, logs: [{ address: vault, topics: [releaseTopic, `0x${"0".repeat(24)}${recipient.slice(2)}`], data: `0x${"0".repeat(61)}3e8` }] }
          : method === "eth_blockNumber"
            ? "0x10"
            : null;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { headers: { "content-type": "application/json" } });
    };
    const result = await new ProofFlowVaultClient({ rpcUrl: "https://example.com", vaultAddress: vault, fetcher }).verifyReleaseTransaction({ transactionHash: txHash as `0x${string}`, payer, recipient, amountBaseUnits: "1000" });
    expect(result.receipt.status).toBe("0x1");
    expect(result.confirmationDepth).toBe(1n);
    expect(result.releaseEventVerified).toBe(true);
  });

  it("rejects a successful transaction with the wrong method", async () => {
    const fetcher: Fetcher = async (_input, init) => {
      const method = (JSON.parse(String(init?.body)) as { method: string }).method;
      const result = method === "eth_chainId" ? "0x7a0" : method === "eth_getTransactionByHash" ? { hash: `0x${"ab".repeat(32)}`, from: "0x0000000000000000000000000000000000000001", to: "0x00000000000000000000000000000000000000aa", value: "0x0", input: "0xdeadbeef" } : method === "eth_getTransactionReceipt" ? null : method === "eth_blockNumber" ? "0x10" : null;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { headers: { "content-type": "application/json" } });
    };
    await expect(new ProofFlowVaultClient({ rpcUrl: "https://example.com", vaultAddress: "0x00000000000000000000000000000000000000aa", fetcher }).verifyReleaseTransaction({ transactionHash: `0x${"ab".repeat(32)}` as `0x${string}`, payer: "0x0000000000000000000000000000000000000001", recipient: "0x0000000000000000000000000000000000000002", amountBaseUnits: "1000" })).rejects.toThrow();
  });

});
