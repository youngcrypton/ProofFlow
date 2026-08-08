import { z } from "zod";
import { encodeFunctionData } from "viem";

export const X_LAYER_TESTNET_CHAIN_ID = 1952;
export const X_LAYER_MAINNET_CHAIN_ID = 196;

const RpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.number().int(),
  result: z.string().optional(),
  error: z.object({ code: z.number().int(), message: z.string() }).optional()
});

export interface XLayerClientOptions {
  rpcUrl: string;
  expectedChainId?: number;
  fetcher?: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;
}

export interface XLayerStatus {
  rpcUrl: string;
  chainId: number;
  blockNumber: bigint;
}

export interface TransactionReceipt {
  transactionHash: `0x${string}`;
  blockNumber: bigint;
  status: "0x1" | "0x0";
  from: `0x${string}`;
  to: `0x${string}` | null;
}

const TransactionReceiptSchema = z.object({
  transactionHash: z.string().regex(/^0x[0-9a-f]{64}$/i),
  blockNumber: z.string(),
  status: z.enum(["0x1", "0x0"]),
  from: z.string().regex(/^0x[0-9a-f]{40}$/i),
  to: z.string().regex(/^0x[0-9a-f]{40}$/i).nullable()
});

function hexToNumber(value: string, field: string): number {
  if (!/^0x[0-9a-f]+$/i.test(value)) throw new Error(`Invalid ${field} response`);
  return Number.parseInt(value.slice(2), 16);
}

function hexToBigInt(value: string, field: string): bigint {
  if (!/^0x[0-9a-f]+$/i.test(value)) throw new Error(`Invalid ${field} response`);
  return BigInt(value);
}

export class XLayerClient {
  private readonly rpcUrl: string;
  private readonly expectedChainId: number;
  private readonly fetcher: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

  constructor(options: XLayerClientOptions) {
    if (!options.rpcUrl.startsWith("https://")) throw new Error("X Layer RPC must use HTTPS");
    this.rpcUrl = options.rpcUrl;
    this.expectedChainId = options.expectedChainId ?? X_LAYER_TESTNET_CHAIN_ID;
    this.fetcher = options.fetcher ?? fetch;
  }

