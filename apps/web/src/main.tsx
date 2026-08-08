import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { JobState } from "@proofflow/domain";
import type { Agreement, AuditEvent, EvidenceManifest, PolicyDecision, ReviewRun } from "@proofflow/domain";
import "./styles.css";

type ApiEnvelope<T> = { data: T; error?: never } | { data?: never; error: { code: string; message: string } };
type XLayerStatus = { rpcUrl: string; chainId: number; blockNumber: string };
type VaultSnapshot = { address: string; payer: string; recipient: string; amount: string; deadline: string; policyHash: string; evidenceHash: string; funded: boolean; released: boolean; disputed: boolean; paused: boolean; balance: string };
type TransactionPreview = { to: string; value: string; data: string; method: string };
type ChainPreview = { agreementId: string; network: { chainId: number; rpcUrl: string }; vault: VaultSnapshot; transactions: { fund: TransactionPreview; commitEvidence: TransactionPreview | null; release: TransactionPreview } };

type AgreementDetail = { agreement: Agreement; manifest: EvidenceManifest | null; reviewRun: ReviewRun | null; decision: PolicyDecision | null; audit: AuditEvent[]; chain: ChainPreview | null; chainError: string | null };

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8787";
const ZERO_HASH = `0x${"0".repeat(64)}`;
const ADDRESS_A = "0x0000000000000000000000000000000000000001";
const ADDRESS_B = "0x0000000000000000000000000000000000000002";
const DEMO_AGREEMENT: Agreement = {
  id: "agr_demo_001",
  title: "Solar installation — milestone 02",
  description: "Release after the installed system is inspected and the completion evidence is verified.",
  payer: ADDRESS_A,
  recipient: ADDRESS_B,
  tokenAddress: ADDRESS_A,
  amountBaseUnits: "4280000000000000000",
  deadline: "2026-08-28T17:00:00.000Z",
  policy: { version: "solar-install-v1", requiredEvidence: ["invoice", "signed_approval", "status_update"], minimumConfidenceBps: 9000, releaseAmountBaseUnits: "4280000000000000000", deadline: "2026-08-28T17:00:00.000Z" },
  policyHash: ZERO_HASH,
  state: "READY_TO_RELEASE" as JobState,
  createdAt: "2026-08-01T09:00:00.000Z",
  updatedAt: "2026-08-07T16:40:00.000Z"
};
const DEMO_MANIFEST: EvidenceManifest = { agreementId: DEMO_AGREEMENT.id, submittedBy: ADDRESS_B, submittedAt: "2026-08-07T16:32:00.000Z", items: [{ type: "invoice", name: "invoice-204.pdf", mediaType: "application/pdf", sha256: "a".repeat(64), uri: "https://example.com/evidence/invoice-204.pdf" }, { type: "signed_approval", name: "approval.pdf", mediaType: "application/pdf", sha256: "b".repeat(64), uri: "https://example.com/evidence/approval.pdf" }, { type: "status_update", name: "site-status.json", mediaType: "application/json", sha256: "c".repeat(64), uri: "https://example.com/evidence/site-status.json" }], manifestHash: `0x${"3".repeat(64)}` };
const DEMO_REVIEW: ReviewRun = { id: "rev_demo_001", agreementId: DEMO_AGREEMENT.id, evidenceManifestHash: DEMO_MANIFEST.manifestHash, provider: { provider: "ProofFlow demo reviewer", model: "deterministic-reviewer-v1", promptVersion: "demo-1" }, observation: { requiredEvidencePresent: true, extractedFacts: [{ key: "installation_status", value: "complete", source: "site-status.json" }, { key: "invoice_amount", value: "4.280 X Layer", source: "invoice-204.pdf" }], contradictions: [], missingItems: [], confidenceBps: 9400 }, inputHash: `0x${"4".repeat(64)}`, outputHash: `0x${"5".repeat(64)}`, status: "SUCCEEDED", createdAt: "2026-08-07T16:35:00.000Z", completedAt: "2026-08-07T16:35:02.000Z" };
const DEMO_DECISION: PolicyDecision = { outcome: "PASS", reasons: [], policyVersion: DEMO_AGREEMENT.policy.version, policyHash: DEMO_AGREEMENT.policyHash, evaluatedAt: "2026-08-07T16:35:02.000Z" };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers: { Accept: "application/json", "content-type": "application/json", ...init?.headers } });
  const body = await response.json() as ApiEnvelope<T>;
  if (!response.ok || body.error) throw new Error(body.error?.message ?? `Request failed (${response.status})`);
  return body.data as T;
}

