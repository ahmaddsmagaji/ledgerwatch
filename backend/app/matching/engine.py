"""Deterministic matching engine, tiers 1-2 (order <-> settlement line).

Tier 1  exact reference
Tier 2  amount + date window (for lines whose reference is missing or mangled)

No AI, no randomness, no floats. The engine never reads the answer key.
Ambiguous candidates are never guessed: they are reported and left unmatched.
Whether a matched pair has a problem (wrong amount, fee, timing) is NOT decided
here; the exception classifier does that.
"""

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.database import Base, SessionLocal, engine
from app.models.tables import Match, MatchTier, Order, Settlement

MATCH_WINDOW_DAYS = 14
TIERS_OWNED = [MatchTier.EXACT_REFERENCE, MatchTier.AMOUNT_DATE_WINDOW]


@dataclass(frozen=True)
class OrderRec:
    id: int
    ref: str
    amount_kobo: int
    ordered_on: date


@dataclass(frozen=True)
class SettlementRec:
    id: int
    order_ref: str | None
    gross_kobo: int
    settled_on: date


@dataclass(frozen=True)
class Pair:
    order_id: int
    settlement_id: int
    tier: MatchTier


@dataclass
class MatchResult:
    pairs: list = field(default_factory=list)
    unmatched_order_ids: list = field(default_factory=list)
    unmatched_settlement_ids: list = field(default_factory=list)
    ambiguous_settlement_ids: list = field(default_factory=list)


def match_orders_to_settlements(orders, settlements, window_days=MATCH_WINDOW_DAYS) -> MatchResult:
    """Pure function: records in, matches out. No database access."""
    result = MatchResult()
    order_by_ref = {o.ref: o for o in orders}
    matched_orders: set = set()
    matched_lines: set = set()
    lines = sorted(settlements, key=lambda s: (s.settled_on, s.id))

    # Tier 1: exact reference. The earliest line for an order wins;
    # any later line quoting the same order is left for the duplicate check.
    for s in lines:
        order = order_by_ref.get(s.order_ref) if s.order_ref else None
        if order is not None and order.id not in matched_orders:
            result.pairs.append(Pair(order.id, s.id, MatchTier.EXACT_REFERENCE))
            matched_orders.add(order.id)
            matched_lines.add(s.id)

    # Tier 2: amount + date window, only for lines whose reference is NOT a valid
    # order reference. A line quoting a valid reference that lost tier 1 is a
    # duplicate and must never be linked to a different order.
    free_by_amount = defaultdict(list)
    for o in orders:
        if o.id not in matched_orders:
            free_by_amount[o.amount_kobo].append(o)

    candidate_lines = [
        s for s in lines if s.id not in matched_lines and s.order_ref not in order_by_ref
    ]
    orders_for_line = {}
    lines_for_order = defaultdict(list)
    for s in candidate_lines:
        found = [
            o
            for o in free_by_amount.get(s.gross_kobo, [])
            if 0 <= (s.settled_on - o.ordered_on).days <= window_days
        ]
        orders_for_line[s.id] = found
        for o in found:
            lines_for_order[o.id].append(s.id)

    for s in candidate_lines:
        found = orders_for_line[s.id]
        if not found:
            continue
        # Link only when the fit is mutual and unique; otherwise do not guess.
        if len(found) == 1 and len(lines_for_order[found[0].id]) == 1:
            result.pairs.append(Pair(found[0].id, s.id, MatchTier.AMOUNT_DATE_WINDOW))
            matched_orders.add(found[0].id)
            matched_lines.add(s.id)
        else:
            result.ambiguous_settlement_ids.append(s.id)

    result.unmatched_order_ids = sorted(o.id for o in orders if o.id not in matched_orders)
    result.unmatched_settlement_ids = sorted(s.id for s in lines if s.id not in matched_lines)
    return result


def run_matching(session: Session) -> MatchResult:
    """Load records, match them, and store the links. Safe to re-run."""
    orders = [
        OrderRec(o.id, o.order_ref, o.amount_kobo, o.ordered_at.date())
        for o in session.scalars(select(Order))
    ]
    lines = [
        SettlementRec(s.id, s.order_ref, s.gross_kobo, s.settled_date)
        for s in session.scalars(select(Settlement))
    ]
    result = match_orders_to_settlements(orders, lines)

    session.execute(delete(Match).where(Match.tier.in_(TIERS_OWNED)))
    for p in result.pairs:
        session.add(Match(tier=p.tier, order_id=p.order_id, settlement_id=p.settlement_id))
    session.commit()
    return result


def main() -> None:
    Base.metadata.create_all(bind=engine)
    with SessionLocal() as session:
        result = run_matching(session)

    tier1 = sum(1 for p in result.pairs if p.tier == MatchTier.EXACT_REFERENCE)
    tier2 = sum(1 for p in result.pairs if p.tier == MatchTier.AMOUNT_DATE_WINDOW)
    print(f"tier 1 exact reference:   {tier1}")
    print(f"tier 2 amount + date:     {tier2}")
    print(f"ambiguous (not linked):   {len(result.ambiguous_settlement_ids)}")
    print(f"orders with no line:      {len(result.unmatched_order_ids)}")
    print(f"lines with no order:      {len(result.unmatched_settlement_ids)}")


if __name__ == "__main__":
    main()
