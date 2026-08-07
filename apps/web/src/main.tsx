import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { JobState, evaluateReleaseGate } from "@proofflow/domain";
import "./styles.css";

const sampleGate = evaluateReleaseGate({
  manifestIntegrity: true,
  observation: {
    requiredEvidencePresent: true,
    extractedFacts: [{ key: "delivery_status", value: "complete", source: "invoice.pdf" }],
    contradictions: [],
    missingItems: [],
    confidence: 0.94
  },
  deterministicRulesPass: true,
  agreementState: JobState.FUNDED,
  milestoneStatus: "REVIEWED",
  humanOverride: false,
  policyVersion: "invoice-v1",
  evaluatedAt: new Date().toISOString()
});

function App() {
  return (
    <main className="shell">
      <nav className="nav">
        <div className="brand"><span className="brand-mark">P</span><span>ProofFlow</span></div>
        <div className="nav-links"><a href="#how">How it works</a><a href="#security">Trust model</a><button className="button button-dark">Open console <span>↗</span></button></div>
      </nav>

      <section className="hero">
        <div className="eyebrow"><span className="pulse" /> AI-assisted onchain settlement</div>
        <h1>Proof before<br /><em>payment.</em></h1>
        <p className="hero-copy">ProofFlow turns real-world work into verifiable onchain payments. Evidence is reviewed by AI, constrained by deterministic policy, and settled on X Layer.</p>
        <div className="hero-actions"><button className="button button-primary">Create an agreement <span>→</span></button><a className="text-link" href="#how">See the workflow <span>↓</span></a></div>
        <div className="hero-proof"><div className="proof-line" /><span>Built for the moment trust gets expensive</span></div>
      </section>

      <section className="signal-grid" id="security">
        <div className="signal-card signal-large"><div className="card-label">Settlement status <span className="status-dot">●</span></div><div className="settlement-value">$4,280.00 <span>USDC</span></div><div className="settlement-meta"><span>Milestone 02 / 03</span><strong>Ready to release</strong></div><div className="progress"><span /></div><div className="receipt"><span className="receipt-icon">✓</span><div><strong>Evidence verified</strong><small>invoice.pdf · 2 minutes ago</small></div><span className="confidence">94%</span></div></div>
        <div className="signal-card policy-card"><div className="card-label">Policy engine</div><div className="policy-title">Rules, not vibes.</div><p>AI interprets evidence. Deterministic policy decides what happens next.</p><div className="rule"><span className="rule-check">✓</span><span>Required evidence present</span><strong>PASS</strong></div><div className="rule"><span className="rule-check">✓</span><span>Deadline within terms</span><strong>PASS</strong></div><div className="rule"><span className="rule-check">✓</span><span>Amount within cap</span><strong>PASS</strong></div><div className="policy-footer">Policy <code>invoice-v1</code> <span>·</span> hash anchored</div></div>
        <div className="signal-card chain-card"><div className="card-label">On X Layer</div><div className="chain-orbit"><div className="orbit-ring ring-one" /><div className="orbit-ring ring-two" /><div className="x-badge">X</div></div><div className="chain-stats"><div><strong>196</strong><span>chain ID</span></div><div><strong>0.01s</strong><span>finality target</span></div><div><strong>100%</strong><span>auditable</span></div></div></div>
      </section>

      <section className="workflow" id="how"><div className="section-kicker">The trust execution loop</div><h2>From promise to proof<br />in one <em>clean loop.</em></h2><div className="steps"><Step num="01" title="Set the terms" copy="Create a milestone agreement with a versioned policy, a deadline, and a clear amount." /><Step num="02" title="Submit evidence" copy="The recipient uploads a tamper-evident manifest of the work they completed." /><Step num="03" title="Review with context" copy="An AI reviewer extracts facts and flags uncertainty without holding the keys." /><Step num="04" title="Settle with proof" copy="A deterministic gate authorizes release only when every condition passes." /></div></section>

      <section className="proof-panel"><div><div className="section-kicker">A receipt you can verify</div><h2>Trust should leave<br /><em>a trail.</em></h2><p>Every decision carries its inputs: evidence hashes, policy version, review result, and the X Layer transaction. No black boxes. No “trust me.”</p><button className="button button-light">View sample receipt <span>↗</span></button></div><div className="receipt-large"><div className="receipt-top"><span>PROOF RECEIPT</span><span className="receipt-chain">X LAYER / 196</span></div><div className="receipt-status"><span className="big-check">✓</span><div><small>Settlement authorized</small><strong>Milestone 02 released</strong></div></div><div className="receipt-rows"><div><span>Agreement</span><code>agr_8f2...d21</code></div><div><span>Evidence manifest</span><code>0x3a9...e7b</code></div><div><span>Policy version</span><code>invoice-v1</code></div><div><span>Transaction</span><code>0x7c1...a92 ↗</code></div></div></div></section>

      <section className="closing"><div className="section-kicker">The protocol for autonomous commerce</div><h2>When work is real,<br />payment can be <em>programmable.</em></h2><p>Start with one reliable workflow. Build the trust layer that every autonomous business will need.</p><button className="button button-primary">Build with ProofFlow <span>→</span></button></section>
      <footer><div className="brand"><span className="brand-mark">P</span><span>ProofFlow</span></div><span>AI-assisted. Human-accountable. Onchain.</span><span>© 2026</span></footer>
    </main>
  );
}

function Step({ num, title, copy }: { num: string; title: string; copy: string }) {
  return <article className="step"><span className="step-num">{num}</span><h3>{title}</h3><p>{copy}</p><span className="step-arrow">↗</span></article>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

void sampleGate;