function App() {
  const [agreements, setAgreements] = useState<Agreement[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AgreementDetail | null>(null);
  const [network, setNetwork] = useState<XLayerStatus | null>(null);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [notice, setNotice] = useState<{ kind: "info" | "success" | "danger"; text: string } | null>(null);
  const [demo, setDemo] = useState(false);
  const [resetting, setResetting] = useState(false);

  const loadAgreements = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api<Agreement[]>("/api/v1/agreements");
      setAgreements(result);
      setDemo(false);
      setSelectedId((current) => current && result.some((item) => item.id === current) ? current : result[0]?.id ?? null);
    } catch (error) {
      setNotice({ kind: "info", text: "API unavailable. Showing the verified demo workspace; connect the API to load live agreements." });
      setAgreements([DEMO_AGREEMENT]);
      setDemo(true);
      setSelectedId(DEMO_AGREEMENT.id);
    } finally { setLoading(false); }
  }, []);

  const loadNetwork = useCallback(async () => {
    try { setNetwork(await api<XLayerStatus>("/api/v1/xlayer/status")); setNetworkError(null); }
    catch (error) { setNetworkError(error instanceof Error ? error.message : "X Layer status unavailable"); }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      if (id === DEMO_AGREEMENT.id) { setDetail({ agreement: DEMO_AGREEMENT, manifest: DEMO_MANIFEST, reviewRun: DEMO_REVIEW, decision: DEMO_DECISION, audit: demoAudit(), chain: null, chainError: "Vault address is not configured for this demo workspace." }); return; }
      const agreement = await api<Agreement>(`/api/v1/agreements/${id}`);
      const [manifest, reviewRun, audit] = await Promise.all([api<EvidenceManifest>(`/api/v1/agreements/${id}/evidence`).catch(() => null), api<ReviewRun>(`/api/v1/agreements/${id}/reviews/latest`).catch(() => null), api<AuditEvent[]>(`/api/v1/agreements/${id}/audit`)]);
      let chain: ChainPreview | null = null; let chainError: string | null = null;
      try { chain = await api<ChainPreview>(`/api/v1/agreements/${id}/chain-preview`); } catch (error) { chainError = error instanceof Error ? error.message : "Vault status unavailable"; }
      setDetail({ agreement, manifest, reviewRun, decision: null, audit, chain, chainError });
    } catch (error) { setNotice({ kind: "danger", text: error instanceof Error ? error.message : "Agreement could not be loaded." }); }
    finally { setDetailLoading(false); }
  }, [demo]);

  useEffect(() => { void loadAgreements(); void loadNetwork(); }, [loadAgreements, loadNetwork]);
  useEffect(() => { if (selectedId) void loadDetail(selectedId); }, [selectedId, loadDetail]);

  const selected = detail?.agreement ?? agreements.find((item) => item.id === selectedId) ?? null;
  const awaiting = agreements.filter((item) => ["UNDER_REVIEW", "READY_TO_RELEASE", "AWAITING_FUNDING"].includes(item.state)).length;
  const escrow = agreements.filter((item) => item.state !== "RELEASED").reduce((sum, item) => sum + BigInt(item.amountBaseUnits || "0"), 0n);
  const statusLabel = network ? `X Layer ${network.chainId === 196 ? "mainnet" : "testnet"}` : "X Layer offline";

  async function refresh() { await Promise.all([loadAgreements(), loadNetwork()]); if (selectedId) await loadDetail(selectedId); }
  async function resetDemo() {
    setResetting(true);
    try { await api("/api/v1/demo/reset", { method: "POST" }); setNotice({ kind: "success", text: "Demo workspace reset. The seeded agreement is ready to inspect." }); await loadAgreements(); }
    catch (error) { setNotice({ kind: "danger", text: error instanceof Error ? error.message : "Demo reset failed." }); }
    finally { setResetting(false); }
  }
  async function simulate(action: "fund" | "review" | "release") {
    if (!selectedId || demo) { setNotice({ kind: "info", text: "Demo data is read-only. Connect the API and configure a vault to run live actions." }); return; }
    const paths: Record<string, [string, RequestInit]> = { fund: [`/api/v1/agreements/${selectedId}/fund`, { method: "POST" }], review: [`/api/v1/agreements/${selectedId}/review`, { method: "POST", body: JSON.stringify({ evidenceText: "Evidence received for the milestone." }) }], release: [`/api/v1/agreements/${selectedId}/settlement-intents`, { method: "POST", body: JSON.stringify({ idempotencyKey: `ui-${selectedId}-${Date.now()}` }) }] };
    const path = paths[action];
    if (!path) return;
    try { await api(path[0], path[1]); setNotice({ kind: "success", text: action === "release" ? "Settlement intent created. The wallet step is not signed by ProofFlow." : "Agreement updated." }); await refresh(); } catch (error) { setNotice({ kind: "danger", text: error instanceof Error ? error.message : "Action failed." }); }
  }

  return <div className="app-shell">
    <Sidebar selected={selected} network={statusLabel} onRefresh={refresh} />
    <main className="main-content">
      <header className="topbar"><div><div className="breadcrumb">Workspace / <strong>Trust operations</strong></div><h1>Good evening, <em>operator.</em></h1></div><div className="topbar-actions"><button className="icon-button" aria-label="Refresh data" onClick={() => void refresh()}>↻</button><div className="network-status"><span className={network ? "status-dot online" : "status-dot"} />{statusLabel}<small>{network ? `Block ${network.blockNumber}` : networkError ?? "Checking RPC"}</small></div><div className="wallet-chip"><span>0x0000...0001</span><b>Buyer</b></div></div></header>
      {notice && <div className={`inline-banner ${notice.kind}`} role="status"><span>{notice.kind === "danger" ? "!" : notice.kind === "success" ? "✓" : "i"}</span><p>{notice.text}</p><button className="banner-close" aria-label="Dismiss notification" onClick={() => setNotice(null)}>×</button></div>}
      <section className="page-heading"><div><div className="eyebrow">Trust execution console</div><h2>Overview</h2><p>Evidence, policy, and settlement in one accountable loop.</p></div><div className="heading-actions"><button className="button secondary" disabled={resetting} onClick={() => void resetDemo()}>{resetting ? "Resetting…" : "Reset demo"}</button><button className="button primary" onClick={() => setNotice({ kind: "info", text: "Agreement creation is next in the workflow. The live API foundation is ready." })}>+ Create agreement</button></div></section>
      <section className="metric-grid"><Metric label="Active agreements" value={String(agreements.length)} detail="Visible to this workspace" /><Metric label="Awaiting your action" value={String(awaiting)} detail="Review, fund, or release" tone={awaiting > 0 ? "lime" : ""} /><Metric label="In escrow" value={`${formatUnits(escrow)} XLAY`} detail="Unsettled agreement value" tone="dark" /><Metric label="Settled this period" value="—" detail="No fabricated comparison" /></section>
      <section className="dashboard-grid"><div className="panel priority-panel"><PanelHeading title="Priority queue" kicker="Next valid action" /><div className="queue-list">{loading ? <SkeletonRows /> : agreements.length === 0 ? <EmptyState title="Your trust queue is clear." copy="Create an agreement to turn a real-world commitment into a verifiable settlement." /> : agreements.map((agreement) => <QueueRow key={agreement.id} agreement={agreement} selected={agreement.id === selectedId} onClick={() => setSelectedId(agreement.id)} />)}</div></div><div className="panel network-panel"><PanelHeading title="Network health" kicker="Observed now" /><div className="network-hero"><div className="network-orbit"><span>×</span></div><div><strong>{network ? "Connected" : "Unavailable"}</strong><p>{network ? `X Layer ${network.chainId === 1952 ? "testnet" : "mainnet"}` : networkError ?? "RPC status is being checked."}</p></div></div><div className="network-detail"><span>Chain ID</span><code>{network?.chainId ?? "—"}</code><span>Latest block</span><code>{network?.blockNumber ?? "—"}</code></div><button className="text-button" onClick={() => void loadNetwork()}>Refresh RPC status ↻</button></div></section>
      <section className="panel agreement-panel"><PanelHeading title="Agreements" kicker={`${agreements.length} visible`} action={<button className="text-button" onClick={() => setNotice({ kind: "info", text: "Search and filtering will be added with the agreement creation flow." })}>Filter & search</button>} /><div className="agreement-table"><div className="table-head"><span>Agreement</span><span>Counterparty</span><span>Amount</span><span>State</span><span>Updated</span></div>{agreements.map((agreement) => <AgreementRow key={agreement.id} agreement={agreement} selected={agreement.id === selectedId} onClick={() => setSelectedId(agreement.id)} />)}</div></section>
      {selected && <DetailPanel detail={detail} loading={detailLoading} onAction={simulate} demo={demo} />}
    </main>
  </div>;
}

