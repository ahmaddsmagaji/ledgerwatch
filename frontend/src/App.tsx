import { useEffect, useMemo, useState } from "react";
import "./App.css";

const API_URL = "https://ledgerwatch-backend-v2.onrender.com";
const PURPLE = "#5B0DBA";
const PURPLE_DARK = "#2E1065";
const ADMIN_EMAIL = "dsahmadmagaji@gmail.com";
const LOGO = "/brand/logo.png";

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

const FALLBACK_OVERVIEW: OverviewData = { transactions: 0, total_value: 0, settlements_received: 0, open_exceptions: 0, reconciliation_rate: 0, flagged_total: 0, flagged_count: 0, resolved_count: 0, breakdown: [] };

const menu = [
  { id: "overview", label: "Overview", icon: "◈" },
  { id: "transactions", label: "Transactions", icon: "⇄" },
  { id: "settlements", label: "Settlements", icon: "◉" },
  { id: "reconciliation", label: "Reconciliation", icon: "✓" },
  { id: "exceptions", label: "Exceptions", icon: "!" },
  { id: "integrations", label: "Integrations", icon: "↗" },
  { id: "reports", label: "Reports", icon: "▤" },
  { id: "settings", label: "Settings", icon: "⚙" },
  { id: "admin", label: "Admin", icon: "🛡" },
];

const PLANS = [
  { name: "Starter", price: 10000, desc: "For small shops getting started.", feats: ["1 workspace", "Manual + CSV import", "Exceptions + audit trail"] },
  { name: "Growth", price: 30000, desc: "For growing businesses with daily sales.", feats: ["Everything in Starter", "More transactions", "Team assignments"] },
  { name: "Scale", price: 70000, desc: "For distributors + multi-branch.", feats: ["Everything in Growth", "Multiple workspaces", "Advanced reports"] },
];

const INTEGRATIONS = [
  { name: "Paystack", desc: "Import settlements + fees automatically. No manual CSV.", status: "Planned • Not Connected" },
  { name: "Flutterwave", desc: "Import settlements + fees automatically. No manual CSV.", status: "Planned • Not Connected" },
  { name: "Monnify", desc: "Import settlements + virtual account credits.", status: "Planned • Not Connected" },
  { name: "Google Sheets", desc: "Export any table to Sheets in 1 click. Works today.", status: "Available" },
  { name: "Bank Statement (CSV)", desc: "Upload any Nigerian bank statement CSV. Works today.", status: "Available" },
];

function statusClass(s: string) {
  if (s === "Matched" || s === "Received") return "st matched";
  if ((s || "").includes("Missing") || (s || "").includes("Duplicate") || (s || "").includes("Orphan")) return "st bad";
  return "st warn";
}
const RESOLVE_REASONS = ["Timing difference — settled next day", "Fee confirmed by provider", "Duplicate — second entry voided", "Bank credit matched to manual receipt", "Provider confirmed — no action needed", "Other — see note"];
const asArray = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
function getUsers(): Record<string, User & { password: string }> { try { return JSON.parse(localStorage.getItem("lw_users") || "{}"); } catch { return {}; } }
function getSession(): User | null { try { return JSON.parse(localStorage.getItem("lw_session") || "null"); } catch { return null; } }
function GoogleIcon() { return <span style={{ width: 18, height: 18, borderRadius: "50%", background: "#fff", border: "1px solid #e2e8f0", display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 900, fontSize: 13, color: "#4285F4", flexShrink: 0 }}>G</span>; }
function LogoImg({ size = 40, radius = 10 }: { size?: number; radius?: number }) { return <div style={{ width: size, height: size, borderRadius: radius, overflow: "hidden", background: "#000", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}><img src={LOGO} alt="Ledgerwatch logo" style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} /></div>; }
function mapSummary(s: any): OverviewData {
  if (!s || typeof s !== "object") return FALLBACK_OVERVIEW;
  const ordersTotal = n(s.orders_total ?? s.transactions);
  const ordersMatched = n(s.orders_matched ?? s.matched);
  const exceptionsTotal = n(s.exceptions_total ?? s.open_exceptions ?? s.flagged_count);
  const atRiskKobo = n(s.unresolved_at_risk_kobo ?? s.flagged_total);
  const atRiskNaira = atRiskKobo > 1000 ? atRiskKobo / 100 : atRiskKobo;
  const byType = s.by_type || {};
  const breakdown: BreakdownItem[] = Object.entries(byType).map(([label, v]: any) => ({ label, count: n(v?.count), pct: "—", amount: n(v?.amount_at_risk_kobo) / 100 }));
  const rate = ordersTotal > 0 ? Math.round(((ordersMatched / ordersTotal) * 100) * 10) / 10 : 0;
  return { transactions: ordersTotal, total_value: n(s.total_value ?? (s.total_value_kobo ? n(s.total_value_kobo) / 100 : 0)), settlements_received: n(s.settlements_received ?? 0), open_exceptions: n(s.by_status?.open ?? exceptionsTotal), reconciliation_rate: n(s.reconciliation_rate ?? rate), flagged_total: atRiskNaira, flagged_count: exceptionsTotal, resolved_count: n(s.by_status?.resolved ?? 0), breakdown };
}
function mapExceptions(d: any): Exc[] {
  const raw: any[] = Array.isArray(d) ? d : asArray<any>((d as any)?.items ?? (d as any)?.exceptions);
  return raw.map((x: any, i: number) => ({ id: String(x.id ?? `EXC-${i + 1}`), txn: String(x.order_ref ?? x.txn ?? x.order_id ?? ""), reference: String(x.bank_ref ?? x.reference ?? x.order_ref ?? ""), type: String(x.type ?? "Exception"), amount: x.amount_at_risk_kobo != null ? n(x.amount_at_risk_kobo) / 100 : n(x.amount), detail: String(x.summary ?? x.detail ?? "") }));
}

