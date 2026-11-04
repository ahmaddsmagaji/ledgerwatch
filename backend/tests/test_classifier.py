from datetime import date

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from app.core.database import Base
from app.matching.batch import run_batch_matching
from app.matching.classifier import (
    BankFact,
    LineFact,
    OrderFact,
    classify,
    expected_fee,
    run_classification,
)
from app.matching.engine import run_matching
from app.models.tables import (
    AuditLog,
    BankTransaction,
    ExceptionStatus,
    ExceptionType,
    Order,
    ReconException,
)
from app.services.ingestion import ingest_all
from app.services.synthetic import generate, write_files

ORDER_AMOUNT = 1_000_000  # NGN 10,000.00 in kobo; the rate card fee on it is 15,000


def O(i, amount=ORDER_AMOUNT, day=1):
    return OrderFact(i, f"ORD-{i}", amount, date(2026, 10, day))


def S(i, ref, gross, fee, net, day=2):
    return LineFact(i, ref, gross, fee, net, date(2026, 10, day))


def clean_line(i, ref, gross=ORDER_AMOUNT, day=2):
    fee = expected_fee(gross)
    return S(i, ref, gross, fee, gross - fee, day)


def Bk(i, amount=5_000):
    return BankFact(i, f"BNK-{i}", amount, "TEST NARRATION")


def kinds(result):
    return [f.type for f in result.findings]


def test_rate_card():
    assert expected_fee(1_000_000) == 15_000
    assert expected_fee(20_000_000) == 200_000  # capped at NGN 2,000
    assert expected_fee(333) == 5


def test_clean_pair_has_no_findings():
    r = classify([O(1)], [clean_line(10, "ORD-1")], [Bk(100)], {10: 1}, {10: 100})
    assert r.findings == []
    assert r.unclassified_settlement_ids == []
    assert r.settlement_ids_without_bank_link == []


def test_missing_settlement():
    r = classify([O(1), O(2)], [clean_line(10, "ORD-1")], [Bk(100)], {10: 1}, {10: 100})
    assert kinds(r) == [ExceptionType.MISSING_SETTLEMENT]
    assert r.findings[0].order_id == 2
    assert r.findings[0].amount_at_risk_kobo == ORDER_AMOUNT


def test_amount_mismatch():
    line = clean_line(10, "ORD-1", gross=ORDER_AMOUNT + 5_000)
    r = classify([O(1)], [line], [Bk(100)], {10: 1}, {10: 100})
    assert kinds(r) == [ExceptionType.AMOUNT_MISMATCH]
    assert r.findings[0].amount_at_risk_kobo == 5_000


def test_fee_discrepancy():
    line = S(10, "ORD-1", ORDER_AMOUNT, 35_000, ORDER_AMOUNT - 35_000)
    r = classify([O(1)], [line], [Bk(100)], {10: 1}, {10: 100})
    assert kinds(r) == [ExceptionType.FEE_DISCREPANCY]
    assert r.findings[0].amount_at_risk_kobo == 20_000


def test_capped_fee_is_not_flagged():
    big = 20_000_000
    r = classify([O(1, amount=big)], [clean_line(10, "ORD-1", gross=big)], [Bk(100)], {10: 1}, {10: 100})
    assert r.findings == []


def test_net_that_does_not_add_up_is_flagged():
    line = S(10, "ORD-1", ORDER_AMOUNT, 15_000, 980_000)  # should be 985,000
    r = classify([O(1)], [line], [Bk(100)], {10: 1}, {10: 100})
    assert kinds(r) == [ExceptionType.FEE_DISCREPANCY]
    assert r.findings[0].amount_at_risk_kobo == 5_000


@pytest.mark.parametrize("lag,flagged", [(0, False), (3, False), (4, True), (-1, True)])
def test_timing_break_threshold(lag, flagged):
    line = clean_line(10, "ORD-1", day=10 + lag)
    r = classify([O(1, day=10)], [line], [Bk(100)], {10: 1}, {10: 100})
    assert (kinds(r) == [ExceptionType.TIMING_BREAK]) is flagged


