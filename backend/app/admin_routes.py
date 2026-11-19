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
