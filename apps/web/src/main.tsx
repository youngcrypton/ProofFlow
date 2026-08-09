import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { JobState } from "@proofflow/domain";
import type { Agreement, AuditEvent, EvidenceManifest, EvidenceType, PolicyDecision, ReviewRun } from "@proofflow/domain";
import "./styles.css";

type ApiEnvelope<T> = { data: T; error?: never } | { data?: never; error: { code: string; message: string } };
type XLayerStatus = { rpcUrl: string; chainId: number; blockNumber: string };
type VaultSnapshot = { address: string; payer: string; recipient: string; amount: string; deadline: string; policyHash: string; evidenceHash: string; funded: boolean; released: boolean; disputed: boolean; paused: boolean; balance: string };
type TransactionPreview = { to: string; value: string; data: string; method: string };
type SettlementIntent = { id: string; agreementId: string; amountBaseUnits: string; recipient: string; state: "CREATED" | "AWAITING_AUTHORIZATION" | "SUBMITTED" | "CONFIRMED" | "FAILED" | "UNKNOWN"; transactionHash?: string; createdAt: string; updatedAt: string };
type SettlementAuthorization = { walletAddress: string; transactionHash: string; chainId: number };
type SettlementReconciliation = { status: "PENDING" | "CONFIRMED" | "FAILED"; intent: SettlementIntent; receipt: { transactionHash: string; blockNumber: string; status: "0x1" | "0x0" } | null };
type Eip1193Provider = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown>; on?: (event: string, handler: (...args: unknown[]) => void) => void; removeListener?: (event: string, handler: (...args: unknown[]) => void) => void; isOkxWallet?: boolean };
type ChainPreview = { agreementId: string; network: { chainId: number; rpcUrl: string }; vault: VaultSnapshot; transactions: { fund: TransactionPreview; commitEvidence: TransactionPreview | null; release: TransactionPreview } };
type AgreementDetail = { agreement: Agreement; manifest: EvidenceManifest | null; reviewRun: ReviewRun | null; decision: PolicyDecision | null; audit: AuditEvent[]; chain: ChainPreview | null; chainError: string | null };
type AgreementDraft = { title: string; description: string; payer: string; recipient: string; tokenAddress: string; amountBaseUnits: string; deadline: string; evidenceType: EvidenceType };
type SettlementStage = "idle" | "preparing" | "ready" | "awaiting_wallet" | "submitted" | "confirming" | "confirmed" | "failed" | "unknown";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8787";
const XLAYER_TESTNET_CHAIN_ID = 1952;
const XLAYER_TESTNET_CHAIN_HEX = "0x7a0";
const XLAYER_TESTNET_CONFIG = { chainId: XLAYER_TESTNET_CHAIN_HEX, chainName: "X Layer testnet", nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 }, rpcUrls: ["https://testrpc.xlayer.tech/terigon", "https://xlayertestrpc.okx.com/terigon"], blockExplorerUrls: ["https://www.okx.com/web3/explorer/xlayer-test"] };

function getOkxProvider(): Eip1193Provider | null {
  const globals = window as Window & { okxwallet?: Eip1193Provider; ethereum?: Eip1193Provider };
  if (globals.okxwallet) return { ...globals.okxwallet, isOkxWallet: true };
  if (globals.ethereum?.isOkxWallet) return globals.ethereum;
  return null;
}

async function switchToXLayer(provider: Eip1193Provider): Promise<void> {
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: XLAYER_TESTNET_CHAIN_HEX }] });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: number }).code : undefined;
    if (code !== 4902) throw error;
    await provider.request({ method: "wallet_addEthereumChain", params: [XLAYER_TESTNET_CONFIG] });
  }
}

