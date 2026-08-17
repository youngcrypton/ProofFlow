import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { clamdPing } from "./clamd-client";
import {
  AgreementCreateInputSchema,
  AgreementSchema,
  EvidenceManifestContentSchema,
  EvidenceTypeSchema,
  JobState,
  ReviewObservationSchema,
  PolicyDecisionSchema,
  SettlementIntentSchema,
  canonicalizeEvidenceManifest,
  canonicalizePolicy,
  evaluatePolicy,
  normalizeEvmAddress
} from "@proofflow/domain";
import { MemoryRepository } from "./memory-repository";
import type { ProofFlowRepository } from "./repository";
import type { AuditEvent } from "@proofflow/domain";
import { ProofFlowVaultClient, XLayerClient } from "./xlayer";
import { runReview, createReviewProvider } from "./reviewer";
import { logStructured, Observability, routeLabel } from "./observability";
import { EvidenceStore } from "./evidence-store";
import { recoverMessageAddress } from "viem";
import type { Hex } from "viem";

type AppVariables = { walletAddress?: string };
type WalletChallenge = { address: string; nonce: string; message: string; expiresAt: number };

const MAX_BODY_BYTES = 1_000_000;
const MAX_UPLOAD_BODY_BYTES = 12_000_000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = Number(process.env.PROOFFLOW_RATE_LIMIT ?? 60);
const RPC_TIMEOUT_MS = Number(process.env.PROOFFLOW_RPC_TIMEOUT_MS ?? 8_000);
const DEFAULT_ALLOWED_ORIGIN = "http://localhost:5173";
const CORS_ALLOWED_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const CORS_ALLOWED_HEADERS = ["Content-Type", "Accept", "Authorization", "X-Request-Id", "X-ProofFlow-Wallet-Session"];
const requestBuckets = new Map<string, { startedAt: number; count: number }>();
const WALLET_SESSION_TTL_MS = 15 * 60_000;
const WALLET_CHALLENGE_TTL_MS = 5 * 60_000;