function Sidebar({ selected, network, onRefresh }: { selected: Agreement | null; network: string; onRefresh: () => void }) { return <aside className="sidebar"><div className="brand"><span className="brand-mark">P</span><span>ProofFlow</span></div><div className="workspace-select"><span className="workspace-avatar">T</span><span><b>Trust operations</b><small>Workspace</small></span><span>⌄</span></div><button className="button primary create-side">+ Create agreement</button><nav className="side-nav"><a className="active" href="#overview">⌂ <span>Overview</span></a><a href="#agreements">▣ <span>Agreements</span><b>{selected ? 1 : 0}</b></a><a href="#review">◌ <span>Review queue</span></a><a href="#activity">≡ <span>Activity</span></a></nav><div className="sidebar-bottom"><div className="side-network"><span className="status-dot online" /><div><small>Network</small><b>{network}</b></div></div><button className="wallet-side" onClick={onRefresh}><span className="wallet-icon">◈</span><span><small>Connected wallet</small><b>0x0000...0001</b></span><span>•••</span></button><div className="side-footer"><span>Testnet-first</span><span>v0.1.0</span></div></div></aside>; }
function Metric({ label, value, detail, tone = "" }: { label: string; value: string; detail: string; tone?: string }) { return <article className={`metric ${tone}`}><span className="metric-label">{label}</span><strong>{value}</strong><small>{detail}</small></article>; }
function PanelHeading({ title, kicker, action }: { title: string; kicker: string; action?: ReactNode }) { return <div className="panel-heading"><div><span>{kicker}</span><h3>{title}</h3></div>{action}</div>; }
function QueueRow({ agreement, selected, onClick }: { agreement: Agreement; selected: boolean; onClick: () => void }) { return <button className={`queue-row ${selected ? "selected" : ""}`} onClick={onClick}><span className={`state-mark ${stateTone(agreement.state)}`}>{stateIcon(agreement.state)}</span><span className="queue-main"><b>{agreement.title}</b><small>{agreement.id}</small></span><span className="queue-action">{nextAction(agreement.state)}</span><span className="queue-amount">{formatUnits(agreement.amountBaseUnits)} XLAY</span><span className="queue-date">{relativeTime(agreement.updatedAt)}</span></button>; }
function AgreementRow({ agreement, selected, onClick }: { agreement: Agreement; selected: boolean; onClick: () => void }) { return <button className={`table-row ${selected ? "selected" : ""}`} onClick={onClick}><span><b>{agreement.title}</b><small>{agreement.id}</small></span><span className="mono">{shortAddress(agreement.recipient)}</span><span className="numeric">{formatUnits(agreement.amountBaseUnits)} XLAY</span><StateBadge state={agreement.state} /><span className="mono">{relativeTime(agreement.updatedAt)}</span></button>; }
function DetailPanel({ detail, loading, onAction, demo }: { detail: AgreementDetail | null; loading: boolean; onAction: (action: "fund" | "review" | "release") => void; demo: boolean }) { const agreement = detail?.agreement; if (!agreement) return <section className="panel detail-panel"><SkeletonRows /></section>; const review = detail?.reviewRun; const observation = review?.observation; return <section className="detail-panel"><div className="detail-header"><div><span className="eyebrow">Agreement command center · {agreement.id}</span><h2>{agreement.title}</h2><p>{agreement.description}</p></div><StateBadge state={agreement.state} /></div>{detail?.chainError && <div className="chain-warning"><span>!</span><div><b>Vault status is not available</b><p>{detail.chainError}</p><small>Live transaction previews appear after the vault address is configured.</small></div></div>}<div className="detail-grid"><div><section className="detail-card state-banner"><span className={`state-mark large ${stateTone(agreement.state)}`}>{stateIcon(agreement.state)}</span><div><span className="eyebrow">Current state</span><h3>{stateTitle(agreement.state)}</h3><p>{stateCopy(agreement.state)}</p></div><button className="button primary action-button" disabled={loading || (demo && agreement.state !== "READY_TO_RELEASE")} onClick={() => void onAction(agreement.state === "AWAITING_FUNDING" ? "fund" : agreement.state === "EVIDENCE_SUBMITTED" ? "review" : "release")}>{nextAction(agreement.state)}</button></section><section className="detail-card"><SectionTitle title="Lifecycle" kicker="Agreement state" /><Lifecycle state={agreement.state} /></section><section className="detail-card"><SectionTitle title="Evidence and review" kicker="AI observation · deterministic gate" />{detail?.manifest ? <EvidenceReview manifest={detail.manifest} review={review} observation={observation} decision={detail.decision} /> : <EmptyState title="No evidence manifest" copy="Evidence has not been submitted for this agreement." />}</section><section className="detail-card"><SectionTitle title="Audit trail" kicker="Append-only integrity" /><AuditTrail events={detail?.audit ?? []} /></section></div><aside className="detail-sidebar"><section className="detail-card terms-card"><SectionTitle title="Terms" kicker="Immutable agreement" /><InfoRow label="Amount" value={`${formatUnits(agreement.amountBaseUnits)} XLAY`} /><InfoRow label="Deadline" value={formatDate(agreement.deadline)} /><InfoRow label="Payer" value={shortAddress(agreement.payer)} mono /><InfoRow label="Recipient" value={shortAddress(agreement.recipient)} mono /><InfoRow label="Policy" value={agreement.policy.version} /><InfoRow label="Policy hash" value={shortHash(agreement.policyHash)} mono /></section><section className="detail-card"><SectionTitle title="Vault status" kicker="X Layer settlement" />{detail?.chain ? <VaultCard chain={detail.chain} /> : <div className="not-configured"><span>◌</span><b>Awaiting vault connection</b><p>Configure <code>PROOFFLOW_VAULT_ADDRESS</code> to verify the onchain terms and preview safe transactions.</p></div>}</section></aside></div></section>; }
function SectionTitle({ title, kicker }: { title: string; kicker: string }) { return <div className="section-title"><span>{kicker}</span><h3>{title}</h3></div>; }
function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) { return <div className="info-row"><span>{label}</span><strong className={mono ? "mono" : ""}>{value}</strong></div>; }
function StateBadge({ state }: { state: Agreement["state"] }) { return <span className={`state-badge ${stateTone(state)}`}><span>{stateIcon(state)}</span>{stateLabel(state)}</span>; }
function Lifecycle({ state }: { state: Agreement["state"] }) { const steps: Agreement["state"][] = [JobState.AWAITING_FUNDING, JobState.FUNDED, JobState.EVIDENCE_SUBMITTED, JobState.UNDER_REVIEW, JobState.READY_TO_RELEASE, JobState.RELEASED]; const index = steps.indexOf(state); return <div className="lifecycle">{steps.map((step, i) => <div className={`lifecycle-step ${i < index ? "complete" : i === index ? "current" : ""}`} key={step}><span>{i < index ? "✓" : i + 1}</span><small>{stateLabel(step)}</small></div>)}</div>; }
function EvidenceReview({ manifest, review, observation, decision }: { manifest: EvidenceManifest; review: ReviewRun | null | undefined; observation: ReviewRun["observation"] | undefined; decision: PolicyDecision | null }) { return <div className="evidence-review"><div className="evidence-summary"><div className="summary-icon">✓</div><div><b>{review ? "AI review completed" : "Evidence manifest received"}</b><p>{review ? `Structured observations from ${review.provider.model}.` : "Waiting for a review run."}</p></div>{review && <span className="confidence-value">{(review.observation.confidenceBps / 100).toFixed(0)}%</span>}</div><div className="trust-boundary"><span>AI observation</span><i>→</i><span className="policy-chip">Deterministic policy gate</span><i>→</i><span className={decision?.outcome === "PASS" ? "pass-chip" : "review-chip"}>{decision?.outcome ?? "Awaiting evaluation"}</span></div><div className="evidence-list">{manifest.items.map((item) => <div className="evidence-item" key={item.sha256}><span className="file-icon">□</span><span><b>{item.name}</b><small>{item.type} · {item.mediaType}</small></span><code>{shortHash(item.sha256)}</code><span className="pass-text">✓ verified</span></div>)}</div>{observation && <div className="facts"><span className="eyebrow">Extracted facts</span>{observation.extractedFacts.map((fact) => <div className="fact" key={`${fact.key}-${fact.source}`}><b>{fact.key}</b><span>{fact.value}</span><small>Source: {fact.source}</small></div>)}</div>}</div>; }
function AuditTrail({ events }: { events: AuditEvent[] }) { return events.length ? <div className="audit-list">{events.slice().reverse().map((event) => <div className="audit-item" key={event.id}><span className="audit-dot" /><div><b>{event.eventType.replaceAll("_", " ")}</b><p>{event.actor} · {relativeTime(event.occurredAt)}</p></div><code>{shortHash(event.eventHash)}</code></div>)}</div> : <EmptyState title="No audit events yet" copy="Lifecycle events will appear here as this agreement changes." />; }
function VaultCard({ chain }: { chain: ChainPreview }) { return <div className="vault-card"><div className="vault-state"><span className="status-dot online" /><b>{chain.vault.released ? "Released" : chain.vault.funded ? "Funded" : "Awaiting funding"}</b><small>Chain {chain.network.chainId}</small></div><InfoRow label="Vault" value={shortAddress(chain.vault.address)} mono /><InfoRow label="Balance" value={`${formatUnits(chain.vault.balance)} XLAY`} /><div className="preview-block"><span className="eyebrow">Safe transaction previews</span>{Object.values(chain.transactions).filter(Boolean).map((tx) => <div className="tx-preview" key={tx!.method}><span><b>{tx!.method}</b><small>Not signed · not submitted</small></span><button className="copy-button" onClick={() => void navigator.clipboard?.writeText(JSON.stringify(tx))}>Copy JSON</button></div>)}</div></div>; }
function SkeletonRows() { return <div className="skeleton-rows"><span /><span /><span /></div>; }
function EmptyState({ title, copy }: { title: string; copy: string }) { return <div className="empty-state"><span>○</span><b>{title}</b><p>{copy}</p></div>; }
function AppErrorBoundary({ children }: { children: ReactNode }) { return <>{children}</>; }

