import { useEffect, useState } from "react";

const API = import.meta.env.VITE_API_URL || "http://localhost:8000";
const FRONT = "https://ledgerwatch-theta.vercel.app";

type User = { id: number; name: string; username?: string | null; email: string; role: string; status: string; created_at?: string };
type Audit = { id: number; created_at: string; actor: string; action: string; target: string; outcome: string; meta: string };

export default function AdminConsole({ token, onBack }: { token: string; onBack: () => void }) {
  const [users, setUsers] = useState<User[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [txs, setTxs] = useState<any[]>([]);
  const [txKind, setTxKind] = useState("orders");
  const [msg, setMsg] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [role, setNewRole] = useState("support");
  const [editId, setEditId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editUsername, setEditUsername] = useState("");
  const [resetLink, setResetLink] = useState("");

  const H = { "x-admin-token": token, "Content-Type": "application/json" };
  const load = async () => {
    const u = await fetch(`${API}/api/admin/users?limit=100`, { headers: { "x-admin-token": token } });
    if (u.ok) setUsers(await u.json());
    const a = await fetch(`${API}/api/admin/audit?limit=50`, { headers: { "x-admin-token": token } });
    if (a.ok) setAudit(await a.json());
    const t = await fetch(`${API}/api/admin/transactions?kind=${txKind}&limit=50`, { headers: { "x-admin-token": token } });
    if (t.ok) setTxs(await t.json());
  };
  useEffect(() => { load(); }, [txKind]);

  const createUser = async () => {
    setMsg(""); setResetLink("");
    const r = await fetch(`${API}/api/admin/users/create`, { method: "POST", headers: H, body: JSON.stringify({ name, email, username: username || undefined, role }) });
    const j = await r.json();
    if (!r.ok) { setMsg("ERROR: " + (j.detail || "create failed")); return; }
    setMsg("User created: " + j.email + ". Now generating reset link...");
    const rr = await fetch(`${API}/api/admin/users/request-password-reset`, { method: "POST", headers: H, body: JSON.stringify({ email }) });
    const jj = await rr.json();
    if (jj.reset_link) setResetLink(jj.reset_link);
    setName(""); setEmail(""); setUsername("");
    load();
  };
  const saveEdit = async () => {
    if (!editId) return;
    const r = await fetch(`${API}/api/admin/users/${editId}`, { method: "PATCH", headers: H, body: JSON.stringify({ name: editName, email: editEmail, username: editUsername || undefined }) });
    const j = await r.json();
    if (!r.ok) { setMsg("ERROR: " + (j.detail || "update failed")); return; }
    setMsg("Updated: " + j.email); setEditId(null); load();
  };
  const updateUserRole = async (id: number, newRole: string) => {
    const r = await fetch(`${API}/api/admin/users/${id}/role`, { method: "PATCH", headers: H, body: JSON.stringify({ role: newRole }) });
    const j = await r.json();
    if (!r.ok) setMsg("ERROR: " + (j.detail || "role failed")); else setMsg("Role changed");
    load();
  };
  const setStatus = async (id: number, status: string) => {
    const r = await fetch(`${API}/api/admin/users/${id}/status`, { method: "PATCH", headers: H, body: JSON.stringify({ status, reason: "admin action" }) });
    const j = await r.json();
    if (!r.ok) setMsg("ERROR: " + (j.detail || "status failed")); else setMsg("Status changed");
    load();
  };
  const doReset = async (em: string) => {
    const r = await fetch(`${API}/api/admin/users/request-password-reset`, { method: "POST", headers: H, body: JSON.stringify({ email: em }) });
    const j = await r.json();
    if (j.reset_link) { setResetLink(j.reset_link); setMsg("Reset link generated for " + em); }
    else setMsg(j.message || "Reset requested");
  };
  const hardDelete = async (id: number, em: string) => {
    if (!confirm("PERMANENT hard-delete " + em + "? This cannot be undone.")) return;
    const r = await fetch(`${API}/api/admin/users/${id}/hard-delete`, { method: "DELETE", headers: { "x-admin-token": token } });
    const j = await r.json();
    if (!r.ok) setMsg("ERROR: " + (j.detail || "delete failed")); else setMsg("Hard-deleted: " + em);
    load();
  };
  const restore = async (id: number) => {
    const r = await fetch(`${API}/api/admin/users/${id}/restore`, { method: "POST", headers: { "x-admin-token": token } });
    const j = await r.json();
    if (!r.ok) setMsg("ERROR: " + (j.detail || "restore failed")); else setMsg("Restored");
    load();
  };
  const exportAudit = async () => {
    const r = await fetch(`${API}/api/admin/audit/export`, { headers: { "x-admin-token": token } });
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "ledgerwatch-audit.csv"; a.click(); URL.revokeObjectURL(url);
  };

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: 16, fontFamily: "system-ui" }}>
      <button onClick={onBack} style={{ marginBottom: 12 }}>← Back to Dashboard</button>
      <h1>Admin Console — Real Backend</h1>
      {msg && <div style={{ background: "#eef", padding: 10, borderRadius: 8, marginBottom: 12 }}>{msg}</div>}
      {resetLink && (
        <div style={{ background: "#fff3cd", padding: 12, borderRadius: 8, marginBottom: 12 }}>
          <b>Reset link — copy and send securely, do not post in public chat:</b>
          <div style={{ wordBreak: "break-all", marginTop: 6 }}>{resetLink}</div>
          <button onClick={() => { navigator.clipboard.writeText(resetLink); setMsg("Copied"); }} style={{ marginTop: 8 }}>Copy Link</button>
        </div>
      )}

      <h2>Create User / Invite</h2>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <input placeholder="Full name" value={name} onChange={e => setName(e.target.value)} />
        <input placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} />
        <input placeholder="Username (optional)" value={username} onChange={e => setUsername(e.target.value)} />
        <select value={role} onChange={e => setNewRole(e.target.value)}>
          <option value="support">support</option><option value="auditor">auditor</option><option value="admin">admin</option><option value="super_admin">super_admin</option>
        </select>
        <button onClick={createUser}>Create + Generate Reset Link</button>
      </div>

      <h2>Users ({users.length})</h2>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr><th align="left">Name</th><th align="left">Username</th><th align="left">Email</th><th align="left">Role</th><th align="left">Status</th><th align="left">Actions</th></tr></thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id} style={{ borderTop: "1px solid #ddd" }}>
                <td>{u.name}</td><td>@{u.username || "-"}</td><td>{u.email}</td>
                <td><select value={u.role} onChange={e => updateUserRole(u.id, e.target.value)}><option value="support">support</option><option value="auditor">auditor</option><option value="admin">admin</option><option value="super_admin">super_admin</option></select></td>
                <td>{u.status}</td>
                <td style={{ display: "flex", gap: 4, flexWrap: "wrap", padding: 4 }}>
                  <button onClick={() => { setEditId(u.id); setEditName(u.name); setEditEmail(u.email); setEditUsername(u.username || ""); }}>Edit</button>
                  <button onClick={() => doReset(u.email)}>Reset Link</button>
                  {u.status === "active" ? <button onClick={() => setStatus(u.id, "deactivated")}>Deactivate</button> : <button onClick={() => restore(u.id)}>Restore</button>}
                  <button onClick={() => hardDelete(u.id, u.email)} style={{ color: "red" }}>Hard Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editId && (
        <div style={{ background: "#f6f6f6", padding: 12, borderRadius: 8, marginTop: 12 }}>
          <b>Edit user #{editId}</b>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
            <input value={editName} onChange={e => setEditName(e.target.value)} placeholder="Name" />
            <input value={editEmail} onChange={e => setEditEmail(e.target.value)} placeholder="Email" />
            <input value={editUsername} onChange={e => setEditUsername(e.target.value)} placeholder="Username" />
            <button onClick={saveEdit}>Save</button>
            <button onClick={() => setEditId(null)}>Cancel</button>
          </div>
        </div>
      )}

      <h2 style={{ marginTop: 24 }}>Transactions — Real Data</h2>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <button onClick={() => setTxKind("orders")}>Orders</button>
        <button onClick={() => setTxKind("settlements")}>Settlements</button>
        <button onClick={() => setTxKind("bank")}>Bank</button>
        <span>{txs.length} rows</span>
      </div>
      <div style={{ overflowX: "auto", maxHeight: 300, overflowY: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr><th align="left">ID</th><th align="left">Reference</th><th align="left">Amount (kobo)</th><th align="left">Detail</th></tr></thead>
          <tbody>{txs.map((t: any) => (
            <tr key={t.id} style={{ borderTop: "1px solid #eee" }}><td>{t.id}</td><td>{t.reference}</td><td>{t.amount_kobo}</td><td>{t.customer || t.order_ref || t.narration || t.date || ""}</td></tr>
          ))}</tbody>
        </table>
      </div>

      <h2 style={{ marginTop: 24 }}>Audit Log</h2>
      <button onClick={exportAudit}>Export Audit CSV</button>
      <div style={{ overflowX: "auto", maxHeight: 300, overflowY: "auto", marginTop: 8 }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr><th align="left">Time</th><th align="left">Actor</th><th align="left">Action</th><th align="left">Target</th><th align="left">Meta</th></tr></thead>
          <tbody>{audit.map(a => (
            <tr key={a.id} style={{ borderTop: "1px solid #eee" }}><td>{a.created_at}</td><td>{a.actor}</td><td>{a.action}</td><td>{a.target}</td><td>{a.meta}</td></tr>
          ))}</tbody>
        </table>
      </div>
      <p style={{ color: "#666", marginTop: 16 }}>Frontend: {FRONT} — Backend: {API}</p>
    </div>
  );
}
