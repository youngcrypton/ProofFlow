# ProofFlow UI/UX specification and design system

**Status:** Ready for implementation
**Version:** 1.0
**Date:** 2026-08-07
**Owner:** Product and Engineering
**Scope:** ProofFlow web console and the dashboard experience built on top of the existing API, policy engine, evidence manifest, audit trail, vault contract, and X Layer adapter.

---

## 1. Product decision

ProofFlow is a trust execution console for milestone-based commerce:

> **AI checks the evidence. Deterministic policy controls the decision. X Layer settles the result.**

The dashboard must make that sequence visible at every important moment. It must never imply that an AI model can move funds, that an offchain result is a payment, or that a transaction is complete before the chain confirms it.

The first dashboard is intentionally narrow. It should make one escrow agreement feel exceptionally clear and safe rather than attempting to become a general-purpose Web3 operating system.

### 1.1 Primary product outcome

A first-time buyer can:

1. Create an agreement in under three minutes.
2. Understand the policy before signing.
3. Fund the escrow with an exact transaction preview.
4. See what evidence the supplier must provide.
5. Review why ProofFlow approved, blocked, or escalated a milestone.
6. Release funds with an explicit authorization step.
7. Verify the final receipt independently on X Layer.

A supplier can:

1. See the terms and evidence checklist.
2. Submit evidence without understanding Solidity.
3. Track review progress and resolve missing information.
4. See the exact settlement state and transaction receipt.

A reviewer can:

1. Understand the evidence, extracted facts, contradictions, and policy rules.
2. Distinguish model observations from deterministic decisions.
3. Escalate or override only with an explicit reason and audit record.

### 1.2 Non-goals for this interface

- Token launch or tokenomics tooling.
- General-purpose DAO administration.
- Unrestricted autonomous wallet actions.
- A chat-first AI interface that hides the actual workflow.
- Trading, yield, bridging, or portfolio management.
- Legal advice or a guarantee that a commercial claim is legally valid.
- Replacing a human signer for a release.

---

## 2. Design principles

### 2.1 Proof over polish

Visual quality matters, but the interface must prioritize verifiability over spectacle. Every positive state should answer:

- What was checked?
- Which evidence supported it?
- Which policy version was applied?
- Who or what authorized the next action?
- What is confirmed onchain versus merely prepared offchain?

### 2.2 AI is visible, bounded, and fallible

AI review is shown as an advisory observation layer. The UI must label model-derived facts as **AI observation**, show confidence and source references, and keep the deterministic gate visually separate. Never use copy such as “AI approved payment.” Use “AI review completed” followed by “Policy gate: ready to release.”

### 2.3 State is more important than activity

A user should understand the current state from the page header without reading the timeline. Activity history supports the state; it does not replace it.

### 2.4 One obvious next action

Each screen has one primary action. Secondary actions remain available but visually subordinate. Destructive, financial, and irreversible actions require a confirmation surface that states the exact amount, recipient, network, and consequence.

### 2.5 Progressive disclosure

Show the decision summary first. Let users expand evidence facts, raw hashes, model metadata, policy rules, transaction calldata, and audit details when they need to inspect them.

### 2.6 Calm under failure

Blocked, delayed, uncertain, and disconnected states are first-class product states. The design must never turn a missing wallet, failed RPC call, uncertain AI review, or pending transaction into a generic red error page.

### 2.7 Trust is earned through consistency

The same state, color, terminology, and icon must mean the same thing throughout the product. A green check means a verified condition, not merely a successful API request.

### 2.8 Dense when useful, spacious when consequential

Tables and audit logs may be information-dense. Funding, release, dispute, and override decisions require generous spacing and clear confirmation hierarchy.

---

## 3. Users, roles, and permissions

### 3.1 Buyer / payer

The party that creates the agreement, funds the vault, reviews evidence, and authorizes release. Buyer actions:

- Create and edit a draft agreement.
- Publish immutable terms.
- Fund a milestone.
- Request evidence review.
- Approve a ready-to-release milestone.
- Open a dispute before release.
- View audit history and receipts.

### 3.2 Supplier / recipient

The party performing the work and submitting evidence. Supplier actions:

- View assigned agreement terms.
- View evidence requirements.
- Submit or replace an evidence manifest before review.
- Respond to missing evidence requests.
- View review outcome and settlement status.
- View confirmed receipts.

The supplier cannot change the policy, fund the vault, release funds, or override a failed gate.

### 3.3 Reviewer

A human who investigates uncertainty or contradictions. Reviewer actions:

- Inspect evidence and extracted observations.
- Mark evidence as accepted, insufficient, or contradictory.
- Request clarification.
- Escalate to the buyer.
- Record a bounded human override where permitted.

Every reviewer action requires a reason and creates an audit event.

### 3.4 Operator / administrator

A trusted workspace operator who manages environment settings and integrations. Operator actions are outside the critical payment path and must not be confused with a buyer release authorization.

### 3.5 Role presentation

Display role in the workspace switcher and agreement header using text, not color alone:

- `Buyer`
- `Supplier`
- `Reviewer`
- `Operator`