async function pollSettlement(intentId: string, transactionHash: string): Promise<SettlementReconciliation | null> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const result = await api<SettlementReconciliation>(`/api/v1/settlement-intents/${intentId}/reconcile`, { method: "POST", body: JSON.stringify({ transactionHash }) });
      if (result.status === "CONFIRMED" || result.status === "FAILED") return result;
    } catch {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 4_000));
  }
  return null;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const isMultipart = typeof FormData !== "undefined" && init?.body instanceof FormData;
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (!isMultipart && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
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
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [walletChainId, setWalletChainId] = useState<number | null>(null);
  const [walletProvider, setWalletProvider] = useState<Eip1193Provider | null>(null);
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [settlementStage, setSettlementStage] = useState<SettlementStage>("idle");
  const [settlementHash, setSettlementHash] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "info" | "success" | "danger"; text: string } | null>(null);
  const [resetting, setResetting] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const loadAgreements = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api<Agreement[]>("/api/v1/agreements");
      setAgreements(result);
      setSelectedId((current) => current && result.some((item) => item.id === current) ? current : result[0]?.id ?? null);
    } catch {
      setNotice({ kind: "danger", text: "Live workspace unavailable. Check the API connection and retry." });
      setAgreements([]);
      setSelectedId(null);
    } finally { setLoading(false); }
  }, []);

  const loadNetwork = useCallback(async () => {
    try { setNetwork(await api<XLayerStatus>("/api/v1/xlayer/status")); setNetworkError(null); }
    catch (error) { setNetworkError(error instanceof Error ? error.message : "X Layer status unavailable"); }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      const agreement = await api<Agreement>(`/api/v1/agreements/${id}`);
      const [manifest, reviewRun, decisionResult, audit] = await Promise.all([
        api<EvidenceManifest>(`/api/v1/agreements/${id}/evidence`).catch(() => null),
        api<ReviewRun>(`/api/v1/agreements/${id}/reviews/latest`).catch(() => null),
        api<{ decision: PolicyDecision }>(`/api/v1/agreements/${id}/policy-decision`).catch(() => null),
        api<AuditEvent[]>(`/api/v1/agreements/${id}/audit`)
      ]);
      let chain: ChainPreview | null = null;
      let chainError: string | null = null;
      try { chain = await api<ChainPreview>(`/api/v1/agreements/${id}/chain-preview`); }
      catch (error) { chainError = error instanceof Error ? error.message : "Vault status unavailable"; }
      setDetail({ agreement, manifest, reviewRun, decision: decisionResult?.decision ?? null, audit, chain, chainError });
    } catch (error) { setNotice({ kind: "danger", text: error instanceof Error ? error.message : "Agreement could not be loaded." }); }
    finally { setDetailLoading(false); }
  }, []);

  useEffect(() => { void loadAgreements(); void loadNetwork(); }, [loadAgreements, loadNetwork]);
  useEffect(() => {
    const provider = getOkxProvider();
    if (!provider) return;
    const onAccountsChanged = (...args: unknown[]) => { const accounts = (args[0] as string[] | undefined) ?? []; setWalletAddress(accounts[0] ?? null); if (!accounts[0]) setWalletChainId(null); };
    const onChainChanged = (...args: unknown[]) => { const value = args[0]; setWalletChainId(typeof value === "string" ? Number.parseInt(value, 16) : null); };
    setWalletProvider(provider);
    void provider.request({ method: "eth_accounts" }).then((value) => onAccountsChanged(value));
    void provider.request({ method: "eth_chainId" }).then((value) => onChainChanged(value));
    provider.on?.("accountsChanged", onAccountsChanged);
    provider.on?.("chainChanged", onChainChanged);
    return () => { provider.removeListener?.("accountsChanged", onAccountsChanged); provider.removeListener?.("chainChanged", onChainChanged); };
  }, []);
  useEffect(() => { if (selectedId) void loadDetail(selectedId); }, [selectedId, loadDetail]);

  const selected = detail?.agreement ?? agreements.find((item) => item.id === selectedId) ?? null;
  const attention = agreements.filter((item) => ["BLOCKED", "DISPUTED", "UNDER_REVIEW", "EVIDENCE_SUBMITTED", "AWAITING_FUNDING"].includes(item.state)).length;
  const reviewQueue = agreements.filter((item) => ["UNDER_REVIEW", "EVIDENCE_SUBMITTED"].includes(item.state)).length;
  const escrow = agreements.filter((item) => item.state !== "RELEASED").reduce((sum, item) => sum + BigInt(item.amountBaseUnits || "0"), 0n);
  const statusLabel = network ? `X Layer ${network.chainId === 196 ? "mainnet" : "testnet"}` : "X Layer offline";

  async function refresh() { await Promise.all([loadAgreements(), loadNetwork()]); if (selectedId) await loadDetail(selectedId); }
  async function handleCreated(agreement: Agreement) { setCreateOpen(false); setNotice({ kind: "success", text: `Agreement ${agreement.id} created and awaiting funding.` }); await loadAgreements(); setSelectedId(agreement.id); await loadDetail(agreement.id); }
  async function handleEvidenceSubmitted() { setEvidenceOpen(false); setNotice({ kind: "success", text: "Evidence manifest submitted and hashed into the audit trail." }); await refresh(); }
  async function resetDemo() { setResetting(true); try { await api("/api/v1/demo/reset", { method: "POST" }); setNotice({ kind: "success", text: "Demo workspace reset. The seeded agreement is ready to inspect." }); await loadAgreements(); } catch (error) { setNotice({ kind: "danger", text: error instanceof Error ? error.message : "Demo reset failed." }); } finally { setResetting(false); } }

  async function connectWallet() {
    setWalletError(null);
    const provider = walletProvider ?? getOkxProvider();
    if (!provider) { setWalletError("OKX Wallet was not detected. Install or unlock OKX Wallet, then try again."); return; }
    setWalletProvider(provider);
    try {
      const accounts = await provider.request({ method: "eth_requestAccounts" }) as string[];
      setWalletAddress(accounts[0] ?? null);
      const chainHex = await provider.request({ method: "eth_chainId" }) as string;
      setWalletChainId(Number.parseInt(chainHex, 16));
      setNotice({ kind: "success", text: `OKX Wallet connected: ${shortAddress(accounts[0] ?? "")}.` });
    } catch (error) { setWalletError(error instanceof Error ? error.message : "OKX Wallet connection was rejected."); }
  }

  async function switchWalletNetwork() {
    setWalletError(null);
    const provider = walletProvider ?? getOkxProvider();
    if (!provider) { setWalletError("OKX Wallet was not detected."); return; }
    try { await switchToXLayer(provider); setWalletChainId(XLAYER_TESTNET_CHAIN_ID); setNotice({ kind: "success", text: "OKX Wallet switched to X Layer testnet." }); }
    catch (error) { setWalletError(error instanceof Error ? error.message : "Network switch was rejected in OKX Wallet."); }
  }

  async function authorizeRelease(agreementId: string) {
    const provider = walletProvider ?? getOkxProvider();
    if (!provider) { setWalletError("OKX Wallet was not detected. Install OKX Wallet before authorizing settlement."); return; }
    if (!walletAddress) { await connectWallet(); return; }
    setWalletBusy(true); setWalletError(null); setSettlementStage("preparing"); setSettlementHash(null);
    let submittedHash: string | null = null;
    try {
      const expectedChainId = Number(import.meta.env.VITE_XLAYER_CHAIN_ID ?? XLAYER_TESTNET_CHAIN_ID);
      const currentChainHex = await provider.request({ method: "eth_chainId" }) as string;
      const currentChainId = Number.parseInt(currentChainHex, 16);
      setWalletChainId(currentChainId);
      if (currentChainId !== expectedChainId) { setSettlementStage("preparing"); await switchToXLayer(provider); }
      const confirmedChainHex = await provider.request({ method: "eth_chainId" }) as string;
      const confirmedChainId = Number.parseInt(confirmedChainHex, 16);
      setWalletChainId(confirmedChainId);
      if (confirmedChainId !== expectedChainId) throw new Error(`OKX Wallet is on chain ${confirmedChainId}. Switch to X Layer testnet before continuing.`);
      const intentResponse = await api<SettlementIntent>(`/api/v1/agreements/${agreementId}/settlement-intent`);
      const previewResponse = await api<{ transactions: { release: { to: string; value: string | bigint; data: string } } }>(`/api/v1/agreements/${agreementId}/chain-preview`);
      const tx = previewResponse.transactions.release;
      setSettlementStage("awaiting_wallet");
      submittedHash = await provider.request({ method: "eth_sendTransaction", params: [{ from: walletAddress, to: tx.to, data: tx.data, value: `0x${BigInt(tx.value).toString(16)}` }] }) as string;
      setSettlementHash(submittedHash); setSettlementStage("submitted");
      await api<{ intent: SettlementIntent; authorization: SettlementAuthorization }>(`/api/v1/settlement-intents/${intentResponse.id}/authorization`, { method: "POST", body: JSON.stringify({ walletAddress, transactionHash: submittedHash, chainId: confirmedChainId }) });
      setSettlementStage("confirming");
      const reconciliation = await pollSettlement(intentResponse.id, submittedHash);
      if (!reconciliation) { setSettlementStage("unknown"); setNotice({ kind: "info", text: "Transaction submitted. Confirmation is uncertain; refresh before retrying." }); return; }
      if (reconciliation.status === "FAILED") { setSettlementStage("failed"); setWalletError("X Layer rejected the settlement receipt. No funds were marked as released."); return; }
      setSettlementStage("confirmed");
      setNotice({ kind: "success", text: `Settlement confirmed on X Layer: ${shortHash(submittedHash)}.` });
      await refresh();
    } catch (error) {
      if (submittedHash) { setSettlementStage("unknown"); setWalletError("Transaction was submitted, but confirmation is uncertain. Refresh or open the transaction before retrying."); }
      else { setSettlementStage("failed"); setWalletError(error instanceof Error ? error.message : "Settlement authorization failed."); }
    } finally { setWalletBusy(false); }
  }

  async function simulate(action: "fund" | "evidence" | "review" | "release") {
    if (action === "release") { if (selected) setReleaseOpen(true); return; }
    if (action === "evidence") { setEvidenceOpen(true); return; }
    if (!selectedId) return;
    const paths: Record<"fund" | "review", [string, RequestInit]> = { fund: [`/api/v1/agreements/${selectedId}/fund`, { method: "POST" }], review: [`/api/v1/agreements/${selectedId}/review`, { method: "POST", body: JSON.stringify({ evidenceText: "Evidence received for the milestone." }) }] };
    try { await api(paths[action][0], paths[action][1]); setNotice({ kind: "success", text: "Agreement updated." }); await refresh(); } catch (error) { setNotice({ kind: "danger", text: error instanceof Error ? error.message : "Action failed." }); }
  }

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <Sidebar selected={selected} network={statusLabel} walletAddress={walletAddress} mobileOpen={mobileNavOpen} onToggle={() => setMobileNavOpen((value) => !value)} onConnect={() => void connectWallet()} onCreate={() => { setCreateOpen(true); setMobileNavOpen(false); }} />
    <main id="main-content" className="main-content">
      <header className="topbar"><div className="topbar-title"><div className="breadcrumb">Workspace / <strong>Trust operations</strong></div><h1>Trust operations</h1></div><div className="topbar-actions"><button className="icon-button" aria-label="Refresh data" onClick={() => void refresh()}>↻</button><div className="network-status"><span className={network ? "status-dot online" : "status-dot"} /><div><b>{statusLabel}</b><small>{network ? `Block ${network.blockNumber}` : networkError ?? "Checking RPC"}</small></div></div><div className="wallet-chip"><span className="wallet-chip-icon">◈</span><div><b>{walletAddress ? shortAddress(walletAddress) : "Wallet disconnected"}</b><small>{walletAddress && walletChainId === XLAYER_TESTNET_CHAIN_ID ? "OKX Wallet · X Layer testnet" : walletAddress ? "OKX Wallet · wrong network" : "OKX Wallet required to settle"}</small></div></div></div></header>
      <div className="testnet-banner"><span className="banner-signal">!</span><div><b>X Layer testnet workspace</b><p>Funds and transactions here are for demonstration only. ProofFlow never signs or moves funds without your explicit OKX Wallet approval.</p></div><span className="banner-mono">CHAIN {network?.chainId ?? XLAYER_TESTNET_CHAIN_ID}</span></div>
      {notice && <div className={`inline-banner ${notice.kind}`} role="status" aria-live="polite"><span>{notice.kind === "danger" ? "!" : notice.kind === "success" ? "✓" : "i"}</span><p>{notice.text}</p><button className="banner-close" aria-label="Dismiss notification" onClick={() => setNotice(null)}>×</button></div>}
      <section className="page-heading"><div><div className="eyebrow">Trust execution console</div><h2>Make the next safe move.</h2><p>AI checks the evidence. Policy decides. You approve. X Layer settles.</p></div><div className="heading-actions"><button className="button secondary" disabled={resetting} onClick={() => void resetDemo()}>{resetting ? "Resetting…" : "Reset demo"}</button><button className="button primary" onClick={() => setCreateOpen(true)}>+ Create agreement</button></div></section>
      <section className="metric-grid" aria-label="Workspace summary"><Metric label="Needs attention" value={String(attention)} detail="Blocked, pending, or waiting" tone={attention > 0 ? "lime" : ""} /><Metric label="Active escrow" value={`${formatUnits(escrow)} XLAY`} detail="Unsettled agreement value" tone="dark" /><Metric label="Review queue" value={String(reviewQueue)} detail="Evidence awaiting a decision" /><Metric label="Network health" value={network ? "Online" : "Offline"} detail={network ? "X Layer RPC responding" : "Last check unavailable"} /></section>
      <section className="dashboard-grid"><div className="panel priority-panel"><PanelHeading title="Priority queue" kicker="What needs attention first" /><div className="queue-list">{loading ? <SkeletonRows /> : agreements.length === 0 ? <EmptyState title="Your trust queue is clear." copy="Create an agreement to turn a real-world commitment into a verifiable settlement." /> : sortPriority(agreements).map((agreement) => <QueueRow key={agreement.id} agreement={agreement} selected={agreement.id === selectedId} onClick={() => setSelectedId(agreement.id)} />)}</div></div><div className="panel network-panel"><PanelHeading title="Network health" kicker="Observed now" /><div className="network-hero"><div className="network-orbit"><span>×</span></div><div><strong>{network ? "Connected" : "Unavailable"}</strong><p>{network ? `X Layer ${network.chainId === 1952 ? "testnet" : "mainnet"}` : networkError ?? "RPC status is being checked."}</p></div></div><div className="network-detail"><span>Chain ID</span><code>{network?.chainId ?? "—"}</code><span>Latest block</span><code>{network?.blockNumber ?? "—"}</code></div><button className="text-button" onClick={() => void loadNetwork()}>Refresh RPC status ↻</button></div></section>
      <section className="panel agreement-panel" id="agreements"><PanelHeading title="Live agreements" kicker={`${agreements.length} visible`} action={<span className="table-scope">Live workspace</span>} /><div className="agreement-table"><div className="table-head"><span>Agreement</span><span>Counterparty</span><span>Amount</span><span>State</span><span>Updated</span></div>{loading ? <SkeletonRows /> : agreements.length ? agreements.map((agreement) => <AgreementRow key={agreement.id} agreement={agreement} selected={agreement.id === selectedId} onClick={() => setSelectedId(agreement.id)} />) : <EmptyState title="No agreements yet" copy="Your first agreement will appear here with its terms, evidence, and settlement state." />}</div></section>
      {selected && <DetailPanel detail={detail} loading={detailLoading} onAction={simulate} walletAddress={walletAddress} walletBusy={walletBusy} walletError={walletError} walletChainId={walletChainId} settlementStage={settlementStage} settlementHash={settlementHash} onConnect={() => void connectWallet()} onSwitchNetwork={() => void switchWalletNetwork()} onReviewRelease={() => setReleaseOpen(true)} />}
      {createOpen && <CreateAgreementModal onClose={() => setCreateOpen(false)} onCreated={handleCreated} />}
      {evidenceOpen && selected && <EvidenceModal agreement={selected} onClose={() => setEvidenceOpen(false)} onSubmitted={handleEvidenceSubmitted} />}
      {releaseOpen && selected && detail?.chain && <ReleaseModal agreement={selected} chain={detail.chain} decision={detail.decision} manifest={detail.manifest} walletAddress={walletAddress} walletChainId={walletChainId} walletBusy={walletBusy} walletError={walletError} stage={settlementStage} transactionHash={settlementHash} onClose={() => setReleaseOpen(false)} onConnect={() => void connectWallet()} onSwitchNetwork={() => void switchWalletNetwork()} onAuthorize={() => void authorizeRelease(selected.id)} />}
    </main>
  </div>;
}

