from collections import defaultdict

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.core.database import Base
from app.matching.classifier import normalize_ref
from app.models.tables import BankTransaction, Match, MatchTier, Order, Settlement
from app.services.hostile import HOSTILE_SEED, build_hostile
from app.services.scoring import found_from_db, score
from app.services.stress import run_pipeline
from app.services.synthetic import generate, write_files


@pytest.fixture()
def session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


def run_hostile(session, tmp_path):
    data = build_hostile()
    write_files(data, tmp_path)
    run_pipeline(session, tmp_path)
    return data


def test_hostile_data_is_deterministic():
    assert build_hostile() == build_hostile()


def test_hostile_answer_key_adds_fourteen_cases():
    baseline = generate(HOSTILE_SEED)["answer_key"]["total_planted"]
    key = build_hostile()["answer_key"]
    assert key["total_planted"] == len(key["planted_exceptions"]) == baseline + 14


def test_clean_exceptions_are_still_found_among_the_noise(session, tmp_path):
    run_hostile(session, tmp_path)
    baseline = generate(HOSTILE_SEED)["answer_key"]["planted_exceptions"]
    s = score(baseline, found_from_db(session))
    assert s.correct == len(baseline)
    assert s.wrong_amounts == []


def test_engine_never_makes_a_wrong_link(session, tmp_path):
    run_hostile(session, tmp_path)
    orders = {o.id: o for o in session.scalars(select(Order))}
    lines = {s.id: s for s in session.scalars(select(Settlement))}
    banks = {b.id: b for b in session.scalars(select(BankTransaction))}

    bank_sums = defaultdict(int)
    for m in session.scalars(select(Match)):
        if m.tier in (MatchTier.EXACT_REFERENCE, MatchTier.AMOUNT_DATE_WINDOW):
            quoted = normalize_ref(lines[m.settlement_id].order_ref)
            assert normalize_ref(orders[m.order_id].order_ref) == quoted
        elif m.tier == MatchTier.BATCH_MANY_TO_ONE:
            bank_sums[m.bank_txn_id] += lines[m.settlement_id].net_kobo

    for bank_id, total in bank_sums.items():
        assert banks[bank_id].amount_kobo == total
