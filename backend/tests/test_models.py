from datetime import datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.database import Base
from app.models.tables import Order


@pytest.fixture()
def session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


def make_order(ref="ORD-1", amount=100_00):
    return Order(
        order_ref=ref,
        customer_name="Test Customer",
        amount_kobo=amount,
        ordered_at=datetime(2026, 1, 1, 10, 0),
    )


def test_valid_order_saves(session):
    session.add(make_order())
    session.commit()
    assert session.query(Order).count() == 1


def test_negative_amount_is_rejected(session):
    session.add(make_order(amount=-500))
    with pytest.raises(IntegrityError):
        session.commit()


def test_duplicate_order_ref_is_rejected(session):
    session.add(make_order(ref="ORD-1"))
    session.commit()
    session.add(make_order(ref="ORD-1"))
    with pytest.raises(IntegrityError):
        session.commit()