import { describe, expect, it } from "vitest";
import { readWalletChainId, walletChainStatus } from "./wallet-state";

describe("wallet chain state", () => {
  it("normalizes hexadecimal and decimal provider chain IDs", () => {
    expect(readWalletChainId("0x7a0")).toBe(1952);
    expect(readWalletChainId("1952")).toBe(1952);
    expect(readWalletChainId(1952)).toBe(1952);
  });

  it("rejects malformed provider values", () => {
    expect(readWalletChainId("not-a-chain")).toBeNull();
    expect(readWalletChainId(null)).toBeNull();
    expect(readWalletChainId(-1)).toBeNull();
  });

  it("distinguishes X Layer testnet from other networks", () => {
    expect(walletChainStatus(1952)).toBe("connected");
    expect(walletChainStatus(1)).toBe("wrong_network");
  });
});
