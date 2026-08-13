import { createAppKit } from "@reown/appkit/react";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import type { AppKitNetwork } from "@reown/appkit/networks";

type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
};

export const XLAYER_TESTNET_CHAIN_ID = 1952;
const XLAYER_TESTNET_CHAIN_HEX = "0x7a0";
const XLAYER_TESTNET_RPC = "https://testrpc.xlayer.tech/terigon";
const REOWN_PROJECT_ID = import.meta.env.VITE_REOWN_PROJECT_ID ?? "b56e18d47c72ab683b10814fe9495694";

const xLayerTestnet: AppKitNetwork = {
  id: XLAYER_TESTNET_CHAIN_ID,
  name: "X Layer Testnet",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: [XLAYER_TESTNET_RPC] }, public: { http: [XLAYER_TESTNET_RPC] } },
  blockExplorers: { default: { name: "OKX Explorer", url: "https://www.okx.com/web3/explorer/xlayer-test" } },
  chainNamespace: "eip155",
  caipNetworkId: `eip155:${XLAYER_TESTNET_CHAIN_ID}`
};

export const walletConfigurationMissing = !REOWN_PROJECT_ID;
const wagmiAdapter = new WagmiAdapter({
  projectId: REOWN_PROJECT_ID || "0000000000000000000000000000000000000000000000000000000000000000",
  networks: [xLayerTestnet],
  ssr: false
});

export const wagmiConfig = wagmiAdapter.wagmiConfig;

export const walletAppKit = createAppKit({
  adapters: [wagmiAdapter],
  projectId: REOWN_PROJECT_ID || "0000000000000000000000000000000000000000000000000000000000000000",
  networks: [xLayerTestnet],
  defaultNetwork: xLayerTestnet,
  metadata: {
    name: "ProofFlow",
    description: "Verifiable work and programmable trust on X Layer.",
    url: window.location.origin,
    icons: ["https://static.okx.com/cdn/assets/imgs/247/58E63FEA47A2B7D7.png"]
  },
  themeMode: "dark",
  themeVariables: {
    "--w3m-color-mix": "#8de6ff",
    "--w3m-color-mix-strength": 12,
    "--w3m-accent": "#c8f36c",
    "--w3m-border-radius-master": "12px"
  },
  features: { analytics: false, email: false, socials: false }
});

export function asEip1193Provider(value: unknown): Eip1193Provider | null {
  if (!value || typeof value !== "object" || typeof (value as Eip1193Provider).request !== "function") return null;
  return value as Eip1193Provider;
}

export async function switchToXLayer(provider: Eip1193Provider): Promise<void> {
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: XLAYER_TESTNET_CHAIN_HEX }] });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: number }).code : undefined;
    if (code !== 4902) throw error;
    await provider.request({ method: "wallet_addEthereumChain", params: [{
      chainId: XLAYER_TESTNET_CHAIN_HEX,
      chainName: "X Layer testnet",
      nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
      rpcUrls: [XLAYER_TESTNET_RPC],
      blockExplorerUrls: ["https://www.okx.com/web3/explorer/xlayer-test"]
    }] });
  }
}
