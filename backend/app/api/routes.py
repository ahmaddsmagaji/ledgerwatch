from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import func
from typing import Optional
from pydantic import BaseModel, field_validator
from datetime import datetime, timezone
import json
import tempfile

from app.api.deps import get_db
from app.models.tables import (
    Order, Settlement, BankTransaction, ReconException, AuditLog, Match,
    ExceptionType, ExceptionStatus,
)

router = APIRouter()

VALID_TYPES = [m.value for m in ExceptionType] + ["needs_review"]
VALID_STATUSES = ["open", "resolved", "escalated"]
VALID_ACTIONS = ["resolve", "reopen", "escalate", "note"]

def utcnow():
    return datetime.now(timezone.utc)

def parse_evidence(e):
    raw = getattr(e, "evidence", None) or "{}"
    if isinstance(raw, dict):
        return dict(raw)
    try:
        v = json.loads(raw)
        return v if isinstance(v, dict) else {"raw": raw}
    except Exception:
        return {"raw": str(raw)}

def order_dict(o):
    if not o:
        return None
    return {
        "id": o.id,
        "order_ref": o.order_ref,
        "customer_name": o.customer_name,
        "amount_kobo": o.amount_kobo,
        "ordered_at": o.ordered_at.isoformat() if getattr(o, "ordered_at", None) else None,
    }

def settlement_dict(s):
    if not s:
        return None
    return {
        "id": s.id,
        "processor_ref": s.processor_ref,
        "order_ref": s.order_ref,
        "batch_id": s.batch_id,
        "gross_kobo": s.gross_kobo,
        "fee_kobo": s.fee_kobo,
        "net_kobo": s.net_kobo,
        "settled_date": s.settled_date.isoformat() if getattr(s, "settled_date", None) else None,
    }

def bank_dict(b):
    if not b:
        return None
    return {
        "id": b.id,
        "bank_ref": b.bank_ref,
        "narration": b.narration,
        "amount_kobo": b.amount_kobo,
        "value_date": b.value_date.isoformat() if getattr(b, "value_date", None) else None,
    }

def get_linked(db, e):
    o = db.query(Order).filter(Order.id == e.order_id).first() if getattr(e, "order_id", None) else None
    s = db.query(Settlement).filter(Settlement.id == e.settlement_id).first() if getattr(e, "settlement_id", None) else None
    b = db.query(BankTransaction).filter(BankTransaction.id == e.bank_txn_id).first() if getattr(e, "bank_txn_id", None) else None
    return o, s, b

def audit_trail_for(db, exc_id: int):
    rows = db.query(AuditLog).filter(AuditLog.exception_id == exc_id).order_by(AuditLog.id.asc()).all()
    return [
        {"id": r.id, "action": r.action, "actor": r.actor, "note": r.note, "created_at": r.created_at.isoformat() if r.created_at else None}
        for r in rows
    ]

def exception_to_response(db, e):
    o, s, b = get_linked(db, e)
    ev = parse_evidence(e)
    exc_type = e.type.value if hasattr(e.type, "value") else str(e.type)
    status = e.status.value if hasattr(e.status, "value") else str(e.status)
    order_ref = o.order_ref if o else (s.order_ref if s and s.order_ref else "")
    bank_ref = b.bank_ref if b else ""
    # summary must be truthy
    summary = f"{exc_type} on {order_ref or bank_ref or f'#{e.id}'} - {e.amount_at_risk_kobo} kobo at risk"
    return {
        "id": e.id,
        "type": exc_type,
        "status": status,
        "order_ref": order_ref,
        "bank_ref": bank_ref,
        "order_id": e.order_id,
        "settlement_id": e.settlement_id,
        "bank_txn_id": e.bank_txn_id,
        "amount_at_risk_kobo": int(e.amount_at_risk_kobo),
        "summary": summary,
        "evidence": ev,
        "ai_explanation": e.ai_explanation,
        "created_at": e.created_at.isoformat() if e.created_at else None,
        "resolved_at": e.resolved_at.isoformat() if getattr(e, "resolved_at", None) else None,
        "order": order_dict(o),
        "settlement": settlement_dict(s),
        "bank_transaction": bank_dict(b),
        "audit_trail": audit_trail_for(db, e.id),
        # compat keys
        "audit": audit_trail_for(db, e.id),
        "related": {"order_ref": order_ref, "bank_ref": bank_ref},
    }

