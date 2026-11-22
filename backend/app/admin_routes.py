"""LedgerWatch Admin Console - FIXED.
- ONE require_admin (old called undefined require_admin_token -> crash)
- ONE POST /users/request-password-reset (old had 2)
- Create user uses password_hash (old used hashed_password -> user with no password)
- Transactions use real tables Order/Settlement/BankTransaction
- Hard-delete writes audit BEFORE delete, restore works via status/deleted flag
- No secrets in code, ADMIN_TOKEN from env only.
"""
import csv, hashlib, io, os, secrets
from datetime import datetime, timezone, timedelta
from typing import Optional, List
from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session
from sqlalchemy import text
from passlib.context import CryptContext
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
from app.api.deps import get_db
from app.models.tables import User, AuditEvent, PasswordReset, Order, Settlement, BankTransaction

router = APIRouter(prefix="/api/admin", tags=["admin"])
ADMIN_EMAIL = os.getenv("ADMIN_EMAIL", "dsahmadmagaji@gmail.com")
ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "")
SUPER_ADMIN_EMAIL = os.getenv("SUPER_ADMIN_EMAIL", ADMIN_EMAIL).lower()
FRONTEND_URL = os.getenv("FRONTEND_URL", "https://ledgerwatch-theta.vercel.app").rstrip("/")

def require_admin(x_admin_token: Optional[str] = Header(default=None)):
    if not ADMIN_TOKEN:
        raise HTTPException(status_code=500, detail="ADMIN_TOKEN not configured on server")
    if not x_admin_token or not secrets.compare_digest(x_admin_token, ADMIN_TOKEN):
        raise HTTPException(status_code=401, detail="Unauthorized")
    return True

def _utcnow(): return datetime.now(timezone.utc)
def write_audit(db: Session, actor: str, action: str, target: str = "", outcome: str = "success", meta: str = ""):
    evt = AuditEvent(actor=actor, action=action, target=target, outcome=outcome, meta=(meta[:2000] if meta else ""), created_at=_utcnow())
    db.add(evt); db.commit(); return evt

class UserOut(BaseModel):
    id: int; name: str; username: Optional[str] = None; email: str; role: str; status: str
    created_at: Optional[datetime] = None; last_activity_at: Optional[datetime] = None
    class Config: from_attributes = True
class RoleUpdate(BaseModel): role: str
class StatusUpdate(BaseModel): status: str; reason: Optional[str] = ""
class CreateUserIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: EmailStr
    role: str = "support"
    username: Optional[str] = Field(default=None, max_length=64)
class UpdateUserIn(BaseModel):
    name: Optional[str] = Field(default=None, max_length=120)
    email: Optional[EmailStr] = None
    username: Optional[str] = Field(default=None, max_length=64)
class ResetRequest(BaseModel): email: EmailStr
class AuditOut(BaseModel):
    id: int; created_at: datetime; actor: str; action: str; target: str; outcome: str; meta: str
    class Config: from_attributes = True

@router.get("/health")
def admin_health(_: bool = Depends(require_admin), db: Session = Depends(get_db)):
    try: db.execute(text("SELECT 1")); db_ok=True
    except Exception: db_ok=False
    return {"app":"Ledgerwatch","env":os.getenv("ENV","production"),"backend":"ok","database":"connected" if db_ok else "unavailable","time":_utcnow().isoformat(),"version":os.getenv("RENDER_GIT_COMMIT","local")[:12],"admin_enforced":True}

@router.get("/diagnostics")
def diagnostics(_: bool = Depends(require_admin), db: Session = Depends(get_db)):
    try: user_count=db.query(User).filter(User.deleted==False).count(); audit_count=db.query(AuditEvent).count(); db_ok=True
    except Exception: user_count=0; audit_count=0; db_ok=False
    return {"database":"connected" if db_ok else "unavailable","users_total":user_count,"audit_events_total":audit_count,"checked_at":_utcnow().isoformat(),"version":os.getenv("RENDER_GIT_COMMIT","local")[:12]}

