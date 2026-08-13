import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Analytics } from "@vercel/analytics/react";
import { AppKitProvider, useAppKitAccount, useAppKitProvider } from "@reown/appkit/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { walletAppKit, walletConfigurationMissing, asEip1193Provider, switchToXLayer, XLAYER_TESTNET_CHAIN_ID, wagmiConfig } from "./wallet";
import AnimatedContent from "./components/motion/AnimatedContent";
import BlurText from "./components/motion/BlurText";
import CountUp from "./components/motion/CountUp";
import SpotlightCard from "./components/motion/SpotlightCard";
import DepthCarousel from "./components/motion/DepthCarousel";
import TrustGrid from "./components/backgrounds/TrustGrid";
import ProofNetworkField from "./components/backgrounds/ProofNetworkField";
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
type Eip1193Provider = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown>; on?: (event: string, handler: (...args: unknown[]) => void) => void; removeListener?: (event: string, handler: (...args: unknown[]) => void) => void; isOkxWallet?: boolean; providers?: Eip1193Provider[] };
type WalletStatus = "idle" | "connecting" | "connected" | "wrong_network" | "rejected" | "unavailable" | "error";
type ChainPreview = { agreementId: string; network: { chainId: number; rpcUrl: string }; vault: VaultSnapshot; transactions: { fund: TransactionPreview; commitEvidence: TransactionPreview | null; release: TransactionPreview } };
type AgreementDetail = { agreement: Agreement; manifest: EvidenceManifest | null; reviewRun: ReviewRun | null; decision: PolicyDecision | null; audit: AuditEvent[]; chain: ChainPreview | null; chainError: string | null };
type AgreementDraft = { title: string; description: string; payer: string; recipient: string; tokenAddress: string; amountBaseUnits: string; deadline: string; evidenceTypes: EvidenceType[]; minimumConfidenceBps: number; releaseAmountBaseUnits: string; policyVersion: string };
type SettlementStage = "idle" | "preparing" | "ready" | "awaiting_wallet" | "submitted" | "confirming" | "confirmed" | "failed" | "unknown";
type View = "landing" | "overview" | "agreements" | "review" | "activity" | "wallet" | "settings";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "/api-proxy";

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
  const requestPath = API_BASE === "/api-proxy" ? `${API_BASE}${path.replace(/^\/api/, "")}` : `${API_BASE}${path}`;
  const response = await fetch(requestPath, { ...init, headers });
  const body = await response.json() as ApiEnvelope<T>;
  if (!response.ok || body.error) {
    const error = new Error(body.error?.message ?? `Request failed (${response.status})`) as Error & { fields?: Record<string, string[]> };
    if (body.error && "fields" in body.error) error.fields = (body.error as typeof body.error & { fields?: Record<string, string[]> }).fields;
    throw error;
  }
  return body.data as T;
}

function getViewFromHash(): View {
  const hash = window.location.hash;
  if (!hash || hash.startsWith("#landing")) return "landing";
  if (hash.startsWith("#agreements")) return "agreements";
  if (hash.startsWith("#review")) return "review";
  if (hash.startsWith("#activity")) return "activity";
  if (hash.startsWith("#wallet")) return "wallet";
  if (hash.startsWith("#settings")) return "settings";
  return "overview";
}