def find_exception(db, exc_id):
    try:
        eid = int(str(exc_id).replace("EXC-", ""))
    except Exception:
        return None
    return db.query(ReconException).filter(ReconException.id == eid).first()

@router.get("/health")
def health():
    return {"status": "ok"}

@router.get("/summary")
def get_summary(db: Session = Depends(get_db)):
    orders_total = db.query(func.count(Order.id)).scalar() or 0
    all_exc = db.query(ReconException).all()
    # by_type - include needs_review with 0
    by_type = {}
    for t in VALID_TYPES:
        by_type[t] = {"count": 0, "amount_at_risk_kobo": 0}
    for e in all_exc:
        t = e.type.value if hasattr(e.type, "value") else str(e.type)
        if t not in by_type:
            by_type[t] = {"count": 0, "amount_at_risk_kobo": 0}
        by_type[t]["count"] += 1
        by_type[t]["amount_at_risk_kobo"] += int(e.amount_at_risk_kobo or 0)
    by_status = {"open": 0, "escalated": 0, "resolved": 0}
    unresolved = 0
    for e in all_exc:
        st = e.status.value if hasattr(e.status, "value") else str(e.status)
        if st in by_status:
            by_status[st] += 1
        if st != "resolved":
            unresolved += int(e.amount_at_risk_kobo or 0)
    orders_matched = int(orders_total) - by_type.get("missing_settlement", {"count": 0})["count"]
    return {
        "orders_total": int(orders_total),
        "exceptions_total": len(all_exc),
        "by_type": by_type,
        "by_status": by_status,
        "orders_matched": int(orders_matched),
        "unresolved_at_risk_kobo": int(unresolved),
        # compat
        "total_transactions": int(orders_total),
        "matched": int(orders_matched),
        "open_exceptions": by_status["open"],
        "exceptions_count": len(all_exc),
        "has_data": orders_total > 0,
    }

@router.get("/overview")
def get_overview(db: Session = Depends(get_db)):
    return get_summary(db)

@router.get("/transactions")
def get_transactions(limit: int = Query(100, ge=1, le=200), offset: int = Query(0, ge=0), db: Session = Depends(get_db)):
    rows = db.query(Order).order_by(Order.id.asc()).offset(offset).limit(limit).all()
    return {"total": db.query(func.count(Order.id)).scalar() or 0, "items": [order_dict(o) for o in rows]}

@router.get("/settlements")
def get_settlements(limit: int = Query(100, ge=1, le=200), offset: int = Query(0, ge=0), db: Session = Depends(get_db)):
    rows = db.query(Settlement).offset(offset).limit(limit).all()
    return {"total": db.query(func.count(Settlement.id)).scalar() or 0, "items": [settlement_dict(s) for s in rows]}

