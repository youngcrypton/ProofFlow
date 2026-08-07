# ProofFlow architecture

## Product slice

ProofFlow’s first production-shaped slice is a milestone escrow workflow:

1. A payer creates an agreement with a recipient, amount, deadline, and versioned policy.
2. The payer funds the milestone on X Layer.
3. The recipient submits an evidence manifest.
4. AI extracts observations and possible gaps from the evidence, but has no authority to move funds.
5. Deterministic policy rules evaluate the evidence manifest and the AI observations.
6. If the release gate passes, an authorized settlement command is created.
7. The contract releases funds once and emits an auditable event.
8. The application reconciles the transaction receipt and shows the proof.

The first demo should support one real testnet agreement and one intentionally blocked case. A small, legible proof is stronger than a broad fake operating system.

## Boundary diagram

```text
┌──────────────────────────────┐
│ Web app                       │
│ agreements, evidence, audit  │
└──────────────┬───────────────┘
               │ typed HTTPS API
┌──────────────▼───────────────┐
│ Application API               │
│ auth · validation · idempotency│
│ orchestration · audit         │
└───────┬───────────┬──────────┘
        │           │
        │           └─────────────────┐
        │                             │
┌───────▼───────────────┐   ┌─────────▼───────────────┐
│ Evidence + policy      │   │ Chain adapter            │
│ hash/manifest          │   │ X Layer RPC              │
│ deterministic rules    │   │ receipt/event reconcile  │
│ AI reviewer (advisory) │   └─────────┬───────────────┘
└────────────────────────┘             │
                              ┌────────▼───────────────┐
                              │ MilestoneVault          │
                              │ funds · state · events  │
                              └─────────────────────────┘
```

## Ownership boundaries

### Browser

The browser renders state and requests user signatures. It never receives server secrets, private keys, unrestricted provider credentials, or unredacted internal prompts.

### API

The API authenticates and authorizes requests, validates input, stores manifests and audit records, invokes the AI adapter, evaluates deterministic policy, constructs transaction intents, and reconciles receipts. It does not silently sign arbitrary transactions.

### AI reviewer

The reviewer returns structured, untrusted observations: extracted facts, missing items, contradictions, and confidence. It cannot call the settlement function and cannot change policy thresholds.

### Policy engine

The policy engine is deterministic, versioned, testable, and explainable. It converts facts plus evidence metadata into `PASS`, `NEEDS_REVIEW`, or `BLOCK`.

### Chain adapter

The adapter is the only application boundary allowed to know RPC details, chain IDs, ABI encoding, receipt polling, and event parsing. It must refuse unknown networks and verify every receipt.

### Contract

The contract owns custody and final state transitions. The initial contract should be deliberately small: configured payer, recipient, amount, deadline, policy hash/version, funded flag, released flag, and pause authority.

## Data model direction

Use an append-only audit trail alongside current projections.

Core aggregates:

- `Agreement`: parties, contract address, policy version, lifecycle state.
- `Milestone`: amount in integer token units, deadline, status, release transaction.
- `EvidenceManifest`: content hashes, metadata, submitter, submitted-at, version.
- `ReviewRun`: model/provider metadata, structured observations, status, error.
- `PolicyDecision`: deterministic result, rule outcomes, policy version, reviewer reference.
- `SettlementCommand`: idempotency key, authorization metadata, transaction intent, reconciliation status.
- `AuditEvent`: actor, action, aggregate, timestamp, correlation ID, redacted metadata.

## State machines

### Milestone

`DRAFT → FUNDED → EVIDENCE_SUBMITTED → REVIEWED → RELEASE_PENDING → RELEASED`

Failure/recovery states are explicit: `BLOCKED`, `EXPIRED`, `CANCELLED`, `RECONCILIATION_REQUIRED`.

### Review

`QUEUED → RUNNING → SUCCEEDED | NEEDS_REVIEW | FAILED`

A failed or uncertain review never means approval.

### Settlement

`CREATED → AWAITING_AUTHORIZATION → SUBMITTED → CONFIRMED | FAILED | UNKNOWN`

`UNKNOWN` requires reconciliation; it must not be retried blindly.

## Decision policy

AI output is evidence, not authority. The release gate must be expressible without an LLM:

```text
release =
  manifest_integrity == true
  AND required_evidence_present == true
  AND contradictions == 0
  AND deterministic_rules_pass == true
  AND human_override == false
  AND agreement_status == FUNDED
  AND milestone_status != RELEASED
```

If any required input is missing or uncertain, the result is `NEEDS_REVIEW` or `BLOCK`.

## X Layer integration boundary

- Development target: X Layer testnet first.
- Chain ID must be configured explicitly and checked at startup and before submission.
- RPC URL is server configuration, never a browser hardcode when a server adapter is available.
- Use the approved OKX/OnchainOS capability only where it materially improves wallet, transaction, or on-chain data UX; do not add an integration merely for branding.
- Store deployed addresses and ABI versions as release artifacts.
- Mainnet is not part of the first milestone.

## Reliability and performance

- Cache immutable chain metadata and contract reads with short, explicit TTLs.
- Batch independent reads; do not poll aggressively.
- Use receipt/event reconciliation jobs rather than blocking request threads.
- Cap evidence size, AI prompt size, and concurrent review jobs.
- Persist idempotency keys for all mutating commands.
- Track latency for API, policy, AI, RPC, transaction confirmation, and page load separately.
- Set budgets before optimizing: initial page JS, API p95, RPC calls per workflow, and time to confirmed demo settlement.

## Deployment shape

### Hackathon MVP

A single deployable API, a web frontend, a small relational database, object storage for evidence, an AI provider adapter, and X Layer testnet. Keep dependencies replaceable.

### Startup evolution

Separate web/API, workers, chain indexer/reconciler, policy service, and evidence storage only when measured load or isolation requirements justify it. Avoid premature microservices.
