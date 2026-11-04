"""Scoring: compares what the engine found against the planted answer key.

This is the ONLY module that reads answer_key.json. The matching engine and
the classifier never see it.
"""

import argparse
import json
from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import Base, SessionLocal, engine
from app.matching.classifier import naira
from app.models.tables import BankTransaction, Order, ReconException

ANSWER_KEY_PATH = Path(__file__).resolve().parents[3] / "data" / "synthetic" / "answer_key.json"


def load_answer_key(path=ANSWER_KEY_PATH) -> dict:
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(f"answer key not found: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def _key(entry: dict) -> tuple:
    kind = entry["type"]
    bank = entry.get("bank_ref") if kind == "orphan_bank_credit" else None
    return (kind, entry.get("order_ref"), bank)


@dataclass
class Score:
    planted_total: int
    found_total: int
    correct: int
    missed: list = field(default_factory=list)          # planted entries the engine did not find
    extra: list = field(default_factory=list)           # findings that were not planted
    wrong_amounts: list = field(default_factory=list)   # (key, planted_kobo, found_kobo)
    by_type: dict = field(default_factory=dict)         # type -> [planted, correct]
    duplicate_findings: int = 0                         # the same finding reported more than once

    @property
    def perfect(self) -> bool:
        return (
            not self.missed
            and not self.extra
            and not self.wrong_amounts
            and self.duplicate_findings == 0
        )


def score(planted: list, found: list) -> Score:
    """Pure function: answer key entries and engine findings in, score out."""
    planted_by_key = {_key(e): e for e in planted}
    if len(planted_by_key) != len(planted):
        raise ValueError("answer key has entries that cannot be told apart")
    found_by_key = {_key(e): e for e in found}

    hits = planted_by_key.keys() & found_by_key.keys()
    result = Score(
        planted_total=len(planted),
        found_total=len(found),
        correct=len(hits),
        duplicate_findings=len(found) - len(found_by_key),
    )
    result.missed = sorted(
        (planted_by_key[k] for k in planted_by_key.keys() - hits), key=lambda e: str(_key(e))
    )
    result.extra = sorted(
        (found_by_key[k] for k in found_by_key.keys() - hits), key=lambda e: str(_key(e))
    )
    for k in sorted(hits, key=str):
        want = planted_by_key[k]["amount_at_risk_kobo"]
        got = found_by_key[k]["amount_at_risk_kobo"]
        if want != got:
            result.wrong_amounts.append((k, want, got))
    for entry in planted:
        counts = result.by_type.setdefault(entry["type"], [0, 0])
        counts[0] += 1
        if _key(entry) in hits:
            counts[1] += 1
    return result


def found_from_db(session: Session) -> list:
    """The engine's findings, in the same shape as the answer key entries."""
    order_ref = {o.id: o.order_ref for o in session.scalars(select(Order))}
    bank_ref = {b.id: b.bank_ref for b in session.scalars(select(BankTransaction))}
    return [
        {
            "type": e.type.value,
            "order_ref": order_ref.get(e.order_id),
            "bank_ref": bank_ref.get(e.bank_txn_id),
            "amount_at_risk_kobo": e.amount_at_risk_kobo,
        }
        for e in session.scalars(select(ReconException))
    ]


def main() -> None:
    parser = argparse.ArgumentParser(description="Score the engine's findings against the answer key.")
    parser.add_argument("--key", default=str(ANSWER_KEY_PATH), help="path to answer_key.json")
    args = parser.parse_args()

    Base.metadata.create_all(bind=engine)
    key = load_answer_key(args.key)
    planted = key["planted_exceptions"]

    with SessionLocal() as session:
        known_orders = set(session.scalars(select(Order.order_ref)))
        absent = sorted({e["order_ref"] for e in planted if e["order_ref"]} - known_orders)
        if absent:
            print("DATASET MISMATCH: the database does not contain the orders the answer key refers to.")
            print(f"  e.g. {', '.join(absent[:3])}")
            print("  Re-run ingestion with --reset, then matching, batch matching, and the classifier.")
            raise SystemExit(2)
        found = found_from_db(session)

    s = score(planted, found)
    notes = {_key(e): e.get("note", "") for e in planted}

    print(f"SCORE: found {s.correct} of {s.planted_total} planted exceptions")
    print(f"findings not in the answer key:   {len(s.extra)}")
    print(f"findings reported twice:          {s.duplicate_findings}")
    print(f"amounts exact (to the kobo):      {s.correct - len(s.wrong_amounts)} of {s.correct}")
    print()
    print(f"{'type':<22}{'planted':>8}{'found':>7}")
    for kind in sorted(s.by_type):
        planted_n, found_n = s.by_type[kind]
        print(f"{kind:<22}{planted_n:>8}{found_n:>7}")

    if s.missed:
        print("\nMISSED:")
        for e in s.missed[:10]:
            print(f"  {e['type']} {e.get('order_ref') or e.get('bank_ref')}: {notes[_key(e)]}")
    if s.extra:
        print("\nNOT IN THE ANSWER KEY (false alarms):")
        for e in s.extra[:10]:
            print(f"  {e['type']} {e.get('order_ref') or e.get('bank_ref')}")
    if s.wrong_amounts:
        print("\nAMOUNT DIFFERS:")
        for k, want, got in s.wrong_amounts[:10]:
            print(f"  {k[0]} {k[1] or k[2]}: planted {naira(want)}, found {naira(got)}")
    if s.found_total == 0:
        print("\nNo exceptions in the database. Run: python -m app.matching.classifier")

    print("\nVERDICT:", "PASS" if s.perfect else "FAIL")
    raise SystemExit(0 if s.perfect else 1)


if __name__ == "__main__":
    main()
