import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import {
  AgreementCreateInputSchema,
  AgreementSchema,
  EvidenceManifestSchema,
  JobState,
  evaluatePolicy
} from "@proofflow/domain";

const app = new Hono();
const agreements = new Map<string, z.infer<typeof AgreementSchema>>();

app.use("*", cors());

app.get("/health", (c) => c.json({ ok: true, service: "proofflow-api", timestamp: new Date().toISOString() }));

app.get("/api/v1/agreements", (c) => c.json({ data: [...agreements.values()], nextCursor: null }));

app.post("/api/v1/agreements/validate", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = AgreementCreateInputSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { code: "VALIDATION_ERROR", message: "Agreement data is invalid.", fields: parsed.error.flatten().fieldErrors } }, 400);
  }
  return c.json({ data: { valid: true, agreement: parsed.data } });
});

app.post("/api/v1/agreements", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = AgreementCreateInputSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { code: "VALIDATION_ERROR", message: "Agreement data is invalid.", fields: parsed.error.flatten().fieldErrors } }, 400);
  }

  const now = new Date().toISOString();
  const agreement = AgreementSchema.parse({
    ...parsed.data,
    id: `agr_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    policyHash: "0x" + "0".repeat(64),
    state: JobState.AWAITING_FUNDING,
    createdAt: now,
    updatedAt: now
  });
  agreements.set(agreement.id, agreement);
  return c.json({ data: agreement }, 201);
});

app.get("/api/v1/agreements/:id", (c) => {
  const agreement = agreements.get(c.req.param("id"));
  if (!agreement) return c.json({ error: { code: "NOT_FOUND", message: "Agreement not found." } }, 404);
  return c.json({ data: agreement });
});

app.post("/api/v1/agreements/:id/evidence", async (c) => {
  const id = c.req.param("id");
  const agreement = agreements.get(id);
  if (!agreement) return c.json({ error: { code: "NOT_FOUND", message: "Agreement not found." } }, 404);
  if (agreement.state !== JobState.FUNDED) return c.json({ error: { code: "INVALID_STATE", message: "Agreement must be funded before evidence submission." } }, 409);

  const body = await c.req.json().catch(() => null);
  const parsed = EvidenceManifestSchema.safeParse(body);
  if (!parsed.success || parsed.data?.agreementId !== id) {
    return c.json({ error: { code: "VALIDATION_ERROR", message: "Evidence manifest is invalid.", fields: parsed.success ? { agreementId: ["Manifest agreementId does not match the route."] } : parsed.error.flatten().fieldErrors } }, 400);
  }

  const updated = AgreementSchema.parse({ ...agreement, state: JobState.EVIDENCE_SUBMITTED, updatedAt: new Date().toISOString() });
  agreements.set(id, updated);
  return c.json({ data: { agreement: updated, manifest: parsed.data } }, 201);
});

app.post("/api/v1/agreements/:id/evaluate", async (c) => {
  const id = c.req.param("id");
  const agreement = agreements.get(id);
  if (!agreement) return c.json({ error: { code: "NOT_FOUND", message: "Agreement not found." } }, 404);
  if (agreement.state !== JobState.EVIDENCE_SUBMITTED) return c.json({ error: { code: "INVALID_STATE", message: "Evidence must be submitted before evaluation." } }, 409);

  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ manifestTypes: z.array(z.string()), manifestIntegrity: z.boolean(), observation: z.object({ requiredEvidencePresent: z.boolean(), extractedFacts: z.array(z.object({ key: z.string(), value: z.string(), source: z.string() })), contradictions: z.array(z.string()), missingItems: z.array(z.string()), confidenceBps: z.number().int().min(0).max(10_000) }) }).safeParse(body);
  if (!parsed.success) return c.json({ error: { code: "VALIDATION_ERROR", message: "Evaluation input is invalid.", fields: parsed.error.flatten().fieldErrors } }, 400);

  const decision = evaluatePolicy({ policy: agreement.policy, ...parsed.data, evaluatedAt: new Date().toISOString() });
  const nextState = decision.outcome === "PASS" ? JobState.READY_TO_RELEASE : decision.outcome === "BLOCK" ? JobState.BLOCKED : JobState.UNDER_REVIEW;
  const updated = AgreementSchema.parse({ ...agreement, state: nextState, updatedAt: decision.evaluatedAt });
  agreements.set(id, updated);
  return c.json({ data: { agreement: updated, decision } });
});

export default {
  port: Number(process.env.PORT ?? 8787),
  fetch: app.fetch
};