  async request(method: string, params: unknown[] = []): Promise<string> {
    const response = await this.fetcher(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
    if (!response.ok) throw new Error(`X Layer RPC returned HTTP ${response.status}`);
    const parsed = RpcResponseSchema.parse(await response.json());
    if (parsed.error) throw new Error(`X Layer RPC ${parsed.error.code}: ${parsed.error.message}`);
    if (!parsed.result) throw new Error(`X Layer RPC returned no result for ${method}`);
    return parsed.result;
  }

  async getChainId(): Promise<number> {
    return hexToNumber(await this.request("eth_chainId"), "chain ID");
  }

  async getBlockNumber(): Promise<bigint> {
    return hexToBigInt(await this.request("eth_blockNumber"), "block number");
  }

  async getTransactionReceipt(transactionHash: `0x${string}`): Promise<TransactionReceipt | null> {
    if (!/^0x[0-9a-f]{64}$/i.test(transactionHash)) throw new Error("Invalid transaction hash");
    const result = await this.requestNullable("eth_getTransactionReceipt", [transactionHash]);
    if (result === null) return null;
    const receipt = TransactionReceiptSchema.parse(result);
    return { transactionHash: receipt.transactionHash as `0x${string}`, blockNumber: hexToBigInt(receipt.blockNumber, "receipt block number"), status: receipt.status, from: receipt.from as `0x${string}`, to: receipt.to as `0x${string}` | null };
  }

  async requestNullable(method: string, params: unknown[] = []): Promise<unknown | null> {
    const response = await this.fetcher(this.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (!response.ok) throw new Error(`X Layer RPC returned HTTP ${response.status}`);
    const parsed = z.object({ jsonrpc: z.literal("2.0"), id: z.number().int(), result: z.unknown().nullable().optional(), error: z.object({ code: z.number().int(), message: z.string() }).optional() }).parse(await response.json());
    if (parsed.error) throw new Error(`X Layer RPC ${parsed.error.code}: ${parsed.error.message}`);
    return parsed.result ?? null;
  }

  async assertExpectedNetwork(): Promise<number> {
    const chainId = await this.getChainId();
    if (chainId !== this.expectedChainId) throw new Error(`Wrong X Layer network: expected ${this.expectedChainId}, received ${chainId}`);
    return chainId;
  }

  async getStatus(): Promise<XLayerStatus> {
    const chainId = await this.assertExpectedNetwork();
    return { rpcUrl: this.rpcUrl, chainId, blockNumber: await this.getBlockNumber() };
  }
}


export const PROOFFLOW_VAULT_ABI = [
  { type: "function", name: "payer", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "recipient", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "amount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "deadline", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "policyHash", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "evidenceHash", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "funded", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "released", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "disputed", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "commitEvidence", stateMutability: "nonpayable", inputs: [{ name: "evidenceHash_", type: "bytes32" }], outputs: [] },
  { type: "function", name: "release", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "fund", stateMutability: "payable", inputs: [], outputs: [] }
] as const;

export interface VaultSnapshot {
  address: `0x${string}`;
  payer: `0x${string}`;
  recipient: `0x${string}`;
  amount: bigint;
  deadline: bigint;
  policyHash: `0x${string}`;
  evidenceHash: `0x${string}`;
  funded: boolean;
  released: boolean;
  disputed: boolean;
  paused: boolean;
  balance: bigint;
}

export interface VaultTransactionPreview {
  to: `0x${string}`;
  value: bigint;
  data: `0x${string}`;
  method: "fund" | "commitEvidence" | "release";
}

export interface VaultClientOptions extends XLayerClientOptions {
  vaultAddress: `0x${string}`;
}

export class ProofFlowVaultClient extends XLayerClient {
  private readonly vaultAddress: `0x${string}`;

  constructor(options: VaultClientOptions) {
    super(options);
    this.vaultAddress = options.vaultAddress;
  }

  get address(): `0x${string}` {
    return this.vaultAddress;
  }

  async snapshot(): Promise<VaultSnapshot> {
    await this.assertExpectedNetwork();
    const calls = await Promise.all([
      this.request("eth_call", [{ to: this.vaultAddress, data: encodeFunctionData({ abi: PROOFFLOW_VAULT_ABI, functionName: "payer" }) }, "latest"]),
      this.request("eth_call", [{ to: this.vaultAddress, data: encodeFunctionData({ abi: PROOFFLOW_VAULT_ABI, functionName: "recipient" }) }, "latest"]),
      this.request("eth_call", [{ to: this.vaultAddress, data: encodeFunctionData({ abi: PROOFFLOW_VAULT_ABI, functionName: "amount" }) }, "latest"]),
      this.request("eth_call", [{ to: this.vaultAddress, data: encodeFunctionData({ abi: PROOFFLOW_VAULT_ABI, functionName: "deadline" }) }, "latest"]),
      this.request("eth_call", [{ to: this.vaultAddress, data: encodeFunctionData({ abi: PROOFFLOW_VAULT_ABI, functionName: "policyHash" }) }, "latest"]),
      this.request("eth_call", [{ to: this.vaultAddress, data: encodeFunctionData({ abi: PROOFFLOW_VAULT_ABI, functionName: "evidenceHash" }) }, "latest"]),
      this.request("eth_call", [{ to: this.vaultAddress, data: encodeFunctionData({ abi: PROOFFLOW_VAULT_ABI, functionName: "funded" }) }, "latest"]),
      this.request("eth_call", [{ to: this.vaultAddress, data: encodeFunctionData({ abi: PROOFFLOW_VAULT_ABI, functionName: "released" }) }, "latest"]),
      this.request("eth_call", [{ to: this.vaultAddress, data: encodeFunctionData({ abi: PROOFFLOW_VAULT_ABI, functionName: "disputed" }) }, "latest"]),
      this.request("eth_call", [{ to: this.vaultAddress, data: encodeFunctionData({ abi: PROOFFLOW_VAULT_ABI, functionName: "paused" }) }, "latest"]),
      this.request("eth_getBalance", [this.vaultAddress, "latest"])
    ]);
    return {
      address: this.vaultAddress,
      payer: decodeAddress(calls[0]),
      recipient: decodeAddress(calls[1]),
      amount: hexToBigInt(calls[2], "amount"),
      deadline: hexToBigInt(calls[3], "deadline"),
      policyHash: normalizeBytes32(calls[4]),
      evidenceHash: normalizeBytes32(calls[5]),
      funded: decodeBool(calls[6]),
      released: decodeBool(calls[7]),
      disputed: decodeBool(calls[8]),
      paused: decodeBool(calls[9]),
      balance: hexToBigInt(calls[10], "balance")
    };
  }

  previewFund(amount: bigint): VaultTransactionPreview {
    if (amount <= 0n) throw new Error("Funding amount must be greater than zero");
    return { to: this.vaultAddress, value: amount, data: encodeFunctionData({ abi: PROOFFLOW_VAULT_ABI, functionName: "fund" }), method: "fund" };
  }

  previewCommitEvidence(evidenceHash: `0x${string}`): VaultTransactionPreview {
    normalizeBytes32(evidenceHash);
    return { to: this.vaultAddress, value: 0n, data: encodeFunctionData({ abi: PROOFFLOW_VAULT_ABI, functionName: "commitEvidence", args: [evidenceHash] }), method: "commitEvidence" };
  }

  previewRelease(): VaultTransactionPreview {
    return { to: this.vaultAddress, value: 0n, data: encodeFunctionData({ abi: PROOFFLOW_VAULT_ABI, functionName: "release" }), method: "release" };
  }

  async assertMatchesAgreement(input: { payer: string; recipient: string; amountBaseUnits: string; policyHash: string }): Promise<VaultSnapshot> {
    const snapshot = await this.snapshot();
    if (snapshot.payer.toLowerCase() !== input.payer.toLowerCase()) throw new Error("Vault payer does not match agreement");
    if (snapshot.recipient.toLowerCase() !== input.recipient.toLowerCase()) throw new Error("Vault recipient does not match agreement");
    if (snapshot.amount !== BigInt(input.amountBaseUnits)) throw new Error("Vault amount does not match agreement");
    if (snapshot.policyHash.toLowerCase() !== input.policyHash.toLowerCase()) throw new Error("Vault policy hash does not match agreement");
    return snapshot;
  }
}

function normalizeBytes32(value: string): `0x${string}` {
  if (!/^0x[0-9a-f]{64}$/i.test(value)) throw new Error("Invalid bytes32 response");
  return value as `0x${string}`;
}

function decodeAddress(value: string): `0x${string}` {
  const normalized = normalizeBytes32(value);
  return `0x${normalized.slice(-40)}` as `0x${string}`;
}

function decodeBool(value: string): boolean {
  return BigInt(value) !== 0n;
}
