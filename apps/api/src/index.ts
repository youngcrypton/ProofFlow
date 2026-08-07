import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import {
  AgreementCreateInputSchema,
  AgreementSchema,
  AuditEventSchema,
  EvidenceManifestContentSchema,
  EvidenceManifestSchema,
  EvidenceTypeSchema,
  JobState,
  canonicalizeEvidenceManifest,
  canonicalizePolicy,
  evaluatePolicy
} from "@proofflow/domain";

const app = new Hono();
const agreements = new Map<string, z.infer<typeof AgreementSchema>>();
const manifests = new Map<string, z.infer<typeof EvidenceManifestSchema>>();
const auditEvents = new Map<string, z.infer<typeof AuditEventSchema>[]>();

app.use("*", cors());

async function sha256Hex(value: string): Promise<`0x${string}`> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `0x${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function appendAuditEvent(aggregateType: z.infer<typeof AuditEventSchema>["aggregateType"], aggregateId: string, eventType: string, payload: unknown, actor: string, occurredAt: string, correlationId: string) {
  const events = auditEvents.get(aggregateId) ?? [];
  const previousEventHash = events.at(-1)?.eventHash ?? `0x${"0".repeat(64)}`;
  const sequence = events.length + 1;
  const eventId = `evt_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const eventHashPromise = Promise.all([sha256Hex(JSON.stringify(payload)), sha256Hex(JSON.stringify({ eventId, sequence, aggregateType, aggregateId, eventType, actor, occurredAt, correlationId, previousEventHash }))]);
  return eventHashPromise.then(([payloadHash, eventHash]) => {
    const event = AuditEventSchema.parse({ id: eventId, sequence, aggregateType, aggregateId, eventType, actor, occurredAt, correlationId, payloadHash, previousEventHash, eventHash });
    auditEvents.set(aggregateId, [...events, event]);
    return event;
  });
}

app.get("/health", (c) => c.json({ ok: true, service: "proofflow-api", timestamp: new Date().toISOString() }));

app.get("/api/v1/agreements", (c) => c.json({ data: [...agreements.values()], nextCursor: null }));

app.post("/api/v1/agreements/validate", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = AgreementCreateInputSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: { code: "VALIDATION_ERROR", message: "Agreement data is invalid.", fields: parsed.error.flatten().fieldErrors } }, 400);
  return c.json({ data: { valid: true, agreement: parsed.data, canonicalPolicy: canonicalizePolicy(parsed.data.policy) } });
});

app.post("/api/v1/agreements", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = AgreementCreateInputSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: { code: "VALIDATION_ERROR", message: "Agreement data is invalid.", fields: parsed.error.flatten().fieldErrors } }, 400);

  const now = new Date().toISOString();
  const policyHash = await sha256Hex(canonicalizePolicy(parsed.data.policy));
  const agreement = AgreementSchema.parse({ ...parsed.data, id: `agr_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`, policyHash, state: JobState.AWAITING_FUNDING, createdAt: now, updatedAt: now });
  agreements.set(agreement.id, agreement);
  await appendAuditEvent("AGREEMENT", agreement.id, "AGREEMENT_CREATED", { agreement }, "system", now, agreement.id);
  return c.json({ data: agreement }, 201);
});

app.get("/api/v1/agreements/:id", (c) => {
  const agreement = agreements.get(c.req.param("id"));
  if (!agreement) return c.json({ error: { code: "NOT_FOUND", message: "Agreement not found." } }, 404);
  return c.json({ data: agreement });
});

app.get("/api/v1/agreements/:id/audit", (c) => c.json({ data: auditEvents.get(c.req.param("id")) ?? [] }));

app.post("/api/v1/agreements/:id/evidence", async (c) => {
  const id = c.req.param("id");
  const agreement = agreements.get(id);
  if (!agreement) return c.json({ error: { code: "NOT_FOUND", message: "Agreement not found." } }, 404);
  if (agreement.state !== JobState.FUNDED) return c.json({ error: { code: "INVALID_STATE", message: "Agreement must be funded before evidence submission." } }, 409);

  const body = await c.req.json().catch(() => null);
  const parsed = EvidenceManifestContentSchema.safeParse(body);
  if (!parsed.success || parsed.data?.agreementId !== id) return c.json({ error: { code: "VALIDATION_ERROR", message: "Evidence manifest is invalid.", fields: parsed.success ? { agreementId: ["Manifest agreementId does not match the route."] } : parsed.error.flatten().fieldErrors } }, 400);

  const submittedAt = parsed.data.submittedAt;
  const manifestHash = await sha256Hex(canonicalizeEvidenceManifest(parsed.data));
  const manifest = EvidenceManifestSchema.parse({ ...parsed.data, manifestHash });
  manifests.set(id, manifest);
  const updated = AgreementSchema.parse({ ...agreement, state: JobState.EVIDENCE_SUBMITTED, updatedAt: submittedAt });
  agreements.set(id, updated);
  await appendAuditEvent("EVIDENCE", id, "EVIDENCE_SUBMITTED", { manifestHash, itemCount: manifest.items.length }, manifest.submittedBy, submittedAt, id);
  return c.json({ data: { agreement: updated, manifest } }, 201);
});

app.post("/api/v1/agreements/:id/evaluate", async (c) => {
  const id = c.req.param("id");
  const agreement = agreements.get(id);
  const manifest = manifests.get(id);
  if (!agreement) return c.json({ error: { code: "NOT_FOUND", message: "Agreement not found." } }, 404);
  if (!manifest) return c.json({ error: { code: "INVALID_STATE", message: "Evidence must be submitted before evaluation." } }, 409);

  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ manifestTypes: z.array(EvidenceTypeSchema), manifestIntegrity: z.boolean(), observation: z.object({ requiredEvidencePresent: z.boolean(), extractedFacts: z.array(z.object({ key: z.string(), value: z.string(), source: z.string() })), contradictions: z.array(z.string()), missingItems: z.array(z.string()), confidenceBps: z.number().int().min(0).max(10_000) }) }).safeParse(body);
  if (!parsed.success) return c.json({ error: { code: "VALIDATION_ERROR", message: "Evaluation input is invalid.", fields: parsed.error.flatten().fieldErrors } }, 400);

  const decision = evaluatePolicy({ policy: agreement.policy, policyHash: agreement.policyHash, ...parsed.data, evaluatedAt: new Date().toISOString() });
  const nextState = decision.outcome === "PASS" ? JobState.READY_TO_RELEASE : decision.outcome === "BLOCK" ? JobState.BLOCKED : JobState.UNDER_REVIEW;
  const updated = AgreementSchema.parse({ ...agreement, state: nextState, updatedAt: decision.evaluatedAt });
  agreements.set(id, updated);
  await appendAuditEvent("POLICY_DECISION", id, "POLICY_EVALUATED", { decision, manifestHash: manifest.manifestHash }, "policy-engine", decision.evaluatedAt, id);
  return c.json({ data: { agreement: updated, decision } });
});

export { app };

export default {
  port: Number(process.env.PORT ?? 8787),
  fetch: app.fetch
};