Use the role label beside the wallet address when the distinction affects available actions.

---

## 4. Information architecture

### 4.1 Global navigation

The authenticated console uses a persistent left rail on desktop and a bottom navigation/action sheet pattern on mobile.

1. **Overview** — workspace-level agreements, pending actions, and network status.
2. **Agreements** — searchable list of all agreements visible to the current user.
3. **Review queue** — items requiring human attention; reviewer and buyer focused.
4. **Activity** — append-only audit events across the workspace.
5. **Settings** — wallet, network, notification, workspace, and API settings.

The left rail contains the ProofFlow mark, current workspace, primary navigation, network indicator, and connected wallet. A compact “Create agreement” button is pinned near the top.

### 4.2 Route map

| Route | Purpose | Primary action |
|---|---|---|
| `/console` | Overview and prioritized work | Open the next pending item |
| `/console/agreements` | Agreement index | Create agreement |
| `/console/agreements/new` | Agreement creation wizard | Continue to policy |
| `/console/agreements/:id` | Agreement command center | Perform the next valid lifecycle action |
| `/console/agreements/:id/policy` | Immutable policy view | Review policy or copy hash |
| `/console/agreements/:id/evidence` | Evidence intake and review | Submit or review evidence |
| `/console/agreements/:id/receipt` | Settlement proof | Verify on explorer |
| `/console/review` | Human review queue | Open the highest-priority case |
| `/console/activity` | Audit log | Filter and inspect an event |
| `/console/settings` | Workspace and connection settings | Resolve a configuration issue |

### 4.3 Navigation rules

- The current route is indicated by icon, label, and a high-contrast active rail treatment.
- The agreement ID and short title remain in the header on all agreement subroutes.
- Browser back navigation must preserve search, filters, and list scroll position where practical.
- A route change must not discard unsaved agreement data without a confirmation prompt.
- Deep links to an agreement must render a useful loading shell, not a blank page.

---

## 5. Dashboard screen specifications

## 5.1 Overview dashboard

### Purpose

Give the user a reliable answer to: **What needs my attention, what is at risk, and what has actually settled?**

### Layout

Desktop layout:

- Left navigation rail: 232 px.
- Main content max width: 1,280 px.
- Page header: title, current workspace, wallet/network status, and `Create agreement`.
- First row: four compact metrics.
- Second row: priority queue and settlement activity.
- Third row: agreement table and network health.

Mobile layout:

- Top bar with menu, ProofFlow mark, and wallet status.
- Metrics become a horizontal scroll row or two-column grid.
- Priority queue comes before the agreement table.
- Bottom fixed action bar contains `Create agreement` when no modal is open.

### Metrics

Use four metrics only in the first release:

1. **Active agreements** — count, with a small state breakdown.
2. **Awaiting your action** — count of review, funding, release, or configuration tasks.
3. **In escrow** — exact token amount with token symbol.
4. **Settled this period** — exact amount and confirmed transaction count.

Do not display fabricated percentage changes without a real comparison period.

### Priority queue

Each item includes:

- Agreement title and short ID.
- Current state badge.
- Required action.
- Amount and milestone number.
- Deadline or age.
- Counterparty short address or name.
- Severity marker only when action is blocked, expiring, or reconciliation is required.

The queue is ordered by urgency, then financial consequence, then age. “Ready to release” items should not be buried below informational activity.

### Empty state

Headline: **Your trust queue is clear.**

Body: “Create an agreement to turn a real-world commitment into a verifiable settlement.”

Primary action: `Create agreement`.

Secondary action: `View demo agreement` for the seeded hackathon workspace only.

### Loading state

Render the page skeleton with stable geometry: metric rectangles, three queue rows, and a table header. Do not use a full-page spinner after the first shell load.

### Error state

For a failed dashboard data request:

- Preserve navigation and last-known non-sensitive values if available.
- Show an inline banner: “We could not refresh the workspace.”
- Include `Retry` and the last successful refresh time.
- Do not show stale financial values as current; label them `Last updated ...`.

---

## 5.2 Agreements index

### Table columns

| Column | Content |
|---|---|
| Agreement | Human title, short ID, counterparty |
| State | Canonical lifecycle state badge |
| Next action | Plain-language action, not internal enum |
| Amount | Amount, token, and milestone progress |
| Network | X Layer testnet/mainnet label |
| Updated | Relative time with exact time on hover/focus |
| Open | Row click or explicit arrow action |

### Filters

- State.
- Role.
- Network.
- Needs action.
- Date range.
- Search by title, agreement ID, wallet address, or transaction hash.

Filters must be URL-addressable so a reviewer can share a queue link.

### Table behavior

- Sort by updated time by default.
- Keep the state and next-action columns visible on narrow desktop widths.
- Never rely on row color to communicate state.
- Use pagination or cursor loading once the list exceeds 50 visible rows.
- Announce filter result counts to assistive technology.

### Empty and first-run states

The first-run state explains the product in one sentence and offers a demo agreement. Avoid a generic “No data” message.

---

## 5.3 Create agreement wizard

The wizard is deliberately staged. Do not compress all fields into one form or begin with a natural-language prompt that hides the resulting terms.