export function parseAllowedOrigins(value = process.env.PROOFFLOW_ALLOWED_ORIGIN): string[] {
  return (value ?? DEFAULT_ALLOWED_ORIGIN)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function clientKey(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "anonymous";
}

function isMutating(request: Request): boolean {
  return request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS";
}

function isMultipartUpload(request: Request): boolean {
  return request.method === "POST" && new URL(request.url).pathname.endsWith("/evidence/upload") && (request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data");
}

export function createApp(repository: ProofFlowRepository = new MemoryRepository(), observability = new Observability(), evidenceStore = new EvidenceStore()) {
  const app = new Hono<{ Variables: AppVariables }>();
  const allowedOrigins = parseAllowedOrigins();
  const xLayerRpcUrl = process.env.XLAYER_RPC_URL ?? "https://testrpc.xlayer.tech/terigon";
  const xLayerChainId = Number(process.env.XLAYER_CHAIN_ID ?? 1952);
  const vaultAddress = process.env.PROOFFLOW_VAULT_ADDRESS;
  const requireAuth = process.env.NODE_ENV === "production" || process.env.PROOFFLOW_REQUIRE_AUTH === "true";
  const enforceWalletAccess = process.env.NODE_ENV === "production" || process.env.PROOFFLOW_ENFORCE_WALLET_AUTH === "true";
  const apiToken = process.env.PROOFFLOW_API_TOKEN;
  const walletSessionSecret = process.env.PROOFFLOW_SESSION_SECRET ?? (requireAuth ? null : crypto.randomUUID());
  const walletChallenges = new Map<string, WalletChallenge>();
  const walletMessage = (address: string, nonce: string, expiresAt: number) => `ProofFlow wallet access\n\nAddress: ${address}\nNonce: ${nonce}\nExpires: ${new Date(expiresAt).toISOString()}\n\nSign this message to authorize this browser session. It does not authorize a transaction.`;
  const signSession = (address: string, expiresAt: number, nonce: string) => {
    if (!walletSessionSecret) return null;
    const payload = Buffer.from(JSON.stringify({ address, expiresAt, nonce })).toString("base64url");
    const signature = createHmac("sha256", walletSessionSecret).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  };
  const verifySession = (token: string | undefined): string | null => {
    if (!token || !walletSessionSecret) return null;
    const [payload, suppliedSignature] = token.split(".");
    if (!payload || !suppliedSignature) return null;
    const expectedSignature = createHmac("sha256", walletSessionSecret).update(payload).digest("base64url");
    const supplied = Buffer.from(suppliedSignature);
    const expected = Buffer.from(expectedSignature);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
    try {
      const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { address?: string; expiresAt?: number };
      if (!parsed.address || !/^0x[a-fA-F0-9]{40}$/.test(parsed.address) || !parsed.expiresAt || parsed.expiresAt < Date.now()) return null;
      return normalizeEvmAddress(parsed.address);
    } catch { return null; }
  };
  const agreementAccess = (c: Context<{ Variables: AppVariables }>, agreement: { payer: string; recipient: string }): Response | null => {
    if (!enforceWalletAccess) return null;
    const wallet = c.get("walletAddress");
    if (!wallet) return c.json({ error: { code: "WALLET_AUTH_REQUIRED", message: "Connect and sign the wallet access message before opening this agreement." } }, 401);
    if (wallet !== normalizeEvmAddress(agreement.payer) && wallet !== normalizeEvmAddress(agreement.recipient)) return c.json({ error: { code: "FORBIDDEN", message: "This wallet is not a party to the agreement." } }, 403);
    return null;
  };
  console.log(`Allowed Origins: ${allowedOrigins.join(", ") || "(none)"}`);
  app.use("*", cors({
    origin: (origin, c) => {
      const matchedOrigin = allowedOrigins.includes(origin) ? origin : null;
      console.log(`Incoming Origin: ${origin || "(none)"}`);
      console.log(`Matched Origin: ${matchedOrigin ?? "(none)"}`);
      console.log(`CORS Applied: ${matchedOrigin ? "true" : "false"}`);
      if (c.req.method === "OPTIONS") console.log("Handled CORS preflight");
      return matchedOrigin;
    },
    allowMethods: CORS_ALLOWED_METHODS,
    allowHeaders: CORS_ALLOWED_HEADERS,
    credentials: true,
    maxAge: 600
  }));
  app.use("*", async (c, next) => {
    const startedAt = performance.now();
    const route = () => routeLabel(new URL(c.req.url).pathname);
    const contentLength = Number(c.req.header("content-length") ?? 0);
    const bodyLimit = isMultipartUpload(c.req.raw) ? MAX_UPLOAD_BODY_BYTES : MAX_BODY_BYTES;
    if (contentLength > bodyLimit) {
      observability.recordRequest({ route: route(), status: 413, durationMs: performance.now() - startedAt });
      return c.json({ error: { code: "PAYLOAD_TOO_LARGE", message: isMultipartUpload(c.req.raw) ? "Upload exceeds the 12 MB request limit." : "Request body exceeds the 1 MB limit." } }, 413);
    }
    const suppliedRequestId = c.req.header("x-request-id");
    const requestId = suppliedRequestId && /^[A-Za-z0-9._:-]{1,128}$/.test(suppliedRequestId) ? suppliedRequestId : crypto.randomUUID();
    c.header("x-request-id", requestId);
    if (isMutating(c.req.raw)) {
      const key = clientKey(c.req.raw);
      const now = Date.now();
      const bucket = requestBuckets.get(key);
      if (!bucket || now - bucket.startedAt >= RATE_WINDOW_MS) requestBuckets.set(key, { startedAt: now, count: 1 });
      else {
        bucket.count += 1;
        if (bucket.count > RATE_LIMIT) {
          c.header("retry-after", "60");
          observability.recordRequest({ route: route(), status: 429, durationMs: performance.now() - startedAt, rateLimited: true });
          return c.json({ error: { code: "RATE_LIMITED", message: "Too many requests. Retry shortly." } }, 429);
        }
      }
      if (requestBuckets.size > 2048) for (const [bucketKey, value] of requestBuckets) if (now - value.startedAt >= RATE_WINDOW_MS) requestBuckets.delete(bucketKey);
    }
    try {
      await next();
    } finally {
      const status = c.res.status;
      const durationMs = Math.round(performance.now() - startedAt);
      observability.recordRequest({ route: route(), status, durationMs });
      logStructured({ event: "http_request", requestId, method: c.req.method, route: route(), status, durationMs });
    }
  });

  app.use("*", async (c, next) => {
    const sessionWallet = verifySession(c.req.header("x-proofflow-wallet-session"));
    if (sessionWallet) c.set("walletAddress", sessionWallet);
    const isSessionRoute = c.req.path === "/api/v1/wallet/challenge" || c.req.path === "/api/v1/wallet/session";
    const hasBearer = Boolean(apiToken && c.req.header("authorization") === `Bearer ${apiToken}`);
    if (requireAuth && isMutating(c.req.raw) && !isSessionRoute && !hasBearer && !sessionWallet) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "A valid API bearer token or signed wallet session is required." } }, 401);
    }
    await next();
  });

  const sha256Hex = async (value: string): Promise<`0x${string}`> => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return `0x${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  };

  const startedAt = Date.now();

  app.get("/health", async (c) => {
    if (process.env.NODE_ENV === "production") {
      try { await clamdPing(); }
      catch { return c.json({ ok: false, service: "proofflow-api", scanner: "unavailable" }, 503); }
    }
    return c.json({ ok: true, service: "proofflow-api", scanner: process.env.NODE_ENV === "production" ? "ready" : "not-required", timestamp: new Date().toISOString(), uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) });
  });

  app.get("/metrics", (c) => {
    const metricsToken = process.env.PROOFFLOW_METRICS_TOKEN;
    if (process.env.NODE_ENV === "production" && (!metricsToken || c.req.header("authorization") !== `Bearer ${metricsToken}`)) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "A valid metrics token is required." } }, 401);
    }
    return c.json({ data: observability.snapshot() });
  });

  app.get("/api/v1/xlayer/status", async (c) => {
    try {
      const client = new XLayerClient({ rpcUrl: xLayerRpcUrl, expectedChainId: xLayerChainId, timeoutMs: RPC_TIMEOUT_MS, onRpcMetric: (metric) => observability.recordRpc(metric) });
      const status = await client.getStatus();
      return c.json({ data: { chainId: status.chainId, blockNumber: status.blockNumber.toString(), network: status.chainId === 196 ? "X Layer mainnet" : "X Layer testnet" } });
    } catch {
      return c.json({ error: { code: "XLAYER_UNAVAILABLE", message: "X Layer status is temporarily unavailable." } }, 503);
    }
  });

  app.post("/api/v1/wallet/challenge", (c) => {
    const body = z.object({ address: z.string().regex(/^0x[a-fA-F0-9]{40}$/) }).safeParse(c.req.query("address") ? { address: c.req.query("address") } : null);
    if (!body.success) return c.json({ error: { code: "VALIDATION_ERROR", message: "A valid wallet address is required." } }, 400);
    if (!walletSessionSecret) return c.json({ error: { code: "SESSION_NOT_CONFIGURED", message: "Wallet sessions are not configured." } }, 503);
    const address = normalizeEvmAddress(body.data.address);
    const nonce = crypto.randomUUID();
    const expiresAt = Date.now() + WALLET_CHALLENGE_TTL_MS;
    const message = walletMessage(address, nonce, expiresAt);
    walletChallenges.set(nonce, { address, nonce, message, expiresAt });
    return c.json({ data: { nonce, message, expiresAt } });
  });

  app.post("/api/v1/wallet/session", async (c) => {
    const body = z.object({ address: z.string().regex(/^0x[a-fA-F0-9]{40}$/), nonce: z.string().uuid(), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: { code: "VALIDATION_ERROR", message: "Wallet session proof is invalid." } }, 400);
    const challenge = walletChallenges.get(body.data.nonce);
    const address = normalizeEvmAddress(body.data.address);
    if (!challenge || challenge.expiresAt < Date.now() || challenge.address !== address) return c.json({ error: { code: "CHALLENGE_INVALID", message: "Wallet challenge is missing, expired, or bound to another address." } }, 401);
    walletChallenges.delete(body.data.nonce);
    try {
      const recovered = normalizeEvmAddress(await recoverMessageAddress({ message: challenge.message, signature: body.data.signature as Hex }));
      if (recovered !== address) return c.json({ error: { code: "SIGNATURE_INVALID", message: "Wallet signature does not match the requested address." } }, 401);
    } catch { return c.json({ error: { code: "SIGNATURE_INVALID", message: "Wallet signature could not be verified." } }, 401); }
    const expiresAt = Date.now() + WALLET_SESSION_TTL_MS;
    const token = signSession(address, expiresAt, body.data.nonce);
    if (!token) return c.json({ error: { code: "SESSION_NOT_CONFIGURED", message: "Wallet sessions are not configured." } }, 503);
    return c.json({ data: { token, address, expiresAt } });
  });

  app.get("/api/v1/agreements", (c) => {
    const role = c.req.query("role");
    const address = c.req.query("address");
    if ((role !== undefined && role !== "client" && role !== "contractor") || (address !== undefined && !/^0x[a-fA-F0-9]{40}$/.test(address))) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "role must be client or contractor and address must be a valid EVM address." } }, 400);
    }
    if (enforceWalletAccess && !c.get("walletAddress")) return c.json({ error: { code: "WALLET_AUTH_REQUIRED", message: "Connect and sign the wallet access message before listing agreements." } }, 401);
    if (enforceWalletAccess && address && normalizeEvmAddress(address) !== c.get("walletAddress")) return c.json({ error: { code: "FORBIDDEN", message: "The requested wallet does not match the signed wallet session." } }, 403);
    const effectiveAddress = address ?? c.get("walletAddress");
    const agreements = repository.listAgreements().filter((agreement) => {
      if (!effectiveAddress) return true;
      const normalizedAddress = normalizeEvmAddress(effectiveAddress);
      if (role === "client") return normalizeEvmAddress(agreement.payer) === normalizedAddress;
      if (role === "contractor") return normalizeEvmAddress(agreement.recipient) === normalizedAddress;
      return normalizeEvmAddress(agreement.payer) === normalizedAddress || normalizeEvmAddress(agreement.recipient) === normalizedAddress;
    });
    return c.json({ data: agreements, nextCursor: null });
  });

  app.post("/api/v1/demo/reset", async (c) => {
    if (process.env.NODE_ENV !== "test" && process.env.PROOFFLOW_ENABLE_DEMO_RESET !== "true") return c.json({ error: { code: "DEMO_RESET_DISABLED", message: "Demo reset is disabled outside explicitly enabled development mode." } }, 403);
    const now = new Date().toISOString();
    const agreement = AgreementSchema.parse({
      id: "agr_demo_001",
      title: "Solar installation — milestone 02",
      description: "Release after the installed system is inspected and the completion evidence is verified.",
      payer: "0x0000000000000000000000000000000000000001",
      recipient: "0x0000000000000000000000000000000000000002",
      tokenAddress: "0x0000000000000000000000000000000000000003",
      amountBaseUnits: "4280000000000000000",
      deadline: "2026-08-28T17:00:00.000Z",
      policy: { version: "solar-install-v1", requiredEvidence: ["invoice", "signed_approval", "status_update"], minimumConfidenceBps: 9000, releaseAmountBaseUnits: "4280000000000000000", deadline: "2026-08-28T17:00:00.000Z" },
      policyHash: await sha256Hex(canonicalizePolicy({ version: "solar-install-v1", requiredEvidence: ["invoice", "signed_approval", "status_update"], minimumConfidenceBps: 9000, releaseAmountBaseUnits: "4280000000000000000", deadline: "2026-08-28T17:00:00.000Z" })),
      state: JobState.READY_TO_RELEASE,
      createdAt: now,
      updatedAt: now
    });
    repository.saveAgreement(agreement);
    const manifest = EvidenceManifestContentSchema.extend({ manifestHash: z.string() }).parse({ agreementId: agreement.id, submittedBy: agreement.recipient, submittedAt: now, items: [
      { type: "invoice", name: "invoice-204.pdf", mediaType: "application/pdf", sha256: "a".repeat(64), uri: "https://example.com/evidence/invoice-204.pdf" },
      { type: "signed_approval", name: "approval.pdf", mediaType: "application/pdf", sha256: "b".repeat(64), uri: "https://example.com/evidence/approval.pdf" },
      { type: "status_update", name: "site-status.json", mediaType: "application/json", sha256: "c".repeat(64), uri: "https://example.com/evidence/site-status.json" }
    ], manifestHash: `0x${"3".repeat(64)}` });
    repository.saveManifest(manifest);
    const review = await runReview(createReviewProvider(), { agreementId: agreement.id, manifest, evidenceText: "Installation complete. Invoice total: 4.280 X Layer." });
    repository.saveReviewRun(review);
    repository.appendAuditEvent({ aggregateType: "AGREEMENT", aggregateId: agreement.id, eventType: "AGREEMENT_CREATED", actor: "demo-seed", occurredAt: now, correlationId: agreement.id }, { agreement });
    repository.appendAuditEvent({ aggregateType: "EVIDENCE", aggregateId: agreement.id, eventType: "EVIDENCE_SUBMITTED", actor: agreement.recipient, occurredAt: now, correlationId: agreement.id }, { manifestHash: manifest.manifestHash, itemCount: manifest.items.length });
    repository.appendAuditEvent({ aggregateType: "POLICY_DECISION", aggregateId: agreement.id, eventType: "AI_REVIEW_COMPLETED", actor: review.provider.provider, occurredAt: review.completedAt ?? now, correlationId: agreement.id }, { reviewRunId: review.id, status: review.status, outputHash: review.outputHash });
    return c.json({ data: { agreement, manifest, reviewRun: review }, reset: true });
  });

  app.get("/api/v1/agreements/:id/chain-preview", async (c) => {
    const id = c.req.param("id");
    const agreement = repository.getAgreement(id);
    if (!agreement) return c.json({ error: { code: "NOT_FOUND", message: "Agreement not found." } }, 404);
    const accessError = agreementAccess(c, agreement);
    if (accessError) return accessError;
    if (!vaultAddress || !/^0x[a-fA-F0-9]{40}$/.test(vaultAddress)) return c.json({ error: { code: "VAULT_NOT_CONFIGURED", message: "ProofFlow vault address is not configured." } }, 503);
    try {
      const client = new ProofFlowVaultClient({ rpcUrl: xLayerRpcUrl, expectedChainId: xLayerChainId, vaultAddress: vaultAddress as `0x${string}`, timeoutMs: RPC_TIMEOUT_MS });
      const snapshot = await client.assertMatchesAgreement({ payer: agreement.payer, recipient: agreement.recipient, amountBaseUnits: agreement.policy.releaseAmountBaseUnits, policyHash: agreement.policyHash });
      return c.json({ data: { agreementId: id, network: { chainId: snapshot ? xLayerChainId : 0, rpcUrl: xLayerRpcUrl }, vault: { ...snapshot, amount: snapshot.amount.toString(), deadline: snapshot.deadline.toString(), balance: snapshot.balance.toString() }, transactions: { fund: client.previewFund(snapshot.amount), commitEvidence: repository.getManifest(id) ? client.previewCommitEvidence(repository.getManifest(id)!.manifestHash as `0x${string}`) : null, release: client.previewRelease() } } });
    } catch {
      return c.json({ error: { code: "VAULT_MISMATCH", message: "The configured vault does not match this agreement." } }, 409);
    }
  });


  app.post("/api/v1/agreements/validate", async (c) => {
    const parsed = AgreementCreateInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: "VALIDATION_ERROR", message: "Agreement data is invalid.", fields: parsed.error.flatten().fieldErrors } }, 400);
    return c.json({ data: { valid: true, agreement: parsed.data, canonicalPolicy: canonicalizePolicy(parsed.data.policy) } });
  });

  app.post("/api/v1/agreements", async (c) => {
    const parsed = AgreementCreateInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: "VALIDATION_ERROR", message: "Agreement data is invalid.", fields: parsed.error.flatten().fieldErrors } }, 400);
    if (enforceWalletAccess) {
      const wallet = c.get("walletAddress");
      if (!wallet) return c.json({ error: { code: "WALLET_AUTH_REQUIRED", message: "Connect and sign the wallet access message before creating an agreement." } }, 401);
      if (wallet !== normalizeEvmAddress(parsed.data.payer)) return c.json({ error: { code: "FORBIDDEN", message: "The signed wallet must match the agreement payer." } }, 403);
    }
    const now = new Date().toISOString();
    const policyHash = await sha256Hex(canonicalizePolicy(parsed.data.policy));
    const agreement = AgreementSchema.parse({ ...parsed.data, id: `agr_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`, policyHash, state: JobState.AWAITING_FUNDING, createdAt: now, updatedAt: now });
    repository.saveAgreement(agreement);
    repository.appendAuditEvent({ aggregateType: "AGREEMENT", aggregateId: agreement.id, eventType: "AGREEMENT_CREATED", actor: "system", occurredAt: now, correlationId: agreement.id }, { agreement });
    return c.json({ data: agreement }, 201);
  });

  app.get("/api/v1/agreements/:id", (c) => {
    const agreement = repository.getAgreement(c.req.param("id"));
    if (!agreement) return c.json({ error: { code: "NOT_FOUND", message: "Agreement not found." } }, 404);
    const accessError = agreementAccess(c, agreement);
    if (accessError) return accessError;
    return c.json({ data: agreement });
  });

  app.post("/api/v1/agreements/:id/fund", (c) => {
    const agreement = repository.getAgreement(c.req.param("id"));
    if (!agreement) return c.json({ error: { code: "NOT_FOUND", message: "Agreement not found." } }, 404);
    const accessError = agreementAccess(c, agreement);
    if (accessError) return accessError;
    if (agreement.state !== JobState.AWAITING_FUNDING) return c.json({ error: { code: "INVALID_STATE", message: "Agreement is not awaiting funding." } }, 409);
    const updated = AgreementSchema.parse({ ...agreement, state: JobState.FUNDED, updatedAt: new Date().toISOString() });
    repository.saveAgreement(updated);
    repository.appendAuditEvent({ aggregateType: "AGREEMENT", aggregateId: updated.id, eventType: "AGREEMENT_FUNDED", actor: "demo-payer", occurredAt: updated.updatedAt, correlationId: updated.id }, { previousState: agreement.state, nextState: updated.state });
    return c.json({ data: updated });
  });

  app.get("/api/v1/agreements/:id/policy-decision", (c) => {
    const agreement = repository.getAgreement(c.req.param("id"));
    if (!agreement) return c.json({ error: { code: "NOT_FOUND", message: "Agreement not found." } }, 404);
    const accessError = agreementAccess(c, agreement);
    if (accessError) return accessError;
    const id = c.req.param("id");
    const decisionEvent = repository.listAuditEvents(id).slice().reverse().find((event: AuditEvent) => event.eventType === "POLICY_EVALUATED");
    if (!decisionEvent) return c.json({ error: { code: "NOT_FOUND", message: "Policy decision not found." } }, 404);
    const payload = (() => {
      try { return (decisionEvent as AuditEvent & { payload?: unknown }).payload; } catch { return null; }
    })();
    const decision = (payload as { decision?: unknown; manifestHash?: string } | undefined)?.decision;
    if (!decision || !PolicyDecisionSchema.safeParse(decision).success) return c.json({ error: { code: "POLICY_DECISION_UNAVAILABLE", message: "Stored policy decision payload is unavailable." } }, 500);
    return c.json({ data: { decision: PolicyDecisionSchema.parse(decision), auditEventId: decisionEvent.id, manifestHash: (payload as { manifestHash?: string } | undefined)?.manifestHash ?? null } });
  });

  app.get("/api/v1/agreements/:id/audit", (c) => {
    const agreement = repository.getAgreement(c.req.param("id"));
    if (!agreement) return c.json({ error: { code: "NOT_FOUND", message: "Agreement not found." } }, 404);
    const accessError = agreementAccess(c, agreement);
    if (accessError) return accessError;
    const events = repository.listAuditEvents(c.req.param("id"));
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (!event) continue;
      const previous = events[index - 1]?.eventHash ?? `0x${"0".repeat(64)}`;
      if (event.sequence !== index + 1 || event.previousEventHash !== previous) return c.json({ error: { code: "AUDIT_CHAIN_INVALID", message: "Audit chain integrity verification failed." } }, 500);
    }
    return c.json({ data: events, integrity: { valid: true, eventCount: events.length } });
  });

  app.post("/api/v1/agreements/:id/evidence", async (c) => {
    const id = c.req.param("id");
    const agreement = repository.getAgreement(id);
    if (!agreement) return c.json({ error: { code: "NOT_FOUND", message: "Agreement not found." } }, 404);
    const accessError = agreementAccess(c, agreement);
    if (accessError) return accessError;
    if (agreement.state !== JobState.FUNDED) return c.json({ error: { code: "INVALID_STATE", message: "Agreement must be funded before evidence submission." } }, 409);
    const parsed = EvidenceManifestContentSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || parsed.data?.agreementId !== id) return c.json({ error: { code: "VALIDATION_ERROR", message: "Evidence manifest is invalid.", fields: parsed.success ? { agreementId: ["Manifest agreementId does not match the route."] } : parsed.error.flatten().fieldErrors } }, 400);
    const submittedAt = parsed.data.submittedAt;
    const manifestHash = await sha256Hex(canonicalizeEvidenceManifest(parsed.data));
    const manifest = EvidenceManifestContentSchema.extend({ manifestHash: z.string() }).parse({ ...parsed.data, manifestHash });
    repository.saveManifest(manifest);
    const updated = AgreementSchema.parse({ ...agreement, state: JobState.EVIDENCE_SUBMITTED, updatedAt: submittedAt });
    repository.saveAgreement(updated);
    repository.appendAuditEvent({ aggregateType: "EVIDENCE", aggregateId: id, eventType: "EVIDENCE_SUBMITTED", actor: manifest.submittedBy, occurredAt: submittedAt, correlationId: id }, { manifestHash, itemCount: manifest.items.length });
    return c.json({ data: { agreement: updated, manifest } }, 201);
  });

  app.get("/api/v1/agreements/:id/evidence", (c) => {
    const agreement = repository.getAgreement(c.req.param("id"));
    if (!agreement) return c.json({ error: { code: "NOT_FOUND", message: "Agreement not found." } }, 404);
    const accessError = agreementAccess(c, agreement);
    if (accessError) return accessError;
    const manifest = repository.getManifest(c.req.param("id"));
    if (!manifest) return c.json({ error: { code: "NOT_FOUND", message: "Evidence manifest not found." } }, 404);
    return c.json({ data: manifest });
  });

  app.post("/api/v1/agreements/:id/evidence/upload", async (c) => {
    const id = c.req.param("id");
    const agreement = repository.getAgreement(id);
    if (!agreement) return c.json({ error: { code: "NOT_FOUND", message: "Agreement not found." } }, 404);
    const accessError = agreementAccess(c, agreement);
    if (accessError) return accessError;
    if (agreement.state !== JobState.FUNDED) return c.json({ error: { code: "INVALID_STATE", message: "Agreement must be funded before evidence upload." } }, 409);
    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) return c.json({ error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Use multipart/form-data with a file field." } }, 415);
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    const evidenceType = form?.get("evidenceType");
    const submittedBy = form?.get("submittedBy");
    if (!file || typeof (file as { arrayBuffer?: unknown }).arrayBuffer !== "function" || typeof evidenceType !== "string" || typeof submittedBy !== "string") return c.json({ error: { code: "VALIDATION_ERROR", message: "file, evidenceType, and submittedBy are required." } }, 400);
    const upload = file as File;
    const type = EvidenceTypeSchema.safeParse(evidenceType);
    const actor = z.string().regex(/^0x[a-fA-F0-9]{40}$/).safeParse(submittedBy);
    if (!type.success || !actor.success) return c.json({ error: { code: "VALIDATION_ERROR", message: "Evidence type or submitter is invalid." } }, 400);
    if (upload.size > Number(process.env.PROOFFLOW_EVIDENCE_MAX_BYTES ?? 10 * 1024 * 1024)) return c.json({ error: { code: "FILE_TOO_LARGE", message: "Evidence file exceeds the configured size limit." } }, 413);
    try {
      const blob = await evidenceStore.put({ bytes: new Uint8Array(await upload.arrayBuffer()), mediaType: upload.type, originalName: upload.name });
      const existing = repository.getManifest(id);
      const now = new Date().toISOString();
      const item = { type: type.data, name: blob.originalName, mediaType: blob.mediaType, sha256: blob.digest.slice(2), uri: `http://proofflow.local/api/v1/evidence/blobs/${blob.digest.slice(2)}` };
      const content = existing ? { ...existing, items: [...existing.items, item], submittedAt: now, submittedBy: actor.data } : { agreementId: id, submittedBy: actor.data, submittedAt: now, items: [item] };
      const parsed = EvidenceManifestContentSchema.parse(content);
      const manifestHash = await sha256Hex(canonicalizeEvidenceManifest(parsed));
      const manifest = EvidenceManifestContentSchema.extend({ manifestHash: z.string() }).parse({ ...parsed, manifestHash });
      repository.saveManifest(manifest);
      if (!existing) repository.saveAgreement(AgreementSchema.parse({ ...agreement, state: JobState.EVIDENCE_SUBMITTED, updatedAt: now }));
      repository.appendAuditEvent({ aggregateType: "EVIDENCE", aggregateId: id, eventType: "EVIDENCE_UPLOADED", actor: actor.data, occurredAt: now, correlationId: id }, { digest: blob.digest, byteLength: blob.byteLength, scanStatus: blob.scanStatus, manifestHash });
      return c.json({ data: { blob, manifest } }, 201);
    } catch (error) {
      const code = error instanceof Error ? error.message : "EVIDENCE_INGESTION_FAILED";
      const status = code === "FILE_TOO_LARGE" ? 413 : code === "UNSUPPORTED_MEDIA_TYPE" || code === "MIME_MISMATCH" ? 415 : code === "SCANNER_UNAVAILABLE" || code === "SCANNER_FAILED" ? 503 : code === "MALWARE_DETECTED" ? 422 : 400;
      return c.json({ error: { code, message: status === 503 ? "Evidence scanning is unavailable; upload rejected closed." : "Evidence upload was rejected." } }, status);
    }
  });

  app.get("/api/v1/evidence/blobs/:digest", async (c) => {
    const evidenceRequiresAuth = process.env.NODE_ENV === "production" || process.env.PROOFFLOW_EVIDENCE_REQUIRE_AUTH === "true";
    const evidenceToken = process.env.PROOFFLOW_API_TOKEN;
    if (evidenceRequiresAuth && (!evidenceToken || c.req.header("authorization") !== `Bearer ${evidenceToken}`)) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "A valid evidence access token is required." } }, 401);
    }
    const digest = c.req.param("digest");
    const bytes = await evidenceStore.get(digest);
    if (!bytes) return c.json({ error: { code: "NOT_FOUND", message: "Evidence blob not found." } }, 404);
    const manifest = repository.listAgreements().map((agreement) => repository.getManifest(agreement.id)).find((item) => item?.items.some((entry) => entry.sha256.toLowerCase() === digest.toLowerCase().replace(/^0x/, "")));
    if (!manifest) return c.json({ error: { code: "NOT_FOUND", message: "Evidence blob not found." } }, 404);
    const blobAgreement = repository.getAgreement(manifest.agreementId);
    if (!blobAgreement) return c.json({ error: { code: "NOT_FOUND", message: "Evidence blob not found." } }, 404);
    const accessError = agreementAccess(c, blobAgreement);
    if (accessError) return accessError;
    const item = manifest.items.find((entry) => entry.sha256.toLowerCase() === digest.toLowerCase().replace(/^0x/, ""));
    const filename = (item?.name ?? "evidence").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160) || "evidence";
    return new Response(Buffer.from(bytes), { headers: { "content-type": item?.mediaType ?? "application/octet-stream", "content-length": String(bytes.byteLength), "content-disposition": `attachment; filename="${filename}"`, "x-content-address": `0x${digest.replace(/^0x/, "")}` } });
  });

  app.post("/api/v1/agreements/:id/evaluate", async (c) => {
    const id = c.req.param("id");
    const agreement = repository.getAgreement(id);
    const manifest = repository.getManifest(id);
    if (!agreement) return c.json({ error: { code: "NOT_FOUND", message: "Agreement not found." } }, 404);
    const accessError = agreementAccess(c, agreement);
    if (accessError) return accessError;
    if (!manifest) return c.json({ error: { code: "INVALID_STATE", message: "Evidence must be submitted before evaluation." } }, 409);
    const reviewRun = repository.getLatestReviewRun(id);
    if (!reviewRun || reviewRun.status !== "SUCCEEDED" || reviewRun.evidenceManifestHash !== manifest.manifestHash) return c.json({ error: { code: "REVIEW_REQUIRED", message: "A successful review of the current evidence is required before policy evaluation." } }, 409);
    const manifestTypes = manifest.items.map((item) => item.type);
    const manifestIntegrity = manifest.items.every((item) => /^[a-f0-9]{64}$/i.test(item.sha256)) && reviewRun.evidenceManifestHash === manifest.manifestHash;
    const decision = evaluatePolicy({ policy: agreement.policy, policyHash: agreement.policyHash, manifestTypes, manifestIntegrity, observation: reviewRun.observation, evaluatedAt: new Date().toISOString() });
    const nextState = decision.outcome === "PASS" ? JobState.READY_TO_RELEASE : decision.outcome === "BLOCK" ? JobState.BLOCKED : JobState.UNDER_REVIEW;
    const updated = AgreementSchema.parse({ ...agreement, state: nextState, updatedAt: decision.evaluatedAt });
    repository.saveAgreement(updated);
    repository.appendAuditEvent({ aggregateType: "POLICY_DECISION", aggregateId: id, eventType: "POLICY_EVALUATED", actor: "policy-engine", occurredAt: decision.evaluatedAt, correlationId: id }, { decision, manifestHash: manifest.manifestHash });
    return c.json({ data: { agreement: updated, decision } });
  });

  app.post("/api/v1/agreements/:id/review", async (c) => {
    const id = c.req.param("id");
    const agreement = repository.getAgreement(id);
    const manifest = repository.getManifest(id);
    if (!agreement) return c.json({ error: { code: "NOT_FOUND", message: "Agreement not found." } }, 404);
    const accessError = agreementAccess(c, agreement);
    if (accessError) return accessError;
    if (!manifest) return c.json({ error: { code: "INVALID_STATE", message: "Evidence must be submitted before review." } }, 409);
    if (agreement.state !== JobState.EVIDENCE_SUBMITTED && agreement.state !== JobState.UNDER_REVIEW) return c.json({ error: { code: "INVALID_STATE", message: "Agreement is not awaiting evidence review." } }, 409);
    const body = z.object({ evidenceText: z.string().max(40_000).default("") }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: { code: "VALIDATION_ERROR", message: "Review input is invalid.", fields: body.error.flatten().fieldErrors } }, 400);
    const reviewStartedAt = performance.now();
    const reviewRun = await runReview(createReviewProvider(), { agreementId: id, manifest, evidenceText: body.data.evidenceText });
    observability.recordReview(reviewRun.status, performance.now() - reviewStartedAt);
    repository.saveReviewRun(reviewRun);
    const updated = AgreementSchema.parse({ ...agreement, state: reviewRun.status === "SUCCEEDED" ? JobState.REVIEWED : JobState.UNDER_REVIEW, updatedAt: reviewRun.completedAt ?? reviewRun.createdAt });
    repository.saveAgreement(updated);
    repository.appendAuditEvent({ aggregateType: "POLICY_DECISION", aggregateId: id, eventType: "AI_REVIEW_COMPLETED", actor: reviewRun.provider.provider, occurredAt: reviewRun.completedAt ?? reviewRun.createdAt, correlationId: id }, { reviewRunId: reviewRun.id, status: reviewRun.status, outputHash: reviewRun.outputHash });
    return c.json({ data: { agreement: updated, reviewRun } }, 201);
  });

  app.get("/api/v1/agreements/:id/reviews/latest", (c) => {
    const agreement = repository.getAgreement(c.req.param("id"));
    if (!agreement) return c.json({ error: { code: "NOT_FOUND", message: "Agreement not found." } }, 404);
    const accessError = agreementAccess(c, agreement);
    if (accessError) return accessError;
    const reviewRun = repository.getLatestReviewRun(c.req.param("id"));
    if (!reviewRun) return c.json({ error: { code: "NOT_FOUND", message: "Review run not found." } }, 404);
    return c.json({ data: reviewRun });
  });

  app.post("/api/v1/agreements/:id/settlement-intents", async (c) => {
    const id = c.req.param("id");
    const agreement = repository.getAgreement(id);
    if (!agreement) return c.json({ error: { code: "NOT_FOUND", message: "Agreement not found." } }, 404);
    if (agreement.state !== JobState.READY_TO_RELEASE) return c.json({ error: { code: "INVALID_STATE", message: "Agreement is not ready for release." } }, 409);
    const manifest = repository.getManifest(id);
    if (!manifest) return c.json({ error: { code: "INVALID_STATE", message: "Evidence manifest is missing." } }, 409);
    const body = z.object({ idempotencyKey: z.string().min(8).max(128) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: { code: "VALIDATION_ERROR", message: "Settlement intent is invalid.", fields: body.error.flatten().fieldErrors } }, 400);
    const existing = repository.getSettlementIntentByIdempotencyKey(body.data.idempotencyKey);
    if (existing) {
      if (existing.agreementId !== id) return c.json({ error: { code: "IDEMPOTENCY_KEY_CONFLICT", message: "Idempotency key is already bound to another agreement." } }, 409);
      return c.json({ data: existing, idempotent: true });
    }
    const now = new Date().toISOString();
    const intent = SettlementIntentSchema.parse({ id: `set_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`, agreementId: id, idempotencyKey: body.data.idempotencyKey, amountBaseUnits: agreement.policy.releaseAmountBaseUnits, recipient: agreement.recipient, tokenAddress: agreement.tokenAddress, policyHash: agreement.policyHash, evidenceManifestHash: manifest.manifestHash, state: "CREATED", createdAt: now, updatedAt: now });
    repository.saveSettlementIntent(intent);
    repository.appendAuditEvent({ aggregateType: "SETTLEMENT_INTENT", aggregateId: id, eventType: "SETTLEMENT_INTENT_CREATED", actor: "system", occurredAt: now, correlationId: id }, { intent });
    return c.json({ data: intent }, 201);
  });

  app.get("/api/v1/agreements/:id/settlement-intent", (c) => {
    const agreement = repository.getAgreement(c.req.param("id"));
    if (!agreement) return c.json({ error: { code: "NOT_FOUND", message: "Agreement not found." } }, 404);
    const accessError = agreementAccess(c, agreement);
    if (accessError) return accessError;
    const intent = repository.getSettlementIntentByAgreementId(c.req.param("id"));
    if (!intent) return c.json({ error: { code: "NOT_FOUND", message: "Settlement intent not found." } }, 404);
    return c.json({ data: intent });
  });

  app.post("/api/v1/settlement-intents/:id/authorization", async (c) => {
    const intent = repository.getSettlementIntent(c.req.param("id"));
    if (!intent) return c.json({ error: { code: "NOT_FOUND", message: "Settlement intent not found." } }, 404);
    const body = z.object({ walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/), transactionHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/), chainId: z.number().int().positive() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: { code: "VALIDATION_ERROR", message: "Authorization receipt is invalid.", fields: body.error.flatten().fieldErrors } }, 400);
    if (intent.transactionHash && intent.transactionHash.toLowerCase() !== body.data.transactionHash.toLowerCase()) return c.json({ error: { code: "TRANSACTION_HASH_CONFLICT", message: "This settlement intent is already bound to a different transaction." } }, 409);
    if (intent.state !== "CREATED" && intent.state !== "AWAITING_AUTHORIZATION") {
      if (intent.transactionHash?.toLowerCase() === body.data.transactionHash.toLowerCase() && intent.authorizedBy?.toLowerCase() === body.data.walletAddress.toLowerCase()) return c.json({ data: { intent, authorization: body.data }, idempotent: true });
      return c.json({ error: { code: "INVALID_STATE", message: "Settlement intent is no longer awaiting authorization." } }, 409);
    }
    const expectedChainId = xLayerChainId;
    if (body.data.chainId !== expectedChainId) return c.json({ error: { code: "WRONG_NETWORK", message: `Expected X Layer chain ${expectedChainId}.` } }, 409);
    const agreement = repository.getAgreement(intent.agreementId);
    if (!agreement) return c.json({ error: { code: "NOT_FOUND", message: "Agreement not found." } }, 404);
    const accessError = agreementAccess(c, agreement);
    if (accessError) return accessError;
    if (body.data.walletAddress.toLowerCase() !== agreement.payer.toLowerCase()) return c.json({ error: { code: "UNAUTHORIZED_WALLET", message: "Only the agreement payer can authorize the native vault release." } }, 403);
    const now = new Date().toISOString();
    if (!vaultAddress || !/^0x[a-fA-F0-9]{40}$/.test(vaultAddress)) return c.json({ error: { code: "VAULT_NOT_CONFIGURED", message: "ProofFlow vault address is not configured." } }, 503);
    try {
      const verifier = new ProofFlowVaultClient({ rpcUrl: xLayerRpcUrl, expectedChainId, vaultAddress: vaultAddress as `0x${string}`, timeoutMs: RPC_TIMEOUT_MS, onRpcMetric: (metric) => observability.recordRpc(metric) });
      await verifier.verifyReleaseIntentTransaction({ transactionHash: body.data.transactionHash as `0x${string}`, payer: agreement.payer });
    } catch (error) {
      return c.json({ error: { code: "AUTHORIZATION_UNVERIFIED", message: error instanceof Error ? error.message : "Could not verify the authorized transaction." } }, 409);
    }
    const updated = SettlementIntentSchema.parse({ ...intent, transactionHash: body.data.transactionHash, authorizedBy: body.data.walletAddress, chainId: body.data.chainId, state: "SUBMITTED", updatedAt: now });
    repository.saveSettlementIntent(updated);
    repository.appendAuditEvent({ aggregateType: "SETTLEMENT_INTENT", aggregateId: intent.agreementId, eventType: "SETTLEMENT_AUTHORIZED", actor: body.data.walletAddress, occurredAt: now, correlationId: intent.id }, { intentId: intent.id, walletAddress: body.data.walletAddress, transactionHash: body.data.transactionHash, chainId: body.data.chainId });
    return c.json({ data: { intent: updated, authorization: body.data } });
  });

  app.post("/api/v1/settlement-intents/:id/reconcile", async (c) => {
    const intent = repository.getSettlementIntent(c.req.param("id"));
    if (!intent) return c.json({ error: { code: "NOT_FOUND", message: "Settlement intent not found." } }, 404);
    const body = z.object({ transactionHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: { code: "VALIDATION_ERROR", message: "Transaction hash is invalid.", fields: body.error.flatten().fieldErrors } }, 400);
    if (!intent.transactionHash) return c.json({ error: { code: "AUTHORIZATION_REQUIRED", message: "Authorize this exact settlement intent in the payer wallet before reconciliation." } }, 409);
    if (intent.transactionHash.toLowerCase() !== body.data.transactionHash.toLowerCase()) return c.json({ error: { code: "TRANSACTION_HASH_CONFLICT", message: "The reconciliation hash does not match the authorized settlement intent." } }, 409);
    const agreement = repository.getAgreement(intent.agreementId);
    if (!agreement) return c.json({ error: { code: "NOT_FOUND", message: "Agreement not found." } }, 404);
    const accessError = agreementAccess(c, agreement);
    if (accessError) return accessError;
    try {
      const client = new XLayerClient({ rpcUrl: xLayerRpcUrl, expectedChainId: xLayerChainId, timeoutMs: RPC_TIMEOUT_MS, onRpcMetric: (metric) => observability.recordRpc(metric) });
      if (!vaultAddress || !/^0x[a-fA-F0-9]{40}$/.test(vaultAddress)) return c.json({ error: { code: "VAULT_NOT_CONFIGURED", message: "ProofFlow vault address is not configured." } }, 503);
      const verifier = new ProofFlowVaultClient({ rpcUrl: xLayerRpcUrl, expectedChainId: xLayerChainId, vaultAddress: vaultAddress as `0x${string}`, timeoutMs: RPC_TIMEOUT_MS });
      const receipt = await verifier.getTransactionReceipt(body.data.transactionHash as `0x${string}`);
      if (!receipt) {
        observability.recordReconciliation("PENDING");
        return c.json({ data: { intent, status: "PENDING", receipt: null } });
      }
      await verifier.verifyReleaseTransaction({ transactionHash: body.data.transactionHash as `0x${string}`, payer: agreement.payer, recipient: agreement.recipient, amountBaseUnits: intent.amountBaseUnits, expectedBlockNumber: receipt.blockNumber });
      if (!receipt.to || receipt.to.toLowerCase() !== vaultAddress.toLowerCase()) return c.json({ error: { code: "RECEIPT_TARGET_MISMATCH", message: "Receipt target does not match the configured ProofFlow vault." } }, 409);
      if (receipt.from.toLowerCase() !== agreement.payer.toLowerCase()) return c.json({ error: { code: "RECEIPT_SENDER_MISMATCH", message: "Receipt sender does not match the agreement payer." } }, 409);
      if (intent.state === "CONFIRMED" || intent.state === "FAILED") {
        observability.recordReconciliation(intent.state === "CONFIRMED" ? "CONFIRMED" : "FAILED");
        const currentAgreement = repository.getAgreement(intent.agreementId);
        return c.json({ data: { intent, agreement: currentAgreement, status: intent.state, receipt: { ...receipt, blockNumber: receipt.blockNumber.toString() }, idempotent: true } });
      }
      const now = new Date().toISOString();
      const nextState = receipt.status === "0x1" ? "CONFIRMED" : "FAILED";
      observability.recordReconciliation(nextState);
      const updated = SettlementIntentSchema.parse({ ...intent, state: nextState, updatedAt: now });
      const projectedAgreement = AgreementSchema.parse({ ...agreement, state: nextState === "CONFIRMED" ? JobState.RELEASED : agreement.state, updatedAt: now });
      repository.confirmSettlement(updated, projectedAgreement, {
        input: { aggregateType: "SETTLEMENT_INTENT", aggregateId: intent.agreementId, eventType: nextState === "CONFIRMED" ? "SETTLEMENT_CONFIRMED" : "SETTLEMENT_FAILED", actor: "xlayer-reconciler", occurredAt: now, correlationId: intent.id },
        payload: { intentId: intent.id, agreementState: projectedAgreement.state, transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber.toString(), status: receipt.status }
      });
      return c.json({ data: { intent: updated, agreement: projectedAgreement, status: nextState, receipt: { ...receipt, blockNumber: receipt.blockNumber.toString() } } });
    } catch (error) {
      observability.recordReconciliation("ERROR");
      return c.json({ error: { code: "RECONCILIATION_FAILED", message: error instanceof Error ? error.message : "Could not reconcile transaction." } }, 503);
    }
  });

  app.get("/api/v1/settlement-intents/:id", (c) => {
    const intent = repository.getSettlementIntent(c.req.param("id"));
    if (!intent) return c.json({ error: { code: "NOT_FOUND", message: "Settlement intent not found." } }, 404);
    const agreement = intent ? repository.getAgreement(intent.agreementId) : null;
    if (agreement) { const accessError = agreementAccess(c, agreement); if (accessError) return accessError; }
    return c.json({ data: intent });
  });

  return app;
}

const repository = new MemoryRepository();

export const app = createApp(repository);

export default {
  port: Number(process.env.PORT ?? 8787),
  fetch: app.fetch
};
