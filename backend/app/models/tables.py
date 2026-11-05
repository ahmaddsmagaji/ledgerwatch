import enum
from datetime import date, datetime, timezone

from sqlalchemy import CheckConstraint, Enum, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class ExceptionType(str, enum.Enum):
    MISSING_SETTLEMENT = "missing_settlement"
    AMOUNT_MISMATCH = "amount_mismatch"
    DUPLICATE = "duplicate"
    FEE_DISCREPANCY = "fee_discrepancy"
    TIMING_BREAK = "timing_break"
    ORPHAN_BANK_CREDIT = "orphan_bank_credit"
    NEEDS_REVIEW = "needs_review"


class ExceptionStatus(str, enum.Enum):
    OPEN = "open"
    ESCALATED = "escalated"
    RESOLVED = "resolved"


class MatchTier(str, enum.Enum):
    EXACT_REFERENCE = "exact_reference"
    AMOUNT_DATE_WINDOW = "amount_date_window"
    FEE_ADJUSTED = "fee_adjusted"
    BATCH_MANY_TO_ONE = "batch_many_to_one"


def _enum(enum_class):
    # Store the readable value (e.g. "missing_settlement") and enforce it in the database
    return Enum(
        enum_class,
        native_enum=False,
        values_callable=lambda e: [member.value for member in e],
    )


class Order(Base):
    """What the business says customers should have paid."""

    __tablename__ = "orders"
    __table_args__ = (
        CheckConstraint("amount_kobo > 0", name="ck_orders_amount_positive"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    order_ref: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    customer_name: Mapped[str] = mapped_column(String(120))
    amount_kobo: Mapped[int]
    ordered_at: Mapped[datetime]


class Settlement(Base):
    """One line of the payment processor's settlement report."""

    __tablename__ = "settlements"
    # Note: no check that net = gross - fee. Bad arithmetic from a processor is
    # something we must detect and report, so the database must be able to store it.
    __table_args__ = (
        CheckConstraint("gross_kobo > 0", name="ck_settlements_gross_positive"),
        CheckConstraint("fee_kobo >= 0", name="ck_settlements_fee_nonnegative"),
        CheckConstraint("net_kobo >= 0", name="ck_settlements_net_nonnegative"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    processor_ref: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    order_ref: Mapped[str | None] = mapped_column(String(64), index=True)
    batch_id: Mapped[str] = mapped_column(String(64), index=True)
    gross_kobo: Mapped[int]
    fee_kobo: Mapped[int]
    net_kobo: Mapped[int]
    settled_date: Mapped[date]


class BankTransaction(Base):
    """One credit line from the bank statement."""

    __tablename__ = "bank_transactions"
    __table_args__ = (
        CheckConstraint("amount_kobo > 0", name="ck_bank_amount_positive"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    bank_ref: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    narration: Mapped[str] = mapped_column(String(255))
    amount_kobo: Mapped[int]
    value_date: Mapped[date]


class Match(Base):
    """A link between records that the engine decided belong together."""

    __tablename__ = "matches"
    __table_args__ = (
        CheckConstraint(
            "order_id IS NOT NULL OR settlement_id IS NOT NULL OR bank_txn_id IS NOT NULL",
            name="ck_matches_has_a_record",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    tier: Mapped[MatchTier] = mapped_column(_enum(MatchTier))
    order_id: Mapped[int | None] = mapped_column(ForeignKey("orders.id"))
    settlement_id: Mapped[int | None] = mapped_column(ForeignKey("settlements.id"))
    bank_txn_id: Mapped[int | None] = mapped_column(ForeignKey("bank_transactions.id"))
    created_at: Mapped[datetime] = mapped_column(default=utcnow)


class ReconException(Base):
    """A discrepancy a human needs to review."""

    __tablename__ = "exceptions"
    __table_args__ = (
        CheckConstraint("amount_at_risk_kobo >= 0", name="ck_exceptions_amount_nonneg"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    type: Mapped[ExceptionType] = mapped_column(_enum(ExceptionType), index=True)
    status: Mapped[ExceptionStatus] = mapped_column(
        _enum(ExceptionStatus), default=ExceptionStatus.OPEN, index=True
    )
    order_id: Mapped[int | None] = mapped_column(ForeignKey("orders.id"))
    settlement_id: Mapped[int | None] = mapped_column(ForeignKey("settlements.id"))
    bank_txn_id: Mapped[int | None] = mapped_column(ForeignKey("bank_transactions.id"))
    amount_at_risk_kobo: Mapped[int]
    evidence: Mapped[str] = mapped_column(Text)  # JSON text: the facts behind the finding
    ai_explanation: Mapped[str | None] = mapped_column(Text)  # filled in later; may stay empty
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    resolved_at: Mapped[datetime | None]


class AuditLog(Base):
    """Append-only record of every human action on an exception."""

    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    exception_id: Mapped[int] = mapped_column(ForeignKey("exceptions.id"), index=True)
    action: Mapped[str] = mapped_column(String(40))
    actor: Mapped[str] = mapped_column(String(80))
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)