function isUserRejected(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: number }).code : undefined;
  return code === 4001 || code === 300;
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
  const { walletProvider: appKitProvider } = useAppKitProvider<Eip1193Provider>("eip155");
  const { address: appKitAddress, isConnected: appKitConnected } = useAppKitAccount({ namespace: "eip155" });
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [walletStatus, setWalletStatus] = useState<WalletStatus>("idle");
  const [settlementStage, setSettlementStage] = useState<SettlementStage>("idle");
  const [settlementHash, setSettlementHash] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "info" | "success" | "danger"; text: string } | null>(null);
  const [resetting, setResetting] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [activeView, setActiveView] = useState<View>(() => getViewFromHash());
  const [searchQuery, setSearchQuery] = useState("");
  const [stateFilter, setStateFilter] = useState("ALL");

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
    const address = appKitConnected ? appKitAddress ?? null : null;
    setWalletAddress(address);
    if (!address) {
      setWalletChainId(null);
      setWalletStatus("idle");
      return;
    }
    const provider = asEip1193Provider(appKitProvider);
    if (!provider) {
      setWalletStatus("unavailable");
      setWalletError("The connected wallet provider is unavailable. Please reconnect.");
      return;
    }
    void provider.request({ method: "eth_chainId" }).then((value) => {
      const chainId = typeof value === "string" ? Number.parseInt(value, 16) : Number(value);
      setWalletChainId(chainId);
      setWalletStatus(chainId === XLAYER_TESTNET_CHAIN_ID ? "connected" : "wrong_network");
      setWalletError(null);
    }).catch(() => {
      setWalletStatus("error");
      setWalletError("Unable to read the connected wallet network.");
    });
  }, [appKitAddress, appKitConnected, appKitProvider]);
  useEffect(() => { if (selectedId) void loadDetail(selectedId); }, [selectedId, loadDetail]);
  useEffect(() => {
    const onHashChange = () => setActiveView(getViewFromHash());
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener("popstate", onHashChange);
    return () => { window.removeEventListener("hashchange", onHashChange); window.removeEventListener("popstate", onHashChange); };
  }, []);

  const selected = detail?.agreement ?? agreements.find((item) => item.id === selectedId) ?? null;
  const attention = agreements.filter((item) => ["BLOCKED", "DISPUTED", "UNDER_REVIEW", "EVIDENCE_SUBMITTED", "AWAITING_FUNDING"].includes(item.state)).length;
  const reviewQueue = agreements.filter((item) => ["UNDER_REVIEW", "EVIDENCE_SUBMITTED"].includes(item.state)).length;
  const escrow = agreements.filter((item) => item.state !== "RELEASED").reduce((sum, item) => sum + BigInt(item.amountBaseUnits || "0"), 0n);
  const statusLabel = network ? `X Layer ${network.chainId === 196 ? "mainnet" : "testnet"}` : "X Layer offline";
  const lifecycleStage = selected ? lifecycleStageFor(selected.state) : "No agreement selected";
  const selectedDecision = detail?.decision?.outcome ?? "Awaiting review";
  const filteredAgreements = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return agreements.filter((agreement) => {
      const matchesQuery = !query || [agreement.title, agreement.id, agreement.recipient, agreement.payer, agreement.state].some((value) => value.toLowerCase().includes(query));
      return matchesQuery && (stateFilter === "ALL" || agreement.state === stateFilter);
    });
  }, [agreements, searchQuery, stateFilter]);
  const reviewAgreements = useMemo(() => sortPriority(agreements.filter((agreement) => ["EVIDENCE_SUBMITTED", "UNDER_REVIEW", "REVIEWED", "READY_TO_RELEASE"].includes(agreement.state))), [agreements]);
  const detailPanel = selected ? <DetailPanel detail={detail} loading={detailLoading} onAction={simulate} walletAddress={walletAddress} walletBusy={walletBusy} walletError={walletError} walletChainId={walletChainId} settlementStage={settlementStage} settlementHash={settlementHash} onConnect={() => void connectWallet()} onSwitchNetwork={() => void switchWalletNetwork()} onReviewRelease={() => setReleaseOpen(true)} /> : null;

  async function refresh() { await Promise.all([loadAgreements(), loadNetwork()]); if (selectedId) await loadDetail(selectedId); }
  async function handleCreated(agreement: Agreement) { setCreateOpen(false); setNotice({ kind: "success", text: `Agreement ${agreement.id} created and awaiting funding.` }); await loadAgreements(); setSelectedId(agreement.id); await loadDetail(agreement.id); }
  async function handleEvidenceSubmitted() { setEvidenceOpen(false); setNotice({ kind: "success", text: "Evidence manifest submitted and hashed into the audit trail." }); await refresh(); }
  async function resetDemo() { setResetting(true); try { await api("/api/v1/demo/reset", { method: "POST" }); setNotice({ kind: "success", text: "Demo workspace reset. The seeded agreement is ready to inspect." }); await loadAgreements(); } catch (error) { setNotice({ kind: "danger", text: error instanceof Error ? error.message : "Demo reset failed." }); } finally { setResetting(false); } }

  async function connectWallet() {
    if (walletBusy) return;
    setWalletError(null);
    if (walletConfigurationMissing) {
      setWalletStatus("unavailable");
      setWalletError("Wallet connections are not configured for this deployment.");
      return;
    }
    setWalletBusy(true);
    setWalletStatus("connecting");
    try {
      await walletAppKit.open({ view: "Connect", namespace: "eip155" });
      setNotice({ kind: "info", text: "Choose a wallet to connect to ProofFlow." });
    } catch (error) {
      if (isUserRejected(error)) {
        setWalletStatus("rejected");
        setWalletError("Connection cancelled.");
      } else {
        console.error("ProofFlow wallet connection failed", error);
        setWalletStatus("error");
        setWalletError("Unable to connect. Please try again.");
      }
    } finally {
      setWalletBusy(false);
    }
  }

  async function switchWalletNetwork() {
    if (walletBusy) return;
    setWalletError(null);
    const provider = asEip1193Provider(appKitProvider);
    if (!provider) { setWalletStatus("unavailable"); setWalletError("Wallet provider unavailable. Reconnect your wallet before switching networks."); return; }
    setWalletBusy(true);
    try { await switchToXLayer(provider); setWalletChainId(XLAYER_TESTNET_CHAIN_ID); setWalletStatus("connected"); setNotice({ kind: "success", text: "Wallet switched to X Layer testnet." }); }
    catch (error) { setWalletStatus(isUserRejected(error) ? "wrong_network" : "error"); setWalletError(isUserRejected(error) ? "Network switch was cancelled." : error instanceof Error ? error.message : "Unable to switch network. Please try again."); }
    finally { setWalletBusy(false); }
  }

  async function authorizeRelease(agreementId: string) {
    const provider = asEip1193Provider(appKitProvider);
    if (!provider) { setWalletError("Wallet provider unavailable. Reconnect your wallet before authorizing settlement."); return; }
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
      if (confirmedChainId !== expectedChainId) throw new Error(`Wallet is on chain ${confirmedChainId}. Switch to X Layer testnet before continuing.`);
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

  function navigate(view: View) {
    window.history.pushState({}, "", view === "landing" ? window.location.pathname : `#${view}`);
    setActiveView(view);
    setMobileNavOpen(false);
  }

  const pageTitle = activeView === "overview" ? "Overview" : activeView === "agreements" ? "Agreements" : activeView === "review" ? "Review queue" : activeView === "activity" ? "Activity" : activeView === "wallet" ? "Wallet" : "Settings";
  const pageDescription = activeView === "overview" ? "A calm command center for commitments that need evidence, judgment, and settlement." : activeView === "agreements" ? "Search every commitment and open the exact terms behind it." : activeView === "review" ? "Make the next decision with evidence, policy, and uncertainty in view." : activeView === "activity" ? "A verifiable record of every meaningful workflow event." : activeView === "wallet" ? "Review network health and keep authorization at the human boundary." : "Control the workspace environment without changing the protocol rules.";
  const pageContent = activeView === "overview" ? <>
    <section className="page-heading hero-stage"><ProofNetworkField className="hero-network-field" dotSize={2} gap={32} baseColor="#536272" activeColor="#7dd3fc" proximity={120} /><TrustGrid /><div className="hero-glow" aria-hidden="true" /><AnimatedContent className="hero-copy"><div className="eyebrow">Verifiable work · programmable trust · {statusLabel}</div><h2><BlurText>Trust the evidence.<br />Not the promise.</BlurText></h2><p>ProofFlow verifies milestone evidence, enforces deterministic release policies, and prepares settlement on X Layer.</p><div className="hero-proof"><span className="hero-proof-dot" aria-hidden="true" /><span>Every release is reviewable before it is irreversible.</span></div></AnimatedContent><div className="heading-actions"><button className="button secondary" onClick={() => navigate("agreements")}>Open console <span aria-hidden="true">→</span></button><button className="button primary" onClick={() => setCreateOpen(true)}>Create agreement <span aria-hidden="true">↗</span></button></div></section>
    <section className="mission-strip" aria-label="Selected agreement progress"><div className="mission-copy"><span className="eyebrow">Current execution lane</span><strong>{selected ? selected.title : "No agreement selected"}</strong><small>{selected ? lifecycleStage : "Create an agreement to begin a verifiable workflow."}</small></div><div className="mission-steps" aria-label="Agreement, evidence, review, settlement"><span className="is-active">01 <b>Agreement</b></span><i>→</i><span className={selected && ["EVIDENCE_SUBMITTED","UNDER_REVIEW","REVIEWED","READY_TO_RELEASE","RELEASED"].includes(selected.state) ? "is-active" : ""}>02 <b>Evidence</b></span><i>→</i><span className={selected && ["UNDER_REVIEW","REVIEWED","READY_TO_RELEASE","RELEASED"].includes(selected.state) ? "is-active" : ""}>03 <b>Review</b></span><i>→</i><span className={selected && ["READY_TO_RELEASE","RELEASED"].includes(selected.state) ? "is-active" : ""}>04 <b>Settlement</b></span></div><span className={`mission-decision ${selectedDecision === "PASS" ? "pass" : selectedDecision === "BLOCK" ? "danger" : "pending"}`}>{selectedDecision}</span></section>
    <section className="metric-grid motion-stagger" aria-label="Workspace summary"><Metric label="Needs attention" value={String(attention)} detail="Blocked, pending, or waiting" tone={attention > 0 ? "lime" : ""} numeric={attention} /><Metric label="Active escrow" value={`${formatUnits(escrow)} XLAY`} detail="Unsettled agreement value" tone="dark" /><Metric label="Review queue" value={String(reviewQueue)} detail="Evidence awaiting a decision" numeric={reviewQueue} /><Metric label="Network health" value={network ? "Online" : "Offline"} detail={network ? "X Layer RPC responding" : "Last check unavailable"} /></section>
    <section className="protocol-section" aria-labelledby="why-proofflow"><div className="protocol-section-header"><span className="eyebrow">Protocol primitives</span><h3 id="why-proofflow">Why trust execution through ProofFlow?</h3><p>Every milestone follows the same accountable path: requirement, evidence, policy, authorization, settlement, receipt.</p></div><div className="protocol-feature-grid"><article className="protocol-feature-card"><div className="protocol-feature-topline"><span>01 · EVIDENCE</span><b>COMMITTED</b></div><h4>Evidence before release</h4><p>Payment eligibility depends on submitted and reviewed evidence—not an unverified promise.</p><div className="protocol-feature-meter"><i style={{ width: "88%" }} /><span>Typed manifest · canonical hash</span></div></article><article className="protocol-feature-card"><div className="protocol-feature-topline"><span>02 · POLICY</span><b>DETERMINISTIC</b></div><h4>Deterministic policy gates</h4><p>Release conditions are evaluated explicitly, with blocked reasons kept visible for review.</p><div className="protocol-feature-meter"><i style={{ width: "72%" }} /><span>Pass · review · block</span></div></article><article className="protocol-feature-card"><div className="protocol-feature-topline"><span>03 · RECEIPT</span><b>RECONCILED</b></div><h4>Auditable settlement</h4><p>Authorization, transaction state, receipt reconciliation, and audit events remain connected.</p><div className="protocol-feature-meter"><i style={{ width: "94%" }} /><span>Intent · receipt · audit</span></div></article></div></section>
    <section className="protocol-section" aria-labelledby="proof-flow"><div className="protocol-section-header"><span className="eyebrow">Execution lifecycle</span><h3 id="proof-flow">The proof flow</h3><p>One accountable lane from agreement terms to a reconciled X Layer receipt.</p></div><div className="protocol-workflow">{[["01","Agreement","Terms published"],["02","Evidence","Manifest submitted"],["03","Review","AI observes"],["04","Policy","Gate decides"],["05","Authorization","Wallet signs"],["06","Settlement","Vault executes"],["07","Receipt","Chain confirms"]].map(([number, title, copy]) => <div className="protocol-step" key={number}><em>{number}</em><strong>{title}</strong><small>{copy}</small></div>)}</div></section>
    <section className="protocol-section protocol-receipt" aria-labelledby="receipt-heading"><div><span className="eyebrow">Cryptographically auditable</span><h3 id="receipt-heading">Every release leaves a receipt.</h3><p>ProofFlow connects the evidence manifest, policy decision, settlement intent, transaction, and reconciled receipt into one auditable chain.</p><button className="button secondary" onClick={() => navigate("activity")}>View audit ledger <span aria-hidden="true">→</span></button></div><div className="receipt-panel"><div className="receipt-line"><span>Agreement</span><code>{selected?.id ?? "Not available yet"}</code></div><div className="receipt-line"><span>Evidence manifest</span><code>{detail?.manifest?.manifestHash ? shortHash(detail.manifest.manifestHash) : "Not available yet"}</code></div><div className="receipt-line"><span>Policy decision</span><code>{detail?.decision?.outcome ?? "Awaiting review"}</code></div><div className="receipt-line"><span>Chain</span><code>{network ? `X Layer · ${network.chainId}` : "X Layer testnet · unavailable"}</code></div><div className="receipt-line"><span>Receipt status</span><code>{selected?.state === "RELEASED" ? "Reconciled" : "Not reconciled"}</code></div></div></section>
    <section className="protocol-activity" aria-labelledby="activity-heading"><div className="protocol-activity-header"><h3 id="activity-heading">Live ProofFlow Activity</h3><span>{detail?.audit?.length ? "X Layer testnet" : "No protocol activity yet"}</span></div>{detail?.audit?.length ? detail.audit.slice().reverse().slice(0, 5).map((event) => <div className="protocol-activity-row" key={event.id}><i aria-hidden="true" /><div><b>{event.eventType.replaceAll("_", " ")}</b><small>{event.actor} · {selected?.id ?? "Agreement"}</small></div><time>{relativeTime(event.occurredAt)}</time></div>) : <div className="protocol-activity-row"><i aria-hidden="true" /><div><b>No protocol activity yet.</b><small>Live evidence, policy, settlement, and receipt events will appear here.</small></div><time>Awaiting data</time></div>}</section>
    <section className="dashboard-grid overview-grid"><div className="panel priority-panel"><PanelHeading title="Priority queue" kicker="What needs attention first" action={<button className="text-button" onClick={() => navigate("review")}>Open review queue →</button>} /><div className="queue-list">{loading ? <SkeletonRows /> : agreements.length === 0 ? <EmptyState title="Your trust queue is clear." copy="Create an agreement to turn a real-world commitment into a verifiable settlement." /> : sortPriority(agreements).slice(0, 4).map((agreement) => <QueueRow key={agreement.id} agreement={agreement} selected={agreement.id === selectedId} onClick={() => { setSelectedId(agreement.id); navigate("agreements"); }} />)}</div></div><div className="panel network-panel"><PanelHeading title="Network health" kicker="Observed now" action={<button className="network-action" onClick={() => void loadNetwork()}>Refresh ↻</button>} /><div className="network-hero"><div className="network-orbit"><span>×</span></div><div><strong>{network ? "Connected" : "Unavailable"}</strong><p>{network ? `X Layer ${network.chainId === 1952 ? "testnet" : "mainnet"}` : networkError ?? "RPC status is being checked."}</p></div></div><div className="network-detail"><span>Chain ID</span><code>{network?.chainId ?? "—"}</code><span>Latest block</span><code>{network?.blockNumber ?? "—"}</code></div></div></section>
    <section className="panel recent-panel"><PanelHeading title="Recent agreements" kicker={`${agreements.length} in workspace`} action={<button className="text-button" onClick={() => navigate("agreements")}>View all →</button>} /><div className="recent-grid">{loading ? <SkeletonRows /> : agreements.length ? agreements.slice(0, 3).map((agreement) => <button className="recent-card" key={agreement.id} onClick={() => { setSelectedId(agreement.id); navigate("agreements"); }}><span className={`state-mark ${stateTone(agreement.state)}`}>{stateIcon(agreement.state)}</span><span><b>{agreement.title}</b><small>{shortAddress(agreement.recipient)} · {relativeTime(agreement.updatedAt)}</small></span><strong>{formatUnits(agreement.amountBaseUnits)} <small>XLAY</small></strong></button>) : <EmptyState title="No agreements yet" copy="Your first agreement will appear here with its terms, evidence, and settlement state." />}</div></section>
  </> : activeView === "agreements" ? <>
    <section className="page-heading compact-heading"><div><div className="eyebrow">Workspace index · {filteredAgreements.length} matching</div><h2>Agreements <em>workspace</em></h2><p>Searchable commitments with their evidence, policy, and settlement state.</p></div><div className="heading-actions"><button className="button primary" onClick={() => setCreateOpen(true)}>+ Create agreement</button></div></section>
    <section className="panel agreement-panel workspace-table-panel"><div className="workspace-toolbar"><div className="search-field"><span aria-hidden="true">⌕</span><input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search title, ID, wallet, or state" aria-label="Search agreements" /></div><label className="filter-field"><span>Filter</span><select value={stateFilter} onChange={(event) => setStateFilter(event.target.value)} aria-label="Filter agreements by state"><option value="ALL">All states</option>{["AWAITING_FUNDING","FUNDED","EVIDENCE_SUBMITTED","UNDER_REVIEW","READY_TO_RELEASE","RELEASED","BLOCKED","DISPUTED"].map((state) => <option key={state} value={state}>{stateLabel(state as Agreement["state"])}</option>)}</select></label><span className="table-scope">Live workspace</span></div><div className="agreement-table"><div className="table-head"><span>Agreement</span><span>Counterparty</span><span>Amount</span><span>State</span><span>Updated</span></div>{loading ? <SkeletonRows /> : filteredAgreements.length ? filteredAgreements.map((agreement) => <AgreementRow key={agreement.id} agreement={agreement} selected={agreement.id === selectedId} onClick={() => setSelectedId(agreement.id)} />) : <EmptyState title="Nothing matches this view" copy="Try a different search or clear the state filter." />}</div></section>
    {detailPanel}
  </> : activeView === "review" ? <>
    <section className="page-heading compact-heading"><div><div className="eyebrow">Human-in-the-loop control</div><h2>Review <em>queue</em></h2><p>AI can observe. Only policy and a human can authorize the next irreversible step.</p></div><span className="queue-count-badge">{reviewAgreements.length} pending decisions</span></section>
    <section className="review-workspace"><div className="panel review-list"><PanelHeading title="Pending decisions" kicker="Prioritized by risk" />{reviewAgreements.length ? reviewAgreements.map((agreement) => <QueueRow key={agreement.id} agreement={agreement} selected={agreement.id === selectedId} onClick={() => setSelectedId(agreement.id)} />) : <EmptyState title="Review queue is clear" copy="When evidence arrives, ProofFlow will place it here with the policy result beside it." />}</div><div className="panel review-brief"><PanelHeading title="Decision brief" kicker={selected ? selected.title : "Select an agreement"} />{selected && detail ? <><div className="review-hero"><span className={`state-mark large ${stateTone(selected.state)}`}>{stateIcon(selected.state)}</span><div><StateBadge state={selected.state} /><h3>{selectedDecision === "PASS" ? "Policy is ready for human approval" : selectedDecision === "BLOCK" ? "Policy has blocked release" : "Evidence needs attention"}</h3><p>{selectedDecision === "PASS" ? "Review the evidence and exact release preview before authorizing in your wallet." : "Inspect the deterministic reasons before moving the agreement forward."}</p></div></div><EvidenceReview manifest={detail.manifest ?? { items: [], manifestHash: "", agreementId: selected.id, submittedBy: "", submittedAt: selected.updatedAt }} review={detail.reviewRun} observation={detail.reviewRun?.observation} decision={detail.decision} /><div className="review-actions"><button className="button secondary" onClick={() => navigate("agreements")}>Open full agreement</button>{selected.state === "EVIDENCE_SUBMITTED" && <button className="button primary" onClick={() => void simulate("review")}>Run bounded review</button>}{selected.state === "READY_TO_RELEASE" && <button className="button primary" onClick={() => setReleaseOpen(true)}>Review release</button>}</div></> : <EmptyState title="Select a decision" copy="Choose a review item to see evidence, model provenance, and deterministic policy reasons." />}</div></section>
  </> : activeView === "activity" ? <>
    <section className="page-heading compact-heading"><div><div className="eyebrow">Append-only record</div><h2>Activity <em>stream</em></h2><p>Every meaningful agreement, evidence, review, and settlement event in sequence.</p></div><span className="verified-pill">✓ Integrity-aware</span></section>
    <section className="activity-layout"><div className="panel activity-panel"><PanelHeading title="Chronological timeline" kicker={selected ? `Showing ${selected.title}` : "Select an agreement to inspect"} />{detail?.audit?.length ? <div className="timeline">{detail.audit.slice().reverse().map((event, index) => <div className="timeline-item" key={event.id}><div className="timeline-rail"><span className="timeline-icon">{index === 0 ? "✦" : "·"}</span></div><div className="timeline-content"><div><b>{event.eventType.replaceAll("_", " ")}</b><time>{relativeTime(event.occurredAt)}</time></div><p>{event.actor} recorded a verifiable workflow event.</p><code>{shortHash(event.eventHash)}</code></div></div>)}</div> : <EmptyState title="Activity will appear here" copy="Select an agreement or create one to begin the append-only timeline." />}</div><div className="panel activity-context"><PanelHeading title="Context" kicker="Current selection" />{selected ? <><StateBadge state={selected.state} /><h3>{selected.title}</h3><p>{lifecycleStage}</p><button className="button secondary full-button" onClick={() => navigate("agreements")}>Open agreement →</button></> : <EmptyState title="No selection" copy="Choose an agreement from the workspace." />}</div></section>
  </> : activeView === "wallet" ? <>
    <section className="page-heading compact-heading"><div><div className="eyebrow">Human authorization boundary</div><h2>Wallet <em>control</em></h2><p>ProofFlow prepares reviewable requests. Your wallet remains the only signer.</p></div><span className="network-status large-status"><span className={network ? "status-dot online" : "status-dot"} />{statusLabel}</span></section>
    <section className="wallet-page-grid"><div className="panel wallet-hero-panel"><div className="wallet-hero-icon">◈</div><div><span className="eyebrow">Multi-wallet connection</span><h3>{walletAddress ? shortAddress(walletAddress) : "Wallet not connected"}</h3><p>{walletAddress ? walletChainId === XLAYER_TESTNET_CHAIN_ID ? "Connected and ready for X Layer testnet previews." : "Connected, but the active chain needs attention." : "Connect a wallet when you are ready to authorize a settlement."}</p></div>{!walletAddress && <button className="button primary" onClick={() => void connectWallet()}>Connect Wallet</button>}</div><div className="panel"><PanelHeading title="Network" kicker="Observed by ProofFlow" /><div className="network-detail light-detail"><span>Environment</span><code>{statusLabel}</code><span>Chain ID</span><code>{network?.chainId ?? XLAYER_TESTNET_CHAIN_ID}</code><span>Latest block</span><code>{network?.blockNumber ?? "—"}</code></div><button className="button secondary full-button" onClick={() => void loadNetwork()}>Refresh network status</button></div>{selected && detail?.chain && <div className="panel wallet-preview-panel"><PanelHeading title="Selected vault" kicker={selected.title} /><VaultCard chain={detail.chain} walletAddress={walletAddress} walletBusy={walletBusy} walletError={walletError} walletChainId={walletChainId} settlementStage={settlementStage} settlementHash={settlementHash} onConnect={() => void connectWallet()} onSwitchNetwork={() => void switchWalletNetwork()} onReviewRelease={() => setReleaseOpen(true)} /></div>}</section>
  </> : <>
    <section className="page-heading compact-heading"><div><div className="eyebrow">Workspace configuration</div><h2>Settings <em>and safeguards</em></h2><p>Operational context for this testnet-first ProofFlow workspace.</p></div></section>
    <section className="settings-grid"><div className="panel settings-card"><PanelHeading title="Environment" kicker="Current deployment posture" /><div className="setting-callout"><span className="status-dot online" /><div><b>Testnet-first workspace</b><p>ProofFlow is configured for human-reviewed settlement on X Layer testnet. Never treat this environment as production custody.</p></div></div><InfoRow label="Network" value={statusLabel} /><InfoRow label="API base" value={API_BASE} mono /><InfoRow label="Release model" value="Explicit wallet authorization" /></div><div className="panel settings-card"><PanelHeading title="Trust boundaries" kicker="What ProofFlow will never do" /><ul className="safeguard-list"><li>AI output cannot authorize a transfer.</li><li>Policy decisions are deterministic and reviewable.</li><li>Transaction previews show recipient, amount, chain, and calldata.</li><li>Receipts are reconciled before a settlement is called complete.</li></ul></div><div className="panel settings-card"><PanelHeading title="Demo controls" kicker="Safe local workflow" /><p className="settings-copy">Reset the seeded workspace to demonstrate the full agreement lifecycle from a known state.</p><button className="button secondary" disabled={resetting} onClick={() => void resetDemo()}>{resetting ? "Resetting…" : "Reset demo workspace"}</button></div></section>
  </>;

  if (activeView === "landing") return <>
    <LandingPage statusLabel={statusLabel} network={network} agreements={agreements} walletAddress={walletAddress} walletBusy={walletBusy} walletStatus={walletStatus} walletError={walletError} onNavigate={navigate} onCreate={() => setCreateOpen(true)} onConnect={() => void connectWallet()} />
    {createOpen && <CreateAgreementModal onClose={() => setCreateOpen(false)} onCreated={handleCreated} walletAddress={walletAddress} />}
  </>;

  return <div className="app-shell phase3-app">
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <Sidebar activeView={activeView} network={statusLabel} walletAddress={walletAddress} mobileOpen={mobileNavOpen} onToggle={() => setMobileNavOpen((value) => !value)} onConnect={() => void connectWallet()} onCreate={() => { setCreateOpen(true); setMobileNavOpen(false); }} onNavigate={navigate} />
    <main id="main-content" className="main-content">
      <header className="topbar">
        <div className="topbar-title"><div className="protocol-kicker"><span className="protocol-pulse" aria-hidden="true" /> PROOFFLOW PROTOCOL · {statusLabel}</div><div className="breadcrumb"><span>Console</span><span aria-hidden="true">/</span><strong>{pageTitle}</strong></div><h1>{pageTitle} <em>{activeView === "overview" ? "command center" : "workspace"}</em></h1><p className="topbar-description">{pageDescription}</p></div>
        <div className="topbar-actions"><nav className="protocol-nav" aria-label="Protocol navigation"><button className={activeView === "overview" ? "active" : ""} onClick={() => navigate("overview")}>Overview</button><button className={activeView === "agreements" ? "active" : ""} onClick={() => navigate("agreements")}>Agreements</button><button className={activeView === "activity" ? "active" : ""} onClick={() => navigate("activity")}>Audit ledger</button></nav><label className="global-search"><span aria-hidden="true">⌕</span><input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search protocol" aria-label="Search protocol" /></label><button className="icon-button" aria-label="Refresh data" onClick={() => void refresh()}>↻</button><div className="network-status"><span className={network ? "status-dot online" : "status-dot"} /><div><b>{statusLabel}</b><small>{network ? `Block ${network.blockNumber}` : networkError ?? "Checking RPC"}</small></div></div><button className="wallet-chip" onClick={() => navigate("wallet")} aria-label="Open wallet control"><span className="wallet-chip-icon">◈</span><div><b>{walletAddress ? shortAddress(walletAddress) : "Connect wallet"}</b><small>{walletAddress && walletChainId === XLAYER_TESTNET_CHAIN_ID ? "Wallet · ready" : walletAddress ? "Wallet · wrong network" : "Wallet required to settle"}</small></div><span aria-hidden="true">↗</span></button></div>
      </header>
      <div className="testnet-banner"><span className="banner-signal">!</span><div><b>X Layer testnet · human-authorized execution</b><p>Funds and transactions here are for demonstration only. ProofFlow never signs or moves funds without your explicit wallet approval.</p></div><span className="banner-mono">CHAIN {network?.chainId ?? XLAYER_TESTNET_CHAIN_ID}</span></div>
      {notice && <div className={`inline-banner ${notice.kind}`} role="status" aria-live="polite"><span>{notice.kind === "danger" ? "!" : notice.kind === "success" ? "✓" : "i"}</span><p>{notice.text}</p><button className="banner-close" aria-label="Dismiss notification" onClick={() => setNotice(null)}>×</button></div>}
      <div className="page-transition" key={activeView}>{pageContent}</div>
      <footer className="app-footer" aria-label="ProofFlow resources"><div className="footer-brand"><span className="brand-mark">P</span><div><strong>ProofFlow</strong><small>Enterprise trust infrastructure</small></div></div><div className="footer-links"><div><b>Platform</b><button onClick={() => navigate("overview")}>Overview</button><button onClick={() => navigate("agreements")}>Agreements</button><button onClick={() => navigate("review")}>Reviews</button></div><div><b>Network</b><button onClick={() => navigate("wallet")}>wallet</button><button onClick={() => navigate("wallet")}>X Layer</button><button onClick={() => navigate("activity")}>Explorer record</button></div><div><b>Resources</b><button onClick={() => navigate("settings")}>Safeguards</button><button onClick={() => navigate("activity")}>Activity</button><button onClick={() => navigate("settings")}>Status</button></div></div><div className="footer-meta"><span>Testnet-first · human authorized</span><span>ProofFlow v0.1.0</span></div></footer>
      {createOpen && <CreateAgreementModal onClose={() => setCreateOpen(false)} onCreated={handleCreated} walletAddress={walletAddress} />}
      {evidenceOpen && selected && <EvidenceModal agreement={selected} onClose={() => setEvidenceOpen(false)} onSubmitted={handleEvidenceSubmitted} />}
      {releaseOpen && selected && detail?.chain && <ReleaseModal agreement={selected} chain={detail.chain} decision={detail.decision} manifest={detail.manifest} walletAddress={walletAddress} walletChainId={walletChainId} walletBusy={walletBusy} walletError={walletError} stage={settlementStage} transactionHash={settlementHash} onClose={() => setReleaseOpen(false)} onConnect={() => void connectWallet()} onSwitchNetwork={() => void switchWalletNetwork()} onAuthorize={() => void authorizeRelease(selected.id)} />}
    </main>
  </div>;
}

