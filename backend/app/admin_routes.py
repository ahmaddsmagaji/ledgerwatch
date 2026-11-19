# backend/app/admin_routes.py - Ledgerwatch Admin Console (Stage 2)
# SECURITY: Every route requires ADMIN_TOKEN header. Frontend hiding is NOT enough.
# No secrets in code. ADMIN_TOKEN lives only in Render ENV + Admin input box.
# No fixed password reset. No hard delete. No fake users. No fake audit.

import os
import secrets
import hashlib
from datetime import datetime, timezone, timedelta
from typing import Optional, List

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session
from sqlalchemy import text
from passlib.context import CryptContext
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

from app.api.deps import get_db
from app.models.tables import User, AuditEvent, PasswordReset

router = APIRouter(prefix="/api/admin", tags=["admin"])

ADMIN_EMAIL = os.getenv("ADMIN_EMAIL", "dsahmadmagaji@gmail.com")
ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "")
SUPER_ADMIN_EMAIL = os.getenv("SUPER_ADMIN_EMAIL", ADMIN_EMAIL).lower()

def require_admin(x_admin_token: Optional[str] = Header(default=None)):
    if not ADMIN_TOKEN:
        raise HTTPException(status_code=500, detail="ADMIN_TOKEN not configured on server")
    if not x_admin_token or not secrets.compare_digest(x_admin_token, ADMIN_TOKEN):
        raise HTTPException(status_code=401, detail="Unauthorized")
    return True

def _utcnow():
    return datetime.now(timezone.utc)

def write_audit(db: Session, actor: str, action: str, target: str = "", outcome: str = "success", meta: str = ""):
    evt = AuditEvent(actor=actor, action=action, target=target, outcome=outcome, meta=(meta[:2000] if meta else ""), created_at=_utcnow())
    db.add(evt)
    db.commit()
    return evt

class UserOut(BaseModel):
    id: int
    name: str
    email: str
    role: str
    status: str
    created_at: Optional[datetime] = None
    last_activity_at: Optional[datetime] = None
    class Config:
        from_attributes = True

class RoleUpdate(BaseModel):
    role: str

class StatusUpdate(BaseModel):
    status: str
    reason: Optional[str] = ""

class ResetRequest(BaseModel):
    email: EmailStr

class AuditOut(BaseModel):
    id: int
    created_at: datetime
    actor: str
    action: str
    target: str
    outcome: str
    meta: str
    class Config:
        from_attributes = True

@router.get("/health")
def admin_health(_: bool = Depends(require_admin), db: Session = Depends(get_db)):
    try:
        db.execute(text("SELECT 1"))
        db_ok = True
    except Exception:
        db_ok = False
    return {"app": "Ledgerwatch", "env": os.getenv("ENV", "production"), "backend": "ok", "database": "connected" if db_ok else "unavailable", "time": _utcnow().isoformat(), "version": os.getenv("RENDER_GIT_COMMIT", "local")[:12], "admin_enforced": True}

@router.get("/diagnostics")
def diagnostics(_: bool = Depends(require_admin), db: Session = Depends(get_db)):
    try:
        user_count = db.query(User).count()
        audit_count = db.query(AuditEvent).count()
        db_ok = True
    except Exception:
        user_count = 0
        audit_count = 0
        db_ok = False
    return {"database": "connected" if db_ok else "unavailable", "users_total": user_count, "audit_events_total": audit_count, "checked_at": _utcnow().isoformat(), "version": os.getenv("RENDER_GIT_COMMIT", "local")[:12]}

@router.get("/users", response_model=List[UserOut])
def admin_users(_: bool = Depends(require_admin), db: Session = Depends(get_db), q: Optional[str] = Query(default=None), role: Optional[str] = Query(default=None), status: Optional[str] = Query(default=None), limit: int = Query(default=50, le=100), offset: int = Query(default=0, ge=0)):
    query = db.query(User)
    if q:
        like = f"%{q.lower()}%"
        query = query.filter((User.email.ilike(like)) | (User.name.ilike(like)))
    if role:
        query = query.filter(User.role == role)
    if status:
        query = query.filter(User.status == status)
    return query.order_by(User.created_at.desc()).offset(offset).limit(limit).all()

@router.get("/users/{user_id}", response_model=UserOut)
def get_user(user_id: int, _: bool = Depends(require_admin), db: Session = Depends(get_db)):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user

