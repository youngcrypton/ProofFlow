import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./index";
import { MemoryRepository } from "./memory-repository";
import { EvidenceStore } from "./evidence-store";

const client = privateKeyToAccount(`0x${"1".repeat(64)}`);
const contractor = privateKeyToAccount(`0x${"2".repeat(64)}`);
const unrelated = privateKeyToAccount(`0x${"3".repeat(64)}`);
const sessionSecret = "contractor-workflow-test-secret";
const input = {
  title: "Build the assigned milestone",
  description: "Complete the implementation and provide proof.",
  acceptanceCriteria: "The requested milestone is demonstrably complete.",
  payer: client.address,
  recipient: `0x${contractor.address.slice(2).toUpperCase()}`,
  tokenAddress: `0x${"4".repeat(40)}`,
  amountBaseUnits: "1000",
  deadline: "2099-01-01T00:00:00.000Z",
  policy: { version: "workflow-v1", requiredEvidence: ["status_update"], minimumConfidenceBps: 9000, releaseAmountBaseUnits: "1000", deadline: "2099-01-01T00:00:00.000Z" }
};

const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const auth = (token: string): HeadersInit => ({ "x-proofflow-wallet-session": token });

function uploadForm(submittedBy: string, agreementId?: string): FormData {
  const form = new FormData();
  form.set("file", new File(["contractor evidence"], "evidence.txt", { type: "text/plain" }));
  form.set("evidenceType", "status_update");
  form.set("submittedBy", submittedBy);
  if (agreementId) form.set("agreementId", agreementId);
  return form;
}

async function session(app: ReturnType<typeof createApp>, account: ReturnType<typeof privateKeyToAccount>): Promise<string> {
  const challenge = await app.request(`http://localhost/api/v1/wallet/challenge?address=${account.address}` , json({}));
  const challengeBody = await challenge.json() as { data: { nonce: string; message: string } };
  const signature = await account.signMessage({ message: challengeBody.data.message });
  const response = await app.request("http://localhost/api/v1/wallet/session", json({ address: account.address, nonce: challengeBody.data.nonce, signature }));
  return ((await response.json()) as { data: { token: string } }).data.token;
}

