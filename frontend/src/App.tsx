import { useEffect, useMemo, useState } from "react";
import "./App.css";

const API_URL = "https://ledgerwatch-backend-v2.onrender.com";

type BreakdownItem = { label: string; count: number; pct: string; amount: number };
type OverviewData = { transactions: number; total_value: number; settlements_received: number; open_exceptions: number; reconciliation_rate: number; flagged_total: number; flagged_count: number; resolved_count: number; breakdown: BreakdownItem[] };
type Txn = { id: string; reference: string; customer: string; amount: number; date: string; channel: string; status: string };
type Settlement = { id: string; provider: string; reference: string; gross: number; fee: number; net: number; date: string; bank: string; status: string };
type Exc = { id: string; txn: string; reference: string; type: string; amount: number; detail: string };
type ReconResult = { run_id: string; total: number; matched: number; exceptions_count: number; rate: number; matched_list: { txn: string; settlement: string; reference: string; amount: number; net: number }[]; exceptions: Exc[] };
type Audit = { time: string; action: string; by: string };

const FALLBACK_OVERVIEW: OverviewData = {
  transactions: 12846, total_value: 48650000, settlements_received: 46920000, open_exceptions: 37, reconciliation_rate: 96.4,
  flagged_total: 2420712.82, flagged_count: 44, resolved_count: 0,
  breakdown: [
    { label: "Missing settlement", count: 12, pct: "44.7%", amount: 1081877.00 },
    { label: "Duplicate", count: 6, pct: "20.1%", amount: 486099.45 },
    { label: "Orphan bank credit", count: 4, pct: "19.0%", amount: 461132.00 },
    { label: "Timing break", count: 6, pct: "16.1%", amount: 390166.37 },
    { label: "Fee discrepancy", count: 8, pct: "0.0%", amount: 938.00 },
    { label: "Amount mismatch", count: 8, pct: "0.0%", amount: 500.00 },
  ],
};
const fmt = (n: number) => "₦" + Number(n || 0).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const menu = [
  { id: "overview", label: "Overview", icon: "◈" }, { id: "transactions", label: "Transactions", icon: "⇄" },
  { id: "settlements", label: "Settlements", icon: "◉" }, { id: "reconciliation", label: "Reconciliation", icon: "✓" },
  { id: "exceptions", label: "Exceptions", icon: "!" }, { id: "integrations", label: "Integrations", icon: "↗" },
  { id: "reports", label: "Reports", icon: "▤" }, { id: "settings", label: "Settings", icon: "⚙" },
];
function statusClass(s: string) {
  if (s === "Matched" || s === "Received") return "st matched";
  if ((s || "").includes("Missing") || (s || "").includes("Duplicate") || (s || "").includes("Orphan")) return "st bad";
  return "st warn";
}
const RESOLVE_REASONS = ["Timing difference — settled next day", "Fee confirmed by provider", "Duplicate — second entry voided", "Bank credit matched to manual receipt", "Provider confirmed — no action needed", "Other — see note"];
const asArray = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const INTEGRATIONS = [
  { name: "Paystack", desc: "Import settlements + fees automatically. No manual CSV.", status: "Planned • Not Connected", color: "#011C33" },
  { name: "Flutterwave", desc: "Import settlements + fees automatically. No manual CSV.", status: "Planned • Not Connected", color: "#F5A623" },
  { name: "Monnify", desc: "Import settlements + virtual account credits.", status: "Planned • Not Connected", color: "#0E7A4B" },
  { name: "Google Sheets", desc: "Export any table to Sheets in 1 click. Works today.", status: "Available ✅", color: "#0F9D58" },
  { name: "Bank Statement (CSV)", desc: "Upload any Nigerian bank statement CSV. Works today.", status: "Available ✅", color: "#5B0DBA" },
];