@router.get("/users", response_model=List[UserOut])
def admin_users(_: bool = Depends(require_admin), db: Session = Depends(get_db), q: Optional[str]=Query(default=None), role: Optional[str]=Query(default=None), status: Optional[str]=Query(default=None), include_deleted: bool=False, limit: int=Query(default=50, le=100), offset: int=Query(default=0, ge=0)):
    query=db.query(User)
    if not include_deleted: query=query.filter(User.deleted==False)
    if q:
        like=f"%{q.lower()}%"; query=query.filter((User.email.ilike(like)) | (User.name.ilike(like)) | (User.username.ilike(like)))
    if role: query=query.filter(User.role==role)
    if status: query=query.filter(User.status==status)
    return query.order_by(User.created_at.desc()).offset(offset).limit(limit).all()

@router.get("/users/{user_id}", response_model=UserOut)
def get_user(user_id: int, _: bool = Depends(require_admin), db: Session = Depends(get_db)):
    user=db.query(User).filter(User.id==user_id).first()
    if not user: raise HTTPException(status_code=404, detail="User not found")
    return user

@router.post("/users/create", response_model=UserOut)
def admin_create_user(payload: CreateUserIn, _: bool = Depends(require_admin), db: Session = Depends(get_db)):
    email=payload.email.lower().strip()
    if db.query(User).filter(User.email==email).first():
        raise HTTPException(status_code=400, detail="User with this email already exists")
    if payload.role not in {"super_admin","admin","support","auditor"}:
        raise HTTPException(status_code=400, detail="Invalid role")
    if payload.username and db.query(User).filter(User.username==payload.username.strip()).first():
        raise HTTPException(status_code=400, detail="Username already in use")
    temp_password=secrets.token_urlsafe(10)
    user=User(name=payload.name.strip(), username=payload.username.strip() if payload.username else None, email=email, password_hash=pwd_context.hash(temp_password), role=payload.role, status="active", created_at=_utcnow())
    db.add(user); db.commit(); db.refresh(user)
    write_audit(db, SUPER_ADMIN_EMAIL, "admin_create_user", target=user.email, meta=f"role={user.role} username={user.username or ''}")
    return user

@router.patch("/users/{user_id}", response_model=UserOut)
def admin_update_user(user_id: int, payload: UpdateUserIn, _: bool = Depends(require_admin), db: Session = Depends(get_db)):
    user=db.query(User).filter(User.id==user_id).first()
    if not user: raise HTTPException(status_code=404, detail="User not found")
    old=f"{user.name} | {user.email} | @{user.username or ''}"
    if payload.name: user.name=payload.name.strip()
    if payload.email:
        dup=db.query(User).filter(User.email==payload.email.lower().strip(), User.id!=user_id).first()
        if dup: raise HTTPException(status_code=400, detail="Email already in use by another user")
        user.email=payload.email.lower().strip()
    if payload.username is not None:
        if payload.username.strip()=="": user.username=None
        else:
            dup=db.query(User).filter(User.username==payload.username.strip(), User.id!=user_id).first()
            if dup: raise HTTPException(status_code=400, detail="Username already in use")
            user.username=payload.username.strip()
    db.commit(); db.refresh(user)
    write_audit(db, SUPER_ADMIN_EMAIL, "admin_update_user", target=user.email, meta=f"from: {old} -> {user.name} | {user.email} | @{user.username or ''}")
    return user

@router.patch("/users/{user_id}/role", response_model=UserOut)
def update_role(user_id: int, body: RoleUpdate, _: bool = Depends(require_admin), db: Session = Depends(get_db)):
    if body.role not in {"super_admin","admin","support","auditor"}: raise HTTPException(status_code=400, detail="Invalid role")
    user=db.query(User).filter(User.id==user_id).first()
    if not user: raise HTTPException(status_code=404, detail="User not found")
    if user.role=="super_admin" and body.role!="super_admin":
        if db.query(User).filter(User.role=="super_admin", User.status=="active", User.deleted==False).count()<=1:
            raise HTTPException(status_code=400, detail="Cannot demote last super admin")
    old=user.role; user.role=body.role; db.commit(); db.refresh(user)
    write_audit(db, SUPER_ADMIN_EMAIL, "role_change", target=user.email, meta=f"{old} -> {body.role}")
    return user

