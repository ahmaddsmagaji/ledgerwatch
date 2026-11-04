"""Tier 4: batch many-to-one matching (settlement lines <-> bank credits).

A batch is every settlement line sharing a batch_id. Its total is the exact
integer sum of the lines' net amounts. A batch matches a bank credit when the
amounts are equal and the credit lands within a few days of the settlement date.

The narration text is deliberately ignored: real narrations vary by bank, and an
exact integer sum is stronger evidence. Ambiguity is never guessed.
"""

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.database import Base, SessionLocal, engine
from app.models.tables import BankTransaction, Match, MatchTier, Settlement

BANK_WINDOW_DAYS = 5


@dataclass(frozen=True)
class LineRec:
    id: int
    batch_id: str
    net_kobo: int
    settled_on: date


@dataclass(frozen=True)
class BankRec:
    id: int
    amount_kobo: int
    value_date: date


@dataclass(frozen=True)
class BatchPair:
    batch_id: str
    bank_txn_id: int
    settlement_ids: tuple


@dataclass
class BatchResult:
    pairs: list = field(default_factory=list)
    ambiguous_batch_ids: list = field(default_factory=list)
    unmatched_batch_ids: list = field(default_factory=list)
    unmatched_bank_ids: list = field(default_factory=list)


def match_batches_to_bank(lines, bank, window_days=BANK_WINDOW_DAYS) -> BatchResult:
    """Pure function: records in, matches out. No database access."""
    result = BatchResult()

    batches = defaultdict(list)
    for ln in lines:
        batches[ln.batch_id].append(ln)

    summary = sorted(
        (
            (batch_id, sum(m.net_kobo for m in members), min(m.settled_on for m in members))
            for batch_id, members in batches.items()
        ),
        key=lambda b: (b[2], b[0]),
    )

    candidates = {}
    batches_for_bank = defaultdict(list)
    for batch_id, total, settled_on in summary:
        found = [
            b
            for b in bank
            if b.amount_kobo == total and 0 <= (b.value_date - settled_on).days <= window_days
        ]
        candidates[batch_id] = found
        for b in found:
            batches_for_bank[b.id].append(batch_id)

    matched_bank: set = set()
    for batch_id, _total, _settled_on in summary:
        found = candidates[batch_id]
        if not found:
            result.unmatched_batch_ids.append(batch_id)
        elif len(found) == 1 and len(batches_for_bank[found[0].id]) == 1:
            ids = tuple(sorted(m.id for m in batches[batch_id]))
            result.pairs.append(BatchPair(batch_id, found[0].id, ids))
            matched_bank.add(found[0].id)
        else:
            result.ambiguous_batch_ids.append(batch_id)

    result.unmatched_bank_ids = sorted(b.id for b in bank if b.id not in matched_bank)
    return result


def run_batch_matching(session: Session) -> BatchResult:
    """Load records, match them, and store the links. Safe to re-run."""
    lines = [
        LineRec(s.id, s.batch_id, s.net_kobo, s.settled_date)
        for s in session.scalars(select(Settlement))
    ]
    bank = [
        BankRec(b.id, b.amount_kobo, b.value_date)
        for b in session.scalars(select(BankTransaction))
    ]
    result = match_batches_to_bank(lines, bank)

    session.execute(delete(Match).where(Match.tier == MatchTier.BATCH_MANY_TO_ONE))
    for pair in result.pairs:
        for settlement_id in pair.settlement_ids:
            session.add(
                Match(
                    tier=MatchTier.BATCH_MANY_TO_ONE,
                    settlement_id=settlement_id,
                    bank_txn_id=pair.bank_txn_id,
                )
            )
    session.commit()
    return result


def main() -> None:
    Base.metadata.create_all(bind=engine)
    with SessionLocal() as session:
        result = run_batch_matching(session)

    linked_lines = sum(len(p.settlement_ids) for p in result.pairs)
    print(f"batches matched to a bank credit: {len(result.pairs)}")
    print(f"settlement lines linked:          {linked_lines}")
    print(f"ambiguous batches (not linked):   {len(result.ambiguous_batch_ids)}")
    print(f"batches with no bank credit:      {len(result.unmatched_batch_ids)}")
    print(f"bank credits with no batch:       {len(result.unmatched_bank_ids)}")


if __name__ == "__main__":
    main()
