import random
from datetime import date

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from app.core.database import Base
from app.matching.engine import (
    OrderRec,
    Pair,
    SettlementRec,
    match_orders_to_settlements,
    run_matching,
)
from app.models.tables import Match, MatchTier, Order
from app.services.ingestion import ingest_all
from app.services.synthetic import N_MANGLED, N_ORDERS, PLANTED, generate, write_files


def order(i, ref, amount, day):
    return OrderRec(i, ref, amount, date(2026, 10, day))


def line(i, ref, gross, day):
    return SettlementRec(i, ref, gross, date(2026, 10, day))


def test_exact_reference_match():
    r = match_orders_to_settlements([order(1, "ORD-1", 10_000, 1)], [line(10, "ORD-1", 10_000, 2)])
    assert r.pairs == [Pair(1, 10, MatchTier.EXACT_REFERENCE)]
    assert r.unmatched_order_ids == [] and r.unmatched_settlement_ids == []


def test_exact_reference_wins_even_when_amount_differs():
    # Judging the amount is the classifier's job, not the matcher's.
    r = match_orders_to_settlements([order(1, "ORD-1", 10_000, 1)], [line(10, "ORD-1", 9_000, 2)])
    assert r.pairs == [Pair(1, 10, MatchTier.EXACT_REFERENCE)]


def test_mangled_reference_matched_by_amount_and_date():
    r = match_orders_to_settlements([order(1, "ORD-1", 10_000, 1)], [line(10, "ord-1", 10_000, 3)])
    assert r.pairs == [Pair(1, 10, MatchTier.AMOUNT_DATE_WINDOW)]


def test_missing_reference_matched_by_amount_and_date():
    r = match_orders_to_settlements([order(1, "ORD-1", 10_000, 1)], [line(10, None, 10_000, 3)])
    assert r.pairs == [Pair(1, 10, MatchTier.AMOUNT_DATE_WINDOW)]


def test_amount_match_outside_window_is_not_linked():
    r = match_orders_to_settlements([order(1, "ORD-1", 10_000, 1)], [line(10, "xyz", 10_000, 30)])
    assert r.pairs == []
    assert r.unmatched_order_ids == [1] and r.unmatched_settlement_ids == [10]


def test_settlement_before_order_is_not_linked():
    r = match_orders_to_settlements([order(1, "ORD-1", 10_000, 5)], [line(10, "xyz", 10_000, 1)])
    assert r.pairs == []


def test_duplicate_line_is_not_relinked_to_another_order():
    orders = [order(1, "ORD-1", 10_000, 1), order(2, "ORD-2", 10_000, 1)]  # same amount
    lines = [line(10, "ORD-1", 10_000, 2), line(11, "ORD-1", 10_000, 2)]
    r = match_orders_to_settlements(orders, lines)
    assert r.pairs == [Pair(1, 10, MatchTier.EXACT_REFERENCE)]
    assert r.unmatched_settlement_ids == [11]
    assert r.unmatched_order_ids == [2]


def test_ambiguous_candidates_are_not_guessed():
    orders = [order(1, "ORD-1", 10_000, 1), order(2, "ORD-2", 10_000, 1)]
    r = match_orders_to_settlements(orders, [line(10, "xyz", 10_000, 2)])
    assert r.pairs == []
    assert r.ambiguous_settlement_ids == [10]


def test_result_is_independent_of_input_order():
    orders = [order(i, f"ORD-{i}", 1_000 * i, 1) for i in range(1, 30)]
    lines = [line(100 + i, f"ORD-{i}" if i % 3 else f"ord-{i}", 1_000 * i, 2) for i in range(1, 30)]
    baseline = match_orders_to_settlements(orders, lines)
    rng = random.Random(1)
    shuffled_orders, shuffled_lines = orders[:], lines[:]
    rng.shuffle(shuffled_orders)
    rng.shuffle(shuffled_lines)
    again = match_orders_to_settlements(shuffled_orders, shuffled_lines)
    assert sorted(baseline.pairs, key=lambda p: p.order_id) == sorted(again.pairs, key=lambda p: p.order_id)


@pytest.fixture()
def session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


def test_engine_on_synthetic_data(session, tmp_path):
    data = generate(7)
    write_files(data, tmp_path)
    ingest_all(session, tmp_path)
    result = run_matching(session)

    tier1 = [p for p in result.pairs if p.tier == MatchTier.EXACT_REFERENCE]
    tier2 = [p for p in result.pairs if p.tier == MatchTier.AMOUNT_DATE_WINDOW]

    # Every order that has a settlement line and a clean reference matches by reference.
    assert len(tier1) == N_ORDERS - PLANTED["missing_settlement"] - N_MANGLED

    # Tier 2 may only ever link orders whose reference was deliberately mangled.
    mangled = {m["order_ref"] for m in data["answer_key"]["mangled_references_not_exceptions"]}
    ref_of = {o.id: o.order_ref for o in session.scalars(select(Order))}
    assert {ref_of[p.order_id] for p in tier2} <= mangled

    # Nothing is linked twice.
    assert len({p.order_id for p in result.pairs}) == len(result.pairs)
    assert len({p.settlement_id for p in result.pairs}) == len(result.pairs)


def test_rerunning_does_not_duplicate_matches(session, tmp_path):
    write_files(generate(7), tmp_path)
    ingest_all(session, tmp_path)
    first = run_matching(session)
    run_matching(session)
    assert session.scalar(select(func.count()).select_from(Match)) == len(first.pairs)
