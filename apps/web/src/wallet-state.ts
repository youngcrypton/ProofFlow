import { XLAYER_TESTNET_CHAIN_ID } from "@proofflow/domain";

export type WalletChainStatus = "connected" | "wrong_network";

export function readWalletChainId(value: unknown): number | null {
  if (typeof value === "string") {
    if (/^0x[0-9a-f]+$/i.test(value)) return Number.parseInt(value.slice(2), 16);
    if (/^\d+$/.test(value)) return Number(value);
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  return null;
}

export function walletChainStatus(chainId: number, expectedChainId = XLAYER_TESTNET_CHAIN_ID): WalletChainStatus {
  return chainId === expectedChainId ? "connected" : "wrong_network";
}
