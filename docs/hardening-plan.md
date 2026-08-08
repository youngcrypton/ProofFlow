# ProofFlow final hardening plan

**Date:** 2026-08-08
**Scope:** Controlled X Layer testnet deployment and hackathon submission
**Mode:** Hardening only. No mainnet enablement and no broad product expansion.

## Baseline

The repository currently passes:

- `npm run check`
- `npm audit --audit-level=high --omit=dev`
- Foundry contract tests: 6 passing

The current prototype has a coherent agreement lifecycle, durable SQLite runtime, deterministic review fixture, hashed audit events, wallet authorization previews, X Layer testnet receipt verification, request IDs, rate limiting, metrics, and a polished dashboard.

The most important remaining risk is not visual. The policy-evaluation API still accepts caller-supplied review observations and manifest-integrity flags. A caller who can reach that route can submit a fabricated `PASS` observation and move an agreement toward settlement. The current evidence route stores a JSON manifest and external URI, not uploaded bytes; it therefore cannot yet enforce MIME sniffing, malware scanning, content-addressed storage, or secure retrieval.

## Priority 0 — release blockers

These items must be complete before calling the system deployment-ready, even for a controlled testnet review.

### 1. Make policy evaluation authoritative

- Remove caller authority over `observation`, `manifestTypes`, and `manifestIntegrity`.
- Derive evidence types and integrity from the stored manifest and stored evidence records.
- Use the latest persisted review run as the only review input.
- Require the review run's manifest hash to equal the current manifest hash.
- Recompute the canonical manifest hash on the server and fail closed on mismatch.
- Reject evaluation if the review is missing, failed, stale, or marked `NEEDS_REVIEW`.
- Make evaluation idempotent for a given manifest hash and policy hash.
- Add tests proving that fabricated client payloads cannot produce `PASS` or `READY_TO_RELEASE`.

### 2. Implement controlled evidence ingestion

Keep the existing JSON manifest endpoint for compatibility, but clearly label it as a legacy/test fixture path. Add a separate multipart upload path:

- Accept one file per upload with an explicit per-file and per-agreement size limit.
- Enforce an allowlist of evidence categories and media types.
- Sanitize names and never use a user-supplied filename as a filesystem path.
- Detect the actual type from file signatures/content, not only the browser MIME header or extension.
- Compute SHA-256 while writing the file; reject a client-provided digest that does not match.
- Store first in a quarantine area under a content-addressed temporary key.
- Scan before the file becomes part of an evidence manifest.
- Require a configured scanner in controlled deployment mode; fail closed when the scanner is unavailable.
- Keep only clean blobs addressable by digest, with metadata in SQLite.
- Make the manifest reference the verified blob digest, size, media type, and server-generated retrieval URI.

The available environment does not currently contain `clamscan`, so the scanner boundary must be an explicit adapter rather than a pretend clean result. The implementation should support ClamAV/`clamd` or another approved scanner, and the deployment checklist must reject production-like startup when no scanner is configured.

### 3. Secure retrieval

- Add a retrieval endpoint that resolves only a stored blob ID/digest.
- Authorize retrieval to the agreement parties or an authenticated operator.
- Prevent path traversal and arbitrary filesystem reads.
- Set `Content-Type` from verified metadata, `X-Content-Type-Options: nosniff`, `Content-Disposition: attachment`, and `Cache-Control: private, no-store`.
- Never inline untrusted HTML or executable content.
- Return 404 for unknown/quarantined blobs without revealing storage details.
- Add tests for unauthorized access, traversal attempts, wrong digest, quarantined blobs, and clean retrieval.

### 4. Make critical state changes atomic

- Add repository-level atomic commands for evidence submission, policy evaluation, review completion, and settlement reconciliation.
- Do not update the agreement, manifest/review record, and audit chain in separate calls.
- Use SQLite transactions with rollback tests and restart tests.
- Add a migration/schema version and startup validation.

### 5. Tighten settlement proof verification

- Bind authorization to the exact settlement intent, not merely the agreement and amount.
- Verify chain ID, receipt success, confirmation depth, transaction sender, vault target, calldata selector, payer, recipient, amount, and intent evidence/policy hashes where emitted or otherwise derivable.
- Reject a token-address mismatch because the current vault is native-asset-only.
- Make repeated authorization/reconciliation idempotent and reject conflicting receipts.
- Keep the wallet as the only signing authority; AI output remains advisory and can never invoke or authorize funds movement.

## Priority 1 — controlled-deployment hardening

### Authentication and configuration

