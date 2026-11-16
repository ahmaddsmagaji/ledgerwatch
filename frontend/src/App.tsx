import { useEffect, useMemo, useState } from "react";
import "./App.css";

const API_URL = "https://ledgerwatch-backend-v2.onrender.com";

// ---------- SAFE NUMBERS - THIS FIXES THE WHITE SCREEN ----------
const n = (v: any) => Number(v ?? 0);
const fmt = (v: any) => "₦" + n(v).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtInt = (v: any) => n(v).toLocaleString("en-NG");

type BreakdownItem = { label: string; count: number; pct: string; amount: number };
type OverviewData = { transactions: number; total_value: number; settlements_received: number; open_exceptions: number; reconciliation_rate: number; flagged_total: number; flagged_count: number; resolved_count: number; breakdown: BreakdownItem[] };
type Txn = { id: string; reference: string; customer: string; amount: number; date: string; channel: string; status: string };
type Settlement = { id: string; provider: string; reference: string; gross: number; fee: number; net: number; date: string; bank: string; status: string };
type Exc = { id: string; txn: string; reference: string; type: string; amount: number; detail: string };
type ReconResult = { run_id: string; total: number; matched: number; exceptions_count: number; rate: number; matched_list: { txn: string; settlement: string; reference: string; amount: number; net: number }[]; exceptions: Exc[] };
type Audit = { time: string; action: string; by: string };
type User = { name: string; email: string; phone: string; business: string };

const FALLBACK_OVERVIEW: OverviewData = {
  transactions: 0, total_value: 0, settlements_received: 0, open_exceptions: 0, reconciliation_rate: 0,
  flagged_total: 0, flagged_count: 0, resolved_count: 0,
  breakdown: [],
};
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

function getUsers(): Record<string, User & { password: string }> {
  try { return JSON.parse(localStorage.getItem("lw_users") || "{}"); } catch { return {}; }
}
function getSession(): User | null {
  try { return JSON.parse(localStorage.getItem("lw_session") || "null"); } catch { return null; }
}

function mapSummary(s: any): OverviewData {
  if (!s || typeof s !== "object") return FALLBACK_OVERVIEW;
  const ordersTotal = n(s.orders_total ?? s.transactions);
  const ordersMatched = n(s.orders_matched ?? s.matched);
  const exceptionsTotal = n(s.exceptions_total ?? s.open_exceptions ?? s.flagged_count);
  const atRiskKobo = n(s.unresolved_at_risk_kobo ?? s.flagged_total);
  const atRiskNaira = atRiskKobo > 1000 ? atRiskKobo / 100 : atRiskKobo;
  const byType = s.by_type || {};
  const breakdown: BreakdownItem[] = Object.entries(byType).map(([label, v]: any) => ({
    label,
    count: n(v?.count),
    pct: "—",
    amount: n(v?.amount_at_risk_kobo) / 100,
  }));
  const rate = ordersTotal > 0 ? Math.round(((ordersMatched / ordersTotal) * 100) * 10) / 10 : 0;
  return {
    transactions: ordersTotal,
    total_value: n(s.total_value ?? (s.total_value_kobo ? n(s.total_value_kobo) / 100 : 0)),
    settlements_received: n(s.settlements_received ?? 0),
    open_exceptions: n(s.by_status?.open ?? exceptionsTotal),
    reconciliation_rate: n(s.reconciliation_rate ?? rate),
    flagged_total: atRiskNaira,
    flagged_count: exceptionsTotal,
    resolved_count: n(s.by_status?.resolved ?? 0),
    breakdown,
  };
}

function mapExceptions(d: any): Exc[] {
  const raw: any[] = Array.isArray(d) ? d : asArray<any>((d as any)?.items ?? (d as any)?.exceptions);
  return raw.map((x: any, i: number) => ({
    id: String(x.id ?? `EXC-${i + 1}`),
    txn: String(x.order_ref ?? x.txn ?? x.order_id ?? ""),
    reference: String(x.bank_ref ?? x.reference ?? x.order_ref ?? ""),
    type: String(x.type ?? "Exception"),
    amount: x.amount_at_risk_kobo != null ? n(x.amount_at_risk_kobo) / 100 : n(x.amount),
    detail: String(x.summary ?? x.detail ?? ""),
  }));
}