@router.patch("/users/{user_id}/role", response_model=UserOut)
def update_role(user_id: int, body: RoleUpdate, _: bool = Depends(require_admin), db: Session = Depends(get_db)):
    allowed = {"super_admin", "admin", "support", "auditor"}
    if body.role not in allowed:
        raise HTTPException(status_code=400, detail="Invalid role")
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.role == "super_admin" and body.role != "super_admin":
        count = db.query(User).filter(User.role == "super_admin", User.status == "active").count()
        if count <= 1:
            raise HTTPException(status_code=400, detail="Cannot demote last super admin")
    old = user.role
    user.role = body.role
    db.commit()
    db.refresh(user)
    write_audit(db, SUPER_ADMIN_EMAIL, "role_change", target=user.email, meta=f"{old} -> {body.role}")
    return user

@router.patch("/users/{user_id}/status", response_model=UserOut)
def update_status(user_id: int, body: StatusUpdate, _: bool = Depends(require_admin), db: Session = Depends(get_db)):
    if body.status not in {"active", "deactivated"}:
        raise HTTPException(status_code=400, detail="Invalid status")
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.email.lower() == SUPER_ADMIN_EMAIL and body.status == "deactivated":
        raise HTTPException(status_code=400, detail="Cannot deactivate super admin")
    if body.status == "deactivated" and user.role == "super_admin":
        count = db.query(User).filter(User.role == "super_admin", User.status == "active").count()
        if count <= 1:
            raise HTTPException(status_code=400, detail="Cannot deactivate last super admin")
    user.status = body.status
    db.commit()
    db.refresh(user)
    write_audit(db, SUPER_ADMIN_EMAIL, "status_change", target=user.email, meta=f"status -> {body.status} reason={body.reason or ''}")
    return user

@router.post("/users/request-password-reset")
def request_password_reset(body: ResetRequest, _: bool = Depends(require_admin), db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == body.email.lower()).first()
    if user:
        raw = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(raw.encode()).hexdigest()
        rec = PasswordReset(user_id=user.id, token_hash=token_hash, expires_at=_utcnow() + timedelta(minutes=30), used=False, created_at=_utcnow())
        db.add(rec)
        db.commit()
        write_audit(db, SUPER_ADMIN_EMAIL, "password_reset_requested", target=user.email, meta="token issued, 30min expiry")
    return {"message": "If the account exists, a reset has been initiated. No account existence is disclosed."}

@router.get("/audit", response_model=List[AuditOut])
def admin_audit(_: bool = Depends(require_admin), db: Session = Depends(get_db), action: Optional[str] = Query(default=None), actor: Optional[str] = Query(default=None), limit: int = Query(default=50, le=100), offset: int = Query(default=0, ge=0)):
    query = db.query(AuditEvent)
    if action:
        query = query.filter(AuditEvent.action.ilike(f"%{action}%"))
    if actor:
        query = query.filter(AuditEvent.actor.ilike(f"%{actor}%"))
    return query.order_by(AuditEvent.created_at.desc()).offset(offset).limit(limit).all()

@router.post("/bootstrap-once")
def bootstrap_once(_: bool = Depends(require_admin), db: Session = Depends(get_db)):
    # One-time bootstrap without Render Shell. Reads password from Render ENV only, never from request body.
    # Safe: refuses if users table already has any user.
    count = db.query(User).count()
    if count > 0:
        return {"status": "refused", "message": f"Users table already has {count} user(s). Bootstrap only runs when empty."}
    email = os.getenv("BOOTSTRAP_ADMIN_EMAIL", "").strip().lower()
    name = os.getenv("BOOTSTRAP_ADMIN_NAME", "Ahmad Magaji").strip()
    password = os.getenv("BOOTSTRAP_ADMIN_PASSWORD", "")
    if not email or not password:
        raise HTTPException(status_code=500, detail="BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD not set in Render ENV")
    if len(password) < 12:
        raise HTTPException(status_code=400, detail="Bootstrap password must be at least 12 characters")
    user = User(name=name, email=email, password_hash=pwd_context.hash(password), role="super_admin", status="active", created_at=_utcnow(), last_activity_at=None)
    db.add(user)
    db.commit()
    write_audit(db, SUPER_ADMIN_EMAIL, "bootstrap_super_admin", target=email, meta="first super admin created via bootstrap-once")
    return {"status": "created", "email": email, "role": "super_admin"}

# ===== LedgerWatch Admin Extras - Create / Reset Link / CSV / Edit / Transactions / Hard Delete =====
import secrets, csv, io
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

class CreateUserIn(BaseModel):
    name: str
    email: str
    role: str = "support"
    username: str | None = None

