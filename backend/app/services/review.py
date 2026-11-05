"""Review workflow: summaries, filtering, detail views, and human actions on exceptions.

All business rules live here; the API layer stays thin. Money is always integer kobo.
"""

import json

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.matching.classifier import naira
from app.models.tables import (
    AuditLog,
    BankTransaction,
    ExceptionStatus,
    ExceptionType,
    Match,
    Order,
    ReconException,
    Settlement,
    utcnow,
)

ACTIONS = ("resolve", "escalate", "reopen", "note")

# action -> (statuses it may start from, status it leads to)
TRANSITIONS = {
    "resolve": ({ExceptionStatus.OPEN, ExceptionStatus.ESCALATED}, ExceptionStatus.RESOLVED),
    "escalate": ({ExceptionStatus.OPEN}, ExceptionStatus.ESCALATED),
    "reopen": ({ExceptionStatus.RESOLVED, ExceptionStatus.ESCALATED}, ExceptionStatus.OPEN),
}


class ReviewError(Exception):
    status_code = 400


class NotFound(ReviewError):
    status_code = 404


class InvalidAction(ReviewError):
    status_code = 409


class BadInput(ReviewError):
    status_code = 422


def _parse_enum(enum_class, value, label):
    if value is None:
        return None
    try:
        return enum_class(value)
    except ValueError:
        allowed = ", ".join(member.value for member in enum_class)
        raise BadInput(f"unknown {label} '{value}' (allowed: {allowed})") from None


def _item(row: ReconException, order_ref, bank_ref) -> dict:
    return {
        "id": row.id,
        "type": row.type.value,
        "status": row.status.value,
        "order_ref": order_ref,
        "bank_ref": bank_ref,
        "amount_at_risk_kobo": row.amount_at_risk_kobo,
        "amount_at_risk_display": naira(row.amount_at_risk_kobo),
        "summary": json.loads(row.evidence).get("summary", ""),
        "created_at": row.created_at.isoformat(),
        "resolved_at": row.resolved_at.isoformat() if row.resolved_at else None,
    }


def _ref_maps(session: Session, rows):
    order_ids = {r.order_id for r in rows if r.order_id is not None}
    bank_ids = {r.bank_txn_id for r in rows if r.bank_txn_id is not None}
    orders, banks = {}, {}
    if order_ids:
        orders = {
            i: ref
            for i, ref in session.execute(select(Order.id, Order.order_ref).where(Order.id.in_(order_ids)))
        }
    if bank_ids:
        banks = {
            i: ref
            for i, ref in session.execute(
                select(BankTransaction.id, BankTransaction.bank_ref).where(BankTransaction.id.in_(bank_ids))
            )
        }
    return orders, banks


def get_summary(session: Session) -> dict:
    orders_total = session.scalar(select(func.count()).select_from(Order)) or 0
    orders_matched = (
        session.scalar(
            select(func.count(func.distinct(Match.order_id))).where(Match.order_id.is_not(None))
        )
        or 0
    )

    by_type = {kind.value: {"count": 0, "amount_at_risk_kobo": 0} for kind in ExceptionType}
    for kind, count, risk in session.execute(
        select(
            ReconException.type,
            func.count(),
            func.coalesce(func.sum(ReconException.amount_at_risk_kobo), 0),
        ).group_by(ReconException.type)
    ):
        by_type[kind.value] = {"count": count, "amount_at_risk_kobo": int(risk)}

    by_status = {state.value: 0 for state in ExceptionStatus}
    for state, count in session.execute(
        select(ReconException.status, func.count()).group_by(ReconException.status)
    ):
        by_status[state.value] = count

    unresolved = int(
        session.scalar(
            select(func.coalesce(func.sum(ReconException.amount_at_risk_kobo), 0)).where(
                ReconException.status != ExceptionStatus.RESOLVED
            )
        )
    )
    return {
        "orders_total": orders_total,
        "orders_matched": orders_matched,
        "match_rate_percent": round(100 * orders_matched / orders_total, 1) if orders_total else 0.0,
        "settlement_lines_total": session.scalar(select(func.count()).select_from(Settlement)) or 0,
        "bank_credits_total": session.scalar(select(func.count()).select_from(BankTransaction)) or 0,
        "total_order_value_kobo": int(
            session.scalar(select(func.coalesce(func.sum(Order.amount_kobo), 0)))
        ),
        "exceptions_total": sum(v["count"] for v in by_type.values()),
        "by_type": by_type,
        "by_status": by_status,
        "unresolved_at_risk_kobo": unresolved,
        "unresolved_at_risk_display": naira(unresolved),
    }


