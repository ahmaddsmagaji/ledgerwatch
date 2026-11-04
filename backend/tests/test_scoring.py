import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.core.database import Base
from app.matching.batch import run_batch_matching
from app.matching.classifier import run_classification
from app.matching.engine import run_matching
from app.models.tables import ReconException
from app.services.ingestion import ingest_all
from app.services.scoring import found_from_db, score
from app.services.synthetic import generate, write_files


def P(kind, order_ref=None, bank_ref=None, amount=100):
    return {
        "type": kind,
        "order_ref": order_ref,
        "bank_ref": bank_ref,
        "amount_at_risk_kobo": amount,
        "note": "test entry",
    }


def test_perfect_score():
    planted = [P("missing_settlement", "ORD-1"), P("orphan_bank_credit", None, "BNK-1")]
    s = score(planted, [dict(e) for e in planted])
    assert s.perfect and s.correct == 2
    assert s.by_type == {"missing_settlement": [1, 1], "orphan_bank_credit": [1, 1]}


def test_missed_exception_is_reported():
    planted = [P("missing_settlement", "ORD-1"), P("duplicate", "ORD-2")]
    s = score(planted, [P("missing_settlement", "ORD-1")])
    assert not s.perfect and s.correct == 1
    assert [e["order_ref"] for e in s.missed] == ["ORD-2"]
    assert s.by_type["duplicate"] == [1, 0]


def test_extra_exception_is_reported():
    s = score(
        [P("missing_settlement", "ORD-1")],
        [P("missing_settlement", "ORD-1"), P("fee_discrepancy", "ORD-9")],
    )
    assert not s.perfect
    assert [e["order_ref"] for e in s.extra] == ["ORD-9"]


def test_wrong_type_counts_as_a_miss_and_an_extra():
    s = score([P("fee_discrepancy", "ORD-1")], [P("amount_mismatch", "ORD-1")])
    assert s.correct == 0 and len(s.missed) == 1 and len(s.extra) == 1


def test_wrong_amount_is_reported():
    s = score([P("fee_discrepancy", "ORD-1", amount=100)], [P("fee_discrepancy", "ORD-1", amount=101)])
    assert s.correct == 1 and not s.perfect
    assert s.wrong_amounts == [(("fee_discrepancy", "ORD-1", None), 100, 101)]


def test_orphans_are_told_apart_by_bank_reference():
    planted = [P("orphan_bank_credit", None, "BNK-1"), P("orphan_bank_credit", None, "BNK-2")]
    s = score(planted, [P("orphan_bank_credit", None, "BNK-1")])
    assert s.correct == 1 and s.missed[0]["bank_ref"] == "BNK-2"


def test_ambiguous_answer_key_is_rejected():
    with pytest.raises(ValueError):
        score([P("duplicate", "ORD-1"), P("duplicate", "ORD-1")], [])


def test_repeated_findings_are_not_perfect():
    s = score(
        [P("missing_settlement", "ORD-1")],
        [P("missing_settlement", "ORD-1"), P("missing_settlement", "ORD-1")],
    )
    assert s.duplicate_findings == 1 and not s.perfect


@pytest.fixture()
def session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


def run_pipeline(session, tmp_path):
    data = generate(7)
    write_files(data, tmp_path)
    ingest_all(session, tmp_path)
    run_matching(session)
    run_batch_matching(session)
    run_classification(session)
    return data["answer_key"]["planted_exceptions"]


def test_full_pipeline_scores_perfectly(session, tmp_path):
    planted = run_pipeline(session, tmp_path)
    s = score(planted, found_from_db(session))
    assert s.perfect
    assert s.correct == s.planted_total == 44


def test_scorer_can_fail(session, tmp_path):
    planted = run_pipeline(session, tmp_path)
    victim = session.scalars(select(ReconException).order_by(ReconException.id)).first()
    session.delete(victim)
    session.commit()
    s = score(planted, found_from_db(session))
    assert not s.perfect and s.correct == 43 and len(s.missed) == 1
