import { useState } from "react";
type Props = { apiUrl: string; adminToken: string };
export default function AdminConsole({ apiUrl, adminToken }: Props) {
  const [tab, setTab] = useState<"health" | "users" | "audit" | "diagnostics" | "security">("health");
  const [health, setHealth] = useState<any>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [audit, setAudit] = useState<any[]>([]);
  const [diag, setDiag] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [auditFilter, setAuditFilter] = useState("");
  const [confirmUser, setConfirmUser] = useState<any>(null);
  const headers = { "X-Admin-Token": adminToken };
  const loadAll = async () => {
    if (!adminToken) { setError("Enter Admin Token first"); return; }
    setLoading(true); setError(""); setMsg("");
    try {
      const [h, u, a, d] = await Promise.all([
        fetch(`${apiUrl}/api/admin/health`, { headers }),
        fetch(`${apiUrl}/api/admin/users?limit=50`, { headers }),
        fetch(`${apiUrl}/api/admin/audit?limit=50`, { headers }),
        fetch(`${apiUrl}/api/admin/diagnostics`, { headers }),
      ]);
      if (h.status === 401) throw new Error("Admin token rejected - 401. Check your new rotated token.");
      if (!h.ok) throw new Error("Backend admin failed");
      setHealth(await h.json()); setUsers(await u.json()); setAudit(await a.json()); setDiag(await d.json());
      setMsg("Backend admin connected - real data");
    } catch (e: any) { setError(e.message || "Cannot load admin data"); setUsers([]); setAudit([]); }
    finally { setLoading(false); }
  };
  const changeRole = async (id: number, role: string) => {
    const r = await fetch(`${apiUrl}/api/admin/users/${id}/role`, { method: "PATCH", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ role }) });
    if (!r.ok) { const j = await r.json().catch(() => ({})); setError(j.detail || "Role change failed"); return; }
    await loadAll();
  };
  const changeStatusDirect = async (user: any, status: string) => {
    const r = await fetch(`${apiUrl}/api/admin/users/${user.id}/status`, { method: "PATCH", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ status, reason: "admin action" }) });
    if (!r.ok) { const j = await r.json().catch(() => ({})); setError(j.detail || "Status change failed"); return; }
    setConfirmUser(null); await loadAll();
  };
  const changeStatus = async (user: any, status: string) => { if (status === "deactivated") { setConfirmUser({ user, status }); return; } await changeStatusDirect(user, status); };
  const requestReset = async (email: string) => {
    const r = await fetch(`${apiUrl}/api/admin/users/request-password-reset`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
    if (!r.ok) { setError("Reset request failed"); return; }
    setMsg("If the account exists, a reset has been initiated.");
  };
  const filteredUsers = users.filter((u) => {
    if (q && !(`${u.name} ${u.email}`.toLowerCase().includes(q.toLowerCase()))) return false;
    if (roleFilter && u.role !== roleFilter) return false;
    if (statusFilter && u.status !== statusFilter) return false;
    return true;
  });
  const filteredAudit = audit.filter((e) => { if (auditFilter && !(`${e.action} ${e.actor} ${e.target}`.toLowerCase().includes(auditFilter.toLowerCase()))) return false; return true; });
  return (
    <div className="admin-console">
      <div className="admin-head"><div><h1>Admin Console</h1><p>Manage platform operations, access, system health, and audit activity.</p></div><button onClick={loadAll} disabled={loading}>{loading ? "Loading..." : "Refresh from backend"}</button></div>
      {error && <div className="admin-error">{error}</div>}
      {msg && <div className="admin-ok">{msg}</div>}
      <div className="admin-tabs">{(["health", "users", "audit", "diagnostics", "security"] as const).map((t) => (<button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>{t === "health" ? "System Health" : t === "users" ? "Users & Access" : t === "audit" ? "Audit Trail" : t === "diagnostics" ? "API & Database Diagnostics" : "Security Settings"}</button>))}</div>
      {tab === "health" && (<div className="admin-card">{!health ? <p>Click Refresh from backend to load real health.</p> : (<><p><b>Backend:</b> {health.backend}</p><p><b>Database:</b> {health.database} — {health.database === "connected" ? "Healthy" : "Unavailable"}</p><p><b>Environment:</b> {health.env}</p><p><b>Last check:</b> {health.time}</p><p><b>Version:</b> {health.version}</p></>)}</div>)}
      {tab === "users" && (<div className="admin-card"><div className="admin-filters"><input placeholder="Search name or email" value={q} onChange={(e) => setQ(e.target.value)} /><select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}><option value="">All roles</option><option value="super_admin">Super Admin</option><option value="admin">Admin</option><option value="support">Support</option><option value="auditor">Auditor</option></select><select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}><option value="">All status</option><option value="active">Active</option><option value="deactivated">Deactivated</option></select></div>{loading ? <p>Loading users from backend...</p> : filteredUsers.length === 0 ? <p>No users in backend database.</p> : (<table className="admin-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead><tbody>{filteredUsers.map((u) => (<tr key={u.id}><td>{u.name}</td><td>{u.email}</td><td><select value={u.role} onChange={(e) => changeRole(u.id, e.target.value)}><option value="super_admin">Super Admin</option><option value="admin">Admin</option><option value="support">Support</option><option value="auditor">Auditor</option></select></td><td>{u.status}</td><td>{u.created_at ? new Date(u.created_at).toLocaleDateString() : "-"}</td><td>{u.status === "active" ? <button onClick={() => changeStatus(u, "deactivated")}>Deactivate</button> : <button onClick={() => changeStatus(u, "active")}>Reactivate</button>}<button onClick={() => requestReset(u.email)}>Request password reset</button></td></tr>))}</tbody></table>)}<p className="admin-note">No fixed-password reset. Reset uses a 30-minute single-use token. No hard delete — deactivation only, to preserve audit + financial history.</p></div>)}
      {tab === "audit" && (<div className="admin-card"><input placeholder="Filter by action / actor / target" value={auditFilter} onChange={(e) => setAuditFilter(e.target.value)} />{filteredAudit.length === 0 ? <p>No audit events yet — events are written by backend only.</p> : (<table className="admin-table"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Outcome</th></tr></thead><tbody>{filteredAudit.map((e) => (<tr key={e.id}><td>{new Date(e.created_at).toLocaleString()}</td><td>{e.actor}</td><td>{e.action}</td><td>{e.target}</td><td>{e.outcome}</td></tr>))}</tbody></table>)}</div>)}
      {tab === "diagnostics" && (<div className="admin-card">{!diag ? <p>Click Refresh to load diagnostics.</p> : (<><p><b>Database:</b> {diag.database}</p><p><b>Users total:</b> {diag.users_total}</p><p><b>Audit events total:</b> {diag.audit_events_total}</p><p><b>Checked at:</b> {diag.checked_at}</p><p><b>Version:</b> {diag.version}</p></>)}<p className="admin-note">No SQL console. Diagnostics are read-only and admin-only.</p></div>)}
      {tab === "security" && (<div className="admin-card"><p><b>Admin token:</b> Configured (value not shown)</p><p><b>Password reset:</b> Token-based, 30 min, single-use</p><p><b>Audit:</b> Backend-written only</p><p><b>Hard delete:</b> Disabled — deactivation only</p><p><b>Last super admin protection:</b> Enabled</p></div>)}
      {confirmUser && (<div className="admin-modal-backdrop"><div className="admin-modal"><h3>Deactivate {confirmUser.user.name} ({confirmUser.user.email})?</h3><p>This will block login but preserve audit + financial history.</p><button onClick={() => setConfirmUser(null)}>Cancel</button><button onClick={() => changeStatusDirect(confirmUser.user, "deactivated")}>Confirm Deactivate</button></div></div>)}
    </div>
  );
}
