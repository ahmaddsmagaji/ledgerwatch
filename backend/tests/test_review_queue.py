import json
from datetime import date

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from app.core.database import Base
from app.matching.classifier import BankFact, LineFact, OrderFact, expected_fee
from app.matching.review_queue import classify_with_review
from app.models.tables import ExceptionType, Order, ReconException
from app.services.hostile import build_hostile
from app.services.stress import run_pipeline
from app.services.synthetic import PLANTED, generate, write_files

ORDER_AMOUNT = 1_000_000  # NGN 10,000.00


def O(i, amount=ORDER_AMOUNT, day=1):
    return OrderFact(i, f"ORD-{i}", amount, date(2026, 10, day))


def clean_line(i, ref, gross=ORDER_AMOUNT, day=2):
    fee = expected_fee(gross)
    return LineFact(i, ref, gross, fee, gross - fee, date(2026, 10, day))


def Bk(i):
    return BankFact(i, f"BNK-{i}", 5_000, "TEST")


def kinds(result):
    return [f.type for f in result.findings]


def test_clean_pair_gets_no_review_item():
    r = classify_with_review([O(1)], [clean_line(10, "ORD-1")], [Bk(100)], {10: 1}, {10: 100})
    assert r.findings == []


def test_unexplained_line_becomes_a_review_item_with_the_likely_order():
    r = classify_with_review([O(1)], [clean_line(10, "ord-1")], [Bk(100)], {}, {10: 100})
    assert kinds(r) == [ExceptionType.NEEDS_REVIEW]  # no false "missing settlement"
    f = r.findings[0]
    assert f.order_id == 1 and f.settlement_id == 10 and f.bank_txn_id == 100
    assert f.amount_at_risk_kobo == clean_line(10, "ord-1").net_kobo
    assert f.evidence["match_basis"] == "reference"
    assert f.evidence["candidates"][0]["order_ref"] == "ORD-1"
    assert "more than one equally good fit" in f.evidence["summary"]


def test_a_different_amount_is_explained():
    line = clean_line(10, "ord-1", gross=ORDER_AMOUNT + 5_000)
    r = classify_with_review([O(1)], [line], [Bk(100)], {}, {10: 100})
    summary = r.findings[0].evidence["summary"]
    assert "NGN 10,050.00" in summary and "NGN 10,000.00" in summary


def test_a_late_settlement_is_explained():
    r = classify_with_review([O(1, day=1)], [clean_line(10, "ord-1", day=30)], [Bk(100)], {}, {10: 100})
    assert "outside the 14-day automatic window" in r.findings[0].evidence["summary"]


def test_two_lines_claiming_one_order_are_both_reviewed():
    lines = [clean_line(10, "ord-1"), clean_line(11, "ORD 1")]
    r = classify_with_review([O(1)], lines, [Bk(100)], {}, {10: 100, 11: 100})
    assert kinds(r) == [ExceptionType.NEEDS_REVIEW, ExceptionType.NEEDS_REVIEW]
    assert all("another unexplained line quotes the same reference" in f.evidence["summary"] for f in r.findings)


def test_a_line_with_no_candidate_is_still_surfaced():
    r = classify_with_review([O(1)], [clean_line(10, "ZZZ-999", gross=777_700)], [Bk(100)], {}, {10: 100})
    assert set(kinds(r)) == {ExceptionType.MISSING_SETTLEMENT, ExceptionType.NEEDS_REVIEW}
    review = next(f for f in r.findings if f.type == ExceptionType.NEEDS_REVIEW)
    assert review.order_id is None and review.evidence["candidates"] == []
    assert review.evidence["match_basis"] == "none"


def test_ambiguous_amount_candidates_are_all_listed():
    fee = expected_fee(ORDER_AMOUNT)
    line = LineFact(10, None, ORDER_AMOUNT, fee, ORDER_AMOUNT - fee, date(2026, 10, 2))
    r = classify_with_review([O(1), O(2)], [line], [Bk(100)], {}, {10: 100})
    assert kinds(r) == [ExceptionType.NEEDS_REVIEW]
    f = r.findings[0]
    assert f.order_id is None and len(f.evidence["candidates"]) == 2
    assert f.evidence["match_basis"] == "amount_and_date"


@pytest.fixture()
def session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


def review_rows(session):
    return session.scalars(
        select(ReconException).where(ReconException.type == ExceptionType.NEEDS_REVIEW)
    ).all()


def load_hostile(session, tmp_path):
    data = build_hostile()
    write_files(data, tmp_path)
    return data, run_pipeline(session, tmp_path)


def test_clean_data_has_no_review_items(session, tmp_path):
    write_files(generate(7), tmp_path)
    run_pipeline(session, tmp_path)
    assert review_rows(session) == []
    assert session.scalar(select(func.count()).select_from(ReconException)) == 44


def test_every_unexplained_line_has_exactly_one_review_item(session, tmp_path):
    _data, result = load_hostile(session, tmp_path)
    rows = review_rows(session)
    assert len(result.unclassified_settlement_ids) > 0
    assert len(rows) == len(result.unclassified_settlement_ids)
    assert {r.settlement_id for r in rows} == set(result.unclassified_settlement_ids)


def test_review_items_replace_the_false_missing_alarms(session, tmp_path):
    load_hostile(session, tmp_path)
    candidate_refs = set()
    for row in review_rows(session):
        candidate_refs |= {c["order_ref"] for c in json.loads(row.evidence)["candidates"]}
    missing_refs = set(
        session.scalars(
            select(Order.order_ref)
            .join(ReconException, ReconException.order_id == Order.id)
            .where(ReconException.type == ExceptionType.MISSING_SETTLEMENT)
        )
    )
    assert candidate_refs.isdisjoint(missing_refs)


def test_genuinely_missing_settlements_are_still_reported(session, tmp_path):
    load_hostile(session, tmp_path)
    count = session.scalar(
        select(func.count())
        .select_from(ReconException)
        .where(ReconException.type == ExceptionType.MISSING_SETTLEMENT)
    )
    assert count == PLANTED["missing_settlement"]


def test_review_items_point_at_the_right_orders(session, tmp_path):
    data, _result = load_hostile(session, tmp_path)
    covered = set()
    for row in review_rows(session):
        covered |= {c["order_ref"] for c in json.loads(row.evidence)["candidates"]}
    hostile = [
        e
        for e in data["answer_key"]["planted_exceptions"]
        if (e["order_ref"] or "").startswith("ORD-9")
    ]
    assert len(hostile) == 11  # 4 late + 4 wrong-amount + 3 double-mangled duplicates
    assert all(e["order_ref"] in covered for e in hostile)