function Sidebar({ selected, network, walletAddress, mobileOpen, onToggle, onConnect, onCreate }: { selected: Agreement | null; network: string; walletAddress: string | null; mobileOpen: boolean; onToggle: () => void; onConnect: () => void; onCreate: () => void }) { return <aside className={`sidebar ${mobileOpen ? "mobile-open" : ""}`}><div className="brand"><span className="brand-mark">P</span><span>ProofFlow</span><button className="mobile-menu-button" aria-label="Toggle navigation" aria-expanded={mobileOpen} onClick={onToggle}>☰</button></div><div className="workspace-select"><span className="workspace-avatar">T</span><span><b>Trust operations</b><small>Workspace</small></span><span>⌄</span></div><button className="button primary create-side" onClick={onCreate}>+ Create agreement</button><nav className="side-nav" aria-label="Primary navigation"><a className="active" aria-current="page" href="#overview" onClick={onToggle}>⌂ <span>Overview</span></a><a href="#agreements" onClick={onToggle}>▣ <span>Agreements</span><b>{selected ? 1 : 0}</b></a><a href="#review" onClick={onToggle}>◌ <span>Review queue</span></a><a href="#activity" onClick={onToggle}>≡ <span>Activity</span></a></nav><div className="sidebar-bottom"><div className="side-network"><span className="status-dot online" /><div><small>Network</small><b>{network}</b></div></div><button className="wallet-side" onClick={walletAddress ? onConnect : onConnect}><span className="wallet-icon">◈</span><span><small>{walletAddress ? "Connected with OKX Wallet" : "Settlement wallet"}</small><b>{walletAddress ? shortAddress(walletAddress) : "Connect OKX Wallet"}</b></span><span>↗</span></button><div className="side-footer"><span>Testnet-first</span><span>v0.1.0</span></div></div></aside>; }
function Metric({ label, value, detail, tone = "" }: { label: string; value: string; detail: string; tone?: string }) { return <article className={`metric ${tone}`}><span className="metric-label">{label}</span><strong>{value}</strong><small>{detail}</small></article>; }
function PanelHeading({ title, kicker, action }: { title: string; kicker: string; action?: ReactNode }) { return <div className="panel-heading"><div><span>{kicker}</span><h3>{title}</h3></div>{action}</div>; }
function QueueRow({ agreement, selected, onClick }: { agreement: Agreement; selected: boolean; onClick: () => void }) { return <button className={`queue-row ${selected ? "selected" : ""}`} onClick={onClick}><span className={`state-mark ${stateTone(agreement.state)}`}>{stateIcon(agreement.state)}</span><span className="queue-main"><b>{agreement.title}</b><small>{agreement.id}</small></span><span className="queue-action">{priorityReason(agreement.state)}</span><span className="queue-amount">{formatUnits(agreement.amountBaseUnits)} XLAY</span><span className="queue-date">{relativeTime(agreement.updatedAt)}</span></button>; }
function AgreementRow({ agreement, selected, onClick }: { agreement: Agreement; selected: boolean; onClick: () => void }) { return <button className={`table-row ${selected ? "selected" : ""}`} onClick={onClick}><span data-label="Agreement"><b>{agreement.title}</b><small>{agreement.id}</small></span><span className="mono" data-label="Counterparty">{shortAddress(agreement.recipient)}</span><span className="numeric" data-label="Amount">{formatUnits(agreement.amountBaseUnits)} XLAY</span><span data-label="State"><StateBadge state={agreement.state} /></span><span className="mono" data-label="Updated">{relativeTime(agreement.updatedAt)}</span></button>; }
function DetailPanel({ detail, loading, onAction, walletAddress, walletBusy, walletError, walletChainId, settlementStage, settlementHash, onConnect, onSwitchNetwork, onReviewRelease }: { detail: AgreementDetail | null; loading: boolean; onAction: (action: "fund" | "evidence" | "review" | "release") => void; walletAddress: string | null; walletBusy: boolean; walletError: string | null; walletChainId: number | null; settlementStage: SettlementStage; settlementHash: string | null; onConnect: () => void; onSwitchNetwork: () => void; onReviewRelease: () => void }) { const agreement = detail?.agreement; if (!agreement) return <section className="panel detail-panel"><SkeletonRows /></section>; const review = detail?.reviewRun; const observation = review?.observation; return <section className="detail-panel" id="overview"><div className="detail-header"><div><span className="eyebrow">Agreement command center · {agreement.id}</span><h2>{agreement.title}</h2><p>{agreement.description}</p></div><StateBadge state={agreement.state} /></div>{detail?.chainError && <div className="chain-warning" role="status"><span>!</span><div><b>Vault status is not available</b><p>{detail.chainError}</p><small>Live transaction previews appear after the vault address is configured.</small></div></div>}<div className="detail-grid"><div><section className="detail-card state-banner"><span className={`state-mark large ${stateTone(agreement.state)}`}>{stateIcon(agreement.state)}</span><div><span className="eyebrow">Current state</span><h3>{stateTitle(agreement.state)}</h3><p>{stateCopy(agreement.state)}</p></div><button className="button primary action-button" disabled={loading || !["AWAITING_FUNDING", "FUNDED", "EVIDENCE_SUBMITTED", "READY_TO_RELEASE"].includes(agreement.state)} onClick={() => void onAction(agreement.state === "AWAITING_FUNDING" ? "fund" : agreement.state === "FUNDED" ? "evidence" : agreement.state === "EVIDENCE_SUBMITTED" ? "review" : "release")}>{nextAction(agreement.state)}</button></section><section className="detail-card"><SectionTitle title="Lifecycle" kicker="Agreement state" /><Lifecycle state={agreement.state} /></section><section className="detail-card"><SectionTitle title="Evidence and review" kicker="AI observation · deterministic gate" />{detail?.manifest ? <EvidenceReview manifest={detail.manifest} review={review} observation={observation} decision={detail.decision} /> : <EmptyState title="No evidence manifest" copy="Evidence has not been submitted for this agreement." />}</section><section className="detail-card"><SectionTitle title="Audit trail" kicker="Append-only integrity" /><AuditTrail events={detail?.audit ?? []} /></section></div><aside className="detail-sidebar"><section className="detail-card terms-card"><SectionTitle title="Terms" kicker="Immutable agreement" /><InfoRow label="Amount" value={`${formatUnits(agreement.amountBaseUnits)} XLAY`} /><InfoRow label="Deadline" value={formatDate(agreement.deadline)} /><InfoRow label="Payer" value={shortAddress(agreement.payer)} mono /><InfoRow label="Recipient" value={shortAddress(agreement.recipient)} mono /><InfoRow label="Policy" value={agreement.policy.version} /><InfoRow label="Policy hash" value={shortHash(agreement.policyHash)} mono /></section><section className="detail-card"><SectionTitle title="Vault status" kicker="X Layer settlement" />{detail?.chain ? <VaultCard chain={detail.chain} walletAddress={walletAddress} walletBusy={walletBusy} walletError={walletError} walletChainId={walletChainId} settlementStage={settlementStage} settlementHash={settlementHash} onConnect={onConnect} onSwitchNetwork={onSwitchNetwork} onReviewRelease={onReviewRelease} /> : <div className="not-configured"><span>◌</span><b>Awaiting vault connection</b><p>Configure <code>PROOFFLOW_VAULT_ADDRESS</code> to verify the onchain terms and preview safe transactions.</p></div>}</section></aside></div></section>; }
function SectionTitle({ title, kicker }: { title: string; kicker: string }) { return <div className="section-title"><span>{kicker}</span><h3>{title}</h3></div>; }
function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) { return <div className="info-row"><span>{label}</span><strong className={mono ? "mono" : ""}>{value}</strong></div>; }
function StateBadge({ state }: { state: Agreement["state"] }) { return <span className={`state-badge ${stateTone(state)}`}><span aria-hidden="true">{stateIcon(state)}</span>{stateLabel(state)}</span>; }
function Lifecycle({ state }: { state: Agreement["state"] }) { const steps: Agreement["state"][] = [JobState.AWAITING_FUNDING, JobState.FUNDED, JobState.EVIDENCE_SUBMITTED, JobState.UNDER_REVIEW, JobState.READY_TO_RELEASE, JobState.RELEASED]; const index = state === JobState.REVIEWED ? 4 : steps.indexOf(state); return <div className="lifecycle" aria-label="Agreement lifecycle">{steps.map((step, i) => <div className={`lifecycle-step ${i < index ? "complete" : i === index ? "current" : ""}`} key={step}><span>{i < index ? "✓" : i + 1}</span><small>{lifecycleLabel(step)}</small></div>)}</div>; }
function EvidenceReview({ manifest, review, observation, decision }: { manifest: EvidenceManifest; review: ReviewRun | null | undefined; observation: ReviewRun["observation"] | undefined; decision: PolicyDecision | null }) { const tone = decision?.outcome === "PASS" ? "pass" : decision?.outcome === "BLOCK" ? "danger" : "warning"; return <div className="evidence-review"><div className="evidence-summary"><div className={`summary-icon ${tone}`}>{decision?.outcome === "BLOCK" ? "!" : "✓"}</div><div><b>{review ? "AI observation complete" : "Evidence manifest received"}</b><p>{review ? `Structured observations from ${review.provider.model}. Advisory only.` : "Waiting for a bounded review run."}</p></div>{review && <span className="confidence-value">{(review.observation.confidenceBps / 100).toFixed(0)}%<small>confidence</small></span>}</div><div className="trust-boundary"><span>AI observes</span><i>→</i><span className="policy-chip">Policy decides</span><i>→</i><span className={`${tone}-chip`}>{decision?.outcome ?? "Awaiting gate"}</span></div><div className="evidence-list">{manifest.items.map((item) => <div className="evidence-item" key={item.sha256}><span className="file-icon">□</span><span><b>{item.name}</b><small>{item.type} · {item.mediaType}</small></span><code>{shortHash(item.sha256)}</code><span className="pass-text">✓ verified</span></div>)}</div>{observation && <div className="facts"><span className="eyebrow">Extracted facts</span>{observation.extractedFacts.map((fact) => <div className="fact" key={`${fact.key}-${fact.source}`}><b>{fact.key}</b><span>{fact.value}</span><small>Source: {fact.source}</small></div>)}</div>}{decision && <div className="decision-box"><div><span className="eyebrow">Deterministic gate · {decision.policyVersion}</span><b>{decision.outcome === "PASS" ? "Release conditions pass" : decision.outcome === "BLOCK" ? "Release blocked" : "Human review required"}</b></div><span className="mono">{shortHash(decision.policyHash)}</span>{decision.reasons.length > 0 && <ul>{decision.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}</div>}</div>; }
function AuditTrail({ events }: { events: AuditEvent[] }) { return events.length ? <div className="audit-list">{events.slice().reverse().map((event) => <div className="audit-item" key={event.id}><span className="audit-dot" /><div><b>{event.eventType.replaceAll("_", " ")}</b><p>{event.actor} · {relativeTime(event.occurredAt)}</p></div><code>{shortHash(event.eventHash)}</code></div>)}</div> : <EmptyState title="No audit events yet" copy="Lifecycle events will appear here as this agreement changes." />; }
function VaultCard({ chain, walletAddress, walletBusy, walletError, walletChainId, settlementStage, settlementHash, onConnect, onSwitchNetwork, onReviewRelease }: { chain: ChainPreview; walletAddress: string | null; walletBusy: boolean; walletError: string | null; walletChainId: number | null; settlementStage: SettlementStage; settlementHash: string | null; onConnect: () => void; onSwitchNetwork: () => void; onReviewRelease: () => void }) { const expectedChainId = Number(import.meta.env.VITE_XLAYER_CHAIN_ID ?? XLAYER_TESTNET_CHAIN_ID); const release = chain.transactions.release; const canReview = chain.vault.funded && !chain.vault.released; const stageCopy: Record<SettlementStage, string> = { idle: "", preparing: "Checking the exact intent and network.", ready: "Ready for your review.", awaiting_wallet: "Confirm the exact transaction in OKX Wallet.", submitted: "Transaction submitted; receipt not final yet.", confirming: "ProofFlow is checking the receipt and release event.", confirmed: "Verified receipt reconciled on X Layer.", failed: "The chain did not confirm this release.", unknown: "Confirmation uncertain. Refresh before retrying." }; const copy = (value: string) => void navigator.clipboard?.writeText(value); return <div className="vault-card"><div className="vault-state"><span className={`status-dot ${chain.vault.released ? "online" : chain.vault.funded ? "online" : ""}`} /><div><b>{chain.vault.released ? "Released" : chain.vault.funded ? "Funded" : "Awaiting funding"}</b><small>{chain.vault.released ? "Final receipt reconciled" : chain.vault.funded ? "Funds held by the vault" : "Fund the agreement to continue"}</small></div><span className="chain-chip">CHAIN {chain.network.chainId}</span></div><InfoRow label="Vault" value={shortAddress(chain.vault.address)} mono /><InfoRow label="Balance" value={`${formatUnits(chain.vault.balance)} XLAY`} /><div className="preview-block"><div className="preview-heading"><span className="eyebrow">Exact settlement intent</span><span className="intent-lock">No opaque signing</span></div><div className="tx-preview featured"><div className="tx-preview-heading"><div><span className="eyebrow">Native release</span><b>{formatUnits(release.value)} XLAY to recipient</b></div><span className="tx-safety">Reviewable</span></div><div className="tx-facts"><InfoRow label="Recipient" value={shortAddress(chain.vault.recipient)} mono /><InfoRow label="Vault contract" value={shortAddress(release.to)} mono /><InfoRow label="Network" value={`X Layer testnet · ${chain.network.chainId}`} /><InfoRow label="Calldata" value={shortHash(release.data)} mono /></div><details className="technical-details"><summary>Inspect calldata and full addresses</summary><div className="technical-body"><InfoRow label="To" value={release.to} mono /><InfoRow label="Data" value={release.data} mono /><button className="copy-button" onClick={() => copy(JSON.stringify(release, null, 2))}>Copy transaction JSON</button></div></details><p className="tx-disclaimer">ProofFlow prepares this exact request. OKX Wallet shows it before you approve. A signature is not a confirmed payment.</p>{canReview && <button className="button primary full-button" disabled={walletBusy} onClick={onReviewRelease}>Review release in OKX Wallet</button>}</div></div><div className="wallet-connection"><div className="wallet-connection-top"><div><span className="eyebrow">Authorization boundary</span><b>{walletAddress ? `OKX Wallet · ${shortAddress(walletAddress)}` : "OKX Wallet not connected"}</b><small>{walletAddress ? walletChainId === expectedChainId ? "On X Layer testnet" : "Wrong network" : "Only your wallet can authorize funds"}</small></div><span className={`wallet-check ${walletAddress && walletChainId === expectedChainId ? "ok" : ""}`}>{walletAddress && walletChainId === expectedChainId ? "✓" : "—"}</span></div>{walletError && <div className="wallet-error" role="alert">{walletError}</div>}{walletAddress && walletChainId !== expectedChainId ? <button className="button secondary full-button" onClick={onSwitchNetwork}>Switch OKX Wallet to X Layer</button> : <button className="button secondary full-button" onClick={onConnect}>{walletAddress ? "Reconnect OKX Wallet" : "Connect OKX Wallet"}</button>}{settlementStage !== "idle" && <div className={`settlement-status ${settlementStage}`} role="status" aria-live="polite"><span className="stage-marker">{stageIcon(settlementStage)}</span><div><b>{stageTitle(settlementStage)}</b><small>{stageCopy[settlementStage]}{settlementHash ? ` · ${shortHash(settlementHash)}` : ""}</small></div></div>}</div></div>; }
function ReleaseModal({ agreement, chain, decision, manifest, walletAddress, walletChainId, walletBusy, walletError, stage, transactionHash, onClose, onConnect, onSwitchNetwork, onAuthorize }: { agreement: Agreement; chain: ChainPreview; decision: PolicyDecision | null; manifest: EvidenceManifest | null; walletAddress: string | null; walletChainId: number | null; walletBusy: boolean; walletError: string | null; stage: SettlementStage; transactionHash: string | null; onClose: () => void; onConnect: () => void; onSwitchNetwork: () => void; onAuthorize: () => void }) { const expectedChainId = Number(import.meta.env.VITE_XLAYER_CHAIN_ID ?? XLAYER_TESTNET_CHAIN_ID); const [detailsOpen, setDetailsOpen] = useState(false); const signed = ["submitted", "confirming", "confirmed", "unknown"].includes(stage); const canAuthorize = detailsOpen && Boolean(walletAddress) && walletChainId === expectedChainId && !walletBusy && !signed; return <Modal title={signed ? stageTitle(stage) : "Ready to release"} eyebrow={signed ? "Settlement lifecycle" : "Human authorization required"} onClose={signed ? () => undefined : onClose} closeDisabled={signed}><div className="release-modal"><div className="release-lead"><span className="state-mark large pass">✓</span><div><b>{signed ? stageCopy(stage) : "Review the exact transaction before signing."}</b><p>{signed ? (transactionHash ? `Transaction ${shortHash(transactionHash)} is being tracked.` : "ProofFlow is tracking the settlement state.") : "This action is irreversible once the vault accepts it."}</p></div></div><div className="release-summary"><InfoRow label="Agreement" value={agreement.title} /><InfoRow label="Amount" value={`${formatUnits(chain.transactions.release.value)} XLAY`} /><InfoRow label="Recipient" value={chain.vault.recipient} mono /><InfoRow label="Network" value={`X Layer testnet · chain ${chain.network.chainId}`} /><InfoRow label="Vault contract" value={chain.vault.address} mono /></div><details className="technical-details comprehension" open={detailsOpen} onToggle={(event) => setDetailsOpen((event.currentTarget as HTMLDetailsElement).open)}><summary>I understand what will be authorized</summary><div className="technical-body"><p className="form-note">The transaction releases the displayed amount from the displayed vault to the displayed recipient. ProofFlow cannot change the recipient or amount after this preview.</p><InfoRow label="Evidence manifest" value={manifest ? shortHash(manifest.manifestHash) : "Not available"} mono /><InfoRow label="Policy" value={decision ? `${decision.policyVersion} · ${shortHash(decision.policyHash)}` : "Not available"} mono /></div></details>{walletError && <div className="form-error" role="alert">{walletError}</div>}{!walletAddress ? <button className="button secondary full-button" onClick={onConnect}>Connect OKX Wallet</button> : walletChainId !== expectedChainId ? <button className="button secondary full-button" onClick={onSwitchNetwork}>Switch OKX Wallet to X Layer</button> : null}<div className="modal-actions"><button type="button" className="button secondary" onClick={onClose} disabled={signed}>Cancel</button><button type="button" className="button primary" disabled={!canAuthorize} onClick={onAuthorize}>{walletBusy ? "Waiting for OKX Wallet…" : signed ? stageTitle(stage) : "Authorize release in OKX Wallet"}</button></div></div></Modal>; }
function SkeletonRows() { return <div className="skeleton-rows" aria-label="Loading"><span /><span /><span /></div>; }
function EmptyState({ title, copy }: { title: string; copy: string }) { return <div className="empty-state"><span>○</span><b>{title}</b><p>{copy}</p></div>; }
function AppErrorBoundary({ children }: { children: ReactNode }) { return <>{children}</>; }

function Modal({ title, eyebrow, onClose, closeDisabled = false, children }: { title: string; eyebrow: string; onClose: () => void; closeDisabled?: boolean; children: ReactNode }) { const modalRef = useRef<HTMLElement | null>(null); useEffect(() => { const previous = document.activeElement as HTMLElement | null; modalRef.current?.querySelector<HTMLElement>("button, input, select, textarea, summary")?.focus(); const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !closeDisabled) onClose(); }; document.addEventListener("keydown", onKey); return () => { document.removeEventListener("keydown", onKey); previous?.focus?.(); }; }, [closeDisabled, onClose]); return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !closeDisabled) onClose(); }}><section className="modal" ref={modalRef} role="dialog" aria-modal="true" aria-labelledby="modal-title"><button className="modal-close" aria-label="Close dialog" disabled={closeDisabled} onClick={onClose}>×</button><span className="eyebrow">{eyebrow}</span><h2 id="modal-title">{title}</h2>{children}</section></div>; }
function ModalActions({ onClose, busy, submitLabel }: { onClose: () => void; busy: boolean; submitLabel: string }) { return <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button type="submit" className="button primary" disabled={busy}>{busy ? "Working…" : submitLabel}</button></div>; }
function Field({ label, value, onChange, placeholder, required = false, textarea = false, select = false, options = [], type = "text" }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; required?: boolean; textarea?: boolean; select?: boolean; options?: string[]; type?: string }) { return <label className="field"><span>{label}</span>{select ? <select value={value} onChange={(event) => onChange(event.target.value)} required={required}>{options.map((option) => <option value={option} key={option}>{option.replaceAll("_", " ")}</option>)}</select> : textarea ? <textarea value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} required={required} rows={3} /> : <input type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} required={required} />}</label>; }

