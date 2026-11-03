"""CSV ingestion: reads the three source files, validates every row, converts
naira to integer kobo with exact decimal math, and stores them in the database.

Bad rows are rejected and reported with a line number and reason. They are never
stored and never crash the run. A file that is missing, unreadable, or has the
wrong columns is rejected as a whole.
"""

import argparse
import csv
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.database import Base, SessionLocal, engine
from app.models.tables import (
    AuditLog,
    BankTransaction,
    Match,
    Order,
    ReconException,
    Settlement,
)

DATA_DIR = Path(__file__).resolve().parents[3] / "data" / "synthetic"

ORDER_COLUMNS = ["order_ref", "customer_name", "amount_ngn", "ordered_at"]
SETTLEMENT_COLUMNS = [
    "processor_ref", "order_ref", "batch_id",
    "gross_ngn", "fee_ngn", "net_ngn", "settled_date",
]
BANK_COLUMNS = ["bank_ref", "value_date", "narration", "credit_ngn"]


class IngestionError(Exception):
    """The whole file is unusable (missing, unreadable, or wrong columns)."""


@dataclass
class IngestResult:
    source: str
    loaded: int = 0
    rejected: list = field(default_factory=list)  # (line_number, reason)


# ---------- value parsers (each raises ValueError with a readable reason) ----------

def naira_to_kobo(text: str) -> int:
    """'1,500.50' -> 150050. Exact decimal math; never touches floats."""
    cleaned = (text or "").strip().replace(",", "")
    if not cleaned:
        raise ValueError("amount is empty")
    try:
        value = Decimal(cleaned)
    except InvalidOperation:
        raise ValueError(f"'{text}' is not a valid amount") from None
    if not value.is_finite():
        raise ValueError(f"'{text}' is not a valid amount")
    kobo = value * 100
    if kobo != kobo.to_integral_value():
        raise ValueError(f"'{text}' has more than 2 decimal places")
    return int(kobo)


def parse_date(text: str) -> date:
    try:
        return date.fromisoformat((text or "").strip())
    except ValueError:
        raise ValueError(f"'{text}' is not a valid date (expected YYYY-MM-DD)") from None


def parse_datetime(text: str) -> datetime:
    try:
        return datetime.strptime((text or "").strip(), "%Y-%m-%d %H:%M")
    except ValueError:
        raise ValueError(f"'{text}' is not a valid timestamp (expected YYYY-MM-DD HH:MM)") from None


def _text(row: dict, column: str, max_len: int, required: bool = True):
    value = (row.get(column) or "").strip()
    if not value:
        if required:
            raise ValueError(f"{column} is empty")
        return None
    if len(value) > max_len:
        raise ValueError(f"{column} is longer than {max_len} characters")
    return value


# ---------- row parsers (turn one CSV row into database fields) ----------

def _parse_order(row: dict) -> dict:
    amount = naira_to_kobo(row["amount_ngn"])
    if amount <= 0:
        raise ValueError("amount_ngn must be greater than zero")
    return {
        "order_ref": _text(row, "order_ref", 64),
        "customer_name": _text(row, "customer_name", 120),
        "amount_kobo": amount,
        "ordered_at": parse_datetime(row["ordered_at"]),
    }


def _parse_settlement(row: dict) -> dict:
    gross = naira_to_kobo(row["gross_ngn"])
    fee = naira_to_kobo(row["fee_ngn"])
    net = naira_to_kobo(row["net_ngn"])
    if gross <= 0:
        raise ValueError("gross_ngn must be greater than zero")
    if fee < 0 or net < 0:
        raise ValueError("fee_ngn and net_ngn cannot be negative")
    # Note: net != gross - fee is NOT rejected here. That is a finding for the
    # matching engine to report, so the data must be stored.
    return {
        "processor_ref": _text(row, "processor_ref", 64),
        "order_ref": _text(row, "order_ref", 64, required=False),
        "batch_id": _text(row, "batch_id", 64),
        "gross_kobo": gross,
        "fee_kobo": fee,
        "net_kobo": net,
        "settled_date": parse_date(row["settled_date"]),
    }