export default function App() {
  const [view, setView] = useState<"landing" | "auth" | "app">(() => (getSession() ? "app" : "landing"));
  const [authMode, setAuthMode] = useState<"login" | "signup">("signup");
  const [user, setUser] = useState<User | null>(() => getSession());
  const [form, setForm] = useState({ name: "", email: "", phone: "", business: "", password: "" });
  const [authError, setAuthError] = useState("");
  const [showForgot, setShowForgot] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotMsg, setForgotMsg] = useState("");
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem("lw_dark") === "1");
  const [mobileMenu, setMobileMenu] = useState(false);
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [pwMsg, setPwMsg] = useState("");
  const [page, setPage] = useState("overview");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [overview, setOverview] = useState<OverviewData>(FALLBACK_OVERVIEW);
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
  const [selectedPlan, setSelectedPlan] = useState("Growth");
  const [currentPlan] = useState("Free Trial");
  const [billingMsg, setBillingMsg] = useState("");
  const [billingError, setBillingError] = useState("");
  const [billingLoading, setBillingLoading] = useState(false);
  const [waNumber, setWaNumber] = useState(() => localStorage.getItem("lw_wa_number") || "");
  const [waCode, setWaCode] = useState("");
  const [waGenerated, setWaGenerated] = useState("");
  const [waLinked, setWaLinked] = useState(() => localStorage.getItem("lw_wa_linked") === "1");
  const [waMsg, setWaMsg] = useState("");
  const [briefingFreq, setBriefingFreq] = useState("Daily");
  const [briefingTone, setBriefingTone] = useState("Merchant style");
  const [waBriefingOn, setWaBriefingOn] = useState(true);
  const [showDelete, setShowDelete] = useState(false);
  const [adminMsg, setAdminMsg] = useState("");
  const [adminUsers, setAdminUsers] = useState<Record<string, User & { password: string }>>({});
  const [adminHealth, setAdminHealth] = useState<any>(null);
  const [adminToken, setAdminToken] = useState(() => localStorage.getItem("lw_admin_token") || "");
  const [adminBackendMsg, setAdminBackendMsg] = useState("");
  const isAdmin = user?.email?.toLowerCase() === ADMIN_EMAIL;

  useEffect(() => { document.body.classList.toggle("dark-mode", darkMode); localStorage.setItem("lw_dark", darkMode ? "1" : "0"); }, [darkMode]);
  useEffect(() => {
    if (view !== "app") return;
    fetch(`${API_URL}/api/summary`).then((r) => r.json()).then((d) => { if (d && typeof d === "object") { setOverview(mapSummary(d)); } }).catch(() => {});
    fetch(`${API_URL}/api/overview`).then((r) => r.json()).then((d) => { if (d && typeof d === "object" && d.total_value != null) { setOverview((prev) => ({ ...prev, ...d, breakdown: asArray<BreakdownItem>(d.breakdown ?? prev.breakdown) })); } }).catch(() => {});
    fetch(`${API_URL}/api/transactions`).then((r) => r.json()).then((d) => setTxns(asArray<Txn>(Array.isArray(d) ? d : (d as any)?.items))).catch(() => {});
    fetch(`${API_URL}/api/settlements`).then((r) => r.json()).then((d) => setSettlements(asArray<Settlement>(Array.isArray(d) ? d : (d as any)?.items))).catch(() => {});
    fetch(`${API_URL}/api/exceptions?limit=200`).then((r) => r.json()).then((d) => setExceptions(mapExceptions(d))).catch(() => {});
  }, [view]);

  const openAuth = (mode: "login" | "signup") => { setAuthMode(mode); setAuthError(""); setShowForgot(false); setMobileMenu(false); setView("auth"); };
  const handleGoogle = () => {
    const cid = (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID;
    if (!cid) { setAuthError("To enable real Google login: add VITE_GOOGLE_CLIENT_ID in Vercel → Settings → Environment Variables, then redeploy. Get it free from console.cloud.google.com → Credentials → OAuth Client ID."); return; }
    setAuthError("Opening Google login...");
    const s = document.createElement("script"); s.src = "https://accounts.google.com/gsi/client"; s.async = true;
    s.onload = () => {
      // @ts-ignore
      window.google.accounts.id.initialize({ client_id: cid, callback: (res: any) => {
        try {
          const payload = JSON.parse(atob(res.credential.split(".")[1]));
          const session: User = { name: payload.name || "Google User", email: payload.email, phone: "", business: "My Business" };
          localStorage.setItem("lw_session", JSON.stringify(session));
          setUser(session); setWorkspaceName("My Business"); setView("app");
        } catch { setAuthError("Google login failed. Try email login."); }
      }});
      // @ts-ignore
      window.google.accounts.id.prompt();
    };
    document.head.appendChild(s);
  };
  const handleAuth = (e: React.FormEvent) => {
    e.preventDefault(); setAuthError("");
    const email = form.email.trim().toLowerCase();
    if (!email || !form.password) { setAuthError("Enter email and password."); return; }
    const users = getUsers();
    if (authMode === "signup") {
      if (!form.name.trim()) { setAuthError("Enter your full name."); return; }
      if (!form.phone.trim()) { setAuthError("Enter your phone number."); return; }
      if (form.password.length < 6) { setAuthError("Password must be at least 6 characters."); return; }
      if (users[email]) { setAuthError("This email already has an account. Log in instead."); return; }
      const nu: User & { password: string } = { name: form.name.trim(), email, phone: form.phone.trim(), business: form.business.trim() || "My Business", password: form.password };
      users[email] = nu; localStorage.setItem("lw_users", JSON.stringify(users));
      const session: User = { name: nu.name, email, phone: nu.phone, business: nu.business };
      localStorage.setItem("lw_session", JSON.stringify(session));
      setUser(session); setWorkspaceName(nu.business); setView("app");
    } else {
      const found = users[email];
      if (!found || found.password !== form.password) { setAuthError("Wrong email or password."); return; }
      const session: User = { name: found.name, email, phone: found.phone, business: found.business };
      localStorage.setItem("lw_session", JSON.stringify(session));
      setUser(session); setWorkspaceName(found.business); setView("app");
    }
  };
  const handleForgot = (e: React.FormEvent) => {
    e.preventDefault();
    const email = forgotEmail.trim().toLowerCase();
    const users = getUsers();
    if (!users[email]) { setForgotMsg("No account with that email. Create an account first."); return; }
    users[email] = { ...users[email], password: "123456" };
    localStorage.setItem("lw_users", JSON.stringify(users));
    setForgotMsg("Password reset to 123456. Log in with 123456, then change it in Settings → Change Password.");
  };
  const handleChangePassword = () => {
    if (!user) return;
    const users = getUsers(); const found = users[user.email.toLowerCase()];
    if (!found || found.password !== currentPw) { setPwMsg("Current password is wrong."); return; }
    if (newPw.length < 6) { setPwMsg("New password must be at least 6 characters."); return; }
    users[user.email.toLowerCase()] = { ...found, password: newPw };
    localStorage.setItem("lw_users", JSON.stringify(users));
    setPwMsg("Password changed. Use the new password next time you log in."); setCurrentPw(""); setNewPw("");
  };
  const logout = () => { localStorage.removeItem("lw_session"); setUser(null); setShowAccountMenu(false); setView("landing"); };
  const goSettings = () => { setShowAccountMenu(false); setPage("settings"); setSidebarOpen(false); };
  const generateWaCode = () => {
    if (!waNumber.trim()) { setWaMsg("Enter WhatsApp number first, e.g. +2348012345678"); return; }
    const code = String(Math.floor(100000 + Math.random() * 900000));
    setWaGenerated(code); localStorage.setItem("lw_wa_number", waNumber);
    setWaMsg(`Your one-time code is ${code}. In live mode we send this via WhatsApp Cloud API. For demo, enter it below to link.`);
  };
  const verifyWaCode = () => {
    if (waCode === waGenerated && waGenerated) {
      setWaLinked(true); localStorage.setItem("lw_wa_linked", "1");
      setWaMsg("WhatsApp linked ✓ Daily briefings will go to " + waNumber);
      setAudit((a) => [{ time: "Just now", action: `WhatsApp linked — ${waNumber}`, by: user?.name || "Owner" }, ...a]);
    } else setWaMsg("Wrong code. Tap Generate code again.");
  };
  const unlinkWa = () => { setWaLinked(false); localStorage.removeItem("lw_wa_linked"); setWaGenerated(""); setWaCode(""); setWaMsg("WhatsApp unlinked."); };
  const subscribe = async () => {
    setBillingError(""); setBillingMsg(""); setBillingLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/billing/initialize`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plan: selectedPlan, email: user?.email || "" }) });
      const data = await res.json().catch(() => ({}));
      if (data?.authorization_url) { window.location.href = data.authorization_url; return; }
      if (data?.note) { setBillingMsg(`Paystack is not connected yet (backend Stage 1). Plan selected: ${selectedPlan} — ${fmt(PLANS.find((p) => p.name === selectedPlan)?.price)} / month. Add PAYSTACK_SECRET_KEY on Render to enable live checkout.`); return; }
      throw new Error("no-url");
    } catch {
      setBillingError("Paystack checkout is not enabled yet. Add PAYSTACK_SECRET_KEY in Render → Environment, then try again. No card was collected on Ledgerwatch.");
    } finally { setBillingLoading(false); }
  };
  const loadAdminUsers = () => { setAdminUsers(getUsers()); };
  const loadAdminBackend = async () => {
    if (!adminToken) { setAdminBackendMsg("Enter Admin Token first (from Render ENV). It is not saved in code."); return; }
    try {
      const r = await fetch(`${API_URL}/api/admin/health`, { headers: { "X-Admin-Token": adminToken } });
      const d = await r.json();
      if (!r.ok) { setAdminBackendMsg("Backend admin denied: " + (d.detail || r.status)); return; }
      setAdminHealth(d); localStorage.setItem("lw_admin_token", adminToken); setAdminBackendMsg("Backend admin connected ✓");
    } catch { setAdminBackendMsg("Cannot reach backend admin. Is Render up?"); }
  };
  const adminResetPw = (email: string) => {
    const users = getUsers(); if (!users[email]) return;
    users[email] = { ...users[email], password: "123456" }; localStorage.setItem("lw_users", JSON.stringify(users)); setAdminUsers(users); setAdminMsg(`Reset ${email} to 123456`);
  };
  const adminDeleteUser = (email: string) => {
    if (email.toLowerCase() === ADMIN_EMAIL) { setAdminMsg("Cannot delete admin."); return; }
    const users = getUsers(); delete users[email]; localStorage.setItem("lw_users", JSON.stringify(users)); setAdminUsers(users); setAdminMsg(`Deleted ${email}`);
  };
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
    try { await fetch(`${API_URL}/api/exceptions/${selectedExc.id}/resolve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason, note, assignee }) }); } catch {}
    setResolvedIds((prev) => new Set(prev).add(selectedExc.id));
    setAudit((a) => [{ time: "Just now", action: `Resolved ${selectedExc.id} (${selectedExc.type}) — ${reason}${note ? ` — Note: ${note}` : ""}`, by: assignee }, ...a]);
    setResolveMsg(`${selectedExc.id} resolved — ${reason}`); setNote(""); setTimeout(() => setResolveMsg(""), 4000);
  };
  const downloadCSV = (datasetOverride?: string) => {
    const ds = datasetOverride || exportDataset;
    let headers: string[] = []; let rows: string[][] = [];
    if (ds === "Transactions") { headers = ["Transaction ID", "Reference", "Customer", "Amount (NGN)", "Date", "Channel", "Status"]; rows = asArray<Txn>(txns).map((t) => [t.id, t.reference, t.customer, String(t.amount), t.date, t.channel, t.status]); }
    else if (ds === "Settlements") { headers = ["Settlement ID", "Provider", "Reference", "Gross", "Fee", "Net", "Date", "Bank", "Status"]; rows = asArray<Settlement>(settlements).map((s) => [s.id, s.provider, s.reference, String(s.gross), String(s.fee), String(s.net), s.date, s.bank, s.status]); }
    else { headers = ["Exception ID", "Transaction", "Reference", "Type", "Amount (NGN)", "Status", "Detail"]; rows = asArray<Exc>(exceptions).map((e) => [e.id, e.txn, e.reference, e.type, String(e.amount), resolvedIds.has(e.id) ? "Resolved" : "Open", e.detail.replace(/,/g, ";")]); }
    const csv = [headers.join(","), ...rows.map((r) => r.map((c) => `"${c}"`).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" }); const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `ledgerwatch-${ds.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(url);
    setExportMsg(`Downloaded ${rows.length} rows — open in Google Sheets: File → Import → Upload`); setTimeout(() => setExportMsg(""), 6000);
  };
  const downloadReport = () => {
    const lines = [`Ledgerwatch Reconciliation Report — ${workspaceName}`, `Period: ${reportPeriod}`, `Generated: ${new Date().toLocaleString()}`, ``, `Transactions: ${n(overview.transactions)}`, `Total Value: ${n(overview.total_value)}`, `Settlements Received: ${n(overview.settlements_received)}`, `Open Exceptions: ${openExceptions.length}`, `Resolved This Session: ${resolvedList.length}`, `Reconciliation Rate: ${n(overview.reconciliation_rate)}%`, `Flagged Total: ${n(overview.flagged_total)}`, ``, `Breakdown:`, ...asArray<BreakdownItem>(overview.breakdown).map((b) => `${b.label},${n(b.count)},${b.pct},${n(b.amount)}`), ``, `Exceptions:`, ...asArray<Exc>(exceptions).map((e) => `${e.id},${e.type},${n(e.amount)},${resolvedIds.has(e.id) ? "Resolved" : "Open"}`)];
    const blob = new Blob([lines.join("\n")], { type: "text/csv" }); const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `ledgerwatch-report-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(url);
    setReportMsg(`Report downloaded for ${reportPeriod} — ${workspaceName}`); setTimeout(() => setReportMsg(""), 6000);
  };
  const saveSettings = () => {
    setSettingsMsg(`Settings saved — Workspace: ${workspaceName} · Currency: ${currency} · Amount tolerance: ₦${tolerance} · Date tolerance: ${dateTolerance} day(s)`);
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
  const settleTotals = useMemo(() => ({ gross: filteredSettlements.reduce((a, s) => a + n(s.gross), 0), fee: filteredSettlements.reduce((a, s) => a + n(s.fee), 0), net: filteredSettlements.reduce((a, s) => a + n(s.net), 0) }), [filteredSettlements]);
  const activeLabel = menu.find((m) => m.id === page)?.label || "Overview";
  const bg = darkMode ? "#0f172a" : "#F6F6F8";
  const cardBg = darkMode ? "#1e293b" : "#ffffff";
  const fg = darkMode ? "#f1f5f9" : "#131118";
  const muted = darkMode ? "#94a3b8" : "#667085";
  const border = darkMode ? "1px solid #334155" : "1px solid #EAECF0";

  if (view === "landing") {
    return (
      <div style={{ fontFamily: "Inter, system-ui, sans-serif", color: fg, background: bg, minHeight: "100vh" }}>
        <header className="landing-header" style={{ background: cardBg }}>
          <nav className="landing-nav-desktop">
            <button onClick={() => document.getElementById("features")?.scrollIntoView({ behavior: "smooth" })}><header className="lw-topbar">
        <div className="lw-top-left">
          <button className="lw-hamburger" aria-label="Menu" onClick={() => document.body.classList.toggle("lw-menu-open")}>☰</button>
          <img src="/brand/logo.png" alt="Ledgerwatch" className="lw-top-logo" onClick={() => window.scrollTo({top: 0, behavior: "smooth"})} />
        </div>
        <div className="lw-top-right">
          <button className="lw-dark-btn" onClick={() => document.documentElement.classList.toggle("dark")}>Dark</button>
          <button className="lw-signup-btn" onClick={() => { const b = document.body.innerText.includes("Start Free"); window.scrollTo({top: 0, behavior: "smooth"}); const el = Array.from(document.querySelectorAll("button")).find(x => x.textContent?.includes("Start Free")); if (el) el.click(); }}>Sign up</button>
        </div>
      </header>
Features</button>
            <button onClick={() => document.getElementById("how")?.scrollIntoView({ behavior: "smooth" })}>How it works</button>
            <button onClick={() => document.getElementById("faq")?.scrollIntoView({ behavior: "smooth" })}>FAQ</button>
            <button onClick={() => setDarkMode((v) => !v)} className="pill-btn">{darkMode ? "Light" : "Dark"}</button>
            {user ? <button onClick={() => setView("app")} className="primary-pill">Back to App ({user.name})</button> : <><button onClick={() => openAuth("login")} className="pill-btn">Log In</button><button onClick={() => openAuth("signup")} className="primary-pill">Start Free</button></>}
          </nav>
          {!user && <><button className="landing-dark-btn" onClick={() => setDarkMode((v) => !v)}>{darkMode ? "Light" : "Dark"}</button><button className="landing-hamburger" onClick={() => setMobileMenu((v) => !v)}>{mobileMenu ? "X" : "☰"}</button></>}
        </header>
        {mobileMenu && !user && (
          <div className="landing-mobile-menu" style={{ background: cardBg }}>
            <button onClick={() => { setMobileMenu(false); document.getElementById("features")?.scrollIntoView({ behavior: "smooth" }); }}>Features</button>
            <button onClick={() => { setMobileMenu(false); document.getElementById("how")?.scrollIntoView({ behavior: "smooth" }); }}>How it works</button>
            <button onClick={() => { setMobileMenu(false); document.getElementById("faq")?.scrollIntoView({ behavior: "smooth" }); }}>FAQ</button>
            <button onClick={() => openAuth("login")} className="pill-btn">Log In</button>
            <button onClick={() => openAuth("signup")} className="primary-pill">Start Free</button>
          </div>
        )}
        <section style={{ background: bg, color: fg }}>
          <div className="landing-hero">
            <div style={{ display: "inline-block", background: darkMode ? "#1e1b4b" : "#f5f3ff", border: "1px solid #e9d5ff", padding: "6px 12px", borderRadius: 999, fontSize: 12, fontWeight: 800, letterSpacing: 1, color: PURPLE }}>PAYMENT SETTLEMENT RECONCILIATION • FOR NIGERIAN BUSINESSES</div>
            <h1>Know what you earned.<br />Find what hasn&apos;t arrived.</h1>
            <p>Did the money you sold actually enter your bank? Ledgerwatch checks <b>every order</b> against <b>Monnify settlements</b> and <b>bank deposits</b> — and shows you exactly what is missing, short, or charged wrong.</p>
            <div className="landing-cta-row">
              <button onClick={() => openAuth("signup")} style={{ background: PURPLE, color: "#fff", border: "none" }}>Start Free →</button>
              <button onClick={() => document.getElementById("how")?.scrollIntoView({ behavior: "smooth" })} style={{ background: cardBg, color: fg, border }}>Watch 2-Min Demo</button>
            </div>
            <p style={{ fontSize: 13, color: muted, marginTop: 14 }}>Setup takes 2 mins. No credit card required.</p>
            <div className="landing-proof">
              <div><div style={{ fontWeight: 900, fontSize: 18 }}>3 sources</div><div style={{ fontSize: 12, color: muted }}>Orders • Settlements • Bank</div></div>
              <div><div style={{ fontWeight: 900, fontSize: 18 }}>Separate</div><div style={{ fontSize: 12, color: muted }}>Your workspace is yours</div></div>
              <div><div style={{ fontWeight: 900, fontSize: 18 }}>Never moves</div><div style={{ fontSize: 12, color: muted }}>We never move money</div></div>
            </div>
            <div style={{ background: cardBg, border, borderRadius: 20, padding: 24, boxShadow: "0 12px 40px rgba(0,0,0,0.08)", width: "100%", marginTop: 28, textAlign: "left" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><b>LIVE EXAMPLE</b><span style={{ background: "#fef3c7", color: "#92400e", padding: "4px 10px", borderRadius: 999, fontSize: 12, fontWeight: 800 }}>Needs investigation</span></div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginTop: 18 }}>
                <div style={{ background: bg, borderRadius: 12, padding: 14 }}><div style={{ fontSize: 11, color: muted, fontWeight: 700 }}>EXPECTED SETTLEMENT</div><div style={{ fontSize: 22, fontWeight: 900 }}>₦98,500</div><div style={{ fontSize: 12, color: muted }}>What Monnify should send</div></div>
                <div style={{ background: bg, borderRadius: 12, padding: 14 }}><div style={{ fontSize: 11, color: muted, fontWeight: 700 }}>BANK DEPOSIT</div><div style={{ fontSize: 22, fontWeight: 900 }}>₦96,500</div><div style={{ fontSize: 12, color: muted }}>What actually hit bank</div></div>
              </div>
              <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 12, padding: 14, marginTop: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}><div><div style={{ fontSize: 11, color: "#991b1b", fontWeight: 800 }}>DIFFERENCE — WHERE IS IT?</div><div style={{ fontSize: 12, color: "#7f1d1d" }}>Fee? Short payment? Timing?</div></div><div style={{ fontSize: 22, fontWeight: 900, color: "#dc2626" }}>₦2,000</div></div>
              <button onClick={() => openAuth("signup")} style={{ width: "100%", marginTop: 14, padding: 12, borderRadius: 10, border: "none", background: PURPLE, color: "#fff", fontWeight: 800, cursor: "pointer" }}>Find my missing ₦2,000 →</button>
              <p style={{ fontSize: 11, color: "#94a3b8", textAlign: "center", marginTop: 8 }}>Example to show how it works — not your real data.</p>
            </div>
          </div>
        </section>
        <section id="features" style={{ maxWidth: 1120, margin: "0 auto", padding: "48px 20px 0" }}>
          <h2 style={{ fontSize: 28, margin: "0 0 8px", textAlign: "center" }}>What is Ledgerwatch?</h2>
          <p style={{ color: muted, fontSize: 17, lineHeight: 1.7, maxWidth: 760, margin: "0 auto", textAlign: "center" }}>You sell. Monnify collects. Your bank should receive. Ledgerwatch is the <b>truth-checker</b> between those 3 numbers.</p>
          <div className="landing-grid-3" style={{ marginTop: 24 }}>
            {[{ t: "Orders", d: "What your system says you sold — every order, reference, customer, amount." }, { t: "Settlements", d: "What Monnify / Paystack / Flutterwave says they sent — Gross − Fee = Net." }, { t: "Bank Deposits", d: "What actually hit your bank — the only number that pays your bills." }, { t: "Exceptions", d: "Only the breaks. Missing, mismatch, duplicate, fee error, orphan credit, timing break." }].map((c) => (<div key={c.t} style={{ background: cardBg, border, borderRadius: 16, padding: 20 }}><div style={{ fontWeight: 800, margin: "8px 0 6px" }}>{c.t}</div><div style={{ color: muted, fontSize: 14, lineHeight: 1.6 }}>{c.d}</div></div>))}
          </div>
        </section>
        <section id="how" style={{ maxWidth: 1120, margin: "0 auto", padding: "48px 20px 0" }}>
          <h2 style={{ fontSize: 28, margin: "0 0 8px", textAlign: "center" }}>How to use it — 3 steps, 5 minutes</h2>
          <div className="landing-grid-3" style={{ marginTop: 16 }}>
            {[{ n: "1", t: "Create your workspace", d: "Sign up with email + phone. Your business gets its own workspace — your data is only yours." }, { n: "2", t: "Add your 3 records", d: "Add Orders, Settlements, Bank credits. Paste, upload CSV, or enter manually." }, { n: "3", t: "Fix only the breaks", d: "Open Exceptions. Click one. See the evidence. Assign it, add a note, resolve it." }].map((c) => (<div key={c.n} style={{ background: darkMode ? "#1e1b4b" : "#faf5ff", border: "1px solid #e9d5ff", borderRadius: 16, padding: 22 }}><div style={{ width: 36, height: 36, borderRadius: 999, background: PURPLE, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 900 }}>{c.n}</div><div style={{ fontWeight: 800, fontSize: 17, margin: "12px 0 6px" }}>{c.t}</div><div style={{ color: muted, fontSize: 14, lineHeight: 1.6 }}>{c.d}</div></div>))}
          </div>
        </section>
        <section style={{ maxWidth: 1120, margin: "0 auto", padding: "48px 20px 0" }}>
          <div className="landing-grid-2">
            <div style={{ border: `2px solid ${PURPLE}`, borderRadius: 16, padding: 22 }}><h3 style={{ margin: "0 0 10px" }}>Who it&apos;s for</h3><ul style={{ color: muted, lineHeight: 1.8, margin: 0, paddingLeft: 18 }}><li>E-commerce stores using Monnify + POS</li><li>Shops with many daily sales to reconcile</li><li>Businesses tired of manual Excel reconciliation</li><li>Owners who want proof for their accountant</li></ul></div>
            <div style={{ background: cardBg, border, borderRadius: 16, padding: 22 }}><h3 style={{ margin: "0 0 10px" }}>What it&apos;s NOT</h3><ul style={{ color: muted, lineHeight: 1.8, margin: 0, paddingLeft: 18 }}><li>Not a payment gateway — we don&apos;t collect money</li><li>Not a bank — we never ask for bank login</li><li>Not an accounting clone — we do one thing: reconciliation</li><li>We never call a mismatch fraud — only needs investigation</li></ul></div>
          </div>
        </section>
        <section id="faq" style={{ maxWidth: 760, margin: "0 auto", padding: "48px 20px 0" }}>
          <h2 style={{ fontSize: 28, textAlign: "center" }}>FAQ</h2>
          {[{ q: "Do you move my money?", a: "No. Ledgerwatch only reads the records you add. It never moves money and never asks for bank login." }, { q: "Do I need CSV to start?", a: "No. You can paste, enter manually, or upload CSV." }, { q: "What is an exception?", a: "A break between Orders, Settlements and Bank — missing, mismatch, duplicate, fee error, orphan credit, or timing difference." }, { q: "Can my accountant use it?", a: "Yes. Export any table or report to CSV and open it in Google Sheets." }].map((f) => (<div key={f.q} style={{ background: cardBg, border, borderRadius: 12, padding: 18, marginBottom: 12 }}><b>{f.q}</b><div style={{ color: muted, marginTop: 6, lineHeight: 1.6 }}>{f.a}</div></div>))}
        </section>
        <section style={{ maxWidth: 1120, margin: "0 auto", padding: "48px 20px 60px" }}>
          <div style={{ background: PURPLE_DARK, color: "#fff", borderRadius: 20, padding: 28, textAlign: "center" }}><h2 style={{ margin: "0 0 8px" }}>Stop guessing where your money went.</h2><p style={{ color: "#d8b4fe", margin: "0 0 18px" }}>Create your workspace and see your first reconciliation in minutes.</p><button onClick={() => openAuth("signup")} style={{ padding: "14px 28px", borderRadius: 12, border: "none", background: "#fff", color: PURPLE_DARK, fontWeight: 900, cursor: "pointer" }}>Create free account →</button></div>
        </section>
        <footer style={{ borderTop: border, padding: "20px 24px", textAlign: "center", color: "#94a3b8", fontSize: 13 }}>Ledgerwatch — Reconcile payments, settlements and bank deposits. We never move your money.</footer>
      </div>
    );
  }

  if (view === "auth") {
    return (
      <div style={{ fontFamily: "Inter, system-ui, sans-serif", minHeight: "100vh", background: "#F6F6F8", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
        <div style={{ background: "#fff", borderRadius: 20, padding: 32, width: "100%", maxWidth: 440, boxShadow: "0 10px 40px rgba(0,0,0,0.08)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}><LogoImg size={36} /><span style={{ fontWeight: 900, fontSize: 22 }}>Ledgerwatch</span></div>
          <h2 style={{ margin: "12px 0 6px", fontSize: 26 }}>{authMode === "signup" ? "Create your account" : "Welcome back"}</h2>
          <p style={{ color: "#667085", margin: "0 0 20px", fontSize: 14 }}>{authMode === "signup" ? "Your own workspace. Your data stays yours." : "Log in to your workspace."}</p>
          <div style={{ display: "flex", background: "#f1f5f9", borderRadius: 999, padding: 4, marginBottom: 20 }}>
            {(["signup", "login"] as const).map((m) => (<button key={m} onClick={() => { setAuthMode(m); setAuthError(""); setShowForgot(false); }} style={{ flex: 1, padding: "10px", borderRadius: 999, border: "none", background: authMode === m ? "#fff" : "transparent", fontWeight: 700, cursor: "pointer" }}>{m === "signup" ? "Sign up" : "Log in"}</button>))}
          </div>
          <button onClick={handleGoogle} style={{ width: "100%", padding: 12, borderRadius: 10, border: "1px solid #e2e8f0", background: "#fff", fontWeight: 700, cursor: "pointer", marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}><GoogleIcon /> Continue with Google</button>
          <div style={{ textAlign: "center", color: "#94a3b8", fontSize: 12, marginBottom: 16 }}>or with email</div>
          {!showForgot ? (
            <form onSubmit={handleAuth} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {authMode === "signup" && (<><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Full name — e.g. Ahmad Magaji" style={{ padding: 12, borderRadius: 10, border: "1px solid #e2e8f0" }} /><input value={form.business} onChange={(e) => setForm({ ...form, business: e.target.value })} placeholder="Business name — e.g. Magaji Stores" style={{ padding: 12, borderRadius: 10, border: "1px solid #e2e8f0" }} /><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="Phone — e.g. 0803 123 4567" style={{ padding: 12, borderRadius: 10, border: "1px solid #e2e8f0" }} /></>)}
              <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="Email — e.g. dsahmadmagaji@gmail.com" style={{ padding: 12, borderRadius: 10, border: "1px solid #e2e8f0" }} />
              <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="Password (at least 6 characters)" style={{ padding: 12, borderRadius: 10, border: "1px solid #e2e8f0" }} />
              {authMode === "login" && <button type="button" onClick={() => { setShowForgot(true); setForgotMsg(""); }} style={{ background: "none", border: "none", color: PURPLE, fontWeight: 700, cursor: "pointer", textAlign: "right", fontSize: 13 }}>Forgot password?</button>}
              {authError && <div style={{ color: "#dc2626", fontSize: 13 }}>{authError}</div>}
              <button type="submit" style={{ padding: 13, borderRadius: 10, border: "none", background: PURPLE, color: "#fff", fontWeight: 800, cursor: "pointer" }}>{authMode === "signup" ? "Create account →" : "Log in →"}</button>
            </form>
          ) : (
            <form onSubmit={handleForgot} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <p style={{ margin: 0, color: "#475569", fontSize: 14 }}>Enter your email. We&apos;ll reset your password.</p>
              <input value={forgotEmail} onChange={(e) => setForgotEmail(e.target.value)} placeholder="Email you signed up with" style={{ padding: 12, borderRadius: 10, border: "1px solid #e2e8f0" }} />
              {forgotMsg && <div style={{ color: forgotMsg.startsWith("Password") ? "#15803d" : "#dc2626", fontSize: 13 }}>{forgotMsg}</div>}
              <button type="submit" style={{ padding: 13, borderRadius: 10, border: "none", background: PURPLE, color: "#fff", fontWeight: 800, cursor: "pointer" }}>Reset password →</button>
              <button type="button" onClick={() => setShowForgot(false)} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer" }}>Back to log in</button>
            </form>
          )}
          <button onClick={() => setView("landing")} style={{ marginTop: 16, width: "100%", background: "none", border: "none", color: "#64748b", cursor: "pointer" }}>Back to home</button>
        </div>
      </div>
    );
  }

  return (
    <div className="layout">
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="sidebar-brand"><div className="logo-wrap"><span className="logo-fallback">L</span><img src={LOGO} alt="Ledgerwatch" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} /></div><div><strong>Ledgerwatch</strong><small>{workspaceName}</small></div><button className="close-btn" onClick={() => setSidebarOpen(false)}>X</button></div>
        <p className="menu-title">MENU</p>
        <nav>{menu.filter((m) => m.id !== "admin" || isAdmin).map((m) => (<button key={m.id} className={`nav-item ${page === m.id ? "active" : ""}`} onClick={() => { setPage(m.id); setSidebarOpen(false); setSearch(""); setStatusFilter("All"); setChannelFilter("All"); setShowAccountMenu(false); }}><span className="nav-icon">{m.icon}</span> {m.label}{m.id === "exceptions" && <span className="badge">{openExceptions.length}</span>}</button>))}</nav>
        <div className="sidebar-footer"><p>Sync. Reconcile. Resolve.</p><small>Ledgerwatch does not move money.</small><button onClick={logout} style={{ marginTop: 12, width: "100%", background: "#ffffff", border: "none", borderRadius: 999, padding: "10px 12px", cursor: "pointer", fontWeight: 800, fontSize: 14, color: "#2E1065" }}>Log out</button><button onClick={() => setView("landing")} style={{ marginTop: 10, width: "100%", background: "none", border: "none", cursor: "pointer", fontSize: 12, color: "#C4B5FD", textDecoration: "underline" }}>← Back to website</button></div>
      </aside>
      {sidebarOpen && <div className="overlay" onClick={() => setSidebarOpen(false)} />}
      <div className="main">
        <header className="topbar" style={{ position: "relative" }}>
          <button className="hamburger" onClick={() => setSidebarOpen(true)}>☰</button><h2>{activeLabel}</h2>
          <input className="search" placeholder="Search TXN, EXC, reference..." value={search} onChange={(e) => setSearch(e.target.value)} />
          <button onClick={() => setDarkMode((v) => !v)} style={{ padding: "8px 12px", borderRadius: 999, border: "1px solid #e2e8f0", background: "#fff", cursor: "pointer", fontWeight: 700 }}>{darkMode ? "Light" : "Dark"}</button>
          <div style={{ position: "relative" }}>
            <button onClick={() => setShowAccountMenu((v) => !v)} className="user" style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 999, padding: "6px 12px 6px 6px", cursor: "pointer" }}>
              <span className="avatar">{(user?.name || "A").slice(0, 1)}</span>
              <span style={{ textAlign: "left", lineHeight: 1.2 }}><strong>{user?.name || "Ahmad Magaji"}</strong><br /><small>Tap for account</small></span>
            </button>
            {showAccountMenu && (
              <div style={{ position: "absolute", right: 0, top: 52, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 14, boxShadow: "0 12px 32px rgba(0,0,0,0.14)", width: 230, zIndex: 50, overflow: "hidden" }}>
                <div style={{ padding: "12px 14px", borderBottom: "1px solid #f1f5f9" }}><strong>{user?.name}</strong><br /><small style={{ color: "#64748b" }}>{user?.email}<br />{user?.business}</small></div>
                <button onClick={goSettings} style={{ width: "100%", textAlign: "left", padding: "12px 14px", background: "none", border: "none", cursor: "pointer", fontSize: 14 }}>Settings</button>
                <button onClick={goSettings} style={{ width: "100%", textAlign: "left", padding: "12px 14px", background: "none", border: "none", cursor: "pointer", fontSize: 14, borderTop: "1px solid #f1f5f9" }}>Change Password</button>
                <button onClick={logout} style={{ width: "100%", textAlign: "left", padding: "12px 14px", background: "none", border: "none", cursor: "pointer", fontSize: 14, color: "#dc2626", borderTop: "1px solid #f1f5f9" }}>Log out</button>
              </div>
            )}
          </div>
        </header>
        <main className="content">
          {page === "overview" && (
            <>
              <div className="overview-header"><div><h2 className="overview-title">Overview</h2><p className="overview-subtitle">Payments, settlements and bank deposits — reconciled. {fmtInt(openExceptions.length)} open · {fmtInt(resolvedList.length)} resolved in this session</p></div>
                <div className="overview-header-right"><label className="period-label">Period<select value={reportPeriod} onChange={(e) => setReportPeriod(e.target.value)}><option>This week</option><option>This month</option><option>Last month</option><option>All time</option></select></label></div></div>
              <section className="kpi-grid">
                <div className="card kpi-card kpi-primary"><span>RECONCILIATION RATE</span><strong>{n(overview.reconciliation_rate)}%</strong><div className="kpi-progress"><span style={{ width: `${Math.min(100, Math.max(0, n(overview.reconciliation_rate)))}%` }} /></div><small>Matched vs flagged • {reportPeriod}</small></div>
                <div className="card kpi-card"><span>TRANSACTION VALUE</span><strong>{fmt(overview.total_value)}</strong><small>{fmtInt(overview.transactions)} transactions</small></div>
                <div className="card kpi-card"><span>SETTLEMENTS RECEIVED</span><strong>{fmt(overview.settlements_received)}</strong><small>Net after fees</small></div>
                <div className="card kpi-card"><span>OPEN EXCEPTIONS</span><strong>{fmtInt(openExceptions.length)}</strong><small>Needs investigation</small></div>
              </section>
              <div className="overview-two-col">
                <section className="panel"><div className="panel-head"><h3>Needs attention</h3><span className="count-badge">{fmtInt(openExceptions.length)} open</span></div>
                  {openExceptions.length === 0 && <p className="empty">All clear — no open exceptions.</p>}
                  {openExceptions.slice(0, 3).map((e) => (<div className="row" key={e.id}><div><strong>{e.type}</strong> · {e.id}<br /><small>{e.txn} · {e.reference}</small></div><div style={{ textAlign: "right" }}><strong>{fmt(e.amount)}</strong><br /><button className="link-btn" onClick={() => { setSelectedExc(e); setPage("exceptions"); }}>View →</button></div></div>))}
                  <button className="link-btn" onClick={() => setPage("exceptions")}>View all open exceptions →</button></section>
                <section className="panel"><div className="panel-head"><h3>Recent activity</h3></div>
                  {audit.slice(0, 3).map((a, i) => (<div className="audit-row" key={i}><small>{a.time} · {a.by}</small><span>{a.action}</span></div>))}
                  <button className="link-btn" onClick={() => setPage("reports")}>View all activity →</button></section>
              </div>
            </>
          )}
          {page === "transactions" && (
            <>
              <p className="hero-sub">Internal records — what your system says you collected.</p>
              <div className="filters"><label>Status<select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}><option>All</option><option>Matched</option><option>Amount Mismatch</option><option>Missing Settlement</option><option>Duplicate</option><option>Timing Difference</option></select></label><label>Channel<select value={channelFilter} onChange={(e) => setChannelFilter(e.target.value)}><option>All</option><option>Paystack</option><option>Flutterwave</option><option>Monnify</option></select></label><button className="clear-btn" onClick={() => { setSearch(""); setStatusFilter("All"); setChannelFilter("All"); }}>Clear filters</button></div>
              <div className="table-wrap"><table className="table"><thead><tr><th>Transaction</th><th>Customer</th><th>Date</th><th>Channel</th><th>Amount</th><th>Status</th></tr></thead><tbody>{filteredTxns.map((t) => (<tr key={t.id}><td><strong>{t.id}</strong><small>{t.reference}</small></td><td>{t.customer}</td><td>{t.date}</td><td>{t.channel}</td><td><strong>{fmt(t.amount)}</strong></td><td><span className={statusClass(t.status)}>{t.status}</span></td></tr>))}</tbody></table></div>
            </>
          )}
          {page === "settlements" && (
            <>
              <p className="hero-sub">Provider payouts — what actually hit your bank. Formula: <strong>Gross − Fee = Net</strong>.</p>
              <section className="cards"><div className="card"><span>TOTAL GROSS</span><strong>{fmt(settleTotals.gross)}</strong><small>Before fees</small></div><div className="card"><span>TOTAL FEES</span><strong>{fmt(settleTotals.fee)}</strong><small>Provider charges</small></div><div className="card"><span>TOTAL NET</span><strong>{fmt(settleTotals.net)}</strong><small>Gross − Fee</small></div><div className="card"><span>SETTLEMENTS</span><strong>{fmtInt(filteredSettlements.length)}</strong><small>Filtered view</small></div></section>
              <div className="table-wrap"><table className="table"><thead><tr><th>Settlement</th><th>Provider / Bank</th><th>Date</th><th>Gross</th><th>Fee</th><th>Net</th><th>Status</th></tr></thead><tbody>{filteredSettlements.map((s) => (<tr key={s.id}><td><strong>{s.id}</strong><small>{s.reference}</small></td><td>{s.provider}<small>{s.bank}</small></td><td>{s.date}</td><td>{fmt(s.gross)}</td><td>{fmt(s.fee)}</td><td><strong>{fmt(s.net)}</strong></td><td><span className={statusClass(s.status)}>{s.status}</span></td></tr>))}</tbody></table></div>
            </>
          )}
          {page === "reconciliation" && (
            <>
              <p className="hero-sub">Sync. Reconcile. Resolve. — Run a new reconciliation.</p>
              <div className="wizard-steps"><div className={`w-step ${wizardStep >= 1 ? "active" : ""}`}><span>1</span> Upload</div><div className="w-line" /><div className={`w-step ${wizardStep >= 2 ? "active" : ""}`}><span>2</span> Run</div><div className="w-line" /><div className={`w-step ${wizardStep >= 3 ? "active" : ""}`}><span>3</span> Results</div></div>
              {wizardStep === 1 && (<div className="panel wizard-panel"><h3>Step 1 — Upload your 3 sources</h3><p>Internal, Settlement, Bank statement. CSV for now. Or use demo data.</p><label className="upload-box"><input type="file" accept=".csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) setUploadedFile(f.name); }} hidden /><div className="upload-icon">⬆</div><strong>{uploadedFile ? `Selected: ${uploadedFile}` : "Click to choose CSV file"}</strong><small>CSV only · Max 5MB</small></label><div className="wizard-actions"><button className="secondary-btn" onClick={() => { setUploadedFile(null); setWizardStep(2); }}>Use Demo Data →</button><button className="primary-btn" disabled={!uploadedFile} onClick={() => setWizardStep(2)}>{uploadedFile ? "Continue with CSV →" : "Choose a file to continue"}</button></div></div>)}
              {wizardStep === 2 && (<div className="panel wizard-panel"><h3>Step 2 — Ready to reconcile?</h3><p>Match by reference, then Gross − Fee = Net.</p>{reconError && <p className="error">{reconError}</p>}<div className="wizard-actions"><button className="secondary-btn" onClick={() => setWizardStep(1)}>← Back</button><button className="primary-btn" onClick={runReconciliation} disabled={reconLoading}>{reconLoading ? "Reconciling..." : "Run Reconciliation"}</button></div></div>)}
              {wizardStep === 3 && recon && (<><div className="panel wizard-panel"><h3>Run Complete — {recon.run_id}</h3><div className="cards"><div className="card"><span>TOTAL</span><strong>{fmtInt(recon.total)}</strong><small>Checked</small></div><div className="card"><span>MATCHED</span><strong>{fmtInt(recon.matched)}</strong><small>Clean</small></div><div className="card"><span>EXCEPTIONS</span><strong>{fmtInt(recon.exceptions_count)}</strong><small>Needs investigation</small></div><div className="card"><span>RATE</span><strong>{n(recon.rate)}%</strong><small>Matched rate</small></div></div><div className="wizard-actions"><button className="secondary-btn" onClick={() => { setWizardStep(1); setRecon(null); }}>New Run</button><button className="primary-btn" onClick={() => setPage("exceptions")}>View Exceptions →</button></div></div><div className="panel"><h3>Exceptions ({fmtInt(recon.exceptions_count)})</h3>{asArray<Exc>(recon.exceptions).map((e) => (<div className="row" key={e.id}><div><strong>{e.type}</strong> · {e.id}<br /><small>{e.detail}</small></div><strong>{fmt(e.amount)}</strong></div>))}</div></>)}
            </>
          )}
          {page === "exceptions" && (
            <>
              <p className="hero-sub">Resolution Queue — click an exception to investigate. We never call it fraud — only needs investigation.</p>
              <section className="cards"><div className="card"><span>OPEN</span><strong>{fmtInt(openExceptions.length)}</strong><small>Needs investigation</small></div><div className="card"><span>RESOLVED THIS SESSION</span><strong>{fmtInt(resolvedList.length)}</strong><small>Audit logged</small></div><div className="card"><span>OPEN VALUE</span><strong>{fmt(openExceptions.reduce((a, e) => a + n(e.amount), 0))}</strong><small>Still unresolved</small></div></section>
              <div className="filters"><label>Type<select value={excFilter} onChange={(e) => setExcFilter(e.target.value)}><option>All</option><option>Missing Settlement</option><option>Amount Mismatch</option><option>Duplicate</option><option>Fee Discrepancy</option><option>Orphan Bank Credit</option><option>Timing Difference</option></select></label><button className="clear-btn" onClick={() => { setSearch(""); setExcFilter("All"); setSelectedExc(null); }}>Clear</button></div>
              <div className="exc-layout">
                <div className="table-wrap"><table className="table"><thead><tr><th>Exception</th><th>Type</th><th>Amount</th><th>Status</th></tr></thead><tbody>{filteredExceptions.map((e) => (<tr key={e.id} className={selectedExc?.id === e.id ? "selected-row" : ""} onClick={() => { setSelectedExc(e); setResolveMsg(""); }}><td><strong>{e.id}</strong><small>{e.txn} · {e.reference}</small></td><td><span className={statusClass(e.type)}>{e.type}</span></td><td><strong>{fmt(e.amount)}</strong></td><td>{resolvedIds.has(e.id) ? <span className="st matched">Resolved</span> : <span className="st bad">Open</span>}</td></tr>))}{filteredExceptions.length === 0 && <tr><td colSpan={4} className="empty">No exceptions match.</td></tr>}</tbody></table></div>
                <div className="panel exc-detail">
                  {!selectedExc && <><h3>Select an exception</h3><p>Click any row on the left to see evidence, assign, add a note, and resolve.</p></>}
                  {selectedExc && (<><h3>{selectedExc.id} — {selectedExc.type}</h3><p><strong>Transaction:</strong> {selectedExc.txn}<br /><strong>Reference:</strong> {selectedExc.reference}<br /><strong>Amount:</strong> {fmt(selectedExc.amount)}</p><p className="evidence"><strong>Evidence:</strong><br />{selectedExc.detail}</p>{resolvedIds.has(selectedExc.id) ? <p className="success-box">Already resolved in this session. See Audit Trail below.</p> : <><label className="field">Assign to<select value={assignee} onChange={(e) => setAssignee(e.target.value)}><option>Ahmad Magaji</option><option>Fatima Yusuf</option><option>Musa Ibrahim</option></select></label><label className="field">Resolution reason<select value={reason} onChange={(e) => setReason(e.target.value)}>{RESOLVE_REASONS.map((r) => <option key={r}>{r}</option>)}</select></label><label className="field">Note (optional)<textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Called provider, confirmed settlement lands tomorrow..." rows={3} /></label>{resolveMsg && <p className="success-box">{resolveMsg}</p>}<button className="primary-btn full" onClick={resolveSelected}>Confirm Resolution</button><p className="note">Resolving does not move money. It only records your decision + audit trail.</p></>}</>)}
                  <div className="audit"><h4>Audit Trail</h4>{audit.map((a, i) => (<div className="audit-row" key={i}><small>{a.time} · {a.by}</small><span>{a.action}</span></div>))}</div>
                </div>
              </div>
            </>
          )}
          {page === "integrations" && (
            <>
              <p className="hero-sub">Connect your money sources. Ledgerwatch only reads — it never moves money.</p>
              <div className="int-grid">{INTEGRATIONS.map((it) => (<div className="panel int-card" key={it.name}><div className="int-head"><span className="int-dot" style={{ background: PURPLE }}>{it.name[0]}</span><div><strong>{it.name}</strong><br /><small>{it.desc}</small></div></div><span className={it.status.includes("Available") ? "st matched" : "st warn"}>{it.status}</span><button className="secondary-btn" disabled={!it.status.includes("Available")}>{it.status.includes("Available") ? "Works today — see Export below" : "Coming soon — use CSV for now"}</button></div>))}</div>
              <div className="panel" style={{ marginTop: 16 }}><h3>Google Sheets Export</h3><p>Download any dataset as CSV, then in Google Sheets: <strong>File → Import → Upload</strong>.</p><div className="filters"><label>Dataset<select value={exportDataset} onChange={(e) => setExportDataset(e.target.value)}><option>Transactions</option><option>Settlements</option><option>Exceptions</option></select></label><button className="primary-btn" style={{ marginTop: 0 }} onClick={() => downloadCSV()}>Download {exportDataset} CSV</button></div>{exportMsg && <p className="success-box">{exportMsg}</p>}</div>
            </>
          )}
          {page === "reports" && (
            <>
              <p className="hero-sub">Share a clean summary with your accountant or boss — no raw CSV digging.</p>
              <div className="filters"><label>Period<select value={reportPeriod} onChange={(e) => setReportPeriod(e.target.value)}><option>This week</option><option>This month</option><option>Last month</option><option>All time</option></select></label><button className="primary-btn" style={{ marginTop: 0 }} onClick={downloadReport}>Download Report CSV</button></div>
              {reportMsg && <p className="success-box">{reportMsg}</p>}
              <div className="panel"><h3>Reconciliation Report — {workspaceName} · {reportPeriod}</h3><p className="note">Generated {new Date().toLocaleString()} · Run REC-2026-104 · Ledgerwatch does not move money.</p><div className="cards"><div className="card"><span>COLLECTED (INTERNAL)</span><strong>{fmt(overview.total_value)}</strong><small>{fmtInt(overview.transactions)} transactions</small></div><div className="card"><span>RECEIVED (SETTLEMENTS)</span><strong>{fmt(overview.settlements_received)}</strong><small>Net after fees</small></div><div className="card"><span>FLAGGED</span><strong>{fmt(overview.flagged_total)}</strong><small>{fmtInt(overview.flagged_count)} exceptions</small></div><div className="card"><span>RECONCILIATION RATE</span><strong>{n(overview.reconciliation_rate)}%</strong><small>{fmtInt(openExceptions.length)} open · {fmtInt(resolvedList.length)} resolved</small></div></div><h4>By Exception Type</h4>{asArray<BreakdownItem>(overview.breakdown).map((b) => (<div className="row" key={b.label}><div><strong>{b.label}</strong> <span>· {fmtInt(b.count)} · {b.pct}</span></div><strong>{fmt(b.amount)}</strong></div>))}<h4>What this means</h4><p>If Collected ≠ Received, the difference is in Exceptions. Resolve each exception with a reason + note, and the Audit Trail proves what you did. No mismatch is called fraud — only needs investigation.</p><div className="wizard-actions"><button className="secondary-btn" onClick={() => downloadCSV("Exceptions")}>Export Exceptions</button><button className="secondary-btn" onClick={() => downloadCSV("Transactions")}>Export Transactions</button><button className="primary-btn" onClick={downloadReport}>Download Full Report</button></div></div>
              <div className="panel" style={{ marginTop: 16 }}><h3>Audit Trail (this session)</h3>{audit.map((a, i) => (<div className="audit-row" key={i}><small>{a.time} · {a.by}</small><span>{a.action}</span></div>))}</div>
            </>
          )}
          {page === "admin" && isAdmin && (
            <>
              <p className="hero-sub">Private Admin Console — only dsahmadmagaji@gmail.com. Backend enforces access.</p>
              <div className="panel"><h3>SYSTEM OVERVIEW</h3>
                <label className="field">Admin Token (from Render ENV, not in code)<input type="password" value={adminToken} onChange={(e) => setAdminToken(e.target.value)} placeholder="Paste ADMIN_TOKEN from Render" /></label>
                <button className="primary-btn" onClick={loadAdminBackend}>Connect to Backend Admin</button>
                {adminBackendMsg && <p className="success-box">{adminBackendMsg}</p>}
                {adminHealth && <div style={{ marginTop: 12, fontSize: 14 }}><div><b>App:</b> {adminHealth.app}</div><div><b>Env:</b> {adminHealth.env}</div><div><b>Backend:</b> {adminHealth.backend}</div><div><b>Database:</b> {adminHealth.database}</div><div><b>Time:</b> {adminHealth.time}</div></div>}
              </div>
              <div className="panel" style={{ marginTop: 16 }}><h3>USERS (This device - Stage 1)</h3><p className="note">Stage 1 shows users saved on this device. Stage 2 will show real backend users from database.</p>
                <button className="secondary-btn" onClick={loadAdminUsers}>Load Users ({Object.keys(getUsers()).length})</button>{adminMsg && <p className="success-box">{adminMsg}</p>}
                {Object.entries(adminUsers).map(([email, u]) => (<div key={email} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderTop: "1px solid #EAECF0", flexWrap: "wrap", gap: 8 }}><div><b>{u.name}</b><div style={{ fontSize: 12, color: "#667085" }}>{email} · {u.business} · {u.phone}</div></div><div style={{ display: "flex", gap: 8 }}><button onClick={() => adminResetPw(email)} className="secondary-btn" style={{ padding: "8px 12px" }}>Reset to 123456</button><button onClick={() => adminDeleteUser(email)} style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #FECDCA", background: "#FEF3F2", color: "#B42318", cursor: "pointer" }}>Delete</button></div></div>))}
              </div>
              <div className="panel" style={{ marginTop: 16 }}><h3>AUDIT TRAIL</h3><p className="note">Stage 2 will log every admin action to backend audit table. For now, actions are in Recent Activity on Overview.</p>{audit.slice(0, 10).map((a, i) => (<div className="audit-row" key={i}><small>{a.time} · {a.by}</small><span>{a.action}</span></div>))}</div>
            </>
          )}
          {page === "settings" && (
            <>
              <p className="hero-sub">Manage your account and preferences. — KoboSync-style, one card per idea.</p>
              {settingsMsg && <p className="success-box">{settingsMsg}</p>}
              <div className="panel"><h3>PROFILE</h3><p className="note">Manage your account information.</p><label className="field">Email address<input value={user?.email || ""} disabled /></label><p className="note">Your account email is managed by your sign-in provider and cannot be changed here.</p><label className="field">Workspace / Business name<input value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} placeholder="Demo Commerce Ltd" /></label><label className="field">Currency<select value={currency} onChange={(e) => setCurrency(e.target.value)}><option>NGN (₦)</option><option>USD ($)</option><option>GBP (£)</option></select></label></div>
              <div className="panel" style={{ marginTop: 16 }}><h3>WHATSAPP ASSISTANT</h3><p className="note">Link your number to message Ledgerwatch on WhatsApp. You&apos;ll send a one-time code from the number you want to link.</p>
                {waLinked ? <div style={{ marginTop: 12, background: "#ECFDF3", border: "1px solid #ABEFC6", borderRadius: 12, padding: 14, display: "flex", justifyContent: "space-between", alignItems: "center" }}><div><b>Linked ✓ {waNumber}</b><div style={{ fontSize: 12, color: "#667085" }}>Daily briefings will go here when enabled.</div></div><button onClick={unlinkWa} className="secondary-btn">Unlink</button></div> : <><label className="field">WhatsApp number<input value={waNumber} onChange={(e) => setWaNumber(e.target.value)} placeholder="+2348012345678" /></label><p className="note">Include country code. Used for WhatsApp briefings on eligible plans.</p><div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}><button onClick={generateWaCode} className="primary-btn" style={{ background: PURPLE }}>Link WhatsApp</button><input value={waCode} onChange={(e) => setWaCode(e.target.value)} placeholder="Enter 6-digit code" style={{ padding: 11, borderRadius: 10, border: "1px solid #D0D5DD", width: 160 }} /><button onClick={verifyWaCode} className="secondary-btn">Verify Code</button></div>{waMsg && <div style={{ fontSize: 13, color: "#067647", marginTop: 10, background: "#ECFDF3", padding: 10, borderRadius: 10 }}>{waMsg}</div>}</>}
                <div style={{ marginTop: 18, borderTop: "1px solid #EAECF0", paddingTop: 16 }}><b>DAILY BRIEFINGS</b><p className="note">Choose how often Ledgerwatch reports your numbers and the tone used.</p><div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}><label style={{ fontSize: 13 }}>Delivery frequency<select value={briefingFreq} onChange={(e) => setBriefingFreq(e.target.value)} style={{ display: "block", padding: 10, borderRadius: 10, border: "1px solid #D0D5DD", marginTop: 4 }}><option>Daily</option><option>Weekly</option><option>Off</option></select></label><label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}><input type="checkbox" checked={waBriefingOn} onChange={(e) => setWaBriefingOn(e.target.checked)} /> Send to WhatsApp</label></div><div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>{["Merchant style", "Ledger style"].map((t) => (<button key={t} onClick={() => setBriefingTone(t)} style={{ textAlign: "left", padding: 14, borderRadius: 12, border: briefingTone === t ? `2px solid ${PURPLE}` : "1px solid #D0D5DD", background: "#fff", cursor: "pointer" }}><b>{t}</b><div style={{ fontSize: 12, color: "#667085" }}>{t === "Merchant style" ? "Net profit, top customer, warm daily recap" : "Concise summary of transactions, fees, exceptions"}</div><div style={{ textAlign: "right" }}>{briefingTone === t ? "✓" : ""}</div></button>))}</div><div style={{ fontSize: 12, color: "#667085", marginTop: 10 }}>Example ({briefingTone}): {briefingTone === "Merchant style" ? "Good morning! Yesterday you collected ₦98,500, bank received ₦96,500. 1 exception needs your eye — ₦2,000 difference." : "Reconciliation: Collected ₦98,500 • Bank ₦96,500 • Exceptions 1 • Rate 96.4%"}</div></div>
              </div>
              <div className="panel" style={{ marginTop: 16 }}><h3>MATCHING RULES</h3><label className="field">Amount tolerance (₦)<input type="number" value={tolerance} onChange={(e) => setTolerance(e.target.value)} placeholder="0" /></label><label className="field">Date tolerance (days)<select value={dateTolerance} onChange={(e) => setDateTolerance(e.target.value)}><option>0</option><option>1</option><option>2</option><option>3</option><option>7</option></select></label><p className="note">Recommended: Amount ₦0 (exact kobo), Date 1 day (T+1 settlement).</p><label className="check"><input type="checkbox" checked={notifyEmail} onChange={(e) => setNotifyEmail(e.target.checked)} /> Email me a daily summary</label><label className="check"><input type="checkbox" checked={notifyNewExc} onChange={(e) => setNotifyNewExc(e.target.checked)} /> Alert me when a new exception appears</label><button className="primary-btn" onClick={saveSettings}>Save Settings</button></div>
              <div className="panel" style={{ marginTop: 16 }}><h3>BILLING</h3><p className="note">Review your current plan, subscription status, and upgrade options.</p><div style={{ display: "flex", justifyContent: "space-between", marginTop: 10 }}><div><div style={{ fontSize: 11, color: "#667085" }}>CURRENT PLAN</div><b style={{ fontSize: 20 }}>{currentPlan}</b></div><span style={{ background: "#ECFDF3", color: "#067647", padding: "4px 10px", borderRadius: 999, fontSize: 12, height: 24 }}>● Active</span></div>{billingMsg && <div style={{ color: "#067647", fontSize: 13, marginTop: 10 }}>{billingMsg}</div>}{billingError && <div style={{ color: "#B42318", fontSize: 13 }}>{billingError}</div>}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 12, marginTop: 14 }}>{PLANS.map((p) => (<div key={p.name} style={{ border: selectedPlan === p.name ? `2px solid ${PURPLE}` : "1px solid #D0D5DD", borderRadius: 12, padding: 14 }}><b>{p.name}</b><div style={{ fontSize: 20, fontWeight: 900 }}>{fmt(p.price)} <span style={{ fontSize: 12, color: "#667085" }}>/ month</span></div><div style={{ fontSize: 12, color: "#667085" }}>{p.desc}</div><button onClick={() => setSelectedPlan(p.name)} style={{ width: "100%", marginTop: 10, padding: 10, borderRadius: 10, border: selectedPlan === p.name ? "none" : "1px solid #D0D5DD", background: selectedPlan === p.name ? PURPLE : "#fff", color: selectedPlan === p.name ? "#fff" : "#131118", fontWeight: 700, cursor: "pointer" }}>{selectedPlan === p.name ? "Selected ✓" : "Select"}</button></div>))}</div>
                <div style={{ marginTop: 16, borderTop: "1px solid #EAECF0", paddingTop: 14 }}><b>Secure billing via Paystack</b><p className="note">You pay on Paystack&apos;s secure page — card, transfer or USSD. Ledgerwatch never sees or stores your card number. Subscriptions renew automatically and can be cancelled from your Paystack account.</p><button onClick={subscribe} className="primary-btn" disabled={billingLoading}>{billingLoading ? "Connecting to Paystack..." : `Subscribe to ${selectedPlan} — ${fmt(PLANS.find((p) => p.name === selectedPlan)?.price)} / month via Paystack →`}</button><p className="note">You will be redirected to Paystack to complete payment safely.</p></div>
              </div>
              <div className="panel" style={{ marginTop: 16 }}><h3>Change Password</h3><p><strong>{user?.name}</strong><br /><small>{user?.business} · {user?.email}</small></p><label className="field">Current password<input type="password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} placeholder="Your current password" /></label><label className="field">New password (at least 6 characters)<input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} placeholder="New password" /></label>{pwMsg && <p className={pwMsg.startsWith("Password") ? "success-box" : "error"}>{pwMsg}</p>}<button className="primary-btn" onClick={handleChangePassword}>Change Password</button></div>
              {isAdmin && (
                <div className="panel" style={{ marginTop: 16, border: "2px solid #5B0DBA" }}><h3>ADMIN — User Management</h3><p className="note">Only visible to {ADMIN_EMAIL}. Fix user problems here.</p><button className="secondary-btn" onClick={loadAdminUsers}>Load Users ({Object.keys(getUsers()).length})</button>{adminMsg && <p className="success-box">{adminMsg}</p>}
                  {Object.entries(adminUsers).map(([email, u]) => (<div key={email} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderTop: "1px solid #EAECF0", flexWrap: "wrap", gap: 8 }}><div><b>{u.name}</b><div style={{ fontSize: 12, color: "#667085" }}>{email} · {u.business} · {u.phone}</div></div><div style={{ display: "flex", gap: 8 }}><button onClick={() => adminResetPw(email)} className="secondary-btn" style={{ padding: "8px 12px" }}>Reset to 123456</button><button onClick={() => adminDeleteUser(email)} style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #FECDCA", background: "#FEF3F2", color: "#B42318", cursor: "pointer" }}>Delete</button></div></div>))}
                </div>
              )}
              <div className="panel" style={{ marginTop: 16, border: "1px solid #FECDCA" }}><h3 style={{ color: "#B42318" }}>DANGER ZONE</h3><p className="note">Manage account-level actions that may have permanent consequences.</p><div style={{ display: "flex", justifyContent: "space-between", marginTop: 12, alignItems: "center" }}><div><b>Sign out</b><div style={{ fontSize: 12, color: "#667085" }}>Sign out on this device. You can sign in again at any time.</div></div><button onClick={logout} className="secondary-btn">Sign out</button></div><div style={{ marginTop: 14, borderTop: "1px solid #EAECF0", paddingTop: 14 }}><b style={{ color: "#B42318" }}>Delete account</b><div style={{ fontSize: 12, color: "#667085" }}>Permanently deletes your account and workspace. This action cannot be undone.</div>{!showDelete ? <button onClick={() => setShowDelete(true)} style={{ marginTop: 10, padding: "9px 14px", borderRadius: 10, border: "1px solid #FECDCA", background: "#FEF3F2", color: "#B42318", cursor: "pointer" }}>Delete my account</button> : <div style={{ marginTop: 10, display: "flex", gap: 10 }}><button onClick={() => { localStorage.removeItem("lw_session"); localStorage.removeItem("lw_users"); setUser(null); setView("landing"); }} style={{ padding: "9px 14px", borderRadius: 10, border: "none", background: "#B42318", color: "#fff", cursor: "pointer" }}>Yes, delete permanently</button><button onClick={() => setShowDelete(false)} className="secondary-btn">Cancel</button></div>}</div></div>
              <div className="panel" style={{ marginTop: 16 }}><h3>Your Account</h3><p><strong>{user?.name}</strong><br /><small>{user?.business} · {user?.email}</small></p><p className="note">Ledgerwatch never asks for your bank login. It only reads CSVs / provider reports you upload. It never moves money.</p><button className="primary-btn" onClick={saveSettings}>Save Settings</button><button className="secondary-btn" onClick={logout} style={{ marginLeft: 10 }}>Log out</button></div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}