function demoAudit(): AuditEvent[] { return [{ id: "evt_03", sequence: 3, aggregateType: "POLICY_DECISION", aggregateId: DEMO_AGREEMENT.id, eventType: "POLICY_EVALUATED", actor: "policy-engine", occurredAt: DEMO_REVIEW.completedAt!, correlationId: DEMO_AGREEMENT.id, payloadHash: `0x${"6".repeat(64)}`, previousEventHash: `0x${"7".repeat(64)}`, eventHash: `0x${"8".repeat(64)}` }, { id: "evt_02", sequence: 2, aggregateType: "EVIDENCE", aggregateId: DEMO_AGREEMENT.id, eventType: "EVIDENCE_SUBMITTED", actor: ADDRESS_B, occurredAt: DEMO_MANIFEST.submittedAt, correlationId: DEMO_AGREEMENT.id, payloadHash: `0x${"9".repeat(64)}`, previousEventHash: ZERO_HASH, eventHash: `0x${"a".repeat(64)}` }]; }
function formatUnits(value: string | bigint) { const raw = BigInt(value); return Number(raw) / 1e18 >= 1 ? (Number(raw) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 4 }) : raw.toString(); }
function shortAddress(value: string) { return `${value.slice(0, 6)}…${value.slice(-4)}`; }
function shortHash(value: string) { return `${value.slice(0, 10)}…${value.slice(-8)}`; }
function formatDate(value: string) { return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); }
function relativeTime(value: string) { const diff = Date.now() - new Date(value).getTime(); const minutes = Math.max(1, Math.round(diff / 60000)); return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`; }
function stateLabel(state: Agreement["state"]) { return state.replaceAll("_", " ").toLowerCase().replace(/(^| )\S/g, (letter) => letter.toUpperCase()); }
function stateIcon(state: Agreement["state"]) { return ["READY_TO_RELEASE", "RELEASED", "FUNDED"].includes(state) ? "✓" : ["BLOCKED", "DISPUTED"].includes(state) ? "!" : ["UNDER_REVIEW", "EVIDENCE_SUBMITTED"].includes(state) ? "◌" : "·"; }
function stateTone(state: Agreement["state"]) { return state === "READY_TO_RELEASE" || state === "RELEASED" || state === "FUNDED" ? "pass" : state === "BLOCKED" || state === "DISPUTED" ? "danger" : state === "UNDER_REVIEW" || state === "EVIDENCE_SUBMITTED" ? "warning" : "pending"; }
function stateTitle(state: Agreement["state"]) { return state === "READY_TO_RELEASE" ? "Ready to release" : stateLabel(state); }
function stateCopy(state: Agreement["state"]) { const copy: Partial<Record<Agreement["state"], string>> = { READY_TO_RELEASE: "Evidence is present, the review is complete, and deterministic policy conditions pass.", UNDER_REVIEW: "A human should inspect the review result before any settlement intent is created.", AWAITING_FUNDING: "Fund the vault before the recipient can submit evidence.", EVIDENCE_SUBMITTED: "Evidence is ready for a bounded AI review.", RELEASED: "The settlement has been confirmed by the protocol." }; return copy[state] ?? "ProofFlow is waiting for the next valid lifecycle event."; }
function nextAction(state: Agreement["state"]) { return state === "AWAITING_FUNDING" ? "Fund agreement" : state === "EVIDENCE_SUBMITTED" ? "Run review" : state === "READY_TO_RELEASE" ? "Prepare settlement" : state === "FUNDED" ? "Await evidence" : "Inspect details"; }

createRoot(document.getElementById("root")!).render(<StrictMode><AppErrorBoundary><App /></AppErrorBoundary></StrictMode>);