def _parse_bank(row: dict) -> dict:
    amount = naira_to_kobo(row["credit_ngn"])
    if amount <= 0:
        raise ValueError("credit_ngn must be greater than zero")
    return {
        "bank_ref": _text(row, "bank_ref", 64),
        "narration": _text(row, "narration", 255),
        "amount_kobo": amount,
        "value_date": parse_date(row["value_date"]),
    }


# ---------- the shared loader ----------

def _ingest(session: Session, path, source: str, model, key: str, required: list, parse_row) -> IngestResult:
    result = IngestResult(source=source)
    path = Path(path)
    if not path.is_file():
        raise IngestionError(f"{source}: file not found: {path}")
    try:
        with path.open(newline="", encoding="utf-8-sig") as handle:
            reader = csv.DictReader(handle)
            missing = [c for c in required if c not in (reader.fieldnames or [])]
            if missing:
                raise IngestionError(f"{source}: missing required columns: {', '.join(missing)}")
            seen = set(session.scalars(select(getattr(model, key))))
            for row in reader:
                line = reader.line_num
                try:
                    values = parse_row(row)
                    if values[key] in seen:
                        raise ValueError(f"duplicate {key} '{values[key]}'")
                except ValueError as exc:
                    result.rejected.append((line, str(exc)))
                    continue
                seen.add(values[key])
                session.add(model(**values))
                result.loaded += 1
        session.commit()
    except (UnicodeDecodeError, csv.Error) as exc:
        session.rollback()
        raise IngestionError(f"{source}: file could not be read as CSV: {exc}") from exc
    except IntegrityError as exc:
        session.rollback()
        raise IngestionError(f"{source}: database rejected the data: {exc.orig}") from exc
    except IngestionError:
        session.rollback()
        raise
    return result


def ingest_orders(session: Session, path) -> IngestResult:
    return _ingest(session, path, "orders", Order, "order_ref", ORDER_COLUMNS, _parse_order)


def ingest_settlements(session: Session, path) -> IngestResult:
    return _ingest(session, path, "settlements", Settlement, "processor_ref", SETTLEMENT_COLUMNS, _parse_settlement)


def ingest_bank_transactions(session: Session, path) -> IngestResult:
    return _ingest(session, path, "bank_transactions", BankTransaction, "bank_ref", BANK_COLUMNS, _parse_bank)


def ingest_all(session: Session, directory=DATA_DIR) -> list:
    directory = Path(directory)
    return [
        ingest_orders(session, directory / "orders.csv"),
        ingest_settlements(session, directory / "settlements.csv"),
        ingest_bank_transactions(session, directory / "bank_statement.csv"),
    ]


def clear_all_data(session: Session) -> None:
    """Delete every row, children first. For demo/dev use only."""
    for model in (AuditLog, ReconException, Match, BankTransaction, Settlement, Order):
        session.execute(delete(model))
    session.commit()


def main() -> None:
    parser = argparse.ArgumentParser(description="Load the three CSV files into the database.")
    parser.add_argument("--dir", default=str(DATA_DIR), help="folder containing the CSV files")
    parser.add_argument("--reset", action="store_true", help="delete all existing rows first")
    args = parser.parse_args()

    Base.metadata.create_all(bind=engine)
    with SessionLocal() as session:
        if args.reset:
            clear_all_data(session)
        try:
            results = ingest_all(session, args.dir)
        except IngestionError as exc:
            print(f"INGESTION FAILED: {exc}")
            raise SystemExit(1)

    for r in results:
        print(f"{r.source}: loaded {r.loaded}, rejected {len(r.rejected)}")
        for line, reason in r.rejected[:5]:
            print(f"    line {line}: {reason}")


if __name__ == "__main__":
    main()
