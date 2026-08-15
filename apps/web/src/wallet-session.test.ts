import { describe, expect, it, vi } from "vitest";
import { WalletSessionController } from "./wallet-session";
import { walletChainStatus } from "./wallet-state";

describe("wallet authentication session lifecycle", () => {
  it("authenticates once, loads agreements after readiness changes, and publishes with the session", async () => {
    const controller = new WalletSessionController();
    let walletSessionReady = false;
    const personalSign = vi.fn(async () => "0xsignature");
    const authenticate = vi.fn(async () => {
      await personalSign();
      return { address: "0xABC", token: "session-token", expiresAt: Date.now() + 60_000 };
    });
    const loadAgreements = vi.fn();
    const first = controller.authenticate("0xAbC", authenticate);
    const second = controller.authenticate("0xabc", authenticate);
    await expect(first).resolves.toMatchObject({ token: "session-token" });
    await expect(second).resolves.toMatchObject({ token: "session-token" });
    walletSessionReady = true;
    if (walletSessionReady) loadAgreements();
    await controller.authenticate("0xABC", authenticate);
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(personalSign).toHaveBeenCalledTimes(1);
    expect(loadAgreements).toHaveBeenCalledTimes(1);
    expect(controller.hasValidSession("0xABC")).toBe(true);
    const publishHeaders = new Headers();
    controller.applyHeader(publishHeaders);
    expect(publishHeaders.get("X-ProofFlow-Wallet-Session")).toBe("session-token");
  });

  it("invalidates when a signature is rejected or the wallet disconnects", async () => {
    const controller = new WalletSessionController();
    await expect(controller.authenticate("0x1", async () => { throw new Error("rejected"); })).rejects.toThrow("rejected");
    expect(controller.token).toBeNull();
    await controller.authenticate("0x1", async () => ({ address: "0x1", token: "one", expiresAt: Date.now() + 60_000 }));
    controller.clear();
    expect(controller.token).toBeNull();
  });

  it("does not restore an expired session and replaces it after an account change", async () => {
    const controller = new WalletSessionController();
    await controller.authenticate("0x1", async () => ({ address: "0x1", token: "one", expiresAt: Date.now() - 1 }));
    expect(controller.hasValidSession("0x1")).toBe(false);
    const headers = new Headers();
    controller.applyHeader(headers);
    expect(headers.has("X-ProofFlow-Wallet-Session")).toBe(false);
    await controller.authenticate("0x2", async () => ({ address: "0x2", token: "two" }));
    expect(controller.address).toBe("0x2");
    expect(controller.token).toBe("two");
  });

  it("ignores a stale authentication result after the connected account changes", async () => {
    const controller = new WalletSessionController();
    let resolveFirst!: (value: { address: string; token: string }) => void;
    const first = controller.authenticate("0x1", () => new Promise((resolve) => { resolveFirst = resolve; }));
    await controller.authenticate("0x2", async () => ({ address: "0x2", token: "two" }));
    resolveFirst({ address: "0x1", token: "one" });
    await first;
    expect(controller.address).toBe("0x2");
    expect(controller.token).toBe("two");
  });

  it("keeps an existing authenticated session and preserves wrong-network detection", async () => {
    const controller = new WalletSessionController();
    const authenticate = vi.fn(async () => ({ address: "0x1", token: "one" }));
    await controller.authenticate("0x1", authenticate);
    await controller.authenticate("0x1", authenticate);
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(walletChainStatus(1)).toBe("wrong_network");
    expect(controller.token).toBe("one");
  });
});