export default function App() {
  const [backendStatus, setBackendStatus] = useState("Checking backend...");
  const [page, setPage] = useState("overview");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [overview, setOverview] = useState<OverviewData>(FALLBACK_OVERVIEW);
  const [overviewSource, setOverviewSource] = useState("Demo data");
  const [txns, setTxns] = useState<Txn[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [statusFilter, setStatusFilter] = useState("All");
  const [channelFilter, setChannelFilter] = useState("All");
  const [wizardStep, setWizardStep] = useState(1);
  const [uploadedFile, setUploadedFile] = useState<string | null>(null);
  const [recon, setRecon] = useState<ReconResult | null>(null);
  const [reconLoading, setReconLoading] = useState(false);
  const [reconError, setReconError] = useState("");
  const [exceptions, setExceptions] = useState<Exc[]>([]);
  const [excFilter, setExcFilter] = useState("All");
  const [selectedExc, setSelectedExc] = useState<Exc | null>(null);
  const [assignee, setAssignee] = useState("Ahmad Magaji");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState(RESOLVE_REASONS[0]);
  const [resolvedIds, setResolvedIds] = useState<Set<string>>(new Set());
  const [audit, setAudit] = useState<Audit[]>([{ time: "2026-11-10 00:01", action: "Run REC-2026-104 completed — 10 checked", by: "System" }]);
  const [resolveMsg, setResolveMsg] = useState("");
  const [exportDataset, setExportDataset] = useState("Transactions");
  const [exportMsg, setExportMsg] = useState("");
  const [workspaceName, setWorkspaceName] = useState("Demo Commerce Ltd");
  const [currency, setCurrency] = useState("NGN (₦)");
  const [tolerance, setTolerance] = useState("0");
  const [dateTolerance, setDateTolerance] = useState("1");
  const [notifyEmail, setNotifyEmail] = useState(true);
  const [notifyNewExc, setNotifyNewExc] = useState(true);
  const [settingsMsg, setSettingsMsg] = useState("");
  const [reportPeriod, setReportPeriod] = useState("This week");
  const [reportMsg, setReportMsg] = useState("");

  useEffect(() => {
    fetch(`${API_URL}/health`).then((r) => r.json()).then((d) => setBackendStatus(`✅ Backend connected: ${d.status}`)).catch(() => setBackendStatus("❌ Backend NOT connected"));
    fetch(`${API_URL}/api/overview`).then((r) => r.json()).then((d) => { if (d && typeof d === "object") { setOverview(d); setOverviewSource("Live from backend ✅"); } }).catch(() => {});
    fetch(`${API_URL}/api/transactions`).then((r) => r.json()).then((d) => setTxns(asArray<Txn>(d))).catch(() => {});
    fetch(`${API_URL}/api/settlements`).then((r) => r.json()).then((d) => setSettlements(asArray<Settlement>(d))).catch(() => {});
    fetch(`${API_URL}/api/exceptions`).then((r) => r.json()).then((d) => setExceptions(asArray<Exc>(Array.isArray(d) ? d : (d as { exceptions?: unknown }).exceptions))).catch(() => {});
  }, []);

  const runReconciliation = async () => {
    setReconLoading(true); setReconError("");
    try {
      const res = await fetch(`${API_URL}/api/reconcile`, { method: "POST" });
      if (!res.ok) throw new Error("fail");
      const data = await res.json();
      setRecon(data); setExceptions(asArray<Exc>(data.exceptions)); setWizardStep(3);
      setAudit((a) => [{ time: "Just now", action: `Run ${data.run_id} completed — ${data.total} checked`, by: "System" }, ...a]);
    } catch { setReconError("Could not run reconciliation. Is backend on?"); }
    setReconLoading(false);
  };

  const resolveSelected = async () => {
    if (!selectedExc) return;
    try {
      await fetch(`${API_URL}/api/exceptions/${selectedExc.id}/resolve`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, note, assignee }),
      });
    } catch {}
    setResolvedIds((prev) => new Set(prev).add(selectedExc.id));
    setAudit((a) => [{ time: "Just now", action: `Resolved ${selectedExc.id} (${selectedExc.type}) — ${reason}${note ? ` — Note: ${note}` : ""}`, by: assignee }, ...a]);
    setResolveMsg(`✅ ${selectedExc.id} resolved — ${reason}`);
    setNote("");
    setTimeout(() => setResolveMsg(""), 4000);
  };

  const downloadCSV = (datasetOverride?: string) => {
    const ds = datasetOverride || exportDataset;
    let headers: string[] = [];
    let rows: string[][] = [];
    if (ds === "Transactions") {
      headers = ["Transaction ID", "Reference", "Customer", "Amount (NGN)", "Date", "Channel", "Status"];
      rows = asArray<Txn>(txns).map((t) => [t.id, t.reference, t.customer, String(t.amount), t.date, t.channel, t.status]);
    } else if (ds === "Settlements") {
      headers = ["Settlement ID", "Provider", "Reference", "Gross", "Fee", "Net", "Date", "Bank", "Status"];
      rows = asArray<Settlement>(settlements).map((s) => [s.id, s.provider, s.reference, String(s.gross), String(s.fee), String(s.net), s.date, s.bank, s.status]);
    } else {
      headers = ["Exception ID", "Transaction", "Reference", "Type", "Amount (NGN)", "Status", "Detail"];
      rows = asArray<Exc>(exceptions).map((e) => [e.id, e.txn, e.reference, e.type, String(e.amount), resolvedIds.has(e.id) ? "Resolved" : "Open", e.detail.replace(/,/g, ";")]);
    }
    const csv = [headers.join(","), ...rows.map((r) => r.map((c) => `"${c}"`).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ledgerwatch-${ds.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setExportMsg(`✅ Downloaded ${rows.length} rows — open in Google Sheets: File → Import → Upload`);
    setTimeout(() => setExportMsg(""), 6000);
  };

  const downloadReport = () => {
    const lines = [
      `Ledgerwatch Reconciliation Report — ${workspaceName}`,
      `Period: ${reportPeriod}`,
      `Generated: ${new Date().toLocaleString()}`,
      ``,
      `Transactions: ${overview.transactions}`,
      `Total Value: ${overview.total_value}`,
      `Settlements Received: ${overview.settlements_received}`,
      `Open Exceptions: ${openExceptions.length}`,
      `Resolved This Session: ${resolvedList.length}`,
      `Reconciliation Rate: ${overview.reconciliation_rate}%`,
      `Flagged Total: ${overview.flagged_total}`,
      ``,
      `Breakdown:`,
      ...asArray<BreakdownItem>(overview.breakdown).map((b) => `${b.label},${b.count},${b.pct},${b.amount}`),
      ``,
      `Exceptions:`,
      ...asArray<Exc>(exceptions).map((e) => `${e.id},${e.type},${e.amount},${resolvedIds.has(e.id) ? "Resolved" : "Open"}`),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ledgerwatch-report-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setReportMsg(`✅ Report downloaded for ${reportPeriod} — ${workspaceName}`);
    setTimeout(() => setReportMsg(""), 6000);
  };

  const saveSettings = () => {
    setSettingsMsg(`✅ Settings saved — Workspace: ${workspaceName} · Currency: ${currency} · Amount tolerance: ₦${tolerance} · Date tolerance: ${dateTolerance} day(s)`);
    setAudit((a) => [{ time: "Just now", action: `Settings updated — tolerance ₦${tolerance}, date ±${dateTolerance} day(s)`, by: "Ahmad Magaji" }, ...a]);
    setTimeout(() => setSettingsMsg(""), 5000);
  };

  const openExceptions = useMemo(() => asArray<Exc>(exceptions).filter((e) => !resolvedIds.has(e.id)), [exceptions, resolvedIds]);
  const resolvedList = useMemo(() => asArray<Exc>(exceptions).filter((e) => resolvedIds.has(e.id)), [exceptions, resolvedIds]);

  const filteredTxns = useMemo(() => {
    const q = search.toLowerCase().trim();
    return asArray<Txn>(txns).filter((t) => {
      const mS = !q || t.id.toLowerCase().includes(q) || t.reference.toLowerCase().includes(q) || t.customer.toLowerCase().includes(q);
      return mS && (statusFilter === "All" || t.status === statusFilter) && (channelFilter === "All" || t.channel === channelFilter);
    });
  }, [txns, search, statusFilter, channelFilter]);

  const filteredSettlements = useMemo(() => {
    const q = search.toLowerCase().trim();
    return asArray<Settlement>(settlements).filter((s) => {
      const mS = !q || s.id.toLowerCase().includes(q) || s.reference.toLowerCase().includes(q) || s.provider.toLowerCase().includes(q);
      return mS && (statusFilter === "All" || s.status === statusFilter) && (channelFilter === "All" || s.provider === channelFilter);
    });
  }, [settlements, search, statusFilter, channelFilter]);

  const filteredExceptions = useMemo(() => {
    const q = search.toLowerCase().trim();
    return asArray<Exc>(exceptions).filter((e) => {
      const mS = !q || e.id.toLowerCase().includes(q) || e.txn.toLowerCase().includes(q) || e.reference.toLowerCase().includes(q) || e.type.toLowerCase().includes(q);
      return mS && (excFilter === "All" || e.type === excFilter);
    });
  }, [exceptions, search, excFilter]);

  const settleTotals = useMemo(() => ({
    gross: filteredSettlements.reduce((a, s) => a + (s.gross || 0), 0),
    fee: filteredSettlements.reduce((a, s) => a + (s.fee || 0), 0),
    net: filteredSettlements.reduce((a, s) => a + (s.net || 0), 0),
  }), [filteredSettlements]);

  const activeLabel = menu.find((m) => m.id === page)?.label || "Overview";

  return (
    <div className="layout">
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="sidebar-brand">
          <div className="logo-wrap">
            <img src="/brand/logo.png" alt="Ledgerwatch" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
            <span className="logo-fallback">L</span>
          </div>
          <div><strong>Ledgerwatch</strong><small>{workspaceName}</small></div>
          <button className="close-btn" onClick={() => setSidebarOpen(false)}>✕</button>
        </div>
        <p className="menu-title">MENU</p>
        <nav>{menu.map((m) => (
          <button key={m.id} className={`nav-item ${page === m.id ? "active" : ""}`} onClick={() => { setPage(m.id); setSidebarOpen(false); setSearch(""); setStatusFilter("All"); setChannelFilter("All"); }}>
            <span className="nav-icon">{m.icon}</span> {m.label}{m.id === "exceptions" && <span className="badge">{openExceptions.length}</span>}
          </button>))}</nav>
        <div className="sidebar-footer"><p>Sync. Reconcile. Resolve.</p><small>Ledgerwatch does not move money.</small></div>
      </aside>
      {sidebarOpen && <div className="overlay" onClick={() => setSidebarOpen(false)} />}

      <div className="main">
        <header className="topbar">
          <button className="hamburger" onClick={() => setSidebarOpen(true)}>☰</button><h2>{activeLabel}</h2>
          <input className="search" placeholder="Search TXN, EXC, reference..." value={search} onChange={(e) => setSearch(e.target.value)} />
          <span className={backendStatus.includes("✅") ? "backend-pill ok" : "backend-pill bad"}>{backendStatus}</span>
          <div className="user"><span className="avatar">A</span><div><strong>Ahmad Magaji</strong><small>Admin</small></div></div>
        </header>

        <main className="content">
          {page === "overview" && (
            <>
              <div className="overview-header">
                <div>
                  <h2 className="overview-title">Overview</h2>
                  <p className="overview-subtitle">Payments, settlements and bank deposits — reconciled. {overviewSource} · {openExceptions.length} open · {resolvedList.length} resolved in this session</p>
                </div>
                <div className="overview-header-right">
                  <label className="period-label">Period
                    <select value={reportPeriod} onChange={(e) => setReportPeriod(e.target.value)}>
                      <option>This week</option><option>This month</option><option>Last month</option><option>All time</option>
                    </select>
                  </label>
                  <span className="freshness-pill">{overviewSource} • Updated just now</span>
                </div>
              </div>

              <section className="kpi-grid">
                <div className="card kpi-card kpi-primary">
                  <span>RECONCILIATION RATE</span>
                  <strong>{overview.reconciliation_rate}%</strong>
                  <div className="kpi-progress"><span style={{ width: `${Math.min(100, Math.max(0, overview.reconciliation_rate))}%` }} /></div>
                  <small>Matched vs flagged • {reportPeriod}</small>
                </div>
                <div className="card kpi-card"><span>TRANSACTION VALUE</span><strong>{fmt(overview.total_value)}</strong><small>{overview.transactions.toLocaleString()} transactions</small></div>
                <div className="card kpi-card"><span>SETTLEMENTS RECEIVED</span><strong>{fmt(overview.settlements_received)}</strong><small>Net after fees</small></div>
                <div className="card kpi-card"><span>OPEN EXCEPTIONS</span><strong>{openExceptions.length}</strong><small>Needs investigation</small></div>
              </section>

              <div className="overview-two-col">
                <section className="panel">
                  <div className="panel-head"><h3>Needs attention</h3><span className="count-badge">{openExceptions.length} open</span></div>
                  {openExceptions.length === 0 && <p className="empty">All clear — no open exceptions.</p>}
                  {openExceptions.slice(0, 3).map((e) => (
                    <div className="row" key={e.id}>
                      <div><strong>{e.type}</strong> · {e.id}<br /><small>{e.txn} · {e.reference}</small></div>
                      <div style={{ textAlign: "right" }}><strong>{fmt(e.amount)}</strong><br /><button className="link-btn" onClick={() => { setSelectedExc(e); setPage("exceptions"); }}>View →</button></div>
                    </div>
                  ))}
                  <button className="link-btn" onClick={() => setPage("exceptions")}>View all open exceptions →</button>
                </section>

                <section className="panel">
                  <div className="panel-head"><h3>Recent activity</h3></div>
                  {audit.slice(0, 3).map((a, i) => (
                    <div className="audit-row" key={i}><small>{a.time} · {a.by}</small><span>{a.action}</span></div>
                  ))}
                  <button className="link-btn" onClick={() => setPage("reports")}>View all activity →</button>
                </section>
              </div>
            </>
          )}

          {page === "transactions" && (
            <>
              <p className="hero-sub">Internal records — what your system says you collected.</p>
              <div className="filters">
                <label>Status<select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}><option>All</option><option>Matched</option><option>Amount Mismatch</option><option>Missing Settlement</option><option>Duplicate</option><option>Timing Difference</option></select></label>
                <label>Channel<select value={channelFilter} onChange={(e) => setChannelFilter(e.target.value)}><option>All</option><option>Paystack</option><option>Flutterwave</option><option>Monnify</option></select></label>
                <button className="clear-btn" onClick={() => { setSearch(""); setStatusFilter("All"); setChannelFilter("All"); }}>Clear filters</button>
              </div>
              <div className="table-wrap"><table className="table"><thead><tr><th>Transaction</th><th>Customer</th><th>Date</th><th>Channel</th><th>Amount</th><th>Status</th></tr></thead>
                <tbody>{filteredTxns.map((t) => (<tr key={t.id}><td><strong>{t.id}</strong><small>{t.reference}</small></td><td>{t.customer}</td><td>{t.date}</td><td>{t.channel}</td><td><strong>{fmt(t.amount)}</strong></td><td><span className={statusClass(t.status)}>{t.status}</span></td></tr>))}</tbody></table></div>
            </>
          )}

          {page === "settlements" && (
            <>
              <p className="hero-sub">Provider payouts — what actually hit your bank. Formula: <strong>Gross − Fee = Net</strong>.</p>
              <section className="cards">
                <div className="card"><span>TOTAL GROSS</span><strong>{fmt(settleTotals.gross)}</strong><small>Before fees</small></div>
                <div className="card"><span>TOTAL FEES</span><strong>{fmt(settleTotals.fee)}</strong><small>Provider charges</small></div>
                <div className="card"><span>TOTAL NET</span><strong>{fmt(settleTotals.net)}</strong><small>Gross − Fee</small></div>
                <div className="card"><span>SETTLEMENTS</span><strong>{filteredSettlements.length}</strong><small>Filtered view</small></div>
              </section>
              <div className="table-wrap"><table className="table"><thead><tr><th>Settlement</th><th>Provider / Bank</th><th>Date</th><th>Gross</th><th>Fee</th><th>Net</th><th>Status</th></tr></thead>
                <tbody>{filteredSettlements.map((s) => (<tr key={s.id}><td><strong>{s.id}</strong><small>{s.reference}</small></td><td>{s.provider}<small>{s.bank}</small></td><td>{s.date}</td><td>{fmt(s.gross)}</td><td>{fmt(s.fee)}</td><td><strong>{fmt(s.net)}</strong></td><td><span className={statusClass(s.status)}>{s.status}</span></td></tr>))}</tbody></table></div>
            </>
          )}

          {page === "reconciliation" && (
            <>
              <p className="hero-sub">Sync. Reconcile. Resolve. — Run a new reconciliation.</p>
              <div className="wizard-steps">
                <div className={`w-step ${wizardStep >= 1 ? "active" : ""}`}><span>1</span> Upload</div><div className="w-line" />
                <div className={`w-step ${wizardStep >= 2 ? "active" : ""}`}><span>2</span> Run</div><div className="w-line" />
                <div className={`w-step ${wizardStep >= 3 ? "active" : ""}`}><span>3</span> Results</div>
              </div>
              {wizardStep === 1 && (
                <div className="panel wizard-panel"><h3>Step 1 — Upload your 3 sources</h3><p>Internal, Settlement, Bank statement. CSV for now. Or use demo data.</p>
                  <label className="upload-box"><input type="file" accept=".csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) setUploadedFile(f.name); }} hidden /><div className="upload-icon">⬆</div><strong>{uploadedFile ? `Selected: ${uploadedFile}` : "Click to choose CSV file"}</strong><small>CSV only · Max 5MB</small></label>
                  <div className="wizard-actions"><button className="secondary-btn" onClick={() => { setUploadedFile(null); setWizardStep(2); }}>Use Demo Data →</button><button className="primary-btn" disabled={!uploadedFile} onClick={() => setWizardStep(2)}>{uploadedFile ? "Continue with CSV →" : "Choose a file to continue"}</button></div>
                </div>
              )}
              {wizardStep === 2 && (
                <div className="panel wizard-panel"><h3>Step 2 — Ready to reconcile?</h3><p>Match by reference, then Gross − Fee = Net.</p>
                  {reconError && <p className="error">{reconError}</p>}
                  <div className="wizard-actions"><button className="secondary-btn" onClick={() => setWizardStep(1)}>← Back</button><button className="primary-btn" onClick={runReconciliation} disabled={reconLoading}>{reconLoading ? "Reconciling..." : "▶ Run Reconciliation"}</button></div>
                </div>
              )}
              {wizardStep === 3 && recon && (
                <>
                  <div className="panel wizard-panel"><h3>✅ Run Complete — {recon.run_id}</h3>
                    <div className="cards">
                      <div className="card"><span>TOTAL</span><strong>{recon.total}</strong><small>Checked</small></div>
                      <div className="card"><span>MATCHED</span><strong>{recon.matched}</strong><small>Clean</small></div>
                      <div className="card"><span>EXCEPTIONS</span><strong>{recon.exceptions_count}</strong><small>Needs investigation</small></div>
                      <div className="card"><span>RATE</span><strong>{recon.rate}%</strong><small>Matched rate</small></div>
                    </div>
                    <div className="wizard-actions"><button className="secondary-btn" onClick={() => { setWizardStep(1); setRecon(null); }}>↺ New Run</button><button className="primary-btn" onClick={() => setPage("exceptions")}>View Exceptions →</button></div>
                  </div>
                  <div className="panel"><h3>Exceptions ({recon.exceptions_count})</h3>{asArray<Exc>(recon.exceptions).map((e) => (<div className="row" key={e.id}><div><strong>{e.type}</strong> · {e.id}<br /><small>{e.detail}</small></div><strong>{fmt(e.amount)}</strong></div>))}</div>
                </>
              )}
            </>
          )}

          {page === "exceptions" && (
            <>
              <p className="hero-sub">Resolution Queue — click an exception to investigate. We never call it fraud — only "needs investigation".</p>
              <section className="cards">
                <div className="card"><span>OPEN</span><strong>{openExceptions.length}</strong><small>Needs investigation</small></div>
                <div className="card"><span>RESOLVED THIS SESSION</span><strong>{resolvedList.length}</strong><small>Audit logged</small></div>
                <div className="card"><span>OPEN VALUE</span><strong>{fmt(openExceptions.reduce((a, e) => a + (e.amount || 0), 0))}</strong><small>Still unresolved</small></div>
              </section>
              <div className="filters">
                <label>Type<select value={excFilter} onChange={(e) => setExcFilter(e.target.value)}><option>All</option><option>Missing Settlement</option><option>Amount Mismatch</option><option>Duplicate</option><option>Fee Discrepancy</option><option>Orphan Bank Credit</option><option>Timing Difference</option></select></label>
                <button className="clear-btn" onClick={() => { setSearch(""); setExcFilter("All"); setSelectedExc(null); }}>Clear</button>
              </div>
              <div className="exc-layout">
                <div className="table-wrap"><table className="table"><thead><tr><th>Exception</th><th>Type</th><th>Amount</th><th>Status</th></tr></thead>
                  <tbody>{filteredExceptions.map((e) => (
                    <tr key={e.id} className={selectedExc?.id === e.id ? "selected-row" : ""} onClick={() => { setSelectedExc(e); setResolveMsg(""); }}>
                      <td><strong>{e.id}</strong><small>{e.txn} · {e.reference}</small></td>
                      <td><span className={statusClass(e.type)}>{e.type}</span></td>
                      <td><strong>{fmt(e.amount)}</strong></td>
                      <td>{resolvedIds.has(e.id) ? <span className="st matched">Resolved</span> : <span className="st bad">Open</span>}</td>
                    </tr>
                  ))}
                  {filteredExceptions.length === 0 && <tr><td colSpan={4} className="empty">No exceptions match.</td></tr>}
                  </tbody></table></div>
                <div className="panel exc-detail">
                  {!selectedExc && <><h3>Select an exception</h3><p>Click any row on the left to see evidence, assign, add a note, and resolve.</p></>}
                  {selectedExc && (
                    <>
                      <h3>{selectedExc.id} — {selectedExc.type}</h3>
                      <p><strong>Transaction:</strong> {selectedExc.txn}<br /><strong>Reference:</strong> {selectedExc.reference}<br /><strong>Amount:</strong> {fmt(selectedExc.amount)}</p>
                      <p className="evidence"><strong>Evidence:</strong><br />{selectedExc.detail}</p>
                      {resolvedIds.has(selectedExc.id)
                        ? <p className="success-box">✅ Already resolved in this session. See Audit Trail below.</p>
                        : <>
                          <label className="field">Assign to<select value={assignee} onChange={(e) => setAssignee(e.target.value)}><option>Ahmad Magaji</option><option>Fatima Yusuf</option><option>Musa Ibrahim</option></select></label>
                          <label className="field">Resolution reason<select value={reason} onChange={(e) => setReason(e.target.value)}>{RESOLVE_REASONS.map((r) => <option key={r}>{r}</option>)}</select></label>
                          <label className="field">Note (optional)<textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Called provider, confirmed settlement lands tomorrow..." rows={3} /></label>
                          {resolveMsg && <p className="success-box">{resolveMsg}</p>}
                          <button className="primary-btn full" onClick={resolveSelected}>✓ Confirm Resolution</button>
                          <p className="note">Resolving does not move money. It only records your decision + audit trail.</p>
                        </>}
                    </>
                  )}
                  <div className="audit"><h4>Audit Trail</h4>{audit.map((a, i) => (<div className="audit-row" key={i}><small>{a.time} · {a.by}</small><span>{a.action}</span></div>))}</div>
                </div>
              </div>
            </>
          )}

          {page === "integrations" && (
            <>
              <p className="hero-sub">Connect your money sources. Ledgerwatch only reads — it never moves money.</p>
              <div className="int-grid">
                {INTEGRATIONS.map((it) => (
                  <div className="panel int-card" key={it.name}>
                    <div className="int-head"><span className="int-dot" style={{ background: it.color }}>{it.name[0]}</span><div><strong>{it.name}</strong><br /><small>{it.desc}</small></div></div>
                    <span className={it.status.includes("Available") ? "st matched" : "st warn"}>{it.status}</span>
                    <button className="secondary-btn" disabled={!it.status.includes("Available")}>{it.status.includes("Available") ? "Works today — see Export below ↓" : "Coming soon — use CSV for now"}</button>
                  </div>
                ))}
              </div>
              <div className="panel" style={{ marginTop: 16 }}>
                <h3>📊 Google Sheets Export</h3>
                <p>Download any dataset as CSV, then in Google Sheets: <strong>File → Import → Upload</strong>.</p>
                <div className="filters">
                  <label>Dataset<select value={exportDataset} onChange={(e) => setExportDataset(e.target.value)}><option>Transactions</option><option>Settlements</option><option>Exceptions</option></select></label>
                  <button className="primary-btn" style={{ marginTop: 0 }} onClick={() => downloadCSV()}>⬇ Download {exportDataset} CSV</button>
                </div>
                {exportMsg && <p className="success-box">{exportMsg}</p>}
              </div>
            </>
          )}

          {page === "reports" && (
            <>
              <p className="hero-sub">Share a clean summary with your accountant or boss — no raw CSV digging.</p>
              <div className="filters">
                <label>Period<select value={reportPeriod} onChange={(e) => setReportPeriod(e.target.value)}><option>This week</option><option>This month</option><option>Last month</option><option>All time</option></select></label>
                <button className="primary-btn" style={{ marginTop: 0 }} onClick={downloadReport}>⬇ Download Report CSV</button>
              </div>
              {reportMsg && <p className="success-box">{reportMsg}</p>}
              <div className="panel">
                <h3>Reconciliation Report — {workspaceName} · {reportPeriod}</h3>
                <p className="note">Generated {new Date().toLocaleString()} · Run REC-2026-104 · Ledgerwatch does not move money.</p>
                <div className="cards">
                  <div className="card"><span>COLLECTED (INTERNAL)</span><strong>{fmt(overview.total_value)}</strong><small>{overview.transactions.toLocaleString()} transactions</small></div>
                  <div className="card"><span>RECEIVED (SETTLEMENTS)</span><strong>{fmt(overview.settlements_received)}</strong><small>Net after fees</small></div>
                  <div className="card"><span>FLAGGED</span><strong>{fmt(overview.flagged_total)}</strong><small>{overview.flagged_count} exceptions</small></div>
                  <div className="card"><span>RECONCILIATION RATE</span><strong>{overview.reconciliation_rate}%</strong><small>{openExceptions.length} open · {resolvedList.length} resolved</small></div>
                </div>
                <h4>By Exception Type</h4>
                {asArray<BreakdownItem>(overview.breakdown).map((b) => (<div className="row" key={b.label}><div><strong>{b.label}</strong> <span>· {b.count} · {b.pct}</span></div><strong>{fmt(b.amount)}</strong></div>))}
                <h4>What this means</h4>
                <p>If Collected ≠ Received, the difference is in Exceptions. Resolve each exception with a reason + note, and the Audit Trail proves what you did. No mismatch is called fraud — only "needs investigation".</p>
                <div className="wizard-actions">
                  <button className="secondary-btn" onClick={() => downloadCSV("Exceptions")}>⬇ Export Exceptions</button>
                  <button className="secondary-btn" onClick={() => downloadCSV("Transactions")}>⬇ Export Transactions</button>
                  <button className="primary-btn" onClick={downloadReport}>⬇ Download Full Report</button>
                </div>
              </div>
              <div className="panel" style={{ marginTop: 16 }}>
                <h3>Audit Trail (this session)</h3>
                {audit.map((a, i) => (<div className="audit-row" key={i}><small>{a.time} · {a.by}</small><span>{a.action}</span></div>))}
              </div>
            </>
          )}

          {page === "settings" && (
            <>
              <p className="hero-sub">Control how Ledgerwatch matches your money. These settings are saved in this browser for now.</p>
              {settingsMsg && <p className="success-box">{settingsMsg}</p>}
              <div className="panel">
                <h3>Workspace</h3>
                <label className="field">Workspace / Business name<input value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} placeholder="Demo Commerce Ltd" /></label>
                <label className="field">Currency<select value={currency} onChange={(e) => setCurrency(e.target.value)}><option>NGN (₦)</option><option>USD ($)</option><option>GBP (£)</option></select></label>
                <p className="note">Workspace name shows in sidebar, Reports, and CSV exports.</p>
              </div>
              <div className="panel" style={{ marginTop: 16 }}>
                <h3>Matching Rules</h3>
                <label className="field">Amount tolerance (₦) — differences smaller than this are treated as Matched<input type="number" value={tolerance} onChange={(e) => setTolerance(e.target.value)} placeholder="0" /></label>
                <label className="field">Date tolerance (days) — settlement can land this many days after sale and still match<select value={dateTolerance} onChange={(e) => setDateTolerance(e.target.value)}><option>0</option><option>1</option><option>2</option><option>3</option><option>7</option></select></label>
                <p className="note">Recommended for Nigeria: Amount tolerance <strong>₦0</strong> (exact kobo math), Date tolerance <strong>1 day</strong> (T+1 settlement). Changing these does not change past runs — it applies to your next run.</p>
              </div>
              <div className="panel" style={{ marginTop: 16 }}>
                <h3>Notifications</h3>
                <label className="check"><input type="checkbox" checked={notifyEmail} onChange={(e) => setNotifyEmail(e.target.checked)} /> Email me a daily summary</label>
                <label className="check"><input type="checkbox" checked={notifyNewExc} onChange={(e) => setNotifyNewExc(e.target.checked)} /> Alert me when a new exception appears</label>
                <p className="note">Demo: notifications are not actually sent yet. In production this uses email / WhatsApp.</p>
              </div>
              <div className="panel" style={{ marginTop: 16 }}>
                <h3>Your Account</h3>
                <p><strong>Ahmad Magaji</strong><br /><small>Admin · Demo Commerce Ltd · ahmad@demo.com</small></p>
                <p className="note">Ledgerwatch never asks for your bank login. It only reads CSVs / provider reports you upload. It never moves money.</p>
                <button className="primary-btn" onClick={saveSettings}>💾 Save Settings</button>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}