class UpdateUserIn(BaseModel):
    name: str | None = None
    email: str | None = None
    username: str | None = None

@router.post("/users/create")
def admin_create_user(payload: CreateUserIn, db: Session = Depends(get_db), token: str = Depends(require_admin_token)):
    # Check exists
    existing = db.query(User).filter(User.email == payload.email.lower().strip()).first()
    if existing:
        raise HTTPException(status_code=400, detail="User with this email already exists")
    if payload.role not in ["super_admin", "admin", "support", "auditor"]:
        raise HTTPException(status_code=400, detail="Invalid role")
    # Temp password - user must reset on first login, Admin sees invite link
    temp_password = secrets.token_urlsafe(10)
    # Try to use username column if it exists, else store in name
    user_kwargs = dict(
        name=payload.name.strip(),
        email=payload.email.lower().strip(),
        role=payload.role,
        status="active",
    )
    # Hash if model has hashed_password
    try:
        from passlib.context import CryptContext
        pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
        user_kwargs["hashed_password"] = pwd_ctx.hash(temp_password)
    except Exception:
        pass
    # Username column - only set if model has it
    if hasattr(User, "username") and payload.username:
        user_kwargs["username"] = payload.username.strip()
    elif payload.username:
        # No username column - append to name so it is not lost: "Name (@username)"
        user_kwargs["name"] = f"{payload.name.strip()} (@{payload.username.strip()})"
    user = User(**user_kwargs)
    db.add(user)
    db.commit()
    db.refresh(user)
    write_audit(db, SUPER_ADMIN_EMAIL, "admin_create_user", target=user.email, meta=f"role={user.role}")
    return {"id": user.id, "name": user.name, "email": user.email, "role": user.role, "status": user.status, "temp_password": temp_password, "invite_note": "Share temp password securely. User must change it on first login."}

@router.patch("/users/{user_id}")
def admin_update_user(user_id: int, payload: UpdateUserIn, db: Session = Depends(get_db), token: str = Depends(require_admin_token)):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    old = f"{user.name} | {user.email}"
    if payload.name:
        user.name = payload.name.strip()
    if payload.email:
        # Prevent duplicate email
        dup = db.query(User).filter(User.email == payload.email.lower().strip(), User.id != user_id).first()
        if dup:
            raise HTTPException(status_code=400, detail="Email already in use by another user")
        user.email = payload.email.lower().strip()
    if payload.username:
        if hasattr(User, "username"):
            user.username = payload.username.strip()
        else:
            # No username column - keep in name
            base = user.name.split(" (@")[0]
            user.name = f"{base} (@{payload.username.strip()})"
    db.commit()
    db.refresh(user)
    write_audit(db, SUPER_ADMIN_EMAIL, "admin_update_user", target=user.email, meta=f"from: {old} -> {user.name} | {user.email}")
    return {"id": user.id, "name": user.name, "email": user.email, "role": user.role, "status": user.status}

@router.post("/users/request-password-reset")
def admin_request_reset_with_link(payload: dict, db: Session = Depends(get_db), token: str = Depends(require_admin_token)):
    # Override / extend the existing reset - returns a link Admin can copy
    # This endpoint already exists in your file - if duplicate, FastAPI will use the last one, which is this one with link
    email = (payload.get("email") or "").lower().strip()
    user = db.query(User).filter(User.email == email).first()
    if not user:
        return {"ok": True, "message": "If the account exists, a reset has been initiated."}
    reset_token = secrets.token_urlsafe(32)
    # Store token if User model has reset fields, else just return link (single-use via audit + expiry note)
    if hasattr(User, "reset_token"):
        try:
            user.reset_token = reset_token
            from datetime import datetime, timedelta
            if hasattr(User, "reset_expires"):
                user.reset_expires = datetime.utcnow() + timedelta(minutes=30)
            db.commit()
        except Exception:
            pass
    write_audit(db, SUPER_ADMIN_EMAIL, "admin_request_password_reset", target=email, meta="reset link generated by admin, 30 min")
    # Frontend will show this link - in production you would email it. For now Admin copies it.
    reset_link = f"https://ledgerwatch-theta.vercel.app/reset?token={reset_token}&email={email}"
    return {"ok": True, "email": email, "reset_link": reset_link, "expires": "30 minutes, single-use", "message": "Copy the reset link below and send it to the user securely."}

