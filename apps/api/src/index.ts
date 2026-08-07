import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { AgreementSchema } from "@proofflow/domain";

const app = new Hono();

app.use("*", cors());

app.get("/health", (c) => c.json({ ok: true, service: "proofflow-api", timestamp: new Date().toISOString() }));

const CreateAgreementRequestSchema = AgreementSchema.extend({
  title: z.string().min(1).max(120),
  description: z.string().max(1000).default("")
});

app.get("/api/v1/agreements", (c) => c.json({ data: [], nextCursor: null }));

app.post("/api/v1/agreements/validate", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = CreateAgreementRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { code: "VALIDATION_ERROR", message: "Agreement data is invalid.", fields: parsed.error.flatten().fieldErrors } }, 400);
  }
  return c.json({ data: { valid: true, agreement: parsed.data } });
});

export default {
  port: 8787,
  fetch: app.fetch
};