### Step 1 — Parties and commercial terms

Fields:

- Agreement title.
- Buyer wallet.
- Supplier wallet.
- Token or native asset.
- Total amount.
- Currency display preference.
- Optional description.

Validation:

- Validate addresses before advancing.
- Normalize and display exact base units before signing.
- Reject zero, negative, malformed, and over-precision amounts.
- Show the connected wallet and role explicitly.

### Step 2 — Milestones

Each milestone includes:

- Name.
- Amount.
- Deadline.
- Description of accepted work.
- Required evidence types.
- Release order if sequential release is selected.

The wizard displays a live total and warns when milestone amounts do not equal the agreement amount. A milestone amount cannot be edited after terms are published.

### Step 3 — Policy

Show a readable policy builder with:

- Required evidence checklist.
- Minimum AI confidence threshold.
- Deadline condition.
- Amount cap.
- Contradiction behavior.
- Human review behavior.
- Policy version.

The UI must include an expandable “What happens if this fails?” explanation for each rule.

### Step 4 — Review and publish

Display an immutable terms preview:

- Buyer and supplier.
- Amounts and deadlines.
- Evidence requirements.
- Policy version.
- Policy hash.
- X Layer network.
- Warnings and unresolved risks.

Primary action: `Publish agreement terms`.

Confirmation copy: “Publishing locks the terms used by the release gate. You can cancel before funding, but you cannot silently change this policy afterward.”

### Step 5 — Fund

After publishing, route to the agreement command center with funding as the only primary action. Show the exact amount, recipient contract address, network, estimated gas, and a link to inspect the transaction data.

---

## 5.4 Agreement command center

This is the core dashboard screen and the most important implementation target.

### Header

- Agreement title.
- Short agreement ID with copy control.
- State badge.
- Buyer/supplier role and counterparty.
- Network chip: `X Layer testnet` or `X Layer mainnet`.
- Contract address with explorer link.
- Overflow menu for safe secondary actions.

### State banner

A prominent state banner appears directly beneath the header. It contains:

- Current state in plain language.
- One-sentence explanation.
- Primary next action.
- Deadline or pending duration when relevant.
- Last updated timestamp.

Canonical plain-language labels:

| Internal state | UI label | Explanation |
|---|---|---|
| `DRAFT` | Draft | Terms are being prepared and no funds are locked. |
| `AWAITING_FUNDING` | Awaiting funding | Terms are published; the escrow is not funded yet. |
| `FUNDED` | Funded | Funds are confirmed in the vault. |
| `EVIDENCE_PENDING` | Evidence pending | The supplier must submit the required evidence. |
| `UNDER_REVIEW` | Under review | Evidence is being checked; no release is possible yet. |
| `READY_TO_RELEASE` | Ready to release | All deterministic release conditions passed. |
| `BLOCKED` | Blocked | A required condition failed or evidence is insufficient. |
| `RELEASED` | Released | Funds are confirmed as released on X Layer. |
| `DISPUTED` | Disputed | A dispute is open; release is paused. |
| `EXPIRED` | Expired | The deadline passed before a valid release. |
| `CANCELLED` | Cancelled | The agreement cannot proceed. |

### Main content columns

Desktop:

- Main column: lifecycle timeline, milestone cards, evidence/review panels.
- Side column: terms summary, vault balance, policy status, and audit preview.

Mobile:

- State banner.
- Primary action.
- Milestone cards.
- Review/policy summary.
- Terms and audit sections as accordions.

### Milestone card

Each card includes:

- Milestone number and title.
- Amount and status.
- Deadline.
- Evidence completion count.
- Review result.
- Next valid action.
- Release transaction when confirmed.

A card must distinguish these states visually:

- Not started.
- Awaiting evidence.
- Reviewing.
- Needs review.
- Ready to release.
- Released.
- Blocked.
- Expired.

The primary button changes by state and role. Invalid actions are not shown as disabled buttons without explanation; either hide them or show a short “Available after ...” explanation.

### Policy summary card

Show:

- Policy name and version.
- Policy hash, truncated with copy action.
- Rule result summary, for example `4 passed · 1 needs review`.
- Link to full policy.
- Explicit label: `Deterministic gate`.

### Trust boundary card

A compact explanatory card should appear in the first demo:

- `AI reviewer` — extracts facts and flags uncertainty.
- `Policy engine` — decides whether conditions pass.
- `Vault contract` — holds and releases funds.

Use three stacked rows with distinct icons and no anthropomorphic language.

---

## 5.5 Evidence workspace

### Purpose

Make evidence submission and review feel like a controlled verification process rather than a document upload utility.

### Evidence intake

The supplier sees:

- Evidence checklist grouped by milestone.
- Accepted file or metadata types.
- Maximum size and privacy note.
- Submission version.
- Required fields for structured evidence.
- `Submit evidence for review` action.

Before submission, show a manifest preview with filenames/types, content hashes, timestamps, and submitter wallet. The user confirms that the manifest is correct.

### Review view

The reviewer sees a split view on desktop:

- Left: evidence list and document preview/metadata.
- Right: extracted facts, citations, contradictions, missing items, confidence, and policy rules.