function LandingPage({ statusLabel, network, agreements, walletAddress, walletBusy, walletStatus, walletError, onNavigate, onCreate, onConnect }: { statusLabel: string; network: XLayerStatus | null; agreements: Agreement[]; walletAddress: string | null; walletBusy: boolean; walletStatus: WalletStatus; walletError: string | null; onNavigate: (view: View) => void; onCreate: () => void; onConnect: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const go = (view: View) => { setMenuOpen(false); onNavigate(view); };
  return <div className="landing-page">
    <div className="landing-canvas" aria-hidden="true" />
    <div className="landing-grid" aria-hidden="true" />
    <div className="landing-vignette" aria-hidden="true" />
    <header className="landing-header">
      <button className="landing-menu-button" aria-label={menuOpen ? "Close navigation" : "Open navigation"} aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}><span /><span /><span /></button>
      <button className="landing-brand" onClick={() => go("landing")} aria-label="ProofFlow home"><span className="landing-brand-mark">P</span><span>ProofFlow</span></button>
      <div className="landing-header-actions"><div className="landing-network"><span className="landing-live-dot" /> <span>{network ? "X LAYER TESTNET · ONLINE" : "X LAYER TESTNET · CHECKING"}</span><code>1952</code></div><button className={`landing-wallet-button ${walletStatus}`} disabled={walletBusy} onClick={onConnect} aria-describedby={walletError ? "landing-wallet-error" : undefined}><span className="landing-wallet-orb" aria-hidden="true">◈</span><span>{walletBusy ? "Connecting…" : walletAddress ? shortAddress(walletAddress) : walletStatus === "unavailable" ? "wallet not detected" : walletStatus === "wrong_network" ? "Wrong network" : "Connect Wallet"}</span><span className="landing-wallet-arrow" aria-hidden="true">↗</span></button>{walletError && <div className="landing-wallet-feedback" id="landing-wallet-error" role="alert"><span>{walletStatus === "unavailable" ? "Wallet unavailable" : walletStatus === "wrong_network" ? "Wrong network" : "Connection issue"}</span><p>{walletError}</p>{walletStatus === "unavailable" && <a href="https://web3.okx.com/download" target="_blank" rel="noreferrer">Install wallet ↗</a>}</div>}</div>
    </header>
    <div className={`landing-menu-backdrop ${menuOpen ? "is-open" : ""}`} aria-hidden={!menuOpen} onClick={() => setMenuOpen(false)} />
    <aside className={`landing-drawer ${menuOpen ? "is-open" : ""}`} aria-label="ProofFlow navigation">
      <div className="landing-drawer-kicker">Navigation / 00</div>
      <h2>Trust, made<br /><em>inspectable.</em></h2>
      <nav className="landing-drawer-nav">
        <button onClick={() => go("overview")}><span>01</span><b>Open console</b><i>↗</i></button>
        <button onClick={() => { setMenuOpen(false); onCreate(); }}><span>02</span><b>Create agreement</b><i>＋</i></button>
        <button onClick={() => go("review")}><span>03</span><b>Review queue</b><i>→</i></button>
        <button onClick={() => go("activity")}><span>04</span><b>Audit ledger</b><i>→</i></button>
        <button onClick={() => go("wallet")}><span>05</span><b>Wallet control</b><i>→</i></button>
      </nav>
      <div className="landing-drawer-links"><a href="https://github.com/youngcrypton/ProofFlow/blob/main/docs/product-spec.md" target="_blank" rel="noreferrer">Product document <span>↗</span></a><a href="https://github.com/youngcrypton/ProofFlow" target="_blank" rel="noreferrer">GitHub repository <span>↗</span></a><a href="https://x.com/ProofFloww" target="_blank" rel="noreferrer">Follow on X <span>↗</span></a></div>
      <div className="landing-drawer-status"><span className="landing-live-dot" /><span>{statusLabel}</span></div>
    </aside>
    <main className="landing-main">
      <section className="landing-hero" aria-labelledby="landing-title">
        <div className="landing-index">01 <span>/</span> TRUST EXECUTION PROTOCOL</div>
        <div className="landing-hero-copy"><p className="landing-eyebrow">AI-powered verification for real-world work</p><h1 id="landing-title">Trust the<br /><em>evidence.</em><br />Not the promise.</h1><p className="landing-lede">ProofFlow turns a milestone agreement into a verifiable path from completed work to programmable settlement on X Layer.</p><div className="landing-actions"><button className="landing-button landing-button-primary" onClick={() => onNavigate("overview")}>Enter the console <span>↗</span></button><button className="landing-button landing-button-wallet" onClick={onConnect}><span className="landing-wallet-orb" aria-hidden="true">◈</span>{walletAddress ? `Wallet ready · ${shortAddress(walletAddress)}` : "Connect wallet to settle"}</button><button className="landing-button landing-button-quiet" onClick={() => window.open("https://github.com/youngcrypton/ProofFlow/blob/main/docs/product-spec.md", "_blank", "noopener,noreferrer")}>Read the brief <span>↗</span></button></div></div>
        <div className="landing-side-note"><span>AI observes</span><span>Policy decides</span><span>Humans authorize</span><span>Chain settles</span></div>
      </section>
      <section className="landing-live-agreements" aria-labelledby="landing-live-agreements-title"><div className="landing-live-heading"><span className="landing-eyebrow">Live agreement stream</span><h2 id="landing-live-agreements-title">Proof in motion.</h2><p>Recent commitments stay visible while they move from evidence to settlement.</p></div><div className="landing-agreement-orbit">{(agreements.length ? agreements.slice(0, 4) : [{ id: "DEMO-01", title: "Awaiting your first agreement", state: "AWAITING_FUNDING", amountBaseUnits: "0", updatedAt: new Date().toISOString() } as Agreement]).map((agreement, index) => <article className={`landing-agreement-card landing-agreement-card-${index + 1}`} key={agreement.id}><div className="landing-agreement-topline"><span className={`landing-agreement-state ${stateTone(agreement.state)}`}><i />{stateLabel(agreement.state)}</span><span>{relativeTime(agreement.updatedAt)}</span></div><h3>{agreement.title}</h3><div className="landing-agreement-bottom"><code>{agreement.amountBaseUnits === "0" ? "Live workspace" : `${formatUnits(agreement.amountBaseUnits)} XLAY`}</code><span>{agreement.id}</span></div></article>)}</div></section>
      <section className="landing-proof" aria-label="ProofFlow principles"><div className="landing-proof-intro"><span className="landing-eyebrow">The missing trust layer</span><h2>Commerce needs<br /><em>proof before payment.</em></h2></div><div className="landing-proof-cards"><article><span>01 / EVIDENCE</span><h3>Commit the work.</h3><p>Evidence is submitted as a typed manifest with a canonical content hash before it becomes a decision input.</p></article><article><span>02 / POLICY</span><h3>Gate the release.</h3><p>AI extracts observations. A deterministic policy engine produces RELEASE, REVIEW, or BLOCK.</p></article><article><span>03 / RECEIPT</span><h3>Verify the outcome.</h3><p>A bounded wallet intent meets an X Layer vault and returns an independently inspectable receipt.</p></article></div></section>
      <section className="landing-how" aria-labelledby="landing-how-title"><div className="landing-how-heading"><span className="landing-eyebrow">New here?</span><h2 id="landing-how-title">How ProofFlow works.</h2><p>Start with the product, not the protocol. ProofFlow protects milestone payments by turning completed work into evidence that can be reviewed before a wallet ever signs.</p></div><div className="landing-how-steps"><article><span>01</span><div><h3>Create the agreement</h3><p>Define the milestone, recipient, amount, deadline, and evidence required for release.</p></div></article><article><span>02</span><div><h3>Submit the proof</h3><p>Upload the evidence. ProofFlow validates, hashes, and records the manifest as the source of truth.</p></div></article><article><span>03</span><div><h3>Review the gate</h3><p>AI observes the evidence. Deterministic policy decides whether the work is ready, blocked, or needs review.</p></div></article><article><span>04</span><div><h3>Authorize and settle</h3><p>When the gate passes, a human reviews the exact transaction in wallet and X Layer returns the receipt.</p></div></article></div><button className="landing-how-cta" onClick={() => onNavigate("overview")}>Open the product console <span>↗</span></button></section>
      <section className="landing-depth" aria-labelledby="landing-depth-title">
        <div className="landing-depth-copy">
          <span className="landing-eyebrow">The ProofFlow sequence</span>
          <h2 id="landing-depth-title">Every handoff<br /><em>stays visible.</em></h2>
          <p>Move through the execution lane: evidence is committed, policy gates the decision, a human authorizes the exact intent, and X Layer returns the receipt.</p>
          <div className="landing-depth-meta"><span><i /> Drag or use arrow keys</span><span>04 stages / one accountable lane</span></div>
        </div>
        <div className="landing-depth-stage">
          <DepthCarousel
            items={[
              { image: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 720 460'%3E%3Crect width='720' height='460' fill='%23081218'/%3E%3Cpath d='M0 390L720 70' stroke='%23c8f36c' stroke-opacity='.45'/%3E%3Cpath d='M100 0L680 460' stroke='%237dd3fc' stroke-opacity='.25'/%3E%3Ctext x='54' y='100' fill='%23c8f36c' font-family='monospace' font-size='18'%3E01 / EVIDENCE%3C/text%3E%3Ctext x='54' y='190' fill='white' font-family='Georgia' font-size='58'%3ECOMMIT%3C/text%3E%3Ctext x='54' y='250' fill='%23aebdca' font-family='sans-serif' font-size='18'%3EHash the work before it becomes a decision.%3C/text%3E%3C/svg%3E", alt: "Evidence commitment stage" },
              { image: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 720 460'%3E%3Crect width='720' height='460' fill='%230a111b'/%3E%3Ccircle cx='560' cy='120' r='130' fill='%23c8f36c' fill-opacity='.08'/%3E%3Cpath d='M0 100H720M0 230H720M0 360H720' stroke='%237dd3fc' stroke-opacity='.16'/%3E%3Ctext x='54' y='100' fill='%237dd3fc' font-family='monospace' font-size='18'%3E02 / POLICY%3C/text%3E%3Ctext x='54' y='190' fill='white' font-family='Georgia' font-size='58'%3EGATE%3C/text%3E%3Ctext x='54' y='250' fill='%23aebdca' font-family='sans-serif' font-size='18'%3ERELEASE, REVIEW, or BLOCK.%3C/text%3E%3C/svg%3E", alt: "Deterministic policy stage" },
              { image: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 720 460'%3E%3Crect width='720' height='460' fill='%23131812'/%3E%3Cpath d='M40 380L300 120L520 300L680 70' fill='none' stroke='%23c8f36c' stroke-width='3'/%3E%3Ccircle cx='300' cy='120' r='8' fill='%23c8f36c'/%3E%3Ccircle cx='520' cy='300' r='8' fill='%237dd3fc'/%3E%3Ctext x='54' y='100' fill='%23c8f36c' font-family='monospace' font-size='18'%3E03 / AUTHORIZATION%3C/text%3E%3Ctext x='54' y='190' fill='white' font-family='Georgia' font-size='58'%3ESIGN%3C/text%3E%3Ctext x='54' y='250' fill='%23aebdca' font-family='sans-serif' font-size='18'%3EThe wallet sees the exact settlement intent.%3C/text%3E%3C/svg%3E", alt: "Human authorization stage" },
              { image: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 720 460'%3E%3Crect width='720' height='460' fill='%230c1018'/%3E%3Crect x='48' y='74' width='624' height='260' rx='10' fill='none' stroke='%23c8f36c' stroke-opacity='.55'/%3E%3Cpath d='M82 258h140l32-84 70 126 76-190 42 148h90' fill='none' stroke='%237dd3fc' stroke-width='3'/%3E%3Ctext x='54' y='100' fill='%237dd3fc' font-family='monospace' font-size='18'%3E04 / RECEIPT%3C/text%3E%3Ctext x='54' y='190' fill='white' font-family='Georgia' font-size='58'%3ESETTLE%3C/text%3E%3Ctext x='54' y='250' fill='%23aebdca' font-family='sans-serif' font-size='18'%3EX Layer makes the outcome inspectable.%3C/text%3E%3C/svg%3E", alt: "X Layer receipt stage" }
            ]}
            cardWidth={310}
            cardHeight={198}
            depth={92}
            spread={72}
            tilt={13}
            visibleCards={2.5}
            falloff={0.24}
            blur={3}
            tint="#071017"
            perspective={1200}
            showIndicators
            showControls
          />
        </div>
      </section>
      <section className="landing-flow" aria-label="ProofFlow execution flow"><div><span className="landing-eyebrow">One accountable lane</span><h2>Agreement → Evidence → Policy → <em>Receipt</em></h2></div><button className="landing-flow-link" onClick={() => onNavigate("activity")}>See the audit trail <span>↗</span></button></section>
    </main>
    <footer className="landing-footer"><span>PROOFFLOW / TESTNET-FIRST / HUMAN-AUTHORIZED</span><div><a href="https://github.com/youngcrypton" target="_blank" rel="noreferrer">GitHub · youngcrypton</a><a href="https://x.com/ProofFloww" target="_blank" rel="noreferrer">X · @ProofFloww</a><button onClick={onCreate}>Start a workflow <span>↗</span></button></div></footer>
  </div>;
}

function Sidebar({ activeView, network, walletAddress, mobileOpen, onToggle, onConnect, onCreate, onNavigate }: { activeView: View; network: string; walletAddress: string | null; mobileOpen: boolean; onToggle: () => void; onConnect: () => void; onCreate: () => void; onNavigate: (view: View) => void }) { const items: { view: View; icon: string; label: string }[] = [{ view: "overview", icon: "⌂", label: "Overview" }, { view: "agreements", icon: "▣", label: "Agreements" }, { view: "review", icon: "◌", label: "Review queue" }, { view: "activity", icon: "≡", label: "Activity" }]; return <><div className={`mobile-nav-backdrop ${mobileOpen ? "is-open" : ""}`} aria-hidden={!mobileOpen} onClick={onToggle} /><aside className={`sidebar ${mobileOpen ? "mobile-open" : ""}`}><div className="brand"><span className="brand-mark">P</span><span>ProofFlow</span><button className="mobile-menu-button" aria-label={mobileOpen ? "Close navigation" : "Open navigation"} aria-expanded={mobileOpen} onClick={onToggle}>{mobileOpen ? "×" : "☰"}</button></div><div className="workspace-select"><span className="workspace-avatar">T</span><span><b>Trust operations</b><small>Workspace</small></span><span>⌄</span></div><button className="button primary create-side" onClick={onCreate}>+ Create agreement</button><nav className="side-nav" aria-label="Primary navigation">{items.map((item) => <button key={item.view} className={activeView === item.view ? "active" : ""} aria-current={activeView === item.view ? "page" : undefined} onClick={() => onNavigate(item.view)}><span className="nav-icon" aria-hidden="true">{item.icon}</span><span>{item.label}</span>{item.view === "review" && <b>{item.view === activeView ? "" : ""}</b>}</button>)}</nav><div className="side-divider" /><nav className="side-nav secondary-nav" aria-label="Workspace settings"><button className={activeView === "wallet" ? "active" : ""} aria-current={activeView === "wallet" ? "page" : undefined} onClick={() => onNavigate("wallet")}><span className="nav-icon" aria-hidden="true">◈</span><span>Wallet</span></button><button className={activeView === "settings" ? "active" : ""} aria-current={activeView === "settings" ? "page" : undefined} onClick={() => onNavigate("settings")}><span className="nav-icon" aria-hidden="true">⚙</span><span>Settings</span></button></nav><div className="sidebar-bottom"><div className="side-network"><span className={`status-dot ${network.includes("offline") ? "" : "online"}`} /><div><small>Network</small><b>{network}</b></div></div><button className="wallet-side" onClick={onConnect}><span className="wallet-icon">◈</span><span><small>{walletAddress ? "Connected wallet" : "Settlement wallet"}</small><b>{walletAddress ? shortAddress(walletAddress) : "Connect Wallet"}</b></span><span>↗</span></button><div className="side-footer"><span>Testnet-first</span><span>v0.1.0</span></div></div></aside></>; }
function Metric({ label, value, detail, tone = "", numeric }: { label: string; value: string; detail: string; tone?: string; numeric?: number }) { return <SpotlightCard className={`metric ${tone}`}><span className="metric-label">{label}</span><strong>{numeric === undefined ? value : <CountUp value={numeric} />}</strong><small>{detail}</small><span className="metric-sheen" aria-hidden="true" /></SpotlightCard>; }
function PanelHeading({ title, kicker, action }: { title: string; kicker: string; action?: ReactNode }) { return <div className="panel-heading"><div><span>{kicker}</span><h3>{title}</h3></div>{action}</div>; }
function QueueRow({ agreement, selected, onClick }: { agreement: Agreement; selected: boolean; onClick: () => void }) { return <SpotlightCard interactive ariaLabel={`Open agreement ${agreement.title}`} className={`queue-row ${selected ? "selected" : ""}`} onClick={onClick}><span className={`state-mark ${stateTone(agreement.state)}`}>{stateIcon(agreement.state)}</span><span className="queue-main"><b>{agreement.title}</b><small>{agreement.id}</small></span><span className="queue-action">{priorityReason(agreement.state)}</span><span className="queue-amount">{formatUnits(agreement.amountBaseUnits)} XLAY</span><span className="queue-date">{relativeTime(agreement.updatedAt)}</span></SpotlightCard>; }
function AgreementRow({ agreement, selected, onClick }: { agreement: Agreement; selected: boolean; onClick: () => void }) { return <button className={`table-row ${selected ? "selected" : ""}`} onClick={onClick}><span data-label="Agreement"><b>{agreement.title}</b><small>{agreement.id}</small></span><span className="mono" data-label="Counterparty">{shortAddress(agreement.recipient)}</span><span className="numeric" data-label="Amount">{formatUnits(agreement.amountBaseUnits)} XLAY</span><span data-label="State"><StateBadge state={agreement.state} /></span><span className="mono" data-label="Updated">{relativeTime(agreement.updatedAt)}</span></button>; }
function DetailPanel({ detail, loading, onAction, walletAddress, walletBusy, walletError, walletChainId, settlementStage, settlementHash, onConnect, onSwitchNetwork, onReviewRelease }: { detail: AgreementDetail | null; loading: boolean; onAction: (action: "fund" | "evidence" | "review" | "release") => void; walletAddress: string | null; walletBusy: boolean; walletError: string | null; walletChainId: number | null; settlementStage: SettlementStage; settlementHash: string | null; onConnect: () => void; onSwitchNetwork: () => void; onReviewRelease: () => void }) { const agreement = detail?.agreement; if (!agreement) return <section className="panel detail-panel"><SkeletonRows /></section>; const review = detail?.reviewRun; const observation = review?.observation; return <section className="detail-panel" id="overview"><div className="detail-header"><div><span className="eyebrow">Agreement command center · {agreement.id}</span><h2>{agreement.title}</h2><p>{agreement.description}</p></div><StateBadge state={agreement.state} /></div>{detail?.chainError && <div className="chain-warning" role="status"><span>!</span><div><b>Vault status is not available</b><p>{detail.chainError}</p><small>Live transaction previews appear after the vault address is configured.</small></div></div>}<div className="detail-grid"><div><section className="detail-card state-banner"><span className={`state-mark large ${stateTone(agreement.state)}`}>{stateIcon(agreement.state)}</span><div><span className="eyebrow">Current state</span><h3>{stateTitle(agreement.state)}</h3><p>{stateCopy(agreement.state)}</p></div><button className="button primary action-button" disabled={loading || !["AWAITING_FUNDING", "FUNDED", "EVIDENCE_SUBMITTED", "READY_TO_RELEASE"].includes(agreement.state)} onClick={() => void onAction(agreement.state === "AWAITING_FUNDING" ? "fund" : agreement.state === "FUNDED" ? "evidence" : agreement.state === "EVIDENCE_SUBMITTED" ? "review" : "release")}>{nextAction(agreement.state)}</button></section><section className="detail-card"><SectionTitle title="Lifecycle" kicker="Agreement state" /><Lifecycle state={agreement.state} /></section><section className="detail-card"><SectionTitle title="Evidence and review" kicker="AI observation · deterministic gate" />{detail?.manifest ? <EvidenceReview manifest={detail.manifest} review={review} observation={observation} decision={detail.decision} /> : <EmptyState title="No evidence manifest" copy="Evidence has not been submitted for this agreement." />}</section><section className="detail-card"><SectionTitle title="Audit trail" kicker="Append-only integrity" /><AuditTrail events={detail?.audit ?? []} /></section></div><aside className="detail-sidebar"><section className="detail-card terms-card"><SectionTitle title="Terms" kicker="Immutable agreement" /><InfoRow label="Amount" value={`${formatUnits(agreement.amountBaseUnits)} XLAY`} /><InfoRow label="Deadline" value={formatDate(agreement.deadline)} /><InfoRow label="Payer" value={shortAddress(agreement.payer)} mono /><InfoRow label="Recipient" value={shortAddress(agreement.recipient)} mono /><InfoRow label="Policy" value={agreement.policy.version} /><InfoRow label="Policy hash" value={shortHash(agreement.policyHash)} mono /></section><section className="detail-card"><SectionTitle title="Vault status" kicker="X Layer settlement" />{detail?.chain ? <VaultCard chain={detail.chain} walletAddress={walletAddress} walletBusy={walletBusy} walletError={walletError} walletChainId={walletChainId} settlementStage={settlementStage} settlementHash={settlementHash} onConnect={onConnect} onSwitchNetwork={onSwitchNetwork} onReviewRelease={onReviewRelease} /> : <div className="not-configured"><span>◌</span><b>Awaiting vault connection</b><p>Configure <code>PROOFFLOW_VAULT_ADDRESS</code> to verify the onchain terms and preview safe transactions.</p></div>}</section></aside></div></section>; }
function SectionTitle({ title, kicker }: { title: string; kicker: string }) { return <div className="section-title"><span>{kicker}</span><h3>{title}</h3></div>; }
function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) { return <div className="info-row"><span>{label}</span><strong className={mono ? "mono" : ""}>{value}</strong></div>; }
function StateBadge({ state }: { state: Agreement["state"] }) { return <span className={`state-badge ${stateTone(state)}`}><span aria-hidden="true">{stateIcon(state)}</span>{stateLabel(state)}</span>; }
function Lifecycle({ state }: { state: Agreement["state"] }) { const steps: Agreement["state"][] = [JobState.AWAITING_FUNDING, JobState.FUNDED, JobState.EVIDENCE_SUBMITTED, JobState.UNDER_REVIEW, JobState.READY_TO_RELEASE, JobState.RELEASED]; const index = state === JobState.REVIEWED ? 4 : steps.indexOf(state); return <div className="lifecycle" aria-label="Agreement lifecycle">{steps.map((step, i) => <div className={`lifecycle-step ${i < index ? "complete" : i === index ? "current" : ""}`} key={step}><span>{i < index ? "✓" : i + 1}</span><small>{lifecycleLabel(step)}</small></div>)}</div>; }
function EvidenceReview({ manifest, review, observation, decision }: { manifest: EvidenceManifest; review: ReviewRun | null | undefined; observation: ReviewRun["observation"] | undefined; decision: PolicyDecision | null }) { const tone = decision?.outcome === "PASS" ? "pass" : decision?.outcome === "BLOCK" ? "danger" : "warning"; return <div className="evidence-review"><div className="evidence-summary"><div className={`summary-icon ${tone}`}>{decision?.outcome === "BLOCK" ? "!" : "✓"}</div><div><b>{review ? "AI observation complete" : "Evidence manifest received"}</b><p>{review ? `Structured observations from ${review.provider.model}. Advisory only.` : "Waiting for a bounded review run."}</p></div>{review && <span className="confidence-value">{(review.observation.confidenceBps / 100).toFixed(0)}%<small>confidence</small></span>}</div><div className="trust-boundary"><span>AI observes</span><i>→</i><span className="policy-chip">Policy decides</span><i>→</i><span className={`${tone}-chip`}>{decision?.outcome ?? "Awaiting gate"}</span></div><div className="evidence-list">{manifest.items.map((item) => <div className="evidence-item" key={item.sha256}><span className="file-icon">□</span><span><b>{item.name}</b><small>{item.type} · {item.mediaType}</small></span><code>{shortHash(item.sha256)}</code><span className="pass-text">✓ verified</span></div>)}</div>{observation && <div className="facts"><span className="eyebrow">Extracted facts</span>{observation.extractedFacts.map((fact) => <div className="fact" key={`${fact.key}-${fact.source}`}><b>{fact.key}</b><span>{fact.value}</span><small>Source: {fact.source}</small></div>)}</div>}{decision && <div className="decision-box"><div><span className="eyebrow">Deterministic gate · {decision.policyVersion}</span><b>{decision.outcome === "PASS" ? "Release conditions pass" : decision.outcome === "BLOCK" ? "Release blocked" : "Human review required"}</b></div><span className="mono">{shortHash(decision.policyHash)}</span>{decision.reasons.length > 0 && <ul>{decision.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}</div>}</div>; }
function AuditTrail({ events }: { events: AuditEvent[] }) { return events.length ? <div className="audit-list">{events.slice().reverse().map((event) => <div className="audit-item" key={event.id}><span className="audit-dot" /><div><b>{event.eventType.replaceAll("_", " ")}</b><p>{event.actor} · {relativeTime(event.occurredAt)}</p></div><code>{shortHash(event.eventHash)}</code></div>)}</div> : <EmptyState title="No audit events yet" copy="Lifecycle events will appear here as this agreement changes." />; }
function VaultCard({ chain, walletAddress, walletBusy, walletError, walletChainId, settlementStage, settlementHash, onConnect, onSwitchNetwork, onReviewRelease }: { chain: ChainPreview; walletAddress: string | null; walletBusy: boolean; walletError: string | null; walletChainId: number | null; settlementStage: SettlementStage; settlementHash: string | null; onConnect: () => void; onSwitchNetwork: () => void; onReviewRelease: () => void }) { const expectedChainId = Number(import.meta.env.VITE_XLAYER_CHAIN_ID ?? XLAYER_TESTNET_CHAIN_ID); const release = chain.transactions.release; const canReview = chain.vault.funded && !chain.vault.released; const stageCopy: Record<SettlementStage, string> = { idle: "", preparing: "Checking the exact intent and network.", ready: "Ready for your review.", awaiting_wallet: "Confirm the exact transaction in your wallet.", submitted: "Transaction submitted; receipt not final yet.", confirming: "ProofFlow is checking the receipt and release event.", confirmed: "Verified receipt reconciled on X Layer.", failed: "The chain did not confirm this release.", unknown: "Confirmation uncertain. Refresh before retrying." }; const copy = (value: string) => void navigator.clipboard?.writeText(value); return <div className="vault-card"><div className="vault-state"><span className={`status-dot ${chain.vault.released ? "online" : chain.vault.funded ? "online" : ""}`} /><div><b>{chain.vault.released ? "Released" : chain.vault.funded ? "Funded" : "Awaiting funding"}</b><small>{chain.vault.released ? "Final receipt reconciled" : chain.vault.funded ? "Funds held by the vault" : "Fund the agreement to continue"}</small></div><span className="chain-chip">CHAIN {chain.network.chainId}</span></div><InfoRow label="Vault" value={shortAddress(chain.vault.address)} mono /><InfoRow label="Balance" value={`${formatUnits(chain.vault.balance)} XLAY`} /><div className="preview-block"><div className="preview-heading"><span className="eyebrow">Exact settlement intent</span><span className="intent-lock">No opaque signing</span></div><div className="tx-preview featured"><div className="tx-preview-heading"><div><span className="eyebrow">Native release</span><b>{formatUnits(release.value)} XLAY to recipient</b></div><span className="tx-safety">Reviewable</span></div><div className="tx-facts"><InfoRow label="Recipient" value={shortAddress(chain.vault.recipient)} mono /><InfoRow label="Vault contract" value={shortAddress(release.to)} mono /><InfoRow label="Network" value={`X Layer testnet · ${chain.network.chainId}`} /><InfoRow label="Calldata" value={shortHash(release.data)} mono /></div><details className="technical-details"><summary>Inspect calldata and full addresses</summary><div className="technical-body"><InfoRow label="To" value={release.to} mono /><InfoRow label="Data" value={release.data} mono /><button className="copy-button" onClick={() => copy(JSON.stringify(release, null, 2))}>Copy transaction JSON</button></div></details><p className="tx-disclaimer">ProofFlow prepares this exact request. Your wallet shows it before you approve. A signature is not a confirmed payment.</p>{canReview && <button className="button primary full-button" disabled={walletBusy} onClick={onReviewRelease}>Review release in wallet</button>}</div></div><div className="wallet-connection"><div className="wallet-connection-top"><div><span className="eyebrow">Authorization boundary</span><b>{walletAddress ? `wallet · ${shortAddress(walletAddress)}` : "Wallet not connected"}</b><small>{walletAddress ? walletChainId === expectedChainId ? "On X Layer testnet" : "Wrong network" : "Only your wallet can authorize funds"}</small></div><span className={`wallet-check ${walletAddress && walletChainId === expectedChainId ? "ok" : ""}`}>{walletAddress && walletChainId === expectedChainId ? "✓" : "—"}</span></div>{walletError && <div className="wallet-error" role="alert">{walletError}</div>}{walletAddress && walletChainId !== expectedChainId ? <button className="button secondary full-button" onClick={onSwitchNetwork}>Switch wallet to X Layer</button> : <button className="button secondary full-button" onClick={onConnect}>{walletAddress ? "Reconnect wallet" : "Connect Wallet"}</button>}{settlementStage !== "idle" && <div className={`settlement-status ${settlementStage}`} role="status" aria-live="polite"><span className="stage-marker">{stageIcon(settlementStage)}</span><div><b>{stageTitle(settlementStage)}</b><small>{stageCopy[settlementStage]}{settlementHash ? ` · ${shortHash(settlementHash)}` : ""}</small></div></div>}</div></div>; }
function ReleaseModal({ agreement, chain, decision, manifest, walletAddress, walletChainId, walletBusy, walletError, stage, transactionHash, onClose, onConnect, onSwitchNetwork, onAuthorize }: { agreement: Agreement; chain: ChainPreview; decision: PolicyDecision | null; manifest: EvidenceManifest | null; walletAddress: string | null; walletChainId: number | null; walletBusy: boolean; walletError: string | null; stage: SettlementStage; transactionHash: string | null; onClose: () => void; onConnect: () => void; onSwitchNetwork: () => void; onAuthorize: () => void }) { const expectedChainId = Number(import.meta.env.VITE_XLAYER_CHAIN_ID ?? XLAYER_TESTNET_CHAIN_ID); const [detailsOpen, setDetailsOpen] = useState(false); const signed = ["submitted", "confirming", "confirmed", "unknown"].includes(stage); const canAuthorize = detailsOpen && Boolean(walletAddress) && walletChainId === expectedChainId && !walletBusy && !signed; return <Modal title={signed ? stageTitle(stage) : "Ready to release"} eyebrow={signed ? "Settlement lifecycle" : "Human authorization required"} onClose={signed ? () => undefined : onClose} closeDisabled={signed}><div className="release-modal"><div className="release-lead"><span className="state-mark large pass">✓</span><div><b>{signed ? stageCopy(stage) : "Review the exact transaction before signing."}</b><p>{signed ? (transactionHash ? `Transaction ${shortHash(transactionHash)} is being tracked.` : "ProofFlow is tracking the settlement state.") : "This action is irreversible once the vault accepts it."}</p></div></div><div className="release-summary"><InfoRow label="Agreement" value={agreement.title} /><InfoRow label="Amount" value={`${formatUnits(chain.transactions.release.value)} XLAY`} /><InfoRow label="Recipient" value={chain.vault.recipient} mono /><InfoRow label="Network" value={`X Layer testnet · chain ${chain.network.chainId}`} /><InfoRow label="Vault contract" value={chain.vault.address} mono /></div><details className="technical-details comprehension" open={detailsOpen} onToggle={(event) => setDetailsOpen((event.currentTarget as HTMLDetailsElement).open)}><summary>I understand what will be authorized</summary><div className="technical-body"><p className="form-note">The transaction releases the displayed amount from the displayed vault to the displayed recipient. ProofFlow cannot change the recipient or amount after this preview.</p><InfoRow label="Evidence manifest" value={manifest ? shortHash(manifest.manifestHash) : "Not available"} mono /><InfoRow label="Policy" value={decision ? `${decision.policyVersion} · ${shortHash(decision.policyHash)}` : "Not available"} mono /></div></details>{walletError && <div className="form-error" role="alert">{walletError}</div>}{!walletAddress ? <button className="button secondary full-button" onClick={onConnect}>Connect Wallet</button> : walletChainId !== expectedChainId ? <button className="button secondary full-button" onClick={onSwitchNetwork}>Switch wallet to X Layer</button> : null}<div className="modal-actions"><button type="button" className="button secondary" onClick={onClose} disabled={signed}>Cancel</button><button type="button" className="button primary" disabled={!canAuthorize} onClick={onAuthorize}>{walletBusy ? "Waiting for wallet…" : signed ? stageTitle(stage) : "Authorize release in wallet"}</button></div></div></Modal>; }
function SkeletonRows() { return <div className="skeleton-rows" aria-label="Loading"><span /><span /><span /></div>; }
function EmptyState({ title, copy }: { title: string; copy: string }) { return <div className="empty-state"><span className="empty-orbit" aria-hidden="true">○</span><b>{title}</b><p>{copy}</p><button className="empty-action" type="button" onClick={() => document.querySelector<HTMLElement>(".create-side")?.click()}>Create an agreement <span aria-hidden="true">↗</span></button></div>; }
function AppErrorBoundary({ children }: { children: ReactNode }) { return <>{children}</>; }

function Modal({ title, eyebrow, onClose, closeDisabled = false, children }: { title: string; eyebrow: string; onClose: () => void; closeDisabled?: boolean; children: ReactNode }) { const modalRef = useRef<HTMLElement | null>(null); useEffect(() => { const previous = document.activeElement as HTMLElement | null; modalRef.current?.querySelector<HTMLElement>("button, input, select, textarea, summary")?.focus(); const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !closeDisabled) onClose(); }; document.addEventListener("keydown", onKey); return () => { document.removeEventListener("keydown", onKey); previous?.focus?.(); }; }, [closeDisabled, onClose]); return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !closeDisabled) onClose(); }}><section className="modal" ref={modalRef} role="dialog" aria-modal="true" aria-labelledby="modal-title"><button className="modal-close" aria-label="Close dialog" disabled={closeDisabled} onClick={onClose}>×</button><span className="eyebrow">{eyebrow}</span><h2 id="modal-title">{title}</h2>{children}</section></div>; }
function ModalActions({ onClose, busy, submitLabel }: { onClose: () => void; busy: boolean; submitLabel: string }) { return <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button type="submit" className="button primary" disabled={busy}>{busy ? "Working…" : submitLabel}</button></div>; }
function Field({ id, label, value, onChange, placeholder, helper, error, required = false, textarea = false, select = false, options = [], type = "text", autoFocus = false, min, max, step }: { id?: string; label: string; value: string; onChange: (value: string) => void; placeholder?: string; helper?: string; error?: string; required?: boolean; textarea?: boolean; select?: boolean; options?: string[]; type?: string; autoFocus?: boolean; min?: string; max?: string; step?: string }) {
  const describedBy = [helper && `${id ?? label}-help`, error && `${id ?? label}-error`].filter(Boolean).join(" ") || undefined;
  return <label className={`field ${error ? "has-error" : ""}`}><span>{label}{required && <i aria-hidden="true">*</i>}</span>{select ? <select id={id} value={value} onChange={(event) => onChange(event.target.value)} required={required} aria-invalid={Boolean(error)} aria-describedby={describedBy} autoFocus={autoFocus}>{options.map((option) => <option value={option} key={option}>{option.replaceAll("_", " ")}</option>)}</select> : textarea ? <textarea id={id} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} required={required} rows={4} aria-invalid={Boolean(error)} aria-describedby={describedBy} autoFocus={autoFocus} /> : <input id={id} type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} required={required} aria-invalid={Boolean(error)} aria-describedby={describedBy} autoFocus={autoFocus} min={min} max={max} step={step} />}{helper && <small id={`${id ?? label}-help`} className="field-help">{helper}</small>}{error && <small id={`${id ?? label}-error`} className="field-error" role="alert">{error}</small>}</label>;
}

