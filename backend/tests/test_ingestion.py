import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from app.core.database import Base
from app.models.tables import BankTransaction, Order, Settlement
from app.services.ingestion import (
    IngestionError,
    ingest_all,
    ingest_orders,
    naira_to_kobo,
)
from app.services.synthetic import generate, write_files


@pytest.fixture()
def session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


@pytest.mark.parametrize(
    "text,expected",
    [
        ("10000.00", 1_000_000),
        ("1,500.5", 150_050),
        ("0.07", 7),
        ("0.10", 10),
        ("1234567.89", 123_456_789),
        ("7", 700),
        ("-5.00", -500),
    ],
)
def test_naira_to_kobo_is_exact(text, expected):
    assert naira_to_kobo(text) == expected


@pytest.mark.parametrize("text", ["", "abc", "19.999", "NaN", "Infinity"])
def test_naira_to_kobo_rejects_bad_input(text):
    with pytest.raises(ValueError):
        naira_to_kobo(text)


def test_orders_good_and_bad_rows(session, tmp_path):
    f = tmp_path / "orders.csv"
    f.write_text(
        "order_ref,customer_name,amount_ngn,ordered_at\n"
        'ORD-1,Ada,"1,000.50",2026-10-01 10:00\n'
        "ORD-2,Bola,abc,2026-10-01 11:00\n"
        "ORD-1,Chidi,5.00,2026-10-01 12:00\n"
        "ORD-3,Dayo,-5.00,2026-10-01 13:00\n"
        "ORD-4,Efe,5.001,2026-10-01 14:00\n"
        "ORD-5,Femi,10.00,not-a-date\n"
    )
    result = ingest_orders(session, f)
    assert result.loaded == 1
    assert len(result.rejected) == 5
    assert result.rejected[0][0] == 3  # line 3 of the file: the 'abc' amount
    assert session.scalars(select(Order.amount_kobo)).all() == [100_050]


def test_missing_columns_reject_whole_file(session, tmp_path):
    f = tmp_path / "orders.csv"
    f.write_text("order_ref,amount_ngn\nORD-1,5.00\n")
    with pytest.raises(IngestionError, match="customer_name"):
        ingest_orders(session, f)
    assert session.scalar(select(func.count()).select_from(Order)) == 0


def test_missing_file_is_a_clear_error(session, tmp_path):
    with pytest.raises(IngestionError, match="file not found"):
        ingest_orders(session, tmp_path / "nope.csv")


def test_full_synthetic_dataset_round_trips_exactly(session, tmp_path):
    data = generate(7)
    write_files(data, tmp_path)
    results = ingest_all(session, tmp_path)

    assert all(not r.rejected for r in results)
    assert [r.loaded for r in results] == [
        len(data["orders"]),
        len(data["settlements"]),
        len(data["bank"]),
    ]
    assert session.scalar(select(func.sum(Order.amount_kobo))) == sum(
        o["amount_kobo"] for o in data["orders"]
    )
    assert session.scalar(select(func.sum(Settlement.net_kobo))) == sum(
        s["net_kobo"] for s in data["settlements"]
    )
    assert session.scalar(select(func.sum(BankTransaction.amount_kobo))) == sum(
        b["amount_kobo"] for b in data["bank"]
    )