On mobile, the split view becomes a stepper: Evidence → AI observations → Policy gate → Decision.

### Fact presentation

Each extracted fact row includes:

- Fact key in human language.
- Value.
- Source reference.
- Confidence.
- Status: `Observed`, `Contradicted`, `Missing`, or `Needs confirmation`.

Never present a confidence score without its interpretation. Prefer “High confidence” plus the numeric value in a disclosure over a naked `94%`.

### Prompt injection treatment

If evidence contains instructions directed at the AI, display an explicit warning:

> “This document contains instructions or claims that are not treated as system rules. ProofFlow ignored them as control input.”

Do not expose internal prompts. Do show that untrusted evidence cannot change policy or authorize payment.

### Human review action

The reviewer must choose one:

- `Confirm evidence`
- `Request clarification`
- `Mark contradiction`
- `Escalate to buyer`

Every action has a reason field when it changes the decision. The reason appears in the audit trail.

---

## 5.6 Policy and decision view

### Decision hierarchy

Use a four-level visual hierarchy:

1. **Outcome** — `PASS`, `NEEDS REVIEW`, or `BLOCK`.
2. **Rule summary** — passed, failed, and unresolved counts.
3. **Rule details** — expected value, observed value, source, and reason.
4. **Raw evidence and hashes** — advanced inspection.

### Decision copy

Use plain explanations:

- Pass: “All required evidence is present, no contradictions were found, and the amount and deadline match the published policy.”
- Needs review: “The evidence is incomplete or uncertain. A human must confirm the unresolved condition.”
- Block: “Release is blocked because the observed quantity does not satisfy the published policy.”

Avoid “AI says yes/no,” “confidence passed,” or “safe to pay” as the only explanation.

### Rule row

| Element | Example |
|---|---|
| Rule | Delivered quantity matches order |
| Required | 100 units |
| Observed | 96 units |
| Source | delivery-receipt.pdf, page 2 |
| Result | BLOCK |
| Action | Request corrected evidence |

The UI must show the published policy version next to every decision. A decision from an older policy cannot be presented as current without a warning.

---

## 5.7 Release and transaction confirmation

### Release review modal

Before a release, show a full confirmation modal, not a toast or small popover.

Required content:

- `Ready to release` heading.
- Agreement and milestone.
- Exact amount and token.
- Recipient wallet, full address available by copy.
- X Layer network and chain ID.
- Vault contract address.
- Evidence manifest hash.
- Policy version/hash.
- Deterministic rule summary.
- Warning that the action is irreversible once confirmed onchain.
- Wallet/signature action.

Primary action: `Authorize release`.
Secondary action: `Cancel`.

The primary action is disabled until the user has opened the details disclosure at least once on desktop and mobile. This is a lightweight comprehension guard, not a legal consent substitute.

### Transaction states

| State | UI treatment |
|---|---|
| Preparing | “Preparing your transaction...” with exact intent visible |
| Wallet prompt | “Confirm in your wallet” with amount and network |
| Submitted | “Transaction submitted” with tx hash and pending indicator |
| Confirmed | “Settlement confirmed” with block/explorer link |
| Failed | “Transaction failed” with retry only after inspecting the error |
| Unknown | “Confirmation uncertain” with reconciliation guidance; never offer blind retry |

A successful wallet signature is not a successful payment. The confirmation screen must wait for a verified receipt and expected event.

### Receipt screen

The receipt is a durable, shareable proof view containing:

- Settlement outcome.
- Agreement and milestone IDs.
- Amount and recipient.
- X Layer network.
- Transaction hash.
- Block number when available.
- Evidence manifest hash.
- Policy version and hash.
- Timestamp.
- Contract address.
- Explorer link.
- Copyable verification data.

Use “Verified on X Layer” only after receipt and event reconciliation pass.

---

## 5.8 Review queue

### Queue priorities

1. Blocked items with financial deadline.
2. Contradictions.
3. Human review required.
4. Failed or unknown chain reconciliation.
5. Missing evidence.
6. Informational completed items.

### Queue row

- Priority label.
- Agreement and milestone.
- Reason for review.
- Amount at risk.
- Age and deadline.
- Assigned reviewer.
- Open action.

### Bulk actions

No bulk financial actions in the MVP. Bulk assignment or acknowledgment may be added later, but release must remain a deliberate per-milestone action.

---

## 5.9 Activity and audit log

The activity screen is append-only in presentation and must never imply that an event was edited in place.

### Event row

- Timestamp with timezone.
- Actor: wallet, service, policy engine, AI reviewer, or contract.
- Action in plain language.
- Agreement/milestone.
- Correlation ID.
- Short event hash or chain transaction.
- Expandable metadata.

### Audit language

Use factual verbs:

- “Evidence manifest submitted.”
- “Review run completed.”
- “Policy gate blocked release.”
- “Buyer authorized release.”
- “X Layer receipt reconciled.”

Do not use promotional language such as “ProofFlow successfully trusted the supplier.”

---

## 6. Design system

## 6.1 Brand personality

ProofFlow should feel:

- Calm rather than frantic.
- Precise rather than cryptic.
- Technical without being intimidating.
- Premium without being ornamental.
- Human-accountable rather than autonomous-for-its-own-sake.

The visual voice combines editorial confidence with operational clarity: warm paper surfaces, deep green structure, acid-lime action color, monospaced verification metadata, and restrained serif emphasis for the concept of proof.

### 6.2 Design tokens

Use CSS custom properties or the project’s token layer. Components must consume tokens rather than hard-coding colors.

#### Color palette

| Token | Value | Use |
|---|---|---|
| `--pf-ink` | `#17221E` | Primary text, dark surfaces, high-emphasis controls |
| `--pf-forest` | `#24332C` | Elevated dark surfaces |
| `--pf-moss` | `#738680` | Secondary dark surface, informational background |
| `--pf-paper` | `#F3F1EB` | Primary application background |
| `--pf-paper-strong` | `#E7E9DE` | Cards, panels, neutral emphasis |
| `--pf-white` | `#FAFAF6` | High-contrast light surfaces |
| `--pf-lime` | `#D8EF60` | Primary action, verified accent, focus accent |
| `--pf-lime-dark` | `#7F9B13` | Lime text on light backgrounds |
| `--pf-line` | `#D8D8D0` | Light borders and separators |
| `--pf-line-dark` | `#405046` | Borders on dark surfaces |
| `--pf-muted` | `#718078` | Secondary text |
| `--pf-muted-dark` | `#AAB8AE` | Secondary text on dark surfaces |
| `--pf-info` | `#2E6F8E` | Informational and pending states |
| `--pf-warning` | `#A96713` | Needs review, deadline warning |
| `--pf-danger` | `#B84B43` | Blocked, failed, destructive action |
| `--pf-success` | `#557B22` | Confirmed positive status when lime is not sufficient |

State colors must be paired with text and an icon. Do not use red/green as the sole state signal.

#### State treatments

| State | Surface | Text | Icon treatment |
|---|---|---|---|
| Pass / confirmed | Lime tint or pale green | Forest/ink | Check circle |
| Needs review | Warm amber tint | Dark amber | Alert triangle |
| Blocked / failed | Pale red | Deep red | X circle |
| Pending | Pale blue/gray | Deep blue/gray | Clock or spinner |
| Neutral | Paper strong | Muted/ink | Dot or document |
| Disputed | Purple-gray tint | Deep purple-gray | Flag |

#### Typography

- **Display:** Playfair Display, italic used sparingly for “proof,” “trust,” and other editorial emphasis.
- **UI and body:** DM Sans.
- **Verification metadata:** DM Mono.

Type scale:

| Name | Size | Line height | Weight | Use |
|---|---:|---:|---:|---|
| Display XL | 72–112 px | 0.92 | 500 | Marketing/empty-state statement only |
| Display | 48–72 px | 0.96 | 500 | Page title when spacious |
| Heading 1 | 32 px | 1.1 | 600 | Dashboard page title |
| Heading 2 | 24 px | 1.2 | 600 | Card and section heading |
| Heading 3 | 18 px | 1.25 | 600 | Milestone and queue item |
| Body | 14 px | 1.5 | 400 | Default reading text |
| Body small | 12 px | 1.45 | 400 | Supporting text |
| Label | 11 px | 1.2 | 600 | Form labels and compact controls |
| Mono | 11–12 px | 1.4 | 400/500 | Hashes, IDs, chain data |

Minimum body text is 14 px in the console. Do not use all-caps for long text.

#### Spacing

Base unit: 4 px.

Use the following scale:

`4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96`

Default component padding is 16 or 20 px. Consequential confirmation surfaces use 24 or 32 px. Avoid arbitrary values.

#### Layout

- Desktop content max width: 1,280 px.
- Desktop rail: 232 px.
- Standard content gutter: 32 px.
- Compact gutter: 20 px.
- Mobile gutter: 16 px.
- Card grid gap: 16 px.
- Section gap: 32–48 px.

#### Radius

- `--radius-sm`: 4 px — tables, tags, compact controls.
- `--radius-md`: 8 px — cards, inputs, buttons.
- `--radius-lg`: 12 px — modals and prominent panels.
- `--radius-pill`: 999 px — status chips and compact filters.

ProofFlow is not a highly rounded “toy crypto” interface. Use radius to group information, not to make every surface look inflated.

#### Elevation

Use borders first and shadows second.

- Level 0: transparent/no shadow.
- Level 1: `0 1px 2px rgba(23,34,30,.06)` for cards.
- Level 2: `0 12px 32px rgba(23,34,30,.12)` for popovers and modals.
- Receipt accent: a restrained offset shadow is allowed for the receipt preview only.

#### Motion

- Fast: 120 ms for hover/focus.
- Standard: 180 ms for component state changes.
- Emphasis: 260 ms for modal and page transitions.
- Use ease-out for entering and ease-in for leaving.
- Respect `prefers-reduced-motion` by removing nonessential movement.
- Never animate a financial amount in a way that obscures the final value.

### 6.3 Iconography

Use one consistent outline icon set with a 1.75 px stroke. Icons must support, never replace, text labels.