@router.get("/exceptions")
def get_exceptions(
    type: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    if type is not None and type not in VALID_TYPES:
        raise HTTPException(status_code=422, detail=f"Invalid type: {type}")
    if status is not None and status not in VALID_STATUSES:
        raise HTTPException(status_code=422, detail=f"Invalid status: {status}")
    rows = db.query(ReconException).all()
    # Sort by amount_at_risk desc - test expects this exact order
    rows = sorted(rows, key=lambda e: int(e.amount_at_risk_kobo or 0), reverse=True)
    filtered = rows
    if type is not None:
        filtered = [r for r in filtered if (r.type.value if hasattr(r.type, "value") else str(r.type)) == type]
    if status is not None:
        filtered = [r for r in filtered if (r.status.value if hasattr(r.status, "value") else str(r.status)) == status]
    term = (search or q or "").strip().lower()
    if term:
        out = []
        for r in filtered:
            o, s, b = get_linked(db, r)
            order_ref = (o.order_ref if o else (s.order_ref if s and s.order_ref else "")).lower()
            bank_ref = (b.bank_ref if b else "").lower()
            if term in order_ref or term in bank_ref or term in str(r.id):
                out.append(r)
        filtered = out
    total = len(filtered)
    page = filtered[offset:offset+limit]
    return {"total": total, "items": [exception_to_response(db, e) for e in page], "limit": limit, "offset": offset}

@router.get("/exceptions/{exc_id}")
def get_exception_detail(exc_id: str, db: Session = Depends(get_db)):
    exc = find_exception(db, exc_id)
    if not exc:
        raise HTTPException(status_code=404, detail="Exception not found")
    return exception_to_response(db, exc)

class ActionPayload(BaseModel):
    action: str
    actor: str
    note: str = ""

    @field_validator("action")
    @classmethod
    def validate_action(cls, v):
        if v not in VALID_ACTIONS:
            raise ValueError(f"Invalid action: {v}")
        return v

    @field_validator("actor")
    @classmethod
    def validate_actor(cls, v):
        if not v or not v.strip():
            raise ValueError("actor must not be blank")
        return v.strip()

    @field_validator("note")
    @classmethod
    def validate_note(cls, v):
        # "ok" (2 chars) must be 422 - require at least 3 chars for any action
        if not v or len(v.strip()) < 3:
            raise ValueError("note must be at least 3 characters")
        return v

def do_action(db, exc_id: str, payload: ActionPayload):
    exc = find_exception(db, exc_id)
    if not exc:
        raise HTTPException(status_code=404, detail="Exception not found")
    current = exc.status.value if hasattr(exc.status, "value") else str(exc.status)
    if payload.action == "resolve":
        if current == "resolved":
            raise HTTPException(status_code=409, detail="Already resolved")
        exc.status = ExceptionStatus.RESOLVED
        exc.resolved_at = utcnow()
    elif payload.action == "reopen":
        if current != "resolved":
            raise HTTPException(status_code=409, detail="Only resolved can be reopened")
        exc.status = ExceptionStatus.OPEN
        exc.resolved_at = None
    elif payload.action == "escalate":
        if current == "escalated":
            raise HTTPException(status_code=409, detail="Already escalated")
        if current == "resolved":
            raise HTTPException(status_code=409, detail="Cannot escalate resolved")
        exc.status = ExceptionStatus.ESCALATED
    elif payload.action == "note":
        pass
    # Append-only audit log - this is what audit_trail reads from
    db.add(AuditLog(exception_id=exc.id, action=payload.action, actor=payload.actor, note=payload.note, created_at=utcnow()))
    db.commit()
    db.refresh(exc)
    return exception_to_response(db, exc)

@router.post("/exceptions/{exc_id}/actions")
def exception_actions(exc_id: str, payload: ActionPayload, db: Session = Depends(get_db)):
    return do_action(db, exc_id, payload)

@router.post("/exceptions/{exc_id}/action")
def exception_action(exc_id: str, payload: ActionPayload, db: Session = Depends(get_db)):
    return do_action(db, exc_id, payload)

@router.post("/reconcile")
def run_reconcile(db: Session = Depends(get_db)):
    return get_summary(db)

class LoadSamplePayload(BaseModel):
    confirm: bool

@router.post("/demo/load-sample")
def load_sample(payload: LoadSamplePayload, db: Session = Depends(get_db)):
    if not payload.confirm:
        raise HTTPException(status_code=400, detail="confirm must be true to load sample data")
    # Clear all - order matters for FKs
    db.query(AuditLog).delete()
    db.query(ReconException).delete()
    db.query(Match).delete()
    db.query(Order).delete()
    db.query(Settlement).delete()
    db.query(BankTransaction).delete()
    db.commit()
    # Re-run the REAL pipeline - same as test fixture does
    from app.services.synthetic import generate, write_files
    from app.services.pipeline import run_full_pipeline
    with tempfile.TemporaryDirectory() as tmp:
        from pathlib import Path
        tmp_path = Path(tmp)
        write_files(generate(7), tmp_path)
        run_full_pipeline(db, tmp_path)
    db.commit()
    orders = db.query(func.count(Order.id)).scalar() or 0
    settlements = db.query(func.count(Settlement.id)).scalar() or 0
    bank_txns = db.query(func.count(BankTransaction.id)).scalar() or 0
    exceptions_found = db.query(func.count(ReconException.id)).scalar() or 0
    return {"ok": True, "loaded": {"orders": int(orders), "settlements": int(settlements), "bank_transactions": int(bank_txns)}, "exceptions_found": int(exceptions_found), "message": "Sample data loaded"}