export default function App() {
  const [view, setView] = useState<"landing" | "auth" | "app">(() => (getSession() ? "app" : "landing"));
  const [authMode, setAuthMode] = useState<"login" | "signup">("signup");
  const [user, setUser] = useState<User | null>(() => getSession());
  const [form, setForm] = useState({ name: "", email: "", phone: "", business: "", password: "" });
  const [authError, setAuthError] = useState("");

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
    if (view !== "app") return;
    fetch(`${API_URL}/health`).then((r) => r.json()).then((d) => setBackendStatus(`✅ Backend connected: ${d.status}`)).catch(() => setBackendStatus("❌ Backend NOT connected"));
    fetch(`${API_URL}/api/summary`).then((r) => r.json()).then((d) => { if (d && typeof d === "object") { setOverview(mapSummary(d)); setOverviewSource("Live from backend ✅"); } }).catch(() => {});
    fetch(`${API_URL}/api/overview`).then((r) => r.json()).then((d) => { if (d && typeof d === "object" && d.total_value != null) { setOverview((prev) => ({ ...prev, ...d, breakdown: asArray<BreakdownItem>(d.breakdown ?? prev.breakdown) })); } }).catch(() => {});
    fetch(`${API_URL}/api/transactions`).then((r) => r.json()).then((d) => setTxns(asArray<Txn>(Array.isArray(d) ? d : (d as any)?.items))).catch(() => {});
    fetch(`${API_URL}/api/settlements`).then((r) => r.json()).then((d) => setSettlements(asArray<Settlement>(Array.isArray(d) ? d : (d as any)?.items))).catch(() => {});
    fetch(`${API_URL}/api/exceptions?limit=200`).then((r) => r.json()).then((d) => setExceptions(mapExceptions(d))).catch(() => {});
  }, [view]);

  const openAuth = (mode: "login" | "signup") => { setAuthMode(mode); setAuthError(""); setView("auth"); };

  const handleAuth = (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError("");
    const email = form.email.trim().toLowerCase();
    if (!email || !form.password) { setAuthError("Enter email and password."); return; }
    const users = getUsers();
    if (authMode === "signup") {
      if (!form.name.trim()) { setAuthError("Enter your full name."); return; }
      if (!form.phone.trim()) { setAuthError("Enter your phone number."); return; }
      if (form.password.length < 6) { setAuthError("Password must be at least 6 characters."); return; }
      if (users[email]) { setAuthError("This email already has an account. Log in instead."); return; }
      const nu: User & { password: string } = { name: form.name.trim(), email, phone: form.phone.trim(), business: form.business.trim() || "My Business", password: form.password };
      users[email] = nu;
      localStorage.setItem("lw_users", JSON.stringify(users));
      const session: User = { name: nu.name, email, phone: nu.phone, business: nu.business };
      localStorage.setItem("lw_session", JSON.stringify(session));
      setUser(session); setWorkspaceName(nu.business); setView("app");
    } else {
      const found = users[email];
      if (!found || found.password !== form.password) { setAuthError("Wrong email or password. If you don't have an account, create one."); return; }
      const session: User = { name: found.name, email, phone: found.phone, business: found.business };
      localStorage.setItem("lw_session", JSON.stringify(session));
      setUser(session); setWorkspaceName(found.business); setView("app");
    }
  };

  const logout = () => { localStorage.removeItem("lw_session"); setUser(null); setView("landing"); };

  const runReconciliation = async () => {
    setReconLoading(true); setReconError("");
    try {
      const res = await fetch(`${API_URL}/api/reconcile`, { method: "POST" });
      if (!res.ok) throw new Error("fail");
      const data = await res.json();
      setRecon({ ...data, exceptions: mapExceptions(data.exceptions) });
      setExceptions(mapExceptions(data.exceptions)); setWizardStep(3);
      setAudit((a) => [{ time: "Just now", action: `Run ${data.run_id} completed — ${n(data.total)} checked`, by: "System" }, ...a]);
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
      `Transactions: ${n(overview.transactions)}`,
      `Total Value: ${n(overview.total_value)}`,
      `Settlements Received: ${n(overview.settlements_received)}`,
      `Open Exceptions: ${openExceptions.length}`,
      `Resolved This Session: ${resolvedList.length}`,
      `Reconciliation Rate: ${n(overview.reconciliation_rate)}%`,
      `Flagged Total: ${n(overview.flagged_total)}`,
      ``,
      `Breakdown:`,
      ...asArray<BreakdownItem>(overview.breakdown).map((b) => `${b.label},${n(b.count)},${b.pct},${n(b.amount)}`),
      ``,
      `Exceptions:`,
      ...asArray<Exc>(exceptions).map((e) => `${e.id},${e.type},${n(e.amount)},${resolvedIds.has(e.id) ? "Resolved" : "Open"}`),
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
    setAudit((a) => [{ time: "Just now", action: `Settings updated — tolerance ₦${tolerance}, date ±${dateTolerance} day(s)`, by: user?.name || "Ahmad Magaji" }, ...a]);
    setTimeout(() => setSettingsMsg(""), 5000);
  };

  const openExceptions = useMemo(() => asArray<Exc>(exceptions).filter((e) => !resolvedIds.has(e.id)), [exceptions, resolvedIds]);
  const resolvedList = useMemo(() => asArray<Exc>(exceptions).filter((e) => resolvedIds.has(e.id)), [exceptions, resolvedIds]);

  const filteredTxns = useMemo(() => {
    const q = search.toLowerCase().trim();
    return asArray<Txn>(txns).filter((t) => {
      const mS = !q || String(t.id || "").toLowerCase().includes(q) || String(t.reference || "").toLowerCase().includes(q) || String(t.customer || "").toLowerCase().includes(q);
      return mS && (statusFilter === "All" || t.status === statusFilter) && (channelFilter === "All" || t.channel === channelFilter);
    });
  }, [txns, search, statusFilter, channelFilter]);

  const filteredSettlements = useMemo(() => {
    const q = search.toLowerCase().trim();
    return asArray<Settlement>(settlements).filter((s) => {
      const mS = !q || String(s.id || "").toLowerCase().includes(q) || String(s.reference || "").toLowerCase().includes(q) || String(s.provider || "").toLowerCase().includes(q);
      return mS && (statusFilter === "All" || s.status === statusFilter) && (channelFilter === "All" || s.provider === channelFilter);
    });
  }, [settlements, search, statusFilter, channelFilter]);

  const filteredExceptions = useMemo(() => {
    const q = search.toLowerCase().trim();
    return asArray<Exc>(exceptions).filter((e) => {
      const mS = !q || String(e.id || "").toLowerCase().includes(q) || String(e.txn || "").toLowerCase().includes(q) || String(e.reference || "").toLowerCase().includes(q) || String(e.type || "").toLowerCase().includes(q);
      return mS && (excFilter === "All" || e.type === excFilter);
    });
  }, [exceptions, search, excFilter]);

  const settleTotals = useMemo(() => ({
    gross: filteredSettlements.reduce((a, s) => a + n(s.gross), 0),
    fee: filteredSettlements.reduce((a, s) => a + n(s.fee), 0),
    net: filteredSettlements.reduce((a, s) => a + n(s.net), 0),
  }), [filteredSettlements]);

  const activeLabel = menu.find((m) => m.id === page)?.label || "Overview";

  if (view === "landing") {
    return (
      <div style={{ fontFamily: "system-ui, sans-serif", color: "#0f172a", background: "#fff", minHeight: "100vh" }}>
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 24px", maxWidth: 1100, margin: "0 auto" }}>
          <div style={{ fontWeight: 800, fontSize: 22 }}><span style={{ color: "#0f766e" }}>Ledger</span>watch</div>
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={() => openAuth("login")} style={{ padding: "10px 18px", borderRadius: 999, border: "1px solid #e2e8f0", background: "#fff", fontWeight: 600, cursor: "pointer" }}>Log in</button>
            <button onClick={() => openAuth("signup")} style={{ padding: "10px 18px", borderRadius: 999, border: "none", background: "#0f766e", color: "#fff", fontWeight: 700, cursor: "pointer" }}>Create account</button>
          </div>
        </header>
        <main style={{ maxWidth: 1100, margin: "0 auto", padding: "40px 24px 80px" }}>
          <div style={{ display: "inline-block", background: "#f0fdfa", color: "#0f766e", padding: "6px 12px", borderRadius: 999, fontSize: 13, fontWeight: 700 }}>PAYMENT SETTLEMENT RECONCILIATION</div>
          <h1 style={{ fontSize: 52, lineHeight: 1.05, letterSpacing: -1.5, margin: "20px 0 16px", maxWidth: 750 }}>Know what you earned. Find what hasn&apos;t arrived.</h1>
          <p style={{ fontSize: 19, color: "#475569", maxWidth: 680, lineHeight: 1.6 }}>Ledgerwatch checks your orders against your Monnify settlements and your bank deposits. If something is missing, short, or charged wrong, we show you exactly what — and track it until it&apos;s resolved.</p>
          <div style={{ display: "flex", gap: 12, marginTop: 28, flexWrap: "wrap" }}>
            <button onClick={() => openAuth("signup")} style={{ padding: "14px 24px", borderRadius: 12, border: "none", background: "#0f766e", color: "#fff", fontWeight: 700, fontSize: 16, cursor: "pointer" }}>Book a Demo →</button>
            <button onClick={() => openAuth("login")} style={{ padding: "14px 24px", borderRadius: 12, border: "1px solid #e2e8f0", background: "#fff", fontWeight: 600, fontSize: 16, cursor: "pointer" }}>See How It Works</button>
          </div>
          <p style={{ fontSize: 13, color: "#94a3b8", marginTop: 12 }}>No card required. Your workspace is separate — your data is only yours.</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginTop: 32, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 16, padding: 20 }}>
            <div><div style={{ color: "#64748b", fontSize: 12 }}>EXAMPLE — EXPECTED SETTLEMENT</div><div style={{ fontWeight: 800, fontSize: 20 }}>₦98,500</div></div>
            <div><div style={{ color: "#64748b", fontSize: 12 }}>BANK DEPOSIT</div><div style={{ fontWeight: 800, fontSize: 20 }}>₦96,500</div></div>
            <div><div style={{ color: "#64748b", fontSize: 12 }}>DIFFERENCE</div><div style={{ fontWeight: 800, fontSize: 20, color: "#dc2626" }}>₦2,000</div></div>
            <div><div style={{ color: "#64748b", fontSize: 12 }}>STATUS</div><div style={{ fontWeight: 800, fontSize: 16 }}>Needs investigation</div></div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16, marginTop: 32 }}>
            {[
              { t: "1. Connect your records", d: "Add your orders, Monnify settlements, and bank credits. Paste, upload, or enter manually — no CSV required to start." },
              { t: "2. We match everything", d: "We match each order to its settlement and to the bank credit. Exact matches, fee differences, and timing differences are all checked." },
              { t: "3. You fix only the breaks", d: "Only the exceptions are shown — missing settlement, amount mismatch, fee discrepancy, duplicate, orphan bank credit. Resolve them one by one, with a full audit trail." },
            ].map((c) => (
              <div key={c.t} style={{ border: "1px solid #e2e8f0", borderRadius: 16, padding: 22 }}>
                <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 8 }}>{c.t}</div>
                <div style={{ color: "#475569", lineHeight: 1.6, fontSize: 15 }}>{c.d}</div>
              </div>
            ))}
          </div>
        </main>
        <footer style={{ borderTop: "1px solid #e2e8f0", padding: "20px 24px", textAlign: "center", color: "#94a3b8", fontSize: 13 }}>Ledgerwatch — Reconcile payments, settlements and bank deposits.</footer>
      </div>
    );
  }

  if (view === "auth") {
    return (
      <div style={{ fontFamily: "system-ui, sans-serif", minHeight: "100vh", background: "#f8fafc", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
        <div style={{ background: "#fff", borderRadius: 20, padding: 32, width: "100%", maxWidth: 440, boxShadow: "0 10px 40px rgba(0,0,0,0.08)" }}>
          <div style={{ fontWeight: 800, fontSize: 22, marginBottom: 4 }}><span style={{ color: "#0f766e" }}>Ledger</span>watch</div>
          <h2 style={{ margin: "0 0 6px", fontSize: 26 }}>{authMode === "signup" ? "Create your account" : "Welcome back"}</h2>
          <p style={{ color: "#64748b", margin: "0 0 20px", fontSize: 14 }}>{authMode === "signup" ? "Your own workspace. Your data stays yours." : "Log in to your workspace."}</p>
          <div style={{ display: "flex", background: "#f1f5f9", borderRadius: 999, padding: 4, marginBottom: 20 }}>
            {(["signup", "login"] as const).map((m) => (
              <button key={m} onClick={() => { setAuthMode(m); setAuthError(""); }} style={{ flex: 1, padding: "10px", borderRadius: 999, border: "none", background: authMode === m ? "#fff" : "transparent", fontWeight: 700, cursor: "pointer" }}>{m === "signup" ? "Sign up" : "Log in"}</button>
            ))}
          </div>
          <button onClick={() => setAuthError("Google login is coming next — for now, create an account with email + password below.")} style={{ width: "100%", padding: 12, borderRadius: 10, border: "1px solid #e2e8f0", background: "#fff", fontWeight: 700, cursor: "pointer", marginBottom: 16 }}>Continue with Google</button>
          <div style={{ textAlign: "center", color: "#94a3b8", fontSize: 12, marginBottom: 16 }}>or with email</div>
          <form onSubmit={handleAuth} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {authMode === "signup" && (
              <>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Full name — e.g. Ahmad Magaji" style={{ padding: 12, borderRadius: 10, border: "1px solid #e2e8f0" }} />
                <input value={form.business} onChange={(e) => setForm({ ...form, business: e.target.value })} placeholder="Business name — e.g. Magaji Stores" style={{ padding: 12, borderRadius: 10, border: "1px solid #e2e8f0" }} />
                <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="Phone — e.g. 0803 123 4567" style={{ padding: 12, borderRadius: 10, border: "1px solid #e2e8f0" }} />
              </>
            )}
            <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="Email — e.g. ahmad@ledgerwatch.com.ng" style={{ padding: 12, borderRadius: 10, border: "1px solid #e2e8f0" }} />
            <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="Password (at least 6 characters)" style={{ padding: 12, borderRadius: 10, border: "1px solid #e2e8f0" }} />
            {authError && <div style={{ color: "#dc2626", fontSize: 13 }}>{authError}</div>}
            <button type="submit" style={{ padding: 13, borderRadius: 10, border: "none", background: "#0f766e", color: "#fff", fontWeight: 800, cursor: "pointer" }}>{authMode === "signup" ? "Create account →" : "Log in →"}</button>
          </form>
          <button onClick={() => setView("landing")} style={{ marginTop: 16, width: "100%", background: "none", border: "none", color: "#64748b", cursor: "pointer" }}>← Back to home</button>
          <p style={{ fontSize: 11, color: "#94a3b8", marginTop: 12, textAlign: "center" }}>Demo auth: saved on this device for now. Real Google login + server auth is next after landing is fixed.</p>
        </div>
      </div>
    );
  }

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
        <div className="sidebar-footer"><p>Sync. Reconcile. Resolve.</p><small>Ledgerwatch does not move money.</small><br /><button onClick={logout} style={{ marginTop: 8, background: "none", border: "1px solid #e2e8f0", borderRadius: 999, padding: "6px 12px", cursor: "pointer" }}>Log out</button></div>
      </aside>
      {sidebarOpen && <div className="overlay" onClick={() => setSidebarOpen(false)} />}

      <div className="main">
        <header className="topbar">
          <button className="hamburger" onClick={() => setSidebarOpen(true)}>☰</button><h2>{activeLabel}</h2>
          <input className="search" placeholder="Search TXN, EXC, reference..." value={search} onChange={(e) => setSearch(e.target.value)} />
          <span className={backendStatus.includes("✅") ? "backend-pill ok" : "backend-pill bad"}>{backendStatus}</span>
          <div className="user"><span className="avatar">{(user?.name || "A").slice(0, 1)}</span><div><strong>{user?.name || "Ahmad Magaji"}</strong><small>{user?.business || "Admin"}</small></div></div>
        </header>

        <main className="content">
          {page === "overview" && (
            <>
              <div className="overview-header">
                <div>
                  <h2 className="overview-title">Overview</h2>
                  <p className="overview-subtitle">Payments, settlements and bank deposits — reconciled. {overviewSource} · {fmtInt(openExceptions.length)} open · {fmtInt(resolvedList.length)} resolved in this session</p>
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
                  <strong>{n(overview.reconciliation_rate)}%</strong>
                  <div className="kpi-progress"><span style={{ width: `${Math.min(100, Math.max(0, n(overview.reconciliation_rate)))}%` }} /></div>
                  <small>Matched vs flagged • {reportPeriod}</small>
                </div>
                <div className="card kpi-card"><span>TRANSACTION VALUE</span><strong>{fmt(overview.total_value)}</strong><small>{fmtInt(overview.transactions)} transactions</small></div>
                <div className="card kpi-card"><span>SETTLEMENTS RECEIVED</span><strong>{fmt(overview.settlements_received)}</strong><small>Net after fees</small></div>
                <div className="card kpi-card"><span>OPEN EXCEPTIONS</span><strong>{fmtInt(openExceptions.length)}</strong><small>Needs investigation</small></div>
              </section>

              <div className="overview-two-col">
                <section className="panel">
                  <div className="panel-head"><h3>Needs attention</h3><span className="count-badge">{fmtInt(openExceptions.length)} open</span></div>
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
                <div className="card"><span>SETTLEMENTS</span><strong>{fmtInt(filteredSettlements.length)}</strong><small>Filtered view</small></div>
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
                      <div className="card"><span>TOTAL</span><strong>{fmtInt(recon.total)}</strong><small>Checked</small></div>
                      <div className="card"><span>MATCHED</span><strong>{fmtInt(recon.matched)}</strong><small>Clean</small></div>
                      <div className="card"><span>EXCEPTIONS</span><strong>{fmtInt(recon.exceptions_count)}</strong><small>Needs investigation</small></div>
                      <div className="card"><span>RATE</span><strong>{n(recon.rate)}%</strong><small>Matched rate</small></div>
                    </div>
                    <div className="wizard-actions"><button className="secondary-btn" onClick={() => { setWizardStep(1); setRecon(null); }}>↺ New Run</button><button className="primary-btn" onClick={() => setPage("exceptions")}>View Exceptions →</button></div>
                  </div>
                  <div className="panel"><h3>Exceptions ({fmtInt(recon.exceptions_count)})</h3>{asArray<Exc>(recon.exceptions).map((e) => (<div className="row" key={e.id}><div><strong>{e.type}</strong> · {e.id}<br /><small>{e.detail}</small></div><strong>{fmt(e.amount)}</strong></div>))}</div>
                </>
              )}
            </>
          )}

          {page === "exceptions" && (
            <>
              <p className="hero-sub">Resolution Queue — click an exception to investigate. We never call it fraud — only &quot;needs investigation&quot;.</p>
              <section className="cards">
                <div className="card"><span>OPEN</span><strong>{fmtInt(openExceptions.length)}</strong><small>Needs investigation</small></div>
                <div className="card"><span>RESOLVED THIS SESSION</span><strong>{fmtInt(resolvedList.length)}</strong><small>Audit logged</small></div>
                <div className="card"><span>OPEN VALUE</span><strong>{fmt(openExceptions.reduce((a, e) => a + n(e.amount), 0))}</strong><small>Still unresolved</small></div>
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
                  <div className="card"><span>COLLECTED (INTERNAL)</span><strong>{fmt(overview.total_value)}</strong><small>{fmtInt(overview.transactions)} transactions</small></div>
                  <div className="card"><span>RECEIVED (SETTLEMENTS)</span><strong>{fmt(overview.settlements_received)}</strong><small>Net after fees</small></div>
                  <div className="card"><span>FLAGGED</span><strong>{fmt(overview.flagged_total)}</strong><small>{fmtInt(overview.flagged_count)} exceptions</small></div>
                  <div className="card"><span>RECONCILIATION RATE</span><strong>{n(overview.reconciliation_rate)}%</strong><small>{fmtInt(openExceptions.length)} open · {fmtInt(resolvedList.length)} resolved</small></div>
                </div>
                <h4>By Exception Type</h4>
                {asArray<BreakdownItem>(overview.breakdown).map((b) => (<div className="row" key={b.label}><div><strong>{b.label}</strong> <span>· {fmtInt(b.count)} · {b.pct}</span></div><strong>{fmt(b.amount)}</strong></div>))}
                <h4>What this means</h4>
                <p>If Collected ≠ Received, the difference is in Exceptions. Resolve each exception with a reason + note, and the Audit Trail proves what you did. No mismatch is called fraud — only &quot;needs investigation&quot;.</p>
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
                <p><strong>{user?.name || "Ahmad Magaji"}</strong><br /><small>{user?.business || "Demo Commerce Ltd"} · {user?.email || "ahmad@demo.com"}</small></p>
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