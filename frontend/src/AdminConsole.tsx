import { useState } from "react";
type Props = { apiUrl: string; adminToken: string };
export default function AdminConsole({ apiUrl, adminToken }: Props) {
  const [tab, setTab] = useState<"health"|"users"|"audit"|"diagnostics"|"security"|"transactions"|"create">("health");
  const [health, setHealth] = useState<any>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [audit, setAudit] = useState<any[]>([]);
  const [diag, setDiag] = useState<any>(null);
  const [txns, setTxns] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [resetLink, setResetLink] = useState("");
  const [resetFor, setResetFor] = useState("");
  const [tempPw, setTempPw] = useState("");
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [auditFilter, setAuditFilter] = useState("");
  const [confirmUser, setConfirmUser] = useState<any>(null);
  const [hardDeleteUser, setHardDeleteUser] = useState<any>(null);
  const [editUser, setEditUser] = useState<any>(null);
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editUsername, setEditUsername] = useState("");
  // Create form
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [newRole, setNewRole] = useState("support");
  const headers = { "X-Admin-Token": adminToken };
  const loadAll = async () => {
    if (!adminToken) { setError("Enter Admin Token first"); return; }
    setLoading(true); setError(""); setMsg(""); setResetLink("");
    try {
      const [h,u,a,d,t] = await Promise.all([
        fetch(`${apiUrl}/api/admin/health`, { headers }),
        fetch(`${apiUrl}/api/admin/users?limit=100`, { headers }),
        fetch(`${apiUrl}/api/admin/audit?limit=100`, { headers }),
        fetch(`${apiUrl}/api/admin/diagnostics`, { headers }),
        fetch(`${apiUrl}/api/admin/transactions?limit=50`, { headers }),
      ]);
      if (h.status===401) throw new Error("Admin token rejected - 401. Check your new rotated token.");
      if (!h.ok) throw new Error("Backend admin failed");
      setHealth(await h.json()); setUsers(await u.json()); setAudit(await a.json()); setDiag(await d.json());
      try { setTxns(await t.json()); } catch { setTxns([]); }
      setMsg("Backend admin connected - real data");
    } catch(e:any){ setError(e.message||"Cannot load admin data"); setUsers([]); setAudit([]); setTxns([]); }
    finally{ setLoading(false); }
  };
  const changeRole = async (id:number, role:string) => {
    const r = await fetch(`${apiUrl}/api/admin/users/${id}/role`, { method:"PATCH", headers:{...headers,"Content-Type":"application/json"}, body:JSON.stringify({role}) });
    if(!r.ok){ const j=await r.json().catch(()=>({})); setError(j.detail||"Role change failed"); return; }
    await loadAll();
  };
  const changeStatusDirect = async (user:any, status:string) => {
    const r = await fetch(`${apiUrl}/api/admin/users/${user.id}/status`, { method:"PATCH", headers:{...headers,"Content-Type":"application/json"}, body:JSON.stringify({status, reason:"admin action"}) });
    if(!r.ok){ const j=await r.json().catch(()=>({})); setError(j.detail||"Status change failed"); return; }
    setConfirmUser(null); await loadAll();
  };
  const changeStatus = async (user:any, status:string) => { if(status==="deactivated"){ setConfirmUser({user,status}); return; } await changeStatusDirect(user,status); };
  const restoreUser = async (user:any) => {
    const r = await fetch(`${apiUrl}/api/admin/users/${user.id}/restore`, { method:"POST", headers });
    if(!r.ok){ const j=await r.json().catch(()=>({})); setError(j.detail||"Restore failed"); return; }
    setMsg(`Restored ${user.email} to active`); await loadAll();
  };
  const doHardDelete = async () => {
    if(!hardDeleteUser) return;
    const r = await fetch(`${apiUrl}/api/admin/users/${hardDeleteUser.id}/hard-delete`, { method:"DELETE", headers });
    if(!r.ok){ const j=await r.json().catch(()=>({})); setError(j.detail||"Hard delete failed"); return; }
    setHardDeleteUser(null); setMsg(`Permanently deleted ${hardDeleteUser.email}`); await loadAll();
  };
  const requestReset = async (email:string) => {
    const r = await fetch(`${apiUrl}/api/admin/users/request-password-reset`, { method:"POST", headers:{...headers,"Content-Type":"application/json"}, body:JSON.stringify({email}) });
    const j = await r.json().catch(()=>({}));
    if(!r.ok){ setError(j.detail||"Reset request failed"); return; }
    if(j.reset_link){ setResetLink(j.reset_link); setResetFor(email); setMsg(`Reset link generated for ${email} - copy it below and send it securely. Expires in 30 min.`); }
    else { setMsg("If the account exists, a reset has been initiated."); }
  };
  const createUser = async () => {
    if(!newName.trim() || !newEmail.trim()){ setError("Name and email are required"); return; }
    setError(""); setTempPw("");
    const r = await fetch(`${apiUrl}/api/admin/users/create`, { method:"POST", headers:{...headers,"Content-Type":"application/json"}, body:JSON.stringify({name:newName, email:newEmail, role:newRole, username:newUsername||undefined}) });
    const j = await r.json().catch(()=>({}));
    if(!r.ok){ setError(j.detail||"Create user failed"); return; }
    setTempPw(j.temp_password||""); setMsg(`Created ${j.email} as ${j.role}. Share the temp password securely - user must change it on first login.`);
    setNewName(""); setNewEmail(""); setNewUsername(""); setNewRole("support");
    await loadAll();
  };
  const saveEdit = async () => {
    if(!editUser) return;
    const r = await fetch(`${apiUrl}/api/admin/users/${editUser.id}`, { method:"PATCH", headers:{...headers,"Content-Type":"application/json"}, body:JSON.stringify({name:editName, email:editEmail, username:editUsername||undefined}) });
    const j = await r.json().catch(()=>({}));
    if(!r.ok){ setError(j.detail||"Update failed"); return; }
    setEditUser(null); setMsg(`Updated ${j.email}`); await loadAll();
  };
  const verifyTxn = async (id:number) => {
    const r = await fetch(`${apiUrl}/api/admin/transactions/${id}/verify`, { method:"POST", headers });
    if(!r.ok){ const j=await r.json().catch(()=>({})); setError(j.detail||"Verify failed"); return; }
    setMsg(`Transaction ${id} verified`); await loadAll();
  };
  const exportAudit = () => {
    // Use backend CSV endpoint - opens download with admin token via fetch blob
    fetch(`${apiUrl}/api/admin/audit/export`, { headers }).then(async (r)=>{
      if(!r.ok) throw new Error("Export failed");
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href=url; a.download="ledgerwatch-audit.csv"; a.click(); URL.revokeObjectURL(url);
      setMsg("Audit CSV downloaded");
    }).catch(()=>setError("Export failed - check backend"));
  };
  const filteredUsers = users.filter((u)=>{ if(q && !(`${u.name} ${u.email}`.toLowerCase().includes(q.toLowerCase()))) return false; if(roleFilter && u.role!==roleFilter) return false; if(statusFilter && u.status!==statusFilter) return false; return true; });
  const filteredAudit = audit.filter((e)=>{ if(auditFilter && !(`${e.action} ${e.actor} ${e.target}`.toLowerCase().includes(auditFilter.toLowerCase()))) return false; return true; });
  const tabs: {id:any; label:string}[] = [
    {id:"health",label:"System Health"},{id:"users",label:"Users & Access"},{id:"create",label:"+ Create User"},{id:"transactions",label:"Transactions"},{id:"audit",label:"Audit Trail"},{id:"diagnostics",label:"Diagnostics"},{id:"security",label:"Security"}
  ];
  return (
    <div className="admin-console">
      <div className="admin-head"><div><h1>Admin Console</h1><p>Manage platform operations, access, system health, and audit activity.</p></div><button onClick={loadAll} disabled={loading}>{loading?"Loading...":"Refresh from backend"}</button></div>
      {error && <div className="admin-error">{error}</div>}
      {msg && <div className="admin-ok">{msg}</div>}
      {resetLink && <div className="admin-card" style={{marginBottom:14}}><p><b>Reset link for {resetFor}:</b></p><p style={{wordBreak:"break-all", background:"#F9FAFB", padding:"10px 12px", borderRadius:8, border:"1px solid #EAECF0"}}>{resetLink}</p><button onClick={()=>{navigator.clipboard.writeText(resetLink); setMsg("Reset link copied");}}>Copy Reset Link</button><p className="admin-note">Expires in 30 min, single-use. Send it securely - do not paste it in chat.</p></div>}
      {tempPw && <div className="admin-card" style={{marginBottom:14, borderColor:"#ABEFC6"}}><p><b>Temp password for new user:</b> <span style={{background:"#ECFDF3", padding:"4px 8px", borderRadius:6}}>{tempPw}</span></p><button onClick={()=>{navigator.clipboard.writeText(tempPw); setMsg("Temp password copied");}}>Copy Temp Password</button><p className="admin-note">User must change it on first login. Share securely.</p></div>}
      <div className="admin-tabs">{tabs.map((t)=>(<button key={t.id} className={tab===t.id?"active":""} onClick={()=>setTab(t.id)}>{t.label}</button>))}</div>
      {tab==="health" && (<div className="admin-card">{!health?<p>Click Refresh from backend to load real health.</p>:(<><p><b>Backend:</b> {health.backend}</p><p><b>Database:</b> {health.database} — {health.database==="connected"?"Healthy":"Unavailable"}</p><p><b>Environment:</b> {health.env}</p><p><b>Last check:</b> {health.time}</p><p><b>Version:</b> {health.version}</p></>)}</div>)}
      {tab==="create" && (<div className="admin-card"><h3 style={{marginTop:0}}>Invite / Create User</h3><p>Create a user without them signing up. They get a temp password and must change it.</p><div className="admin-filters" style={{flexDirection:"column", maxWidth:520}}><input placeholder="Full name *" value={newName} onChange={(e)=>setNewName(e.target.value)} /><input placeholder="Email *" value={newEmail} onChange={(e)=>setNewEmail(e.target.value)} /><input placeholder="Username (optional)" value={newUsername} onChange={(e)=>setNewUsername(e.target.value)} /><select value={newRole} onChange={(e)=>setNewRole(e.target.value)}><option value="support">Support</option><option value="auditor">Auditor</option><option value="admin">Admin</option><option value="super_admin">Super Admin</option></select><button onClick={createUser} style={{background:"#5B0DBA", color:"#fff", border:"none", padding:"11px", borderRadius:10}}>Create User + Generate Temp Password</button></div><p className="admin-note">No email is sent automatically yet. Copy the temp password above and send it securely to the new user.</p></div>)}
      {tab==="users" && (<div className="admin-card"><div className="admin-filters"><input placeholder="Search name or email" value={q} onChange={(e)=>setQ(e.target.value)} /><select value={roleFilter} onChange={(e)=>setRoleFilter(e.target.value)}><option value="">All roles</option><option value="super_admin">Super Admin</option><option value="admin">Admin</option><option value="support">Support</option><option value="auditor">Auditor</option></select><select value={statusFilter} onChange={(e)=>setStatusFilter(e.target.value)}><option value="">All status</option><option value="active">Active</option><option value="deactivated">Deactivated</option></select></div>{loading?<p>Loading users from backend...</p>:filteredUsers.length===0?<p>No users in backend database.</p>:(<table className="admin-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead><tbody>{filteredUsers.map((u)=>(<tr key={u.id}><td>{u.name}</td><td>{u.email}</td><td><select value={u.role} onChange={(e)=>changeRole(u.id,e.target.value)}><option value="super_admin">Super Admin</option><option value="admin">Admin</option><option value="support">Support</option><option value="auditor">Auditor</option></select></td><td>{u.status}</td><td>{u.created_at?new Date(u.created_at).toLocaleDateString():"-"}</td><td><button onClick={()=>{setEditUser(u); setEditName(u.name); setEditEmail(u.email); setEditUsername("");}}>Edit</button>{u.status==="active"?<button onClick={()=>changeStatus(u,"deactivated")}>Deactivate</button>:<><button onClick={()=>restoreUser(u)}>Restore</button><button onClick={()=>changeStatus(u,"active")}>Reactivate</button></>}<button onClick={()=>requestReset(u.email)}>Reset Password</button><button onClick={()=>setHardDeleteUser(u)} style={{borderColor:"#FECDCA", color:"#B42318"}}>Hard Delete</button></td></tr>))}</tbody></table>)}<p className="admin-note">Edit = change name / email / username. Deactivate = block login, preserve history. Restore = bring back a deactivated user. Hard Delete = permanent, cannot be undone, writes audit first.</p></div>)}
      {tab==="transactions" && (<div className="admin-card"><h3 style={{marginTop:0}}>Transactions - Verify</h3>{txns.length===0?<p>No transactions in backend yet, or no transaction table found. Once transactions exist, they will show here for Admin verification.</p>:(<table className="admin-table"><thead><tr><th>Reference</th><th>Amount</th><th>Status</th><th>Verified</th><th>Date</th><th>Action</th></tr></thead><tbody>{txns.map((t)=>(<tr key={t.id}><td>{t.reference}</td><td>{t.currency} {Number(t.amount).toLocaleString()}</td><td>{t.status}</td><td>{t.verified?"✓ Verified":"— Not verified"}</td><td>{t.created_at?new Date(t.created_at).toLocaleDateString():"-"}</td><td>{!t.verified && <button onClick={()=>verifyTxn(t.id)}>Verify Transaction</button>}</td></tr>))}</tbody></table>)}<p className="admin-note">Verify = Admin confirms this transaction is legitimate. It writes an audit row. Verified cannot be unverified from Admin.</p></div>)}
      {tab==="audit" && (<div className="admin-card"><div style={{display:"flex", gap:10, flexWrap:"wrap", marginBottom:12}}><input placeholder="Filter by action / actor / target" value={auditFilter} onChange={(e)=>setAuditFilter(e.target.value)} style={{flex:1, minWidth:220}} /><button onClick={exportAudit} style={{background:"#101828", color:"#fff", border:"none", padding:"10px 14px", borderRadius:10}}>⬇ Export Audit to CSV</button></div>{filteredAudit.length===0?<p>No audit events yet — events are written by backend only.</p>:(<table className="admin-table"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Outcome</th></tr></thead><tbody>{filteredAudit.map((e)=>(<tr key={e.id}><td>{new Date(e.created_at).toLocaleString()}</td><td>{e.actor}</td><td>{e.action}</td><td>{e.target}</td><td>{e.outcome}</td></tr>))}</tbody></table>)}</div>)}
      {tab==="diagnostics" && (<div className="admin-card">{!diag?<p>Click Refresh to load diagnostics.</p>:(<><p><b>Database:</b> {diag.database}</p><p><b>Users total:</b> {diag.users_total}</p><p><b>Audit events total:</b> {diag.audit_events_total}</p><p><b>Checked at:</b> {diag.checked_at}</p><p><b>Version:</b> {diag.version}</p></>)}<p className="admin-note">No SQL console. Diagnostics are read-only and admin-only.</p></div>)}
      {tab==="security" && (<div className="admin-card"><p><b>Admin token:</b> Configured (value not shown)</p><p><b>Password reset:</b> Token-based, 30 min, single-use - link shown to Admin to copy</p><p><b>Audit:</b> Backend-written only</p><p><b>Hard delete:</b> Enabled with double-confirm + audit-first. Hard-deleted users cannot be restored.</p><p><b>Restore:</b> Only for deactivated users, not hard-deleted.</p><p><b>Last super admin protection:</b> Enabled</p></div>)}
      {confirmUser && (<div className="admin-modal-backdrop"><div className="admin-modal"><h3>Deactivate {confirmUser.user.name} ({confirmUser.user.email})?</h3><p>This will block login but preserve audit + financial history. You can Restore later.</p><button onClick={()=>setConfirmUser(null)}>Cancel</button><button onClick={()=>changeStatusDirect(confirmUser.user,"deactivated")}>Confirm Deactivate</button></div></div>)}
      {hardDeleteUser && (<div className="admin-modal-backdrop"><div className="admin-modal"><h3 style={{color:"#B42318"}}>⚠ HARD DELETE {hardDeleteUser.name}?</h3><p><b>{hardDeleteUser.email}</b><br/>This is <b>permanent</b>. It deletes the user row. Audit history is kept, but the user cannot be restored. Use Deactivate if you might need them back.</p><button onClick={()=>setHardDeleteUser(null)}>Cancel - Keep User</button><button onClick={doHardDelete} style={{background:"#B42318"}}>Yes, Hard Delete Permanently</button></div></div>)}
      {editUser && (<div className="admin-modal-backdrop"><div className="admin-modal"><h3>Edit User</h3><p>Change name, email, username for {editUser.email}</p><label className="field">Name<input value={editName} onChange={(e)=>setEditName(e.target.value)} style={{width:"100%", padding:10, marginTop:6, borderRadius:8, border:"1px solid #D0D5DD"}} /></label><label className="field">Email<input value={editEmail} onChange={(e)=>setEditEmail(e.target.value)} style={{width:"100%", padding:10, marginTop:6, borderRadius:8, border:"1px solid #D0D5DD"}} /></label><label className="field">Username<input value={editUsername} onChange={(e)=>setEditUsername(e.target.value)} placeholder="e.g. ahmad_ds" style={{width:"100%", padding:10, marginTop:6, borderRadius:8, border:"1px solid #D0D5DD"}} /></label><div><button onClick={()=>setEditUser(null)}>Cancel</button><button onClick={saveEdit} style={{background:"#5B0DBA", color:"#fff", border:"none"}}>Save Changes</button></div></div></div>)}
    </div>
  );
}
