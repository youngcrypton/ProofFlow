import { z } from "zod";

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