- Require bearer authentication for all mutating routes in controlled deployment mode.
- Protect `/metrics`; never expose operational data anonymously.
- Fail startup when production-like configuration has an empty API token, disabled auth, missing vault address, wrong chain, or missing evidence scanner.
- Keep demo reset disabled unless an explicit test/demo flag is set and restrict it to a safe environment.
- Validate environment variables once at startup with a typed configuration schema.
- Keep secrets out of logs, error messages, audit payloads, and client bundles.

### Request and abuse controls

- Use separate JSON and multipart body limits; the current global 1 MB JSON limit must not be used as the upload policy.
- Add upload-specific rate, concurrency, and aggregate-size limits.
- Add timeouts and bounded retries only for safe read-only RPC operations.
- Make rate-limit state durable or explicitly document the single-process deployment constraint.
- Use stable route labels for metrics and redact user-controlled path fragments.

### AI boundary

- Treat all evidence text and extracted document content as hostile data.
- Use strict delimiters and a fixed system contract for any future model-backed reviewer.
- Validate model output against the typed observation schema.
- Keep tools/network access disabled for review providers.
- Record provider, model, prompt version, input hash, output hash, and failure status.
- Never allow model output to set recipient, amount, token, chain, vault, or authorization state.

### Persistence and recovery

- Add SQLite backup/restore instructions and a verified backup command.
- Configure WAL checkpointing/busy timeout and handle corrupted or unreadable records with a safe startup failure.
- Add retention rules for quarantine, rejected uploads, audit logs, and old review runs.
- Ensure all cleanup jobs are bounded and observable.

## Priority 2 — UI and demo readiness

- Make the upload flow show scanning, quarantined, clean, rejected, and failed states explicitly.
- Show the exact verified file digest, type, size, scan result, policy hash, review hash, and settlement intent in the detail view.
- Keep the settlement button disabled unless the server reports `READY_TO_RELEASE` and the wallet is on chain 1952.
- Add a clear distinction between “preview,” “wallet signature,” “submitted,” and “receipt reconciled.”
- Add accessible labels, keyboard-focus management for modals, Escape-to-close, visible focus styles, and reduced-motion-safe loading states.
- Remove any dead or misleading demo controls; preserve demo reset only behind the explicit demo flag.
- Avoid external font/network dependencies in the production bundle or document the fallback behavior.

## Priority 3 — verification and release process

Add automated coverage for:

1. JSON manifest compatibility path.
2. Multipart upload success.
3. Oversized file rejection.
4. MIME spoofing rejection.
5. Hash mismatch rejection.
6. Malware scanner clean, infected, unavailable, and timeout states.
7. Quarantine isolation and clean promotion.
8. Secure retrieval authorization and headers.
9. Fabricated policy-observation rejection.
10. Review/manifest hash mismatch rejection.
11. Atomic rollback and SQLite restart persistence.
12. Settlement receipt mismatch, wrong vault, wrong sender, wrong amount, failed receipt, insufficient confirmations, and duplicate reconciliation.
13. Auth, rate-limit, metrics, request-ID, and configuration failures.
14. The complete happy path from agreement creation through audit display.

The release command must run type checking, unit/integration tests, the production web build, dependency audit, contract tests, and a testnet-only deployment/configuration check.

## Implementation order

1. Add typed startup configuration and fail-closed deployment checks.
2. Make policy evaluation server-authoritative and atomic.
3. Add evidence blob interfaces, quarantine storage, scanner adapter, and multipart upload tests.
4. Add clean-blob promotion and authorized retrieval.
5. Strengthen exact settlement receipt verification.
6. Add persistence/recovery tests and operational backup documentation.
7. Polish upload, policy, settlement, and receipt UI states.
8. Run the complete release suite and update README, architecture, security notes, and deployment instructions.

## Explicit non-goals for this release

- Mainnet deployment.
- Custodial private keys or server-side transaction signing.
- A provider marketplace.
- Autonomous AI-controlled settlement.
- Unscanned file access.
- Claiming that the existing external-URI manifest path is production-grade file ingestion.

## Release gates

- **Gate A:** authoritative policy and exact settlement boundaries pass all tests.
- **Gate B:** evidence upload is scanned, content-addressed, retrievable only with authorization, and covered by failure tests.
- **Gate C:** persistence, observability, configuration, recovery, and UI states are release-ready.
- **Final:** controlled X Layer testnet demo only; mainnet remains explicitly blocked pending independent contract/security review, production scanner/storage operations, key management, monitoring, and incident response.
