from datetime import date

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from app.core.database import Base
from app.matching.batch import (
    BankRec,
    BatchPair,
    LineRec,
    match_batches_to_bank,
    run_batch_matching,
)
from app.matching.engine import run_matching
from app.models.tables import BankTransaction, Match
from app.services.ingestion import ingest_all
from app.services.synthetic import generate, write_files


def L(i, batch, net, day):
    return LineRec(i, batch, net, date(2026, 10, day))


def B(i, amount, day):
    return BankRec(i, amount, date(2026, 10, day))


def test_many_lines_match_one_bank_credit():
    lines = [L(1, "B1", 300, 5), L(2, "B1", 500, 5), L(3, "B1", 200, 5)]
    r = match_batches_to_bank(lines, [B(10, 1000, 6)])
    assert r.pairs == [BatchPair("B1", 10, (1, 2, 3))]
    assert r.unmatched_batch_ids == [] and r.unmatched_bank_ids == []


def test_one_kobo_difference_is_not_matched():
    r = match_batches_to_bank([L(1, "B1", 1000, 5)], [B(10, 1001, 6)])
    assert r.pairs == []
    assert r.unmatched_batch_ids == ["B1"]
    assert r.unmatched_bank_ids == [10]


def test_bank_credit_outside_window_is_not_matched():
    r = match_batches_to_bank([L(1, "B1", 1000, 5)], [B(10, 1000, 20)])
    assert r.pairs == []
    assert r.unmatched_batch_ids == ["B1"]


def test_bank_credit_before_settlement_is_not_matched():
    r = match_batches_to_bank([L(1, "B1", 1000, 5)], [B(10, 1000, 4)])
    assert r.pairs == []


def test_ambiguous_batches_are_not_guessed():
    lines = [L(1, "B1", 1000, 5), L(2, "B2", 1000, 5)]
    r = match_batches_to_bank(lines, [B(10, 1000, 6)])
    assert r.pairs == []
    assert r.ambiguous_batch_ids == ["B1", "B2"]
    assert r.unmatched_bank_ids == [10]


def test_unrelated_bank_credit_stays_unmatched():
    r = match_batches_to_bank([L(1, "B1", 1000, 5)], [B(10, 1000, 6), B(11, 777, 3)])
    assert r.pairs == [BatchPair("B1", 10, (1,))]
    assert r.unmatched_bank_ids == [11]


def test_batches_are_matched_independently():
    lines = [L(1, "B1", 1000, 5), L(2, "B2", 2000, 6)]
    r = match_batches_to_bank(lines, [B(10, 1000, 6), B(11, 2000, 7)])
    assert r.pairs == [BatchPair("B1", 10, (1,)), BatchPair("B2", 11, (2,))]


@pytest.fixture()
def session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


def test_batch_matching_on_synthetic_data(session, tmp_path):
    data = generate(7)
    write_files(data, tmp_path)
    ingest_all(session, tmp_path)
    result = run_batch_matching(session)

    n_batches = len({s["batch_id"] for s in data["settlements"]})
    assert len(result.pairs) == n_batches
    assert result.ambiguous_batch_ids == [] and result.unmatched_batch_ids == []

    # Every settlement line is linked to exactly one bank credit.
    assert session.scalar(select(func.count()).select_from(Match)) == len(data["settlements"])

    # The credits left over are exactly the planted orphans (the test may read the key; the engine may not).
    ref_of = {b.id: b.bank_ref for b in session.scalars(select(BankTransaction))}
    orphans = {
        e["bank_ref"]
        for e in data["answer_key"]["planted_exceptions"]
        if e["type"] == "orphan_bank_credit"
    }
    assert {ref_of[i] for i in result.unmatched_bank_ids} == orphans


def test_rerun_is_idempotent_and_coexists_with_tiers_1_and_2(session, tmp_path):
    write_files(generate(7), tmp_path)
    ingest_all(session, tmp_path)
    run_matching(session)
    run_batch_matching(session)
    total = session.scalar(select(func.count()).select_from(Match))
    run_batch_matching(session)
    run_matching(session)
    assert session.scalar(select(func.count()).select_from(Match)) == total