@router.patch("/users/{user_id}/status", response_model=UserOut)
def update_status(user_id: int, body: StatusUpdate, _: bool = Depends(require_admin), db: Session = Depends(get_db)):
    if body.status not in {"active","deactivated"}: raise HTTPException(status_code=400, detail="Invalid status")
    user=db.query(User).filter(User.id==user_id).first()
    if not user: raise HTTPException(status_code=404, detail="User not found")
    if user.email.lower()==SUPER_ADMIN_EMAIL and body.status=="deactivated": raise HTTPException(status_code=400, detail="Cannot deactivate super admin")
    if body.status=="deactivated" and user.role=="super_admin":
        if db.query(User).filter(User.role=="super_admin", User.status=="active", User.deleted==False).count()<=1:
            raise HTTPException(status_code=400, detail="Cannot deactivate last super admin")
    user.status=body.status; db.commit(); db.refresh(user)
    write_audit(db, SUPER_ADMIN_EMAIL, "status_change", target=user.email, meta=f"status -> {body.status} reason={body.reason or ''}")
    return user

@router.post("/users/request-password-reset")
def request_password_reset(body: ResetRequest, _: bool = Depends(require_admin), db: Session = Depends(get_db)):
    user=db.query(User).filter(User.email==body.email.lower()).first()
    if not user:
        return {"ok": True, "message": "If the account exists, a reset has been initiated."}
    raw=secrets.token_urlsafe(32)
    token_hash=hashlib.sha256(raw.encode()).hexdigest()
    rec=PasswordReset(user_id=user.id, token_hash=token_hash, expires_at=_utcnow()+timedelta(minutes=30), used=False, created_at=_utcnow())
    db.add(rec)
    user.reset_token=token_hash; user.reset_expires=_utcnow()+timedelta(minutes=30)
    db.commit()
    write_audit(db, SUPER_ADMIN_EMAIL, "password_reset_requested", target=user.email, meta="token issued, 30min expiry")
    reset_link=f"{FRONTEND_URL}/reset?token={raw}&email={user.email}"
    return {"ok": True, "email": user.email, "reset_link": reset_link, "expires": "30 minutes, single-use", "message": "Copy the reset link below and send it to the user securely. Do not paste it in public chat."}

@router.get("/audit", response_model=List[AuditOut])
def admin_audit(_: bool = Depends(require_admin), db: Session = Depends(get_db), action: Optional[str]=Query(default=None), actor: Optional[str]=Query(default=None), limit: int=Query(default=50, le=100), offset: int=Query(default=0, ge=0)):
    query=db.query(AuditEvent)
    if action: query=query.filter(AuditEvent.action.ilike(f"%{action}%"))
    if actor: query=query.filter(AuditEvent.actor.ilike(f"%{actor}%"))
    return query.order_by(AuditEvent.created_at.desc()).offset(offset).limit(limit).all()

@router.get("/audit/export")
def admin_audit_export(_: bool = Depends(require_admin), db: Session = Depends(get_db)):
    events=db.query(AuditEvent).order_by(AuditEvent.created_at.desc()).limit(1000).all()
    output=io.StringIO(); w=csv.writer(output); w.writerow(["time","actor","action","target","outcome","meta"])
    for e in events:
        def esc(v):
            s=str(v or "")
            return ("'"+s) if s and s[0] in ("=","+","-","@","\t","\r") else s
        w.writerow([esc(e.created_at), esc(e.actor), esc(e.action), esc(e.target), esc(e.outcome), esc(e.meta)])
    output.seek(0)
    return StreamingResponse(iter([output.getvalue()]), media_type="text/csv", headers={"Content-Disposition":"attachment; filename=ledgerwatch-audit.csv"})

