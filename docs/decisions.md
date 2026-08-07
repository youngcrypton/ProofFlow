# Architecture decisions

## ADR-001: Build a narrow trust-execution vertical first

**Decision:** The first product is milestone-based commerce: agreement → evidence → deterministic policy → authorized settlement → proof receipt.

**Reason:** It creates a complete, judgeable loop with a real market use case while preserving the larger protocol direction. A generic “AI Web3 startup operating system” would spread the team across too many shallow surfaces.

## ADR-002: AI is an analyst, never a custodian

**Decision:** AI returns typed observations and an explanation. A deterministic policy engine decides eligibility. A signer explicitly authorizes the settlement intent. The contract enforces the final invariants.

**Reason:** AI is probabilistic; money movement must be deterministic, inspectable, and bounded.

## ADR-003: Off-chain evidence, on-chain commitment

**Decision:** Store evidence bytes and review metadata off-chain; put the evidence root/hash, policy version, agreement ID, recipient, and amount in the settlement path.

**Reason:** This limits gas and avoids putting private or bulky documents on a public chain while preserving tamper evidence.

## ADR-004: Native asset path before arbitrary ERC-20s

**Decision:** The first contract supports a single well-defined native-token flow. ERC-20 support is a later extension behind a token adapter and adversarial tests.

**Reason:** Token behavior varies and expands the security surface. A dependable demo is more valuable than broad but weak support.

## ADR-005: Test local EVM, then X Layer testnet

**Decision:** Contract correctness is proven locally before deployment to X Layer testnet. Mainnet is out of scope for the MVP.

**Reason:** Local tests are faster and deterministic; testnet proves ecosystem integration without risking funds.

## ADR-006: Monorepo with explicit package boundaries

**Decision:** Keep web, API, contract, and shared domain code in one repository with separate packages/apps and no cross-layer reach-through.

**Reason:** One command can validate the project, while boundaries prevent UI code from owning policy or contract assumptions.

## ADR-007: Fail closed and reconcile asynchronously

**Decision:** Uncertain AI, RPC, storage, or chain state never triggers settlement. Background reconciliation may retry reads, but never silently changes terms.

**Reason:** Safety is more important than liveness for a trust protocol.
