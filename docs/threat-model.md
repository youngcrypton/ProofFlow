# ProofFlow threat model — MVP

## Assets

- Funds held by the milestone vault.
- Agreement terms and recipient identity.
- Evidence bytes, hashes, and review results.
- Signer keys and transaction authorization.
- Audit history and settlement receipts.

## Trust boundaries

1. Browser to API: untrusted input and untrusted files.
2. API to evidence storage: content may be adversarial and can contain prompt injection.
3. API to AI provider: model output is untrusted and may be unavailable or malformed.
4. API to policy engine: only validated typed data may cross the boundary.
5. Signer to chain: the user must see and approve the exact intent.
6. Contract to external chain state: RPC responses may be stale, unavailable, or from the wrong network.

## Critical invariants

- AI output can never directly invoke a transfer.
- A settlement intent is bound to one agreement, one milestone, one recipient, one amount, one evidence root, and one policy version.
- A milestone can be released at most once.
- Only the authorized approver can approve a settlement intent.
- Refunds cannot race or follow a completed release.
- Contract calls reject wrong chain assumptions at the client boundary and enforce state checks on-chain.
- Evidence is content-addressed; replacing a file creates a new version rather than mutating history.
- Private keys and provider secrets never enter the browser bundle or repository.
- Every externally visible state transition has an audit event and a transaction/reconciliation status.

## Threats and mitigations

| Threat | Mitigation |
|---|---|
| Prompt injection in evidence | Treat evidence as data; isolate extraction; do not expose tools or secrets to the reviewer; schema-validate output. |
| Malicious AI recommendation | Deterministic policy engine, explicit approval, contract invariants, fail-closed uncertainty. |
| Replay of settlement | Unique intent ID and nonce; contract consumes the intent; client tracks transaction hash. |
| Double release | Contract state machine and one-time release guard; invariant tests. |
| Recipient substitution | Recipient is hashed/bound in the intent and checked at settlement. |
| Wrong chain or contract | Network allowlist, chain ID check, contract address config, deployment manifest. |
| RPC tampering or stale reads | Multiple read providers where practical, event reconciliation, finality-aware status, no settlement from an unverified read. |
| Oversized or hostile files | Size/type limits, malware scanning boundary, timeouts, hashing before processing. |
| API abuse | Authentication, authorization, idempotency keys, rate limits, structured audit logs. |
| Secret leakage | Environment-only secrets, redacted logs, no client exposure, pre-commit secret scanning. |
| XSS or injection | Output encoding, strict CSP where deployable, safe markdown rendering, validated URLs. |
| Denial of service | Bounded queues, request timeouts, pagination, backpressure, bounded RPC concurrency. |

## Security test gates

- Contract unit, fuzz, and invariant tests.
- Policy table tests, including boundary timestamps and amounts.
- Malformed AI output tests.
- Prompt-injection fixture tests.
- Authorization and replay tests.
- Wrong-chain and wrong-contract tests.
- Dependency and secret scans.
- Manual review of all transaction signing surfaces.
