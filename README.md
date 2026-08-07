# ProofFlow

ProofFlow is an AI-assisted trust-execution protocol for autonomous commerce.

The first vertical is deliberately narrow: a business creates a milestone agreement, submits evidence of completion, receives an AI-assisted review, passes the evidence through deterministic policy rules, and settles an authorized payment on X Layer testnet.

## Product boundary

ProofFlow does not let an AI model move funds. AI produces structured observations. Deterministic policy evaluates the observations and agreement terms. A human or bounded signer approves an exact settlement intent. The smart contract enforces the final state transition.

## Repository map

- `apps/web` — user-facing application.
- `apps/api` — request handling, orchestration, and persistence adapters.
- `packages/domain` — shared types, schemas, and policy logic.
- `contracts` — Solidity contracts and Foundry tests.
- `docs` — architecture decisions, roadmap, and threat model.
- `scripts` — reproducible developer and CI helpers.

## Status

Milestone 0 is complete. The repository boundary, product scope, roadmap, architecture decisions, and initial threat model are established. Implementation starts with the reproducible local skeleton.

## Safety

This project is testnet-first. Do not use production private keys or real funds. Contract code requires independent review before any mainnet deployment.

## Development workflow

1. Work from `Projects/ProofFlow` in VS Code.
2. Keep domain rules independent from the UI, database, AI provider, and RPC client.
3. Every feature ships with validation, tests, error handling, and documentation.
4. Run the full check suite before moving to the next milestone.