function formatUnits(value: string | bigint) { const raw = BigInt(value); const units = Number(raw) / 1e18; return units >= 1 ? units.toLocaleString("en-US", { maximumFractionDigits: 4 }) : raw.toString(); }
function shortAddress(value: string) { return value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "—"; }
function shortHash(value: string) { return value ? `${value.slice(0, 10)}…${value.slice(-8)}` : "—"; }
function formatDate(value: string) { return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); }
function relativeTime(value: string) { const diff = Date.now() - new Date(value).getTime(); const minutes = Math.max(1, Math.round(diff / 60000)); return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`; }
function stateLabel(state: Agreement["state"]) { return state.replaceAll("_", " ").toLowerCase().replace(/(^| )\S/g, (letter) => letter.toUpperCase()); }
function lifecycleLabel(state: Agreement["state"]) { const labels: Partial<Record<Agreement["state"], string>> = { AWAITING_FUNDING: "Terms published", FUNDED: "Vault funded", EVIDENCE_SUBMITTED: "Evidence submitted", UNDER_REVIEW: "AI review", READY_TO_RELEASE: "Wallet authorization", RELEASED: "X Layer confirmed" }; return labels[state] ?? stateLabel(state); }
function stateIcon(state: Agreement["state"]) { return ["READY_TO_RELEASE", "RELEASED", "FUNDED"].includes(state) ? "✓" : ["BLOCKED", "DISPUTED"].includes(state) ? "!" : ["UNDER_REVIEW", "EVIDENCE_SUBMITTED"].includes(state) ? "◌" : "·"; }
function stateTone(state: Agreement["state"]) { return state === "READY_TO_RELEASE" || state === "RELEASED" || state === "FUNDED" ? "pass" : state === "BLOCKED" || state === "DISPUTED" ? "danger" : state === "UNDER_REVIEW" || state === "EVIDENCE_SUBMITTED" ? "warning" : "pending"; }
function stateTitle(state: Agreement["state"]) { return state === "READY_TO_RELEASE" ? "Ready to release" : stateLabel(state); }
function stateCopy(state: Agreement["state"]) { const copy: Partial<Record<Agreement["state"], string>> = { READY_TO_RELEASE: "Evidence is present, the review is complete, and deterministic policy conditions pass. Review the exact release before signing.", UNDER_REVIEW: "A human should inspect the review result before any settlement intent is created.", AWAITING_FUNDING: "Fund the vault before the recipient can submit evidence.", EVIDENCE_SUBMITTED: "Evidence is ready for a bounded AI review.", RELEASED: "The settlement has been confirmed by the protocol." }; return copy[state] ?? "ProofFlow is waiting for the next valid lifecycle event."; }
function nextAction(state: Agreement["state"]) { return state === "AWAITING_FUNDING" ? "Fund agreement" : state === "FUNDED" ? "Submit evidence" : state === "EVIDENCE_SUBMITTED" ? "Run review" : state === "READY_TO_RELEASE" ? "Review release" : "Inspect details"; }
function priorityReason(state: Agreement["state"]) { return state === "BLOCKED" ? "Blocked — inspect policy" : state === "DISPUTED" ? "Disputed — review" : state === "UNDER_REVIEW" ? "Human review needed" : state === "EVIDENCE_SUBMITTED" ? "Run policy review" : state === "AWAITING_FUNDING" ? "Fund vault" : "Monitor settlement"; }
function sortPriority(agreements: Agreement[]) { const weight: Record<string, number> = { BLOCKED: 0, DISPUTED: 1, UNDER_REVIEW: 2, EVIDENCE_SUBMITTED: 3, AWAITING_FUNDING: 4, READY_TO_RELEASE: 5, RELEASED: 6 }; return [...agreements].sort((a, b) => (weight[a.state] ?? 9) - (weight[b.state] ?? 9)); }
function stageTitle(stage: SettlementStage) { const labels: Record<SettlementStage, string> = { idle: "Settlement idle", preparing: "Preparing settlement", ready: "Ready for review", awaiting_wallet: "Confirm in OKX Wallet", submitted: "Submitted to X Layer", confirming: "Confirming receipt", confirmed: "Verified on X Layer", failed: "Settlement failed", unknown: "Confirmation uncertain" }; return labels[stage]; }
function stageCopy(stage: SettlementStage) { const copy: Record<SettlementStage, string> = { idle: "", preparing: "Checking the exact intent and network.", ready: "Ready for your review.", awaiting_wallet: "Confirm the exact transaction in OKX Wallet.", submitted: "Transaction submitted; receipt not final yet.", confirming: "ProofFlow is checking the receipt and release event.", confirmed: "Verified receipt reconciled on X Layer.", failed: "The chain did not confirm this release.", unknown: "Confirmation uncertain. Refresh before retrying." }; return copy[stage]; }
function stageIcon(stage: SettlementStage) { return stage === "confirmed" ? "✓" : stage === "failed" ? "!" : stage === "unknown" ? "?" : stage === "submitted" || stage === "confirming" ? "◌" : "·"; }

createRoot(document.getElementById("root")!).render(<StrictMode><AppErrorBoundary><App /></AppErrorBoundary></StrictMode>);

function CreateAgreementModal({ onClose, onCreated }: { onClose: () => void; onCreated: (agreement: Agreement) => Promise<void> }) {
  const [draft, setDraft] = useState<AgreementDraft>({ title: "", description: "", payer: "0x0000000000000000000000000000000000000001", recipient: "0x0000000000000000000000000000000000000002", tokenAddress: "0x0000000000000000000000000000000000000003", amountBaseUnits: "1000000000000000000", deadline: "2026-09-30T17:00:00.000Z", evidenceType: "invoice" });
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  function update(key: keyof AgreementDraft, value: string) { setDraft((current) => ({ ...current, [key]: value })); }
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); setError(null); const body = { title: draft.title, description: draft.description, payer: draft.payer, recipient: draft.recipient, tokenAddress: draft.tokenAddress, amountBaseUnits: draft.amountBaseUnits, deadline: new Date(draft.deadline).toISOString(), policy: { version: "proof-v1", requiredEvidence: [draft.evidenceType], minimumConfidenceBps: 9000, releaseAmountBaseUnits: draft.amountBaseUnits, deadline: new Date(draft.deadline).toISOString() } }; try { const agreement = await api<Agreement>("/api/v1/agreements", { method: "POST", body: JSON.stringify(body) }); await onCreated(agreement); } catch (cause) { setError(cause instanceof Error ? cause.message : "Agreement could not be created."); } finally { setBusy(false); } }
  return <Modal title="Create agreement" eyebrow="New trust commitment" onClose={onClose}><form className="modal-form" onSubmit={(event) => void submit(event)}><Field label="Title" value={draft.title} placeholder="e.g. Website launch — milestone 01" onChange={(value) => update("title", value)} required /><Field label="Description" value={draft.description} placeholder="What must be true before release?" onChange={(value) => update("description", value)} textarea /><div className="form-grid"><Field label="Amount (base units)" value={draft.amountBaseUnits} onChange={(value) => update("amountBaseUnits", value)} required /><Field label="Deadline" value={draft.deadline.slice(0, 16)} type="datetime-local" onChange={(value) => update("deadline", value)} required /></div><div className="form-grid"><Field label="Payer address" value={draft.payer} onChange={(value) => update("payer", value)} required /><Field label="Recipient address" value={draft.recipient} onChange={(value) => update("recipient", value)} required /></div><Field label="Required evidence" value={draft.evidenceType} select options={["invoice", "purchase_order", "signed_approval", "delivery_receipt", "status_update"]} onChange={(value) => update("evidenceType", value as EvidenceType)} /><p className="form-note">The policy is hashed at creation. ProofFlow will not create an onchain vault until the agreement terms are verified.</p>{error && <div className="form-error">{error}</div>}<ModalActions onClose={onClose} busy={busy} submitLabel="Create agreement" /></form></Modal>;
}

function EvidenceModal({ agreement, onClose, onSubmitted }: { agreement: Agreement; onClose: () => void; onSubmitted: () => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null); const [type, setType] = useState<EvidenceType>(agreement.policy.requiredEvidence[0] ?? "status_update"); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) { event.preventDefault(); if (!file) { setError("Choose an evidence file before submitting."); return; } setBusy(true); setError(null); const form = new FormData(); form.set("evidenceType", type); form.set("submittedBy", agreement.recipient); form.set("file", file); try { await api(`/api/v1/agreements/${agreement.id}/evidence/upload`, { method: "POST", body: form, headers: {} }); await onSubmitted(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Evidence could not be uploaded."); } finally { setBusy(false); } }
  return <Modal title="Upload evidence" eyebrow={`${agreement.title} · scanned ingestion`} onClose={onClose}><form className="modal-form" onSubmit={(event) => void submit(event)}><Field label="Evidence type" value={type} select options={agreement.policy.requiredEvidence} onChange={(value) => setType(value as EvidenceType)} /><label className="field"><span>Evidence file</span><input type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} required /></label><div className="upload-note"><b>Controlled intake</b><p>ProofFlow validates the type, hashes the bytes, and scans before the evidence joins the manifest. Instructions inside documents are treated as untrusted content, never as system rules.</p></div>{error && <div className="form-error" role="alert">{error}</div>}<ModalActions onClose={onClose} busy={busy} submitLabel="Scan and submit evidence" /></form></Modal>;
}