function baseUnitsFromDisplay(value: string): string {
  const normalized = value.trim();
  if (!/^\d+(\.\d{0,18})?$/.test(normalized)) return "";
  const parts = normalized.split(".");
  const whole = parts[0] ?? "0";
  const fraction = parts[1] ?? "";
  return (BigInt(whole) * 1_000_000_000_000_000_000n + BigInt(fraction.padEnd(18, "0") || "0")).toString();
}
function formatUnits(value: string | bigint) { const raw = BigInt(value); const units = Number(raw) / 1e18; return units >= 1 ? units.toLocaleString("en-US", { maximumFractionDigits: 4 }) : raw.toString(); }
function shortAddress(value: string) { return value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "—"; }
function shortHash(value: string) { return value ? `${value.slice(0, 10)}…${value.slice(-8)}` : "—"; }
function formatDate(value: string) { return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); }
function relativeTime(value: string) { const diff = Date.now() - new Date(value).getTime(); const minutes = Math.max(1, Math.round(diff / 60000)); return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`; }
function stateLabel(state: Agreement["state"]) { return state.replaceAll("_", " ").toLowerCase().replace(/(^| )\S/g, (letter) => letter.toUpperCase()); }
function lifecycleLabel(state: Agreement["state"]) { const labels: Partial<Record<Agreement["state"], string>> = { AWAITING_FUNDING: "Terms published", FUNDED: "Vault funded", EVIDENCE_SUBMITTED: "Evidence submitted", UNDER_REVIEW: "AI review", READY_TO_RELEASE: "Wallet authorization", RELEASED: "X Layer confirmed" }; return labels[state] ?? stateLabel(state); }
function lifecycleStageFor(state: Agreement["state"]) { const stages: Partial<Record<Agreement["state"], string>> = { AWAITING_FUNDING: "Agreement created · waiting for vault funding", FUNDED: "Agreement funded · evidence is the next move", EVIDENCE_SUBMITTED: "Evidence submitted · ready for bounded review", UNDER_REVIEW: "AI review running · policy remains the authority", REVIEWED: "Review complete · inspect the deterministic decision", READY_TO_RELEASE: "Policy passed · wallet authorization is required", RELEASED: "Receipt confirmed · settlement is complete", BLOCKED: "Policy blocked settlement · inspect the reasons", DISPUTED: "Dispute opened · settlement is paused" }; return stages[state] ?? "Lifecycle state requires inspection"; }
function stateIcon(state: Agreement["state"]) { return ["READY_TO_RELEASE", "RELEASED", "FUNDED"].includes(state) ? "✓" : ["BLOCKED", "DISPUTED"].includes(state) ? "!" : ["UNDER_REVIEW", "EVIDENCE_SUBMITTED"].includes(state) ? "◌" : "·"; }
function stateTone(state: Agreement["state"]) { return state === "READY_TO_RELEASE" || state === "RELEASED" || state === "FUNDED" ? "pass" : state === "BLOCKED" || state === "DISPUTED" ? "danger" : state === "UNDER_REVIEW" || state === "EVIDENCE_SUBMITTED" ? "warning" : "pending"; }
function stateTitle(state: Agreement["state"]) { return state === "READY_TO_RELEASE" ? "Ready to release" : stateLabel(state); }
function stateCopy(state: Agreement["state"]) { const copy: Partial<Record<Agreement["state"], string>> = { READY_TO_RELEASE: "Evidence is present, the review is complete, and deterministic policy conditions pass. Review the exact release before signing.", UNDER_REVIEW: "A human should inspect the review result before any settlement intent is created.", AWAITING_FUNDING: "Fund the vault before the recipient can submit evidence.", EVIDENCE_SUBMITTED: "Evidence is ready for a bounded AI review.", RELEASED: "The settlement has been confirmed by the protocol." }; return copy[state] ?? "ProofFlow is waiting for the next valid lifecycle event."; }
function nextAction(state: Agreement["state"]) { return state === "AWAITING_FUNDING" ? "Fund agreement" : state === "FUNDED" ? "Submit evidence" : state === "EVIDENCE_SUBMITTED" ? "Run review" : state === "READY_TO_RELEASE" ? "Review release" : "Inspect details"; }
function priorityReason(state: Agreement["state"]) { return state === "BLOCKED" ? "Blocked — inspect policy" : state === "DISPUTED" ? "Disputed — review" : state === "UNDER_REVIEW" ? "Human review needed" : state === "EVIDENCE_SUBMITTED" ? "Run policy review" : state === "AWAITING_FUNDING" ? "Fund vault" : "Monitor settlement"; }
function sortPriority(agreements: Agreement[]) { const weight: Record<string, number> = { BLOCKED: 0, DISPUTED: 1, UNDER_REVIEW: 2, EVIDENCE_SUBMITTED: 3, AWAITING_FUNDING: 4, READY_TO_RELEASE: 5, RELEASED: 6 }; return [...agreements].sort((a, b) => (weight[a.state] ?? 9) - (weight[b.state] ?? 9)); }
function stageTitle(stage: SettlementStage) { const labels: Record<SettlementStage, string> = { idle: "Settlement idle", preparing: "Preparing settlement", ready: "Ready for review", awaiting_wallet: "Confirm in wallet", submitted: "Submitted to X Layer", confirming: "Confirming receipt", confirmed: "Verified on X Layer", failed: "Settlement failed", unknown: "Confirmation uncertain" }; return labels[stage]; }
function stageCopy(stage: SettlementStage) { const copy: Record<SettlementStage, string> = { idle: "", preparing: "Checking the exact intent and network.", ready: "Ready for your review.", awaiting_wallet: "Confirm the exact transaction in your wallet.", submitted: "Transaction submitted; receipt not final yet.", confirming: "ProofFlow is checking the receipt and release event.", confirmed: "Verified receipt reconciled on X Layer.", failed: "The chain did not confirm this release.", unknown: "Confirmation uncertain. Refresh before retrying." }; return copy[stage]; }
function stageIcon(stage: SettlementStage) { return stage === "confirmed" ? "✓" : stage === "failed" ? "!" : stage === "unknown" ? "?" : stage === "submitted" || stage === "confirming" ? "◌" : "·"; }

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(<StrictMode><WagmiProvider config={wagmiConfig}><QueryClientProvider client={queryClient}><AppKitProvider projectId={import.meta.env.VITE_REOWN_PROJECT_ID ?? ""} networks={walletAppKit.options.networks} adapters={[walletAppKit.chainAdapters.eip155].filter(Boolean) as never}><AppErrorBoundary><App /><Analytics /></AppErrorBoundary></AppKitProvider></QueryClientProvider></WagmiProvider></StrictMode>);

function CreateAgreementModal({ onClose, onCreated, walletAddress }: { onClose: () => void; onCreated: (agreement: Agreement) => Promise<void>; walletAddress: string | null }) {
  const evidenceOptions: Array<{ type: EvidenceType; label: string; description: string }> = [
    { type: "invoice", label: "Invoice", description: "Confirms the agreed invoice exists." },
    { type: "purchase_order", label: "Purchase order", description: "Confirms the purchase was formally requested." },
    { type: "signed_approval", label: "Signed approval", description: "Confirms the required person approved the work." },
    { type: "delivery_receipt", label: "Delivery receipt", description: "Confirms the goods or service were delivered." },
    { type: "api_response", label: "API response", description: "Confirms the required system response was received." },
    { type: "status_update", label: "Status update", description: "Confirms the expected status was reached." },
  ];
  const nativeTokenAddress = "0x0000000000000000000000000000000000000000";
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [draft, setDraft] = useState<AgreementDraft>({ title: "", description: "", payer: walletAddress ?? "", recipient: "", tokenAddress: nativeTokenAddress, amountBaseUnits: "", deadline: "", evidenceTypes: [], minimumConfidenceBps: 9000, releaseAmountBaseUnits: "", policyVersion: "proof-v1" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (walletAddress && !draft.payer) update("payer", walletAddress);
  }, [walletAddress]);

  const update = <K extends keyof AgreementDraft>(key: K, value: AgreementDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => { const next = { ...current }; delete next[key]; return next; });
    setError(null);
  };
  const setStepAndFocus = (next: 1 | 2 | 3 | 4) => { setError(null); setStep(next); window.setTimeout(() => document.getElementById(`agreement-step-${next}`)?.focus(), 0); };
  const toggleEvidence = (type: EvidenceType) => update("evidenceTypes", draft.evidenceTypes.includes(type) ? draft.evidenceTypes.filter((item) => item !== type) : [...draft.evidenceTypes, type]);
  const amountBaseUnits = baseUnitsFromDisplay(draft.amountBaseUnits);
  const policy = { version: draft.policyVersion.trim(), requiredEvidence: draft.evidenceTypes, minimumConfidenceBps: draft.minimumConfidenceBps, releaseAmountBaseUnits: amountBaseUnits, deadline: draft.deadline ? new Date(draft.deadline).toISOString() : "" };
  const body = { title: draft.title.trim(), description: draft.description.trim(), payer: draft.payer.trim(), recipient: draft.recipient.trim(), tokenAddress: nativeTokenAddress, amountBaseUnits, deadline: policy.deadline, policy };

  function validateAddress(value: string, label: string): string | null { return /^0x[a-fA-F0-9]{40}$/.test(value.trim()) ? null : `Enter a valid ${label.toLowerCase()} wallet address.`; }
  function validateCurrentStep(): boolean {
    const next: Record<string, string> = {};
    if (step === 1) {
      if (!draft.title.trim()) next.title = "Add a name for this agreement.";
      if (!draft.description.trim()) next.description = "Tell us what needs to be completed.";
      if (draft.description.trim().length > 1000) next.description = "Keep the description under 1,000 characters.";
    }
    if (step === 2) {
      const payerError = validateAddress(draft.payer, "payer");
      const recipientError = validateAddress(draft.recipient, "recipient");
      if (payerError) next.payer = payerError;
      if (recipientError) next.recipient = recipientError;
      if (!amountBaseUnits || BigInt(amountBaseUnits) <= 0n) next.amountBaseUnits = "Enter an amount greater than zero.";
      if (!draft.deadline || Number.isNaN(new Date(draft.deadline).getTime()) || new Date(draft.deadline).getTime() <= Date.now()) next.deadline = "Choose a future deadline.";
    }
    if (step === 3 && draft.evidenceTypes.length === 0) next.evidenceTypes = "Select at least one proof requirement.";
    setFieldErrors(next);
    setError(Object.keys(next).length ? "Check the highlighted fields before continuing." : null);
    return Object.keys(next).length === 0;
  }

  async function publish(event: FormEvent) {
    event.preventDefault();
    if (!validateCurrentStep()) return;
    setBusy(true); setError(null);
    try {
      const agreement = await api<Agreement>("/api/v1/agreements", { method: "POST", body: JSON.stringify(body) });
      await onCreated(agreement);
    } catch (cause) {
      const apiError = cause as Error & { fields?: Record<string, string[]> };
      const mapped = Object.fromEntries(Object.entries(apiError.fields ?? {}).map(([key, messages]) => [key.replace(/^policy\./, ""), messages[0] ?? "Check this value."]));
      setFieldErrors(mapped);
      setError(apiError.message || "Agreement could not be published.");
    } finally { setBusy(false); }
  }

  return <Modal title="Create your agreement" eyebrow={`New agreement · step ${step} of 4`} onClose={onClose}>
    <div className="wizard-progress" aria-label="Agreement creation progress">
      {([1, 2, 3, 4] as const).map((item) => <button key={item} type="button" id={`agreement-step-${item}`} className={`wizard-tab wizard-tab-${item} ${step === item ? "active" : step > item ? "complete" : "upcoming"}`} aria-current={step === item ? "step" : undefined} onClick={() => item < step && setStepAndFocus(item)} disabled={item > step}><b>0{item}</b><strong>{["Details", "Participants", "Proof", "Review"][item - 1]}</strong><small>{step === item ? `Step ${item} of 4` : step > item ? "Complete" : "Next"}</small></button>)}
    </div>
    <form className={`modal-form agreement-wizard-form wizard-step-${step}`} onSubmit={(event) => void (step === 4 ? publish(event) : undefined)} noValidate>
      {step === 1 && <>
        <div className="wizard-intro"><b>Start by telling us what this agreement is about.</b><p>Use plain language. You can review everything before anything is published.</p></div>
        <Field id="agreement-title" label="Agreement name" value={draft.title} placeholder="e.g. Website launch — milestone 01" helper="Give this agreement a name that both sides will recognize." error={fieldErrors.title} onChange={(value) => update("title", value)} autoFocus required />
        <Field id="agreement-description" label="Description" value={draft.description} placeholder="What needs to be completed before payment can be released?" helper="Describe the work, service, or commitment covered by this agreement." error={fieldErrors.description} textarea onChange={(value) => update("description", value)} required />
        <div className="wizard-explanation"><span className="wizard-explanation-icon">i</span><p>You will choose who is involved, how much is being paid, and what must be proven before payment can be released.</p></div>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button type="button" className="button primary" onClick={() => validateCurrentStep() && setStepAndFocus(2)}>Continue</button></div>
      </>}
      {step === 2 && <>
        <div className="wizard-intro"><b>Tell us who is involved and what is being paid.</b><p>The payer provides the funds. The recipient receives them when the agreement is successfully completed.</p></div>
        <div className="wizard-section-heading"><span>Participants</span><small>Wallet addresses are checked before you continue.</small></div>
        <div className="form-grid participants-grid"><Field id="agreement-payer" label="Payer" value={draft.payer} placeholder="0x…" helper={walletAddress ? "Your connected wallet is ready to use as the payer." : "The wallet providing the funds."} error={fieldErrors.payer} onChange={(value) => update("payer", value)} required /><Field id="agreement-recipient" label="Recipient" value={draft.recipient} placeholder="0x…" helper="The wallet that receives the funds when the agreement is completed." error={fieldErrors.recipient} onChange={(value) => update("recipient", value)} required /></div>
        <div className="wizard-section-heading payment-heading"><span>Payment</span><small>Amounts are shown in XLAY. ProofFlow handles the blockchain units for you.</small></div>
        <div className="form-grid payment-grid"><Field id="agreement-amount" label="Amount" value={draft.amountBaseUnits} placeholder="e.g. 10" helper="The full amount held for this agreement." error={fieldErrors.amountBaseUnits} type="number" min="0" step="any" onChange={(value) => update("amountBaseUnits", value)} required /><div className="asset-readonly"><span>Token</span><strong>XLAY</strong><small>Native X Layer token</small></div></div>
        <Field id="agreement-deadline" label="Deadline" value={draft.deadline} helper="Choose when the agreement should be completed." error={fieldErrors.deadline} type="datetime-local" onChange={(value) => update("deadline", value)} required />
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="modal-actions"><button type="button" className="button secondary" onClick={() => setStepAndFocus(1)}>Back</button><button type="button" className="button primary" onClick={() => validateCurrentStep() && setStepAndFocus(3)}>Continue</button></div>
      </>}
      {step === 3 && <>
        <div className="wizard-intro"><b>Choose what needs to be proven.</b><p>Payment cannot be released until the required evidence has been reviewed.</p></div>
        <fieldset className="evidence-options" aria-describedby="evidence-help"><legend>Proof requirements</legend><p id="evidence-help" className="form-note">Select every item that must be available before payment can be released.</p><div className="evidence-option-grid">{evidenceOptions.map(({ type, label, description }) => <label className={`evidence-option evidence-option-${type} ${draft.evidenceTypes.includes(type) ? "selected" : ""}`} key={type}><input type="checkbox" checked={draft.evidenceTypes.includes(type)} onChange={() => toggleEvidence(type)} /><span><b>{label}</b><small>{description}</small><em>{draft.evidenceTypes.includes(type) ? "Selected" : "Choose"}</em></span></label>)}</div>{fieldErrors.evidenceTypes && <div className="field-error" role="alert">{fieldErrors.evidenceTypes}</div>}<div className="evidence-count" aria-live="polite">{draft.evidenceTypes.length} {draft.evidenceTypes.length === 1 ? "requirement" : "requirements"} selected</div></fieldset>
        <details className="advanced-settings"><summary>Advanced verification settings <span>Optional</span></summary><div className="advanced-settings-body"><p>These settings control how ProofFlow evaluates evidence before allowing settlement.</p><Field id="agreement-policy-version" label="Policy version" value={draft.policyVersion} placeholder="proof-v1" helper="Keep the default unless you have a versioned policy." onChange={(value) => update("policyVersion", value)} required /><Field id="agreement-confidence" label="Minimum confidence" value={String(draft.minimumConfidenceBps / 100)} type="number" min="0" max="100" step="1" helper="Evidence reviews must meet this confidence level." onChange={(value) => update("minimumConfidenceBps", Math.round(Number(value) * 100))} required /></div></details>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="modal-actions"><button type="button" className="button secondary" onClick={() => setStepAndFocus(2)}>Back</button><button type="button" className="button primary" onClick={() => validateCurrentStep() && setStepAndFocus(4)}>Review agreement</button></div>
      </>}
      {step === 4 && <>
        <div className="wizard-intro"><b>Everything below will be locked when you publish.</b><p>Review the details carefully. You can edit any section without starting over.</p></div>
        <ReviewSection title="Agreement" onEdit={() => setStepAndFocus(1)}><InfoRow label="Name" value={body.title} /><InfoRow label="Description" value={body.description} /><InfoRow label="Deadline" value={formatDate(body.deadline)} /></ReviewSection>
        <ReviewSection title="Payment" onEdit={() => setStepAndFocus(2)}><InfoRow label="Amount" value={`${draft.amountBaseUnits} XLAY`} /><InfoRow label="Token" value="XLAY · native X Layer token" /></ReviewSection>
        <ReviewSection title="Participants" onEdit={() => setStepAndFocus(2)}><InfoRow label="Payer" value={shortAddress(body.payer)} mono /><InfoRow label="Recipient" value={shortAddress(body.recipient)} mono /></ReviewSection>
        <ReviewSection title="Proof requirements" onEdit={() => setStepAndFocus(3)}><InfoRow label="Selected evidence" value={draft.evidenceTypes.map((type) => evidenceOptions.find((item) => item.type === type)?.label ?? type).join(", ")} /><p className="review-helper">Payment cannot be released until the required evidence has been reviewed.</p></ReviewSection>
        <ReviewSection title="Verification" onEdit={() => setStepAndFocus(3)}><InfoRow label="Policy" value={draft.policyVersion} /><InfoRow label="Confidence requirement" value={`${(draft.minimumConfidenceBps / 100).toFixed(0)}% minimum`} /></ReviewSection>
        <div className="publish-warning"><span>!</span><p><b>Publishing locks these agreement terms.</b> ProofFlow evaluates the required evidence, but it does not independently control your wallet. Your explicit wallet approval is always required before funds move.</p></div>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="modal-actions"><button type="button" className="button secondary" onClick={() => setStepAndFocus(3)}>Back</button><button type="submit" className="button primary" disabled={busy}>{busy ? "Publishing…" : "Publish agreement"}</button></div>
      </>}
    </form>
  </Modal>;
}

function ReviewSection({ title, onEdit, children }: { title: string; onEdit: () => void; children: ReactNode }) { return <section className="review-section"><div className="review-section-heading"><h3>{title}</h3><button type="button" className="text-button" onClick={onEdit}>Edit</button></div><div className="review-section-body">{children}</div></section>; }

function EvidenceModal({ agreement, onClose, onSubmitted }: { agreement: Agreement; onClose: () => void; onSubmitted: () => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null); const [type, setType] = useState<EvidenceType>(agreement.policy.requiredEvidence[0] ?? "status_update"); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) { event.preventDefault(); if (!file) { setError("Choose an evidence file before submitting."); return; } setBusy(true); setError(null); const form = new FormData(); form.set("evidenceType", type); form.set("submittedBy", agreement.recipient); form.set("file", file); try { await api(`/api/v1/agreements/${agreement.id}/evidence/upload`, { method: "POST", body: form, headers: {} }); await onSubmitted(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Evidence could not be uploaded."); } finally { setBusy(false); } }
  return <Modal title="Upload evidence" eyebrow={`${agreement.title} · scanned ingestion`} onClose={onClose}><form className="modal-form" onSubmit={(event) => void submit(event)}><Field label="Evidence type" value={type} select options={agreement.policy.requiredEvidence} onChange={(value) => setType(value as EvidenceType)} /><label className="field"><span>Evidence file</span><input type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} required /></label><div className="upload-note"><b>Controlled intake</b><p>ProofFlow validates the type, hashes the bytes, and scans before the evidence joins the manifest. Instructions inside documents are treated as untrusted content, never as system rules.</p></div>{error && <div className="form-error" role="alert">{error}</div>}<ModalActions onClose={onClose} busy={busy} submitLabel="Scan and submit evidence" /></form></Modal>;
}
