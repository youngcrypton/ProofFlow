export type WalletSession = {
  address: string;
  token: string;
  expiresAt?: number;
};

type Authenticate = () => Promise<WalletSession>;

export class WalletSessionController {
  private session: WalletSession | null = null;
  private inFlight: { address: string; promise: Promise<WalletSession> } | null = null;
  private generation = 0;

  get token(): string | null {
    return this.session?.token ?? null;
  }

  get address(): string | null {
    return this.session?.address ?? null;
  }

  hasValidSession(address: string): boolean {
    const normalized = normalizeAddress(address);
    return this.session?.address === normalized && (!this.session.expiresAt || this.session.expiresAt > Date.now());
  }

  authenticate(address: string, authenticate: Authenticate): Promise<WalletSession> {
    const normalized = normalizeAddress(address);
    if (this.hasValidSession(normalized)) return Promise.resolve(this.session!);
    if (this.inFlight?.address === normalized) return this.inFlight.promise;
    if ((this.session && this.session.address !== normalized) || (this.inFlight && this.inFlight.address !== normalized)) this.clear();
    const generation = this.generation;
    const promise = authenticate().then((session) => {
      const normalizedSession = { ...session, address: normalizeAddress(session.address) };
      if (normalizedSession.address !== normalized) throw new Error("Wallet session address does not match the connected wallet.");
      if (generation === this.generation) this.session = normalizedSession;
      return normalizedSession;
    }).finally(() => {
      if (this.inFlight?.promise === promise) this.inFlight = null;
    });
    this.inFlight = { address: normalized, promise };
    return promise;
  }

  clear(): void {
    this.generation += 1;
    this.session = null;
    this.inFlight = null;
  }

  invalidate(address?: string): void {
    if (!address || this.address === normalizeAddress(address)) this.clear();
  }

  applyHeader(headers: Headers): void {
    if (this.session && this.session.expiresAt && this.session.expiresAt <= Date.now()) this.clear();
    if (this.token) headers.set("X-ProofFlow-Wallet-Session", this.token);
  }
}

export function normalizeAddress(address: string): string {
  return address.toLowerCase();
}
