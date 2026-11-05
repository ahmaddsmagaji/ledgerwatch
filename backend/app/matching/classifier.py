"""Exception classifier: turns matching results into typed, evidenced exceptions.

Deterministic rules only. No AI, no floats, and it never reads the answer key.
The fee rate card and settlement SLA below are inputs from the processor's
agreement (here: the fictional PayRail). In a real deployment they become
per-processor configuration.
"""

import json
from dataclasses import dataclass, field
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import Base, SessionLocal, engine
from app.models.tables import (
    AuditLog,
    BankTransaction,
    ExceptionStatus,
    ExceptionType,
    Match,
    MatchTier,
    Order,
    ReconException,
    Settlement,
)

SLA_DAYS = 3             # settlement is expected within this many days of the order
FEE_PERMILLE = 15        # 1.5% ...
FEE_CAP_KOBO = 200_000   # ... capped at NGN 2,000


def expected_fee(gross_kobo: int) -> int:
    """The rate card's fee: 1.5% rounded half-up to the kobo, capped."""
    return min((gross_kobo * FEE_PERMILLE + 500) // 1000, FEE_CAP_KOBO)


def naira(kobo: int) -> str:
    return f"NGN {kobo // 100:,}.{kobo % 100:02d}"


def normalize_ref(ref: str) -> str:
    """'ord-00042', 'ORD 00042' and 'ORD-00042' all become 'ORD00042'."""
    return "".join(ch for ch in ref.upper() if ch.isalnum())


@dataclass(frozen=True)
class OrderFact:
    id: int
    ref: str
    amount_kobo: int
    ordered_on: date


@dataclass(frozen=True)
class LineFact:
    id: int
    order_ref: str | None
    gross_kobo: int
    fee_kobo: int
    net_kobo: int
    settled_on: date


@dataclass(frozen=True)
class BankFact:
    id: int
    bank_ref: str
    amount_kobo: int
    narration: str


@dataclass(frozen=True)
class Finding:
    type: ExceptionType
    order_id: int | None
    settlement_id: int | None
    bank_txn_id: int | None
    amount_at_risk_kobo: int
    evidence: dict


@dataclass
class ClassifyResult:
    findings: list = field(default_factory=list)
    unclassified_settlement_ids: list = field(default_factory=list)
    settlement_ids_without_bank_link: list = field(default_factory=list)


def classify(orders, lines, bank, order_links, bank_links, sla_days=SLA_DAYS) -> ClassifyResult:
    """Pure function. order_links maps settlement_id -> order_id;
    bank_links maps settlement_id -> bank_txn_id."""
    result = ClassifyResult()
    findings = result.findings
    order_by_id = {o.id: o for o in orders}
    linked_order_ids = set(order_links.values())
    banks_with_batch = set(bank_links.values())

    def add(kind, order_id, settlement_id, bank_id, risk, evidence):
        findings.append(Finding(kind, order_id, settlement_id, bank_id, risk, evidence))

    # 1. Orders nobody paid
    for o in sorted(orders, key=lambda x: x.id):
        if o.id not in linked_order_ids:
            add(
                ExceptionType.MISSING_SETTLEMENT, o.id, None, None, o.amount_kobo,
                {
                    "order_ref": o.ref,
                    "order_amount_kobo": o.amount_kobo,
                    "ordered_on": o.ordered_on.isoformat(),
                    "summary": f"Order {o.ref} for {naira(o.amount_kobo)} has no line in the settlement report.",
                },
            )

    # 2. Matched pairs: check amount, fee, and timing independently
    for s in sorted(lines, key=lambda x: x.id):
        order_id = order_links.get(s.id)
        if order_id is None:
            continue
        o = order_by_id[order_id]
        bank_id = bank_links.get(s.id)

        if s.gross_kobo != o.amount_kobo:
            diff = abs(s.gross_kobo - o.amount_kobo)
            add(
                ExceptionType.AMOUNT_MISMATCH, o.id, s.id, bank_id, diff,
                {
                    "order_ref": o.ref,
                    "order_amount_kobo": o.amount_kobo,
                    "settled_gross_kobo": s.gross_kobo,
                    "summary": f"Order {o.ref} is {naira(o.amount_kobo)} but the processor settled a gross of "
                               f"{naira(s.gross_kobo)} (difference {naira(diff)}).",
                },
            )

        fee_expected = expected_fee(s.gross_kobo)
        if s.fee_kobo != fee_expected:
            diff = abs(s.fee_kobo - fee_expected)
            add(
                ExceptionType.FEE_DISCREPANCY, o.id, s.id, bank_id, diff,
                {
                    "order_ref": o.ref,
                    "gross_kobo": s.gross_kobo,
                    "fee_charged_kobo": s.fee_kobo,
                    "fee_expected_kobo": fee_expected,
                    "summary": f"Fee charged on {o.ref} is {naira(s.fee_kobo)}; the rate card gives "
                               f"{naira(fee_expected)} (difference {naira(diff)}).",
                },
            )
        elif s.net_kobo != s.gross_kobo - s.fee_kobo:
            diff = abs(s.net_kobo - (s.gross_kobo - s.fee_kobo))
            add(
                ExceptionType.FEE_DISCREPANCY, o.id, s.id, bank_id, diff,
                {
                    "order_ref": o.ref,
                    "gross_kobo": s.gross_kobo,
                    "fee_charged_kobo": s.fee_kobo,
                    "net_reported_kobo": s.net_kobo,
                    "summary": f"Net settled on {o.ref} does not equal gross minus fee "
                               f"(off by {naira(diff)}).",
                },
            )

        lag = (s.settled_on - o.ordered_on).days
        if lag < 0 or lag > sla_days:
            add(
                ExceptionType.TIMING_BREAK, o.id, s.id, bank_id, s.net_kobo,
                {
                    "order_ref": o.ref,
                    "ordered_on": o.ordered_on.isoformat(),
                    "settled_on": s.settled_on.isoformat(),
                    "days_to_settle": lag,
                    "sla_days": sla_days,
                    "summary": f"Order {o.ref} settled {lag} days after the order; expected within {sla_days} days."
                               if lag >= 0 else
                               f"Order {o.ref} settled {-lag} days BEFORE the order was placed.",
                },
            )

    # 3. Settlement lines with no order: duplicates, or unexplained
    norm_to_order = {normalize_ref(o.ref): o for o in orders}
    for s in sorted(lines, key=lambda x: x.id):
        if s.id in order_links:
            continue
        target = norm_to_order.get(normalize_ref(s.order_ref)) if s.order_ref else None
        if target is not None and target.id in linked_order_ids:
            add(
                ExceptionType.DUPLICATE, target.id, s.id, bank_links.get(s.id), s.net_kobo,
                {
                    "order_ref": target.ref,
                    "appears_as": s.order_ref,
                    "duplicate_net_kobo": s.net_kobo,
                    "summary": f"Order {target.ref} appears more than once in the settlement report; "
                               f"the extra line pays {naira(s.net_kobo)}.",
                },
            )
        else:
            result.unclassified_settlement_ids.append(s.id)

    # 4. Bank credits that match no settlement batch
    for b in sorted(bank, key=lambda x: x.id):
        if b.id not in banks_with_batch:
            add(
                ExceptionType.ORPHAN_BANK_CREDIT, None, None, b.id, b.amount_kobo,
                {
                    "bank_ref": b.bank_ref,
                    "narration": b.narration,
                    "credit_kobo": b.amount_kobo,
                    "summary": f"Bank credit {b.bank_ref} of {naira(b.amount_kobo)} "
                               f"matches no settlement batch.",
                },
            )

    result.settlement_ids_without_bank_link = sorted(s.id for s in lines if s.id not in bank_links)
    return result


def run_classification(session: Session) -> ClassifyResult:
    """Load facts and links, classify, and sync the exceptions table.
    Safe to re-run: human decisions are never deleted."""
    orders = [
        OrderFact(o.id, o.order_ref, o.amount_kobo, o.ordered_at.date())
        for o in session.scalars(select(Order))
    ]
    lines = [
        LineFact(s.id, s.order_ref, s.gross_kobo, s.fee_kobo, s.net_kobo, s.settled_date)
        for s in session.scalars(select(Settlement))
    ]
    bank = [
        BankFact(b.id, b.bank_ref, b.amount_kobo, b.narration)
        for b in session.scalars(select(BankTransaction))
    ]
    order_links, bank_links = {}, {}
    for m in session.scalars(select(Match)):
        if m.tier in (MatchTier.EXACT_REFERENCE, MatchTier.AMOUNT_DATE_WINDOW):
            order_links[m.settlement_id] = m.order_id
        elif m.tier == MatchTier.BATCH_MANY_TO_ONE:
            bank_links[m.settlement_id] = m.bank_txn_id

    from app.matching.review_queue import classify_with_review  # local import avoids a cycle

    result = classify_with_review(orders, lines, bank, order_links, bank_links)

    existing = {
        (e.type, e.order_id, e.settlement_id, e.bank_txn_id): e
        for e in session.scalars(select(ReconException))
    }
    audited = set(session.scalars(select(AuditLog.exception_id)))
    seen = set()
    for f in result.findings:
        key = (f.type, f.order_id, f.settlement_id, f.bank_txn_id)
        seen.add(key)
        evidence = json.dumps(f.evidence, sort_keys=True)
        row = existing.get(key)
        if row is None:
            session.add(
                ReconException(
                    type=f.type,
                    order_id=f.order_id,
                    settlement_id=f.settlement_id,
                    bank_txn_id=f.bank_txn_id,
                    amount_at_risk_kobo=f.amount_at_risk_kobo,
                    evidence=evidence,
                )
            )
        else:
            row.amount_at_risk_kobo = f.amount_at_risk_kobo
            row.evidence = evidence
    for key, row in existing.items():
        if key not in seen and row.status == ExceptionStatus.OPEN and row.id not in audited:
            session.delete(row)
    session.commit()
    return result


def main() -> None:
    Base.metadata.create_all(bind=engine)
    with SessionLocal() as session:
        result = run_classification(session)

    totals = {}
    for f in result.findings:
        count, risk = totals.get(f.type.value, (0, 0))
        totals[f.type.value] = (count + 1, risk + f.amount_at_risk_kobo)

    print(f"{'type':<22}{'count':>5}   amount at risk")
    for kind in sorted(totals):
        count, risk = totals[kind]
        print(f"{kind:<22}{count:>5}   {naira(risk)}")
    print(f"{'TOTAL EXCEPTIONS':<22}{len(result.findings):>5}")
    print(f"settlement lines with no explanation:    {len(result.unclassified_settlement_ids)}")
    print(f"settlement lines with no bank link:      {len(result.settlement_ids_without_bank_link)}")


if __name__ == "__main__":
    main()