Required semantic icons:

- Agreement: document/check.
- Evidence: file/shield.
- AI observation: sparkle/scan, always paired with `AI observation` text.
- Deterministic policy: sliders/list-check.
- Onchain: chain/link.
- Wallet: wallet.
- Pending: clock.
- Pass: check circle.
- Needs review: alert triangle.
- Blocked: X circle.
- Audit: list/history.
- External explorer: arrow-up-right.

Do not use a robot icon as the primary symbol for the reviewer; it overstates autonomy.

### 6.4 Buttons

Variants:

- **Primary:** lime background, ink text. One per screen.
- **Dark primary:** ink background, paper text. Used on light pages when lime is reserved for verified states.
- **Secondary:** paper/transparent with line border.
- **Destructive:** danger text/border, used only in confirmation contexts.
- **Quiet:** no border, muted text, for navigation and low-risk actions.

Rules:

- Minimum height: 40 px desktop, 44 px mobile.
- Horizontal padding: 16 px minimum.
- Include a visible label for financial actions.
- Loading buttons preserve their width and replace the label with a spinner plus status text.
- Do not use “Submit” where “Submit evidence” or “Authorize release” is available.

### 6.5 Status badges

Badges contain a short label plus an icon or dot. Examples:

- `Funded`
- `Under review`
- `Ready to release`
- `Blocked`
- `Confirmed`
- `Pending`

Badge colors are subdued. The primary emphasis belongs to the state banner and next action, not to saturated pills everywhere.

### 6.6 Forms

Every form field has:

- Persistent visible label.
- Short helper text when the field affects a policy or transaction.
- Inline validation after blur and on submit.
- Error text adjacent to the field.
- A clear unit: `USDC`, `base units`, `UTC`, or `wallet address`.

Address fields support paste normalization, checksum validation, and a copy control. Never truncate an address in an input value.

### 6.7 Tables and data density

- Use row separators, not zebra stripes, by default.
- Align amounts right and use tabular numerals.
- Align hashes and IDs in mono.
- Keep row height at least 52 px desktop and 60 px mobile list mode.
- Provide a card/list alternative on mobile.
- Keep the user’s chosen filters visible above the table.

### 6.8 Dialogs, drawers, and disclosures

Use a modal for consequential confirmation, a drawer for contextual inspection, and an accordion for secondary details within the page.

A release modal must:

- Trap focus.
- Restore focus to the triggering control.
- Close on Escape only before signing; after submission, the transaction state must remain visible.
- Prevent accidental background interaction.
- Include a clear cancel action.

### 6.9 Toasts and banners

Toasts are for non-consequential feedback such as “Copied.” They must not be the only confirmation of funding, release, or evidence submission.

Use inline banners for:

- Network mismatch.
- Wallet disconnected.
- Stale data.
- Review required.
- Reconciliation uncertainty.

---

## 7. Content and terminology system

### 7.1 Canonical terms

| Use | Do not use |
|---|---|
| Agreement | Deal, contract package |
| Milestone | Task payment, tranche unless legally intended |
| Evidence | Proof file, AI input |
| Evidence manifest | Upload bundle |
| Policy gate | AI decision |
| AI observation | AI approval |
| Settlement | Payout when describing the protocol action |
| Release | Send money, cash out |
| Confirmed on X Layer | Done, successful after wallet signature |
| Needs review | Maybe safe, uncertain AI |
| Blocked | Failed trust, bad supplier |

### 7.2 Writing style

- Use short, factual sentences.
- Lead with the current state and consequence.
- Explain why an action is unavailable.
- Put technical identifiers in a disclosure or metadata row.
- Use “you” for user actions and “ProofFlow” for system actions.
- Never blame the supplier for a blocked condition; describe the evidence mismatch.

### 7.3 Financial copy

Always show:

1. Formatted amount.
2. Token symbol.
3. Exact base-unit or transaction detail in disclosure.
4. Recipient.
5. Network.

Example: **Release 250.00 USDC to 0x12...89 on X Layer testnet**.

### 7.4 Time copy

Use relative time for activity lists, with exact UTC timestamp available on hover, focus, or expansion. Deadlines show both date and timezone when the user may be in a different locale.

---

## 8. Accessibility specification

Target WCAG 2.2 AA for the console.

### Required behaviors

- Full keyboard operation, including navigation rail, tables, filters, dialogs, disclosures, and wallet flow instructions.
- Visible focus ring using `--pf-lime` with a dark outline where needed.
- Contrast of at least 4.5:1 for normal text and 3:1 for large text or UI components.
- No state communicated by color alone.
- Proper heading hierarchy per route.
- Every icon-only control has an accessible name and tooltip.
- Live regions announce transaction state changes and review completion.
- Screen-reader text distinguishes “AI observation” from “deterministic policy result.”
- Errors are associated with their input and summarized at submit.
- Tables have headers; mobile list transformations preserve labels.
- Reduced motion support.
- Touch targets at least 44 × 44 px on mobile.

### Wallet and transaction accessibility

The page must explain what the user is being asked to sign before opening the wallet. After returning from the wallet, the status is announced and the receipt link is keyboard accessible.