describe("wallet-scoped contractor workflow", () => {
  const previous = { enforce: process.env.PROOFFLOW_ENFORCE_WALLET_AUTH, require: process.env.PROOFFLOW_REQUIRE_AUTH, secret: process.env.PROOFFLOW_SESSION_SECRET };
  beforeEach(() => { process.env.PROOFFLOW_ENFORCE_WALLET_AUTH = "true"; process.env.PROOFFLOW_REQUIRE_AUTH = "true"; process.env.PROOFFLOW_SESSION_SECRET = sessionSecret; });
  afterEach(() => { for (const [key, value] of Object.entries({ PROOFFLOW_ENFORCE_WALLET_AUTH: previous.enforce, PROOFFLOW_REQUIRE_AUTH: previous.require, PROOFFLOW_SESSION_SECRET: previous.secret })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

  it("shows an assigned agreement only to the signed contractor and protects evidence submission", async () => {
    const repository = new MemoryRepository();
    const app = createApp(repository);
    const clientToken = await session(app, client);
    const contractorToken = await session(app, contractor);
    const unrelatedToken = await session(app, unrelated);
    const created = await app.request("http://localhost/api/v1/agreements", { ...json(input), headers: { "content-type": "application/json", ...auth(clientToken) } });
    expect(created.status).toBe(201);
    const agreement = (await created.json() as { data: { id: string } }).data;
    await app.request(`http://localhost/api/v1/agreements/${agreement.id}/fund`, { method: "POST", headers: auth(clientToken) });

    const assigned = await app.request("http://localhost/api/v1/agreements?role=contractor&address=0x0000000000000000000000000000000000000001", { headers: auth(contractorToken) });
    expect(assigned.status).toBe(403);
    const contractorList = await app.request("http://localhost/api/v1/agreements?role=contractor", { headers: auth(contractorToken) });
    expect((await contractorList.json() as { data: Array<{ id: string }> }).data.map((item) => item.id)).toContain(agreement.id);
    const unrelatedList = await app.request("http://localhost/api/v1/agreements?role=contractor", { headers: auth(unrelatedToken) });
    expect((await unrelatedList.json() as { data: Array<{ id: string }> }).data).toHaveLength(0);
    expect((await app.request(`http://localhost/api/v1/agreements/${agreement.id}`, { headers: auth(unrelatedToken) })).status).toBe(403);
    expect((await app.request("http://localhost/api/v1/agreements?role=contractor")).status).toBe(401);

    const manifest = { agreementId: agreement.id, submittedBy: contractor.address, submittedAt: "2026-08-07T00:00:00.000Z", items: [{ type: "status_update", name: "status.txt", mediaType: "text/plain", sha256: "a".repeat(64), uri: "https://example.com/status.txt" }] };
    const submitted = await app.request(`http://localhost/api/v1/agreements/${agreement.id}/evidence`, { ...json(manifest), headers: { "content-type": "application/json", ...auth(contractorToken) } });
    expect(submitted.status).toBe(201);
    const detail = await app.request(`http://localhost/api/v1/agreements/${agreement.id}`, { headers: auth(contractorToken) });
    expect(detail.status).toBe(200);
    expect((await detail.json() as { data: { state: string } }).data.state).toBe("EVIDENCE_SUBMITTED");
    expect((await app.request(`http://localhost/api/v1/agreements/${agreement.id}/evidence`, { ...json({ ...manifest, submittedBy: client.address }), headers: { "content-type": "application/json", ...auth(clientToken) } })).status).toBe(403);
  });

  it("keeps client access and normalized contractor matching intact", async () => {
    const repository = new MemoryRepository();
    const app = createApp(repository);
    const clientToken = await session(app, client);
    const created = await app.request("http://localhost/api/v1/agreements", { ...json(input), headers: { "content-type": "application/json", "x-proofflow-wallet-session": clientToken } });
    const agreement = (await created.json() as { data: { id: string } }).data;
    const clientList = await app.request("http://localhost/api/v1/agreements?role=client", { headers: { "x-proofflow-wallet-session": clientToken } });
    expect((await clientList.json() as { data: Array<{ id: string }> }).data.map((item) => item.id)).toContain(agreement.id);
    expect(input.recipient.slice(2)).toBe(input.recipient.slice(2).toUpperCase());
  });

  it("requires a valid signed session for agreement creation and ignores browser wallet substitutions", async () => {
    const app = createApp(new MemoryRepository());
    const contractorToken = await session(app, contractor);
    expect((await app.request("http://localhost/api/v1/agreements", { ...json(input) })).status).toBe(401);
    expect((await app.request("http://localhost/api/v1/agreements", { ...json(input), headers: { "content-type": "application/json", ...auth("expired.invalid.session") } })).status).toBe(401);
    expect((await app.request("http://localhost/api/v1/agreements", { ...json(input), headers: { "content-type": "application/json", ...auth(contractorToken) } })).status).toBe(403);
    expect((await app.request(`http://localhost/api/v1/agreements?role=client&address=${client.address}`, { headers: auth(contractorToken) })).status).toBe(403);
  });

  it("rejects contractor funding and unrelated JSON and multipart evidence submission", async () => {
    const repository = new MemoryRepository();
    const app = createApp(repository);
    const clientToken = await session(app, client);
    const contractorToken = await session(app, contractor);
    const unrelatedToken = await session(app, unrelated);
    const created = await app.request("http://localhost/api/v1/agreements", { ...json(input), headers: { "content-type": "application/json", ...auth(clientToken) } });
    const agreement = (await created.json() as { data: { id: string } }).data;

    expect((await app.request(`http://localhost/api/v1/agreements/${agreement.id}/fund`, { method: "POST", headers: auth(contractorToken) })).status).toBe(403);
    expect((await app.request(`http://localhost/api/v1/agreements/${agreement.id}/fund`, { method: "POST", headers: auth(clientToken) })).status).toBe(200);

    const manifest = { agreementId: agreement.id, submittedBy: unrelated.address, submittedAt: "2026-08-07T00:00:00.000Z", items: [{ type: "status_update", name: "status.txt", mediaType: "text/plain", sha256: "b".repeat(64), uri: "https://example.com/unrelated.txt" }] };
    expect((await app.request(`http://localhost/api/v1/agreements/${agreement.id}/evidence`, { ...json(manifest), headers: { "content-type": "application/json", ...auth(unrelatedToken) } })).status).toBe(403);
    expect((await app.request(`http://localhost/api/v1/agreements/${agreement.id}/evidence/upload`, { method: "POST", headers: auth(unrelatedToken), body: uploadForm(unrelated.address) })).status).toBe(403);
  });

  it("rejects agreement ID and submitter substitution across contractor boundaries", async () => {
    const repository = new MemoryRepository();
    const app = createApp(repository);
    const clientToken = await session(app, client);
    const contractorToken = await session(app, contractor);
    const unrelatedToken = await session(app, unrelated);
    const firstResponse = await app.request("http://localhost/api/v1/agreements", { ...json(input), headers: { "content-type": "application/json", ...auth(clientToken) } });
    const first = (await firstResponse.json() as { data: { id: string } }).data;
    const secondInput = { ...input, title: "Other contractor agreement", recipient: unrelated.address };
    const secondResponse = await app.request("http://localhost/api/v1/agreements", { ...json(secondInput), headers: { "content-type": "application/json", ...auth(clientToken) } });
    const second = (await secondResponse.json() as { data: { id: string } }).data;
    await app.request(`http://localhost/api/v1/agreements/${first.id}/fund`, { method: "POST", headers: auth(clientToken) });
    await app.request(`http://localhost/api/v1/agreements/${second.id}/fund`, { method: "POST", headers: auth(clientToken) });

    expect((await app.request(`http://localhost/api/v1/agreements/${second.id}`, { headers: auth(contractorToken) })).status).toBe(403);
    const substituted = { agreementId: second.id, submittedBy: contractor.address, submittedAt: "2026-08-07T00:00:00.000Z", items: [{ type: "status_update", name: "status.txt", mediaType: "text/plain", sha256: "c".repeat(64), uri: "https://example.com/substituted.txt" }] };
    expect((await app.request(`http://localhost/api/v1/agreements/${first.id}/evidence`, { ...json(substituted), headers: { "content-type": "application/json", ...auth(contractorToken) } })).status).toBe(400);
    expect((await app.request(`http://localhost/api/v1/agreements/${second.id}/evidence`, { ...json({ ...substituted, agreementId: second.id }), headers: { "content-type": "application/json", ...auth(contractorToken) } })).status).toBe(403);
    expect((await app.request(`http://localhost/api/v1/agreements/${second.id}/evidence/upload`, { method: "POST", headers: auth(contractorToken), body: uploadForm(contractor.address, first.id) })).status).toBe(403);

    const forgedSubmitter = { ...substituted, agreementId: first.id, submittedBy: unrelated.address };
    expect((await app.request(`http://localhost/api/v1/agreements/${first.id}/evidence`, { ...json(forgedSubmitter), headers: { "content-type": "application/json", ...auth(contractorToken) } })).status).toBe(403);
    expect((await app.request(`http://localhost/api/v1/agreements/${first.id}/evidence/upload`, { method: "POST", headers: auth(contractorToken), body: uploadForm(unrelated.address) })).status).toBe(403);
    expect((await app.request(`http://localhost/api/v1/agreements/${first.id}/evidence`, { ...json({ ...forgedSubmitter, submittedBy: client.address }), headers: { "content-type": "application/json", ...auth(clientToken) } })).status).toBe(403);
  });

  it("keeps authenticated contractor files quarantined when scanning is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "proofflow-contractor-scan-"));
    try {
      const repository = new MemoryRepository();
      const evidenceStore = new EvidenceStore(root, 10 * 1024 * 1024, async () => ({ clean: false, reason: "SCANNER_UNAVAILABLE" }));
      const app = createApp(repository, undefined, evidenceStore);
      const clientToken = await session(app, client);
      const contractorToken = await session(app, contractor);
      const created = await app.request("http://localhost/api/v1/agreements", { ...json(input), headers: { "content-type": "application/json", ...auth(clientToken) } });
      const agreement = (await created.json() as { data: { id: string } }).data;
      await app.request(`http://localhost/api/v1/agreements/${agreement.id}/fund`, { method: "POST", headers: auth(clientToken) });

      const response = await app.request(`http://localhost/api/v1/agreements/${agreement.id}/evidence/upload`, { method: "POST", headers: auth(contractorToken), body: uploadForm(contractor.address) });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "SCANNER_UNAVAILABLE" } });
      const quarantined = await readdir(join(root, "quarantine"), { recursive: true });
      const clean = await readdir(join(root, "clean"), { recursive: true });
      expect(quarantined.some((name) => name.endsWith(".scan"))).toBe(true);
      expect(clean.some((name) => /^[a-f0-9]{64}$/.test(name))).toBe(false);
      expect(repository.getManifest(agreement.id)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