@router.get("/transactions")
def admin_list_transactions(_: bool = Depends(require_admin), db: Session = Depends(get_db), kind: str=Query(default="orders"), limit: int=Query(default=50, le=200)):
    if kind=="settlements":
        rows=db.query(Settlement).order_by(Settlement.id.desc()).limit(limit).all()
        return [{"id":r.id,"reference":r.processor_ref,"order_ref":r.order_ref,"amount_kobo":r.gross_kobo,"fee_kobo":r.fee_kobo,"net_kobo":r.net_kobo,"date":str(r.settled_date),"kind":"settlement"} for r in rows]
    if kind=="bank":
        rows=db.query(BankTransaction).order_by(BankTransaction.id.desc()).limit(limit).all()
        return [{"id":r.id,"reference":r.bank_ref,"amount_kobo":r.amount_kobo,"narration":r.narration,"date":str(r.value_date),"kind":"bank"} for r in rows]
    rows=db.query(Order).order_by(Order.id.desc()).limit(limit).all()
    return [{"id":r.id,"reference":r.order_ref,"customer":r.customer_name,"amount_kobo":r.amount_kobo,"date":str(r.ordered_at),"kind":"order"} for r in rows]

@router.delete("/users/{user_id}/hard-delete")
def admin_hard_delete_user(user_id: int, _: bool = Depends(require_admin), db: Session = Depends(get_db)):
    user=db.query(User).filter(User.id==user_id).first()
    if not user: raise HTTPException(status_code=404, detail="User not found")
    if user.role=="super_admin":
        if db.query(User).filter(User.role=="super_admin", User.status=="active", User.deleted==False).count()<=1:
            raise HTTPException(status_code=400, detail="Cannot hard-delete the last active super admin")
    email=user.email; name=user.name
    write_audit(db, SUPER_ADMIN_EMAIL, "admin_hard_delete_user", target=email, meta=f"HARD DELETE: {name} | {email} | role={user.role} - permanent")
    db.delete(user); db.commit()
    return {"ok": True, "deleted": email, "warning": "Permanent. This cannot be undone."}

@router.post("/users/{user_id}/restore")
def admin_restore_user(user_id: int, _: bool = Depends(require_admin), db: Session = Depends(get_db)):
    user=db.query(User).filter(User.id==user_id).first()
    if not user: raise HTTPException(status_code=404, detail="User not found - hard-deleted users cannot be restored")
    user.status="active"; user.deleted=False; db.commit()
    write_audit(db, SUPER_ADMIN_EMAIL, "admin_restore_user", target=user.email, meta="restored user to active")
    return {"ok": True, "id": user.id, "status": "active"}

@router.post("/bootstrap-once")
def bootstrap_once(_: bool = Depends(require_admin), db: Session = Depends(get_db)):
    count=db.query(User).count()
    if count>0: return {"status":"refused","message":f"Users table already has {count} user(s). Bootstrap only runs when empty."}
    email=os.getenv("BOOTSTRAP_ADMIN_EMAIL","").strip().lower(); name=os.getenv("BOOTSTRAP_ADMIN_NAME","Ahmad Magaji").strip(); password=os.getenv("BOOTSTRAP_ADMIN_PASSWORD","")
    if not email or not password: raise HTTPException(status_code=500, detail="BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD not set in Render ENV")
    if len(password)<12: raise HTTPException(status_code=400, detail="Bootstrap password must be at least 12 characters")
    user=User(name=name, email=email, password_hash=pwd_context.hash(password), role="super_admin", status="active", created_at=_utcnow())
    db.add(user); db.commit()
    write_audit(db, SUPER_ADMIN_EMAIL, "bootstrap_super_admin", target=email, meta="first super admin created via bootstrap-once")
    return {"status":"created","email":email,"role":"super_admin"}