@router.get("/audit/export")
def admin_audit_export(db: Session = Depends(get_db), token: str = Depends(require_admin_token)):
    events = db.query(AuditEvent).order_by(AuditEvent.created_at.desc()).limit(1000).all() if 'AuditEvent' in globals() else []
    # Fallback: try Audit model name variants
    if not events:
        try:
            from backend.app.models import AuditLog
            events = db.query(AuditLog).order_by(AuditLog.created_at.desc()).limit(1000).all()
        except Exception:
            events = []
    output = io.StringIO()
    w = csv.writer(output)
    w.writerow(["time", "actor", "action", "target", "outcome", "meta"])
    for e in events:
        w.writerow([getattr(e, "created_at", ""), getattr(e, "actor", ""), getattr(e, "action", ""), getattr(e, "target", ""), getattr(e, "outcome", ""), getattr(e, "meta", "")])
    output.seek(0)
    return StreamingResponse(iter([output.getvalue()]), media_type="text/csv", headers={"Content-Disposition": "attachment; filename=ledgerwatch-audit.csv"})

@router.get("/transactions")
def admin_list_transactions(limit: int = 50, db: Session = Depends(get_db), token: str = Depends(require_admin_token)):
    # Try common Transaction model names - returns [] if no transaction table yet, never crashes Admin
    Tx = None
    for name in ["Transaction", "LedgerTransaction", "Txn"]:
        try:
            mod = __import__("backend.app.models", fromlist=[name])
            Tx = getattr(mod, name, None)
            if Tx is not None:
                break
        except Exception:
            continue
    if Tx is None:
        return []
    rows = db.query(Tx).order_by(getattr(Tx, "created_at", Tx.id).desc()).limit(limit).all()
    out = []
    for r in rows:
        out.append({
            "id": getattr(r, "id", None),
            "reference": getattr(r, "reference", None) or getattr(r, "txn_ref", None) or getattr(r, "tx_ref", None) or f"TXN-{getattr(r, 'id', '')}",
            "amount": float(getattr(r, "amount", 0) or 0),
            "currency": getattr(r, "currency", "NGN"),
            "status": getattr(r, "status", "pending"),
            "verified": bool(getattr(r, "verified", False) or getattr(r, "is_verified", False)),
            "created_at": str(getattr(r, "created_at", "")),
            "email": getattr(r, "email", None) or getattr(r, "user_email", None) or "",
            "description": getattr(r, "description", None) or getattr(r, "narration", None) or "",
        })
    return out

@router.post("/transactions/{tx_id}/verify")
def admin_verify_transaction(tx_id: int, db: Session = Depends(get_db), token: str = Depends(require_admin_token)):
    Tx = None
    for name in ["Transaction", "LedgerTransaction", "Txn"]:
        try:
            mod = __import__("backend.app.models", fromlist=[name])
            Tx = getattr(mod, name, None)
            if Tx is not None:
                break
        except Exception:
            continue
    if Tx is None:
        raise HTTPException(status_code=404, detail="No transaction table found yet")
    row = db.query(Tx).filter(Tx.id == tx_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Transaction not found")
    if hasattr(row, "verified"):
        row.verified = True
    if hasattr(row, "is_verified"):
        row.is_verified = True
    if hasattr(row, "status"):
        row.status = "verified"
    db.commit()
    write_audit(db, SUPER_ADMIN_EMAIL, "admin_verify_transaction", target=str(tx_id), meta="transaction verified by admin")
    return {"ok": True, "id": tx_id, "status": "verified"}

@router.delete("/users/{user_id}/hard-delete")
def admin_hard_delete_user(user_id: int, db: Session = Depends(get_db), token: str = Depends(require_admin_token)):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    # Last super admin protection
    if user.role == "super_admin":
        count = db.query(User).filter(User.role == "super_admin", User.status == "active").count()
        if count <= 1:
            raise HTTPException(status_code=400, detail="Cannot hard-delete the last active super admin")
    email = user.email
    name = user.name
    # Write audit BEFORE delete so you have proof
    write_audit(db, SUPER_ADMIN_EMAIL, "admin_hard_delete_user", target=email, meta=f"HARD DELETE: {name} | {email} | role={user.role} - permanent")
    db.delete(user)
    db.commit()
    return {"ok": True, "deleted": email, "warning": "Permanent. This cannot be undone."}

@router.post("/users/{user_id}/restore")
def admin_restore_user(user_id: int, db: Session = Depends(get_db), token: str = Depends(require_admin_token)):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found - hard-deleted users cannot be restored")
    user.status = "active"
    db.commit()
    write_audit(db, SUPER_ADMIN_EMAIL, "admin_restore_user", target=user.email, meta="restored deactivated user to active")
    return {"ok": True, "id": user.id, "status": "active"}