def test_exact_duplicate():
    lines = [clean_line(10, "ORD-1"), clean_line(11, "ORD-1")]
    r = classify([O(1)], lines, [Bk(100)], {10: 1}, {10: 100, 11: 100})
    assert kinds(r) == [ExceptionType.DUPLICATE]
    assert r.findings[0].order_id == 1 and r.findings[0].settlement_id == 11
    assert r.findings[0].amount_at_risk_kobo == lines[1].net_kobo


def test_duplicate_with_mangled_reference_is_still_recognised():
    lines = [clean_line(10, "ORD-1"), clean_line(11, "ord 1")]
    r = classify([O(1)], lines, [Bk(100)], {10: 1}, {10: 100, 11: 100})
    assert kinds(r) == [ExceptionType.DUPLICATE]


def test_unexplained_line_is_reported_not_hidden():
    lines = [clean_line(10, "ORD-1"), clean_line(11, "ZZZ-999")]
    r = classify([O(1)], lines, [Bk(100)], {10: 1}, {10: 100, 11: 100})
    assert r.findings == []
    assert r.unclassified_settlement_ids == [11]


def test_orphan_bank_credit():
    r = classify([O(1)], [clean_line(10, "ORD-1")], [Bk(100), Bk(101, 7_000)], {10: 1}, {10: 100})
    assert kinds(r) == [ExceptionType.ORPHAN_BANK_CREDIT]
    assert r.findings[0].bank_txn_id == 101
    assert r.findings[0].amount_at_risk_kobo == 7_000


def test_line_without_bank_link_is_counted():
    r = classify([O(1)], [clean_line(10, "ORD-1")], [], {10: 1}, {})
    assert r.settlement_ids_without_bank_link == [10]


def test_one_pair_can_have_several_exceptions():
    line = clean_line(10, "ORD-1", gross=ORDER_AMOUNT + 10_000, day=11)
    r = classify([O(1, day=1)], [line], [Bk(100)], {10: 1}, {10: 100})
    assert kinds(r) == [ExceptionType.AMOUNT_MISMATCH, ExceptionType.TIMING_BREAK]


@pytest.fixture()
def session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


def load_everything(session, tmp_path):
    data = generate(7)
    write_files(data, tmp_path)
    ingest_all(session, tmp_path)
    run_matching(session)
    run_batch_matching(session)
    return data


def test_classifier_matches_the_answer_key(session, tmp_path):
    data = load_everything(session, tmp_path)
    result = run_classification(session)
    assert result.unclassified_settlement_ids == []
    assert result.settlement_ids_without_bank_link == []

    order_ref = {o.id: o.order_ref for o in session.scalars(select(Order))}
    bank_ref = {b.id: b.bank_ref for b in session.scalars(select(BankTransaction))}

    def key(kind, o_ref, b_ref):
        return (kind, o_ref, b_ref if kind == "orphan_bank_credit" else None)

    stored = session.scalars(select(ReconException)).all()
    found = {
        key(e.type.value, order_ref.get(e.order_id), bank_ref.get(e.bank_txn_id)): e.amount_at_risk_kobo
        for e in stored
    }
    planted = data["answer_key"]["planted_exceptions"]
    expected = {
        key(p["type"], p["order_ref"], p["bank_ref"]): p["amount_at_risk_kobo"] for p in planted
    }
    assert len(stored) == len(planted)  # no extras, no collisions
    assert found == expected  # same exceptions, same amounts, to the kobo


def test_rerun_is_idempotent_and_keeps_human_decisions(session, tmp_path):
    load_everything(session, tmp_path)
    run_classification(session)
    count = session.scalar(select(func.count()).select_from(ReconException))

    first = session.scalars(select(ReconException).order_by(ReconException.id)).first()
    first_id = first.id
    first.status = ExceptionStatus.RESOLVED
    session.add(AuditLog(exception_id=first_id, action="resolved", actor="tester", note="checked"))
    session.commit()

    run_classification(session)
    assert session.scalar(select(func.count()).select_from(ReconException)) == count
    assert session.get(ReconException, first_id).status == ExceptionStatus.RESOLVED
