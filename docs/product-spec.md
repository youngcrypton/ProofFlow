# ProofFlow product specification

## Decision

Build one reliable workflow before expanding the platform:

**AI-verified invoice/service escrow on X Layer.**

The initial user is a buyer or operator who wants to pay a supplier or service provider against evidence of completed work. The first demo uses a buyer, supplier, two milestones, and a stablecoin-denominated escrow balance.

## User story

As a buyer, I can describe a payment agreement in plain language, review the structured conditions ProofFlow generated, fund the escrow, submit evidence, and release each milestone only when the evidence satisfies the published policy.

As a supplier, I can see the evidence required for payment, submit it, and receive a verifiable onchain settlement receipt.

As a reviewer, I can understand why a release was approved, blocked, or escalated without trusting an opaque model response.

## Critical path

1. Create a job with buyer, supplier, token, total amount, and milestone definitions.
2. Parse the natural-language agreement into a typed policy draft.
3. Show the policy clauses, evidence requirements, limits, and unresolved risks.
4. Buyer signs and funds the escrow on X Layer testnet.
5. Supplier submits evidence metadata and the client stores a content hash.
6. Intake agent extracts facts and citations from the evidence.
7. Reviewer agent attempts to invalidate the release.
8. Deterministic policy engine evaluates typed facts against the policy.
9. If all checks pass, an authorized executor submits the release; otherwise the job is blocked or sent to human review.
10. ProofFlow displays the transaction, evidence hashes, policy hash, and final receipt.

## Explicit non-goals for the MVP

- General-purpose venture creation
- Public token launchpad or tokenomics
- Unbounded autonomous wallets
- Public securities issuance or investment promises
- Complex arbitration or legal dispute resolution
- Cross-chain bridging in the critical path
- Automated wash trading or volume generation
- Model training or custom foundation models

## Product states

A job has one of these states:

- `DRAFT`
- `AWAITING_FUNDING`
- `FUNDED`
- `EVIDENCE_PENDING`
- `UNDER_REVIEW`
- `READY_TO_RELEASE`
- `BLOCKED`
- `RELEASED`
- `DISPUTED`
- `EXPIRED`
- `CANCELLED`

State transitions are explicit, idempotent, logged, and validated both offchain and onchain where relevant.

## Evidence types

The first policy schema supports:

- invoice
- purchase order
- delivery receipt
- signed approval
- API response
- timestamped status update

Documents are untrusted input. Their text can supply facts for extraction but cannot alter system instructions, policy limits, or authorization rules.

## Acceptance criteria

- A first-time user can complete the demo without needing to understand Solidity.
- The policy preview is understandable without reading raw JSON.
- A deliberately mismatched quantity blocks release.
- Duplicate evidence cannot trigger a second release.
- The executor cannot release more than the milestone amount.
- Every release has an X Layer transaction hash and independently checkable receipt.
- Network, wallet, model, and document failures produce recoverable UI states.
- The application never displays a successful payment before chain confirmation.
