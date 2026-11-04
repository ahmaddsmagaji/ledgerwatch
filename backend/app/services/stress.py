"""Stress test: runs the full pipeline on the hostile dataset and reports honestly.

Uses an in-memory database, so your real database is never touched.
"""

from collections import Counter

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.core.database import Base
from app.matching.batch import run_batch_matching
from app.matching.classifier import run_classification
from app.matching.engine import run_matching
from app.services.hostile import HOSTILE_DIR, build_hostile
from app.services.ingestion import ingest_all
from app.services.scoring import found_from_db, score
from app.services.synthetic import write_files


def run_pipeline(session: Session, directory):
    ingest_all(session, directory)
    run_matching(session)
    run_batch_matching(session)
    return run_classification(session)


def main() -> None:
    data = build_hostile()
    write_files(data, HOSTILE_DIR)
    key = data["answer_key"]

    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        result = run_pipeline(session, HOSTILE_DIR)
        found = found_from_db(session)

    s = score(key["planted_exceptions"], found)
    pct = 100 * s.correct / s.planted_total

    print("STRESS TEST on hostile data (in-memory database; your real database is untouched)")
    print(f"files written to: {HOSTILE_DIR}\n")
    print(f"SCORE: found {s.correct} of {s.planted_total} planted exceptions ({pct:.0f}%)")
    print(f"missed:                              {len(s.missed)}")
    print(f"false alarms (not in answer key):    {len(s.extra)}")
    print(f"findings reported twice:             {s.duplicate_findings}")
    print(f"amounts exact among those found:     {s.correct - len(s.wrong_amounts)} of {s.correct}")
    print(f"settlement lines with no explanation: {len(result.unclassified_settlement_ids)}")
    print(f"settlement lines with no bank link:   {len(result.settlement_ids_without_bank_link)}")

    print(f"\n{'type':<22}{'planted':>8}{'found':>7}")
    for kind in sorted(s.by_type):
        planted_n, found_n = s.by_type[kind]
        print(f"{kind:<22}{planted_n:>8}{found_n:>7}")

    print("\nMISSED, by type:")
    missed_types = Counter(e["type"] for e in s.missed)
    for kind in sorted(missed_types):
        sample = next(e for e in s.missed if e["type"] == kind)
        print(f"  {kind}: {missed_types[kind]}   e.g. {sample['note']}")

    print("\nFALSE ALARMS, by type:")
    for kind, count in sorted(Counter(e["type"] for e in s.extra).items()):
        print(f"  {kind}: {count}")

    print("\nHOSTILE CASES (what each one tests):")
    for case in key["hostile_cases"]:
        print(f"  {case['name']} ({case['count']}): {case['engine_limit']}")


if __name__ == "__main__":
    main()