def list_exceptions(
    session: Session, exception_type=None, status=None, search=None, limit=50, offset=0
) -> dict:
    kind = _parse_enum(ExceptionType, exception_type, "type")
    state = _parse_enum(ExceptionStatus, status, "status")
    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))

    query = (
        select(ReconException)
        .outerjoin(Order, ReconException.order_id == Order.id)
        .outerjoin(BankTransaction, ReconException.bank_txn_id == BankTransaction.id)
    )
    if kind is not None:
        query = query.where(ReconException.type == kind)
    if state is not None:
        query = query.where(ReconException.status == state)
    if search and search.strip():
        term = f"%{search.strip().lower()}%"
        query = query.where(
            or_(
                func.lower(Order.order_ref).like(term),
                func.lower(BankTransaction.bank_ref).like(term),
                func.lower(ReconException.evidence).like(term),
            )
        )

    total = session.scalar(select(func.count()).select_from(query.subquery()))
    rows = session.scalars(
        query.order_by(ReconException.amount_at_risk_kobo.desc(), ReconException.id)
        .limit(limit)
        .offset(offset)
    ).all()
    orders, banks = _ref_maps(session, rows)
    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "items": [_item(r, orders.get(r.order_id), banks.get(r.bank_txn_id)) for r in rows],
    }


def get_detail(session: Session, exception_id: int) -> dict:
    row = session.get(ReconException, exception_id)
    if row is None:
        raise NotFound(f"exception {exception_id} not found")
    order = session.get(Order, row.order_id) if row.order_id is not None else None
    line = session.get(Settlement, row.settlement_id) if row.settlement_id is not None else None
    bank = session.get(BankTransaction, row.bank_txn_id) if row.bank_txn_id is not None else None
    trail = session.scalars(
        select(AuditLog).where(AuditLog.exception_id == row.id).order_by(AuditLog.id)
    ).all()

    detail = _item(row, order.order_ref if order else None, bank.bank_ref if bank else None)
    detail["evidence"] = json.loads(row.evidence)
    detail["ai_explanation"] = row.ai_explanation
    detail["order"] = (
        {
            "id": order.id,
            "order_ref": order.order_ref,
            "customer_name": order.customer_name,
            "amount_kobo": order.amount_kobo,
            "ordered_at": order.ordered_at.isoformat(),
        }
        if order
        else None
    )
    detail["settlement"] = (
        {
            "id": line.id,
            "processor_ref": line.processor_ref,
            "order_ref": line.order_ref,
            "batch_id": line.batch_id,
            "gross_kobo": line.gross_kobo,
            "fee_kobo": line.fee_kobo,
            "net_kobo": line.net_kobo,
            "settled_date": line.settled_date.isoformat(),
        }
        if line
        else None
    )
    detail["bank_transaction"] = (
        {
            "id": bank.id,
            "bank_ref": bank.bank_ref,
            "narration": bank.narration,
            "amount_kobo": bank.amount_kobo,
            "value_date": bank.value_date.isoformat(),
        }
        if bank
        else None
    )
    detail["audit_trail"] = [
        {
            "id": a.id,
            "action": a.action,
            "actor": a.actor,
            "note": a.note,
            "created_at": a.created_at.isoformat(),
        }
        for a in trail
    ]
    return detail


def apply_action(session: Session, exception_id: int, action: str, actor: str, note: str) -> dict:
    """Apply a human decision and record it in the audit log. The actor is
    self-declared until authentication exists."""
    if action not in ACTIONS:
        raise BadInput(f"unknown action '{action}' (allowed: {', '.join(ACTIONS)})")
    actor = (actor or "").strip()
    note = (note or "").strip()
    if not actor:
        raise BadInput("actor is required")
    if len(actor) > 80:
        raise BadInput("actor is longer than 80 characters")
    if len(note) < 3:
        raise BadInput("a note of at least 3 characters is required")

    row = session.get(ReconException, exception_id)
    if row is None:
        raise NotFound(f"exception {exception_id} not found")

    if action != "note":
        allowed_from, target = TRANSITIONS[action]
        if row.status not in allowed_from:
            raise InvalidAction(f"cannot {action} an exception that is {row.status.value}")
        row.status = target
        row.resolved_at = utcnow() if target == ExceptionStatus.RESOLVED else None

    session.add(AuditLog(exception_id=row.id, action=action, actor=actor, note=note))
    session.commit()
    return get_detail(session, exception_id)