### Accessibility acceptance test

A keyboard-only user can create a draft, inspect policy, open the release confirmation, cancel it, and navigate to a confirmed receipt without being trapped or losing context.

---

## 9. Responsive behavior

### Breakpoints

- Mobile: under 640 px.
- Tablet: 640–1,023 px.
- Desktop: 1,024–1,439 px.
- Wide desktop: 1,440 px and above.

### Responsive rules

- The navigation rail collapses into a menu below 1,024 px.
- Two-column command center becomes a single column below 900 px.
- Tables become labeled list cards below 720 px.
- Side-by-side evidence review becomes a stepper below 800 px.
- Confirmation modals become full-height bottom sheets on mobile.
- Never horizontally scroll the full page; only intentionally scrollable table regions may overflow.
- Preserve primary action visibility near the bottom edge on mobile.

---

## 10. System states and failure design

Every data-driven component must specify these states before implementation:

1. Loading.
2. Empty.
3. Populated.
4. Needs review.
5. Blocked.
6. Permission denied.
7. Wallet disconnected.
8. Wrong network.
9. RPC unavailable.
10. Transaction pending.
11. Transaction failed.
12. Reconciliation unknown.
13. Stale data.

### Network mismatch

Banner: **Switch to X Layer testnet**.

Body: “Your wallet is connected to chain 1. ProofFlow is currently configured for X Layer testnet, chain 1952.”

Actions: `Switch network` and `View network details`.

Never silently submit a transaction on another chain.

### Wallet disconnected

Show the requested action, the reason it is unavailable, and `Connect wallet`. Do not render a disabled button with no explanation.

### RPC unavailable

Show the last successful refresh time, preserve the page, and allow retry. Do not infer a failed transaction from an RPC timeout.

### Unknown transaction state

Copy: “We received an incomplete confirmation. Your transaction may still be processing. ProofFlow will reconcile it before offering another attempt.”

Actions: `Refresh status`, `Open transaction`, and `View activity`.

Do not show `Retry release` until the transaction is conclusively failed or the user has explicitly resolved the unknown state.

### Session expiration

Preserve unsaved non-sensitive form fields locally only if the user has opted into the browser’s storage behavior. Never persist private keys, raw wallet signatures, or sensitive evidence content in local storage.

---

## 11. Security and trust UX requirements

- Never expose server secrets, private keys, internal prompts, or unrestricted RPC credentials.
- Display wallet addresses with copy and checksum-preserving full-value access.
- Display exact contract address before every financial transaction.
- Identify testnet prominently; testnet assets must never look like production funds.
- Add a visible `Testnet` badge to every testnet route and transaction modal.
- Show policy version and hash wherever a release decision is presented.
- Show evidence manifest hash before and after submission.
- Make the distinction between signed, submitted, mined, and reconciled explicit.
- Use audit events as evidence of system action, not as a substitute for chain confirmation.
- Do not allow a human override to look like a policy pass; label it `Human override` and show the reason.
- Do not allow evidence content to alter UI copy, navigation, system rules, or authorization controls.
- Redact sensitive evidence metadata according to workspace permissions.

---

## 12. Performance requirements

These are product budgets for the first dashboard implementation:

- First meaningful console shell: under 1.5 seconds on a typical broadband connection.
- Initial JavaScript: target under 250 KB gzip for the primary dashboard route.
- Dashboard API p95: under 500 ms excluding chain reads.
- Agreement detail API p95: under 700 ms excluding transaction confirmation.
- No repeated RPC read more frequently than the configured reconciliation interval.
- Skeleton layout shift: CLS target under 0.1.
- Transaction status updates use bounded polling or server events, not unbounded browser loops.
- Large evidence previews load on demand.
- Hashes and long addresses do not cause layout overflow.

Performance must be measured in the browser and API logs. Do not optimize by hiding important verification data.

---

## 13. Component inventory for implementation

### Layout

- `ConsoleShell`
- `Sidebar`
- `MobileNav`
- `PageHeader`
- `SectionHeader`
- `ContentGrid`
- `DetailSidebar`

### Trust and state

- `NetworkBadge`
- `WalletStatus`
- `LifecycleStateBadge`
- `StateBanner`
- `NextActionCard`
- `TrustBoundaryCard`
- `DecisionOutcome`
- `RuleResultRow`
- `ConfidenceIndicator`

### Agreements

- `AgreementTable`
- `AgreementRow`
- `AgreementSummary`
- `MilestoneCard`
- `MilestoneProgress`
- `TermsSummary`
- `PolicySummary`
- `PolicyRuleList`

### Evidence and review

- `EvidenceChecklist`
- `EvidenceManifestPreview`
- `EvidenceItem`
- `FactTable`
- `CitationLink`
- `ReviewDecisionPanel`
- `ContradictionBanner`
- `HumanOverrideDialog`

### Chain and receipt

- `TransactionPreview`
- `WalletPromptState`
- `TransactionProgress`
- `ReceiptCard`
- `ReceiptDetail`
- `ExplorerLink`
- `HashValue`
- `AddressValue`

### Primitives

