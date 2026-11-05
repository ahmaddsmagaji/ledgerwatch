"""Stress test: runs the full pipeline on the hostile dataset and reports honestly.

Uses an in-memory database, so your real database is never touched.
"""

import json
from collections import Counter

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.core.database import Base
from app.matching.batch import run_batch_matching
from app.matching.classifier import run_classification
from app.matching.engine import run_matching
from app.models.tables import ExceptionType, ReconException
from app.services.hostile import HOSTILE_DIR, build_hostile
from app.services.ingestion import ingest_all
from app.services.scoring import found_from_db, score
from app.services.synthetic import write_files


def run_pipeline(session: Session, directory):
    ingest_all(session, directory)
    run_matching(session)
    run_batch_matching(session)
    return run_classification(session)


def review_item_refs(session: Session) -> list:
    """For each needs-review item, the set of order references it lists as candidates."""
    rows = session.scalars(
        select(ReconException).where(ReconException.type == ExceptionType.NEEDS_REVIEW)
    ).all()
    return [{c["order_ref"] for c in json.loads(r.evidence).get("candidates", [])} for r in rows]


def main() -> None:
    data = build_hostile()
    write_files(data, HOSTILE_DIR)
    key = data["answer_key"]

    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        result = run_pipeline(session, HOSTILE_DIR)
        found_all = found_from_db(session)
        review = review_item_refs(session)

    # Review items are not classifications, so they are scored separately.
    classified = [f for f in found_all if f["type"] != "needs_review"]
    s = score(key["planted_exceptions"], classified)
    pct = 100 * s.correct / s.planted_total

    covered = set().union(*review) if review else set()
    surfaced = [e for e in s.missed if e.get("order_ref") in covered]
    not_surfaced = [e for e in s.missed if e.get("order_ref") not in covered]
    planted_refs = {e["order_ref"] for e in key["planted_exceptions"] if e["order_ref"]}
    harmless = sum(1 for refs in review if not (refs & planted_refs))

    print("STRESS TEST on hostile data (in-memory database; your real database is untouched)")
    print(f"files written to: {HOSTILE_DIR}\n")
    print(f"CLASSIFIED CORRECTLY: found {s.correct} of {s.planted_total} planted exceptions ({pct:.0f}%)")
    print(f"missed by the classifier:               {len(s.missed)}")
    print(f"  sent to the review queue:             {len(surfaced)}   (a person sees them, with the likely order)")
    print(f"  not surfaced anywhere:                {len(not_surfaced)}")
    print(f"false alarms among classified findings: {len(s.extra)}")
    print(f"review items raised:                    {len(review)}")
    print(f"  where nothing was wrong:              {harmless}   (a person clears these)")
    print(f"findings reported twice:                {s.duplicate_findings}")
    print(f"amounts exact among those found:        {s.correct - len(s.wrong_amounts)} of {s.correct}")
    print(f"settlement lines with no bank link:     {len(result.settlement_ids_without_bank_link)}   (not yet surfaced)")

    print(f"\n{'type':<22}{'planted':>8}{'found':>7}")
    for kind in sorted(s.by_type):
        planted_n, found_n = s.by_type[kind]
        print(f"{kind:<22}{planted_n:>8}{found_n:>7}")

    if not_surfaced:
        print("\nNOT SURFACED ANYWHERE:")
        for e in not_surfaced:
            print(f"  {e['type']}: {e['note']}")

    print("\nFALSE ALARMS, by type:")
    for kind, count in sorted(Counter(e["type"] for e in s.extra).items()):
        print(f"  {kind}: {count}")

    print("\nHOSTILE CASES (what each one tests):")
    for case in key["hostile_cases"]:
        print(f"  {case['name']} ({case['count']}): {case['engine_limit']}")


if __name__ == "__main__":
    main()
