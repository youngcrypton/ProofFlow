import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import {
  AgreementCreateInputSchema,
  AgreementSchema,
  EvidenceManifestContentSchema,
  EvidenceTypeSchema,
  JobState,
  ReviewObservationSchema,
  SettlementIntentSchema,
  canonicalizeEvidenceManifest,
  canonicalizePolicy,
  evaluatePolicy
} from "@proofflow/domain";
import { MemoryRepository } from "./memory-repository";
import type { ProofFlowRepository } from "./repository";
import { ProofFlowVaultClient, XLayerClient } from "./xlayer";
import { DeterministicDemoReviewer, runReview } from "./reviewer";

export function createApp(repository: ProofFlowRepository = new MemoryRepository()) {
  const app = new Hono();
  app.use("*", cors());

  const sha256Hex = async (value: string): Promise<`0x${string}`> => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return `0x${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  };

  app.get("/health", (c) => c.json({ ok: true, service: "proofflow-api", timestamp: new Date().toISOString() }));

  app.get("/api/v1/xlayer/status", async (c) => {
    try {
      const client = new XLayerClient({ rpcUrl: process.env.XLAYER_RPC_URL ?? "https://testrpc.xlayer.tech/terigon", expectedChainId: Number(process.env.XLAYER_CHAIN_ID ?? 1952) });
      const status = await client.getStatus();
      return c.json({ data: { ...status, blockNumber: status.blockNumber.toString() } });
    } catch (error) {
      return c.json({ error: { code: "XLAYER_UNAVAILABLE", message: error instanceof Error ? error.message : "X Layer status unavailable." } }, 503);
    }
  });

  app.get("/api/v1/agreements", (c) => c.json({ data: repository.listAgreements(), nextCursor: null }));

  app.post("/api/v1/demo/reset", async (c) => {
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
    const review = await runReview(new DeterministicDemoReviewer(), { agreementId: agreement.id, manifest, evidenceText: "Installation complete. Invoice total: 4.280 X Layer." });
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
    const vaultAddress = process.env.PROOFFLOW_VAULT_ADDRESS;
    if (!vaultAddress || !/^0x[a-fA-F0-9]{40}$/.test(vaultAddress)) return c.json({ error: { code: "VAULT_NOT_CONFIGURED", message: "ProofFlow vault address is not configured." } }, 503);
    try {
      const client = new ProofFlowVaultClient({ rpcUrl: process.env.XLAYER_RPC_URL ?? "https://testrpc.xlayer.tech/terigon", expectedChainId: Number(process.env.XLAYER_CHAIN_ID ?? 1952), vaultAddress: vaultAddress as `0x${string}` });
      const snapshot = await client.assertMatchesAgreement({ payer: agreement.payer, recipient: agreement.recipient, amountBaseUnits: agreement.policy.releaseAmountBaseUnits, policyHash: agreement.policyHash });
      return c.json({ data: { agreementId: id, network: { chainId: snapshot ? Number(process.env.XLAYER_CHAIN_ID ?? 1952) : 0, rpcUrl: process.env.XLAYER_RPC_URL ?? "https://testrpc.xlayer.tech/terigon" }, vault: { ...snapshot, amount: snapshot.amount.toString(), deadline: snapshot.deadline.toString(), balance: snapshot.balance.toString() }, transactions: { fund: client.previewFund(snapshot.amount), commitEvidence: repository.getManifest(id) ? client.previewCommitEvidence(repository.getManifest(id)!.manifestHash as `0x${string}`) : null, release: client.previewRelease() } } });
    } catch (error) {
      return c.json({ error: { code: "VAULT_MISMATCH", message: error instanceof Error ? error.message : "Vault verification failed." } }, 409);
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
    return c.json({ data: agreement });
  });

  app.post("/api/v1/agreements/:id/fund", (c) => {
    const agreement = repository.getAgreement(c.req.param("id"));
    if (!agreement) return c.json({ error: { code: "NOT_FOUND", message: "Agreement not found." } }, 404);
    if (agreement.state !== JobState.AWAITING_FUNDING) return c.json({ error: { code: "INVALID_STATE", message: "Agreement is not awaiting funding." } }, 409);
    const updated = AgreementSchema.parse({ ...agreement, state: JobState.FUNDED, updatedAt: new Date().toISOString() });
    repository.saveAgreement(updated);
    repository.appendAuditEvent({ aggregateType: "AGREEMENT", aggregateId: updated.id, eventType: "AGREEMENT_FUNDED", actor: "demo-payer", occurredAt: updated.updatedAt, correlationId: updated.id }, { previousState: agreement.state, nextState: updated.state });
    return c.json({ data: updated });
  });

  app.get("/api/v1/agreements/:id/audit", (c) => c.json({ data: repository.listAuditEvents(c.req.param("id")) }));

  app.post("/api/v1/agreements/:id/evidence", async (c) => {
    const id = c.req.param("id");
    const agreement = repository.getAgreement(id);
    if (!agreement) return c.json({ error: { code: "NOT_FOUND", message: "Agreement not found." } }, 404);
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
    const manifest = repository.getManifest(c.req.param("id"));
    if (!manifest) return c.json({ error: { code: "NOT_FOUND", message: "Evidence manifest not found." } }, 404);
    return c.json({ data: manifest });
  });

  app.post("/api/v1/agreements/:id/evaluate", async (c) => {
    const id = c.req.param("id");
    const agreement = repository.getAgreement(id);
    const manifest = repository.getManifest(id);
    if (!agreement) return c.json({ error: { code: "NOT_FOUND", message: "Agreement not found." } }, 404);
    if (!manifest) return c.json({ error: { code: "INVALID_STATE", message: "Evidence must be submitted before evaluation." } }, 409);
    const parsed = z.object({ manifestTypes: z.array(EvidenceTypeSchema), manifestIntegrity: z.boolean(), observation: ReviewObservationSchema }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: "VALIDATION_ERROR", message: "Evaluation input is invalid.", fields: parsed.error.flatten().fieldErrors } }, 400);
    const decision = evaluatePolicy({ policy: agreement.policy, policyHash: agreement.policyHash, ...parsed.data, evaluatedAt: new Date().toISOString() });
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
    if (!manifest) return c.json({ error: { code: "INVALID_STATE", message: "Evidence must be submitted before review." } }, 409);
    if (agreement.state !== JobState.EVIDENCE_SUBMITTED && agreement.state !== JobState.UNDER_REVIEW) return c.json({ error: { code: "INVALID_STATE", message: "Agreement is not awaiting evidence review." } }, 409);
    const body = z.object({ evidenceText: z.string().max(40_000).default("") }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: { code: "VALIDATION_ERROR", message: "Review input is invalid.", fields: body.error.flatten().fieldErrors } }, 400);
    const reviewRun = await runReview(new DeterministicDemoReviewer(), { agreementId: id, manifest, evidenceText: body.data.evidenceText });
    repository.saveReviewRun(reviewRun);
    const updated = AgreementSchema.parse({ ...agreement, state: reviewRun.status === "SUCCEEDED" ? JobState.REVIEWED : JobState.UNDER_REVIEW, updatedAt: reviewRun.completedAt ?? reviewRun.createdAt });
    repository.saveAgreement(updated);
    repository.appendAuditEvent({ aggregateType: "POLICY_DECISION", aggregateId: id, eventType: "AI_REVIEW_COMPLETED", actor: reviewRun.provider.provider, occurredAt: reviewRun.completedAt ?? reviewRun.createdAt, correlationId: id }, { reviewRunId: reviewRun.id, status: reviewRun.status, outputHash: reviewRun.outputHash });
    return c.json({ data: { agreement: updated, reviewRun } }, 201);
  });

  app.get("/api/v1/agreements/:id/reviews/latest", (c) => {
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
    if (existing) return c.json({ data: existing, idempotent: true });
    const now = new Date().toISOString();
    const intent = SettlementIntentSchema.parse({ id: `set_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`, agreementId: id, idempotencyKey: body.data.idempotencyKey, amountBaseUnits: agreement.policy.releaseAmountBaseUnits, recipient: agreement.recipient, tokenAddress: agreement.tokenAddress, policyHash: agreement.policyHash, evidenceManifestHash: manifest.manifestHash, state: "CREATED", createdAt: now, updatedAt: now });
    repository.saveSettlementIntent(intent);
    repository.appendAuditEvent({ aggregateType: "SETTLEMENT_INTENT", aggregateId: id, eventType: "SETTLEMENT_INTENT_CREATED", actor: "system", occurredAt: now, correlationId: id }, { intent });
    return c.json({ data: intent }, 201);
  });

  app.get("/api/v1/settlement-intents/:id", (c) => {
    const intent = repository.getSettlementIntent(c.req.param("id"));
    if (!intent) return c.json({ error: { code: "NOT_FOUND", message: "Settlement intent not found." } }, 404);
    return c.json({ data: intent });
  });

  return app;
}

export const app = createApp(new MemoryRepository());

export default {
  port: Number(process.env.PORT ?? 8787),
  fetch: app.fetch
};