- `Button`
- `IconButton`
- `Badge`
- `Input`
- `Select`
- `Textarea`
- `Checkbox`
- `RadioGroup`
- `Tabs`
- `Accordion`
- `Dialog`
- `Drawer`
- `Tooltip`
- `Toast`
- `InlineBanner`
- `Skeleton`
- `EmptyState`
- `ErrorState`
- `DataTable`

Each component must document its states, keyboard behavior, responsive behavior, and whether it may be used for a financial action.

---

## 14. Prototype and implementation order

Implement in this order:

### Phase A — foundation

1. Token layer and typography.
2. Console shell, rail, header, wallet/network status.
3. Button, badge, banner, skeleton, empty/error primitives.
4. Route-level responsive layout.

### Phase B — trust workflow

5. Agreement index and overview queue.
6. Agreement command center and state banner.
7. Milestone cards and policy summary.
8. Evidence checklist and manifest preview.
9. Decision outcome and rule rows.

### Phase C — settlement proof

10. Transaction preview.
11. Wallet/signature/pending/confirmed/failed states.
12. Receipt card and explorer verification.
13. Activity timeline and audit log.

### Phase D — hardening

14. Keyboard and screen-reader pass.
15. Mobile pass.
16. Loading, empty, failure, stale, and unknown transaction states.
17. Performance budget measurement.
18. Seeded demo workspace and reset flow.

Do not begin with a chart, AI chat panel, or broad settings page. The product’s winning demo is the lifecycle from terms to evidence to verified settlement.

---

## 15. Demo narrative and screen sequence

The five-minute judge demo should use this exact sequence:

1. **Overview:** show one active agreement and one item awaiting action.
2. **Agreement detail:** explain that the policy is published and immutable.
3. **Evidence:** open the manifest and show the source-backed facts.
4. **Decision:** show AI observations beside the deterministic policy gate.
5. **Adversarial case:** show a mismatched quantity blocked without releasing funds.
6. **Happy path:** open a ready milestone and inspect the exact transaction preview.
7. **Settlement:** authorize, wait for receipt reconciliation, and show the X Layer explorer link.
8. **Receipt:** open the proof receipt with evidence hash, policy hash, and transaction hash.

The UI should make this narrative possible without presenter narration, while still giving a technical judge enough depth to inspect the trust boundary.

---

## 16. Acceptance criteria for dashboard implementation

The dashboard is not ready for demo until all of the following are true:

### Product

- A first-time user can identify the next action on every lifecycle state.
- A buyer can create an agreement, inspect policy, fund, review, and release.
- A supplier can submit evidence and understand missing requirements.
- A reviewer can inspect source-backed facts and record a reasoned outcome.
- A deliberately mismatched quantity visibly blocks release.
- A duplicate release cannot be initiated from the UI.

### Trust

- AI observations and deterministic policy decisions are visually and textually distinct.
- The interface never calls wallet signature “payment confirmed.”
- Testnet is visible in every financial context.
- Release confirmation shows exact amount, recipient, network, contract, policy, and evidence.
- Receipt screen shows transaction and manifest/policy hashes.

### Reliability

- Wallet disconnect, wrong network, RPC timeout, failed transaction, and unknown transaction states are recoverable.
- Refreshing an agreement does not duplicate activity or mutate state incorrectly.
- Last-known data is labeled when stale.
- Loading states preserve layout and do not flash false success.

### Accessibility

- Keyboard-only end-to-end flow passes.
- Screen-reader labels identify state, role, AI observation, deterministic result, and transaction status.
- Contrast and target-size checks pass.
- Reduced-motion mode is respected.

### Performance

- Dashboard route meets the JavaScript and layout-shift budgets.
- API and RPC calls are bounded and observable.
- Evidence previews are lazy-loaded.

### Visual quality

- The visual system is consistent across overview, detail, review, and receipt surfaces.
- No placeholder copy, generic “lorem ipsum,” empty chart, or dead navigation remains.
- The primary action is obvious without making the interface loud.
- The receipt is screenshot-ready and independently understandable.

---

## 17. Open implementation decisions

These decisions must be resolved in code, not by changing the product promise:

1. Wallet connector library and supported wallet list.
2. Whether the first dashboard uses a client-side router or server-rendered route shell.
3. Evidence preview provider and maximum file types.
4. Exact explorer URL builder for X Layer testnet and mainnet.
5. Whether workspace roles are mocked for the hackathon or backed by API authorization immediately.
6. Whether the initial token path is native X Layer asset only or includes a stablecoin adapter.

The interface must keep these choices behind stable components so they do not change the user-facing trust model.

---

## 18. Definition of done for this specification

This document is the source of truth for dashboard implementation when:

- A route has a defined purpose and primary action.
- Every critical lifecycle state has plain-language copy.
- Financial actions have an explicit confirmation model.
- AI, policy, and chain responsibilities are visibly separated.
- Tokens, typography, spacing, components, accessibility, responsiveness, failure states, and performance budgets are specified.
- The demo narrative and implementation order are fixed.

Dashboard code should not invent a competing visual language or workflow without updating this document and recording the decision in `docs/decisions.md`.
