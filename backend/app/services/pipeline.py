"""Runs the whole pipeline on a folder of CSV files: load, match, link to the bank, classify."""

from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.matching.batch import run_batch_matching
from app.matching.classifier import run_classification
from app.matching.engine import run_matching
from app.models.tables import ReconException
from app.services.ingestion import DATA_DIR, clear_all_data, ingest_all

SAMPLE_DIR = DATA_DIR


def run_full_pipeline(session: Session, directory=SAMPLE_DIR, reset: bool = True) -> dict:
    """Load the three CSVs from a folder and run every stage. With reset=True,
    all existing data (including reviewer decisions) is deleted first."""
    if reset:
        clear_all_data(session)
    results = ingest_all(session, Path(directory))
    run_matching(session)
    run_batch_matching(session)
    classified = run_classification(session)
    return {
        "loaded": {r.source: r.loaded for r in results},
        "rejected_rows": {r.source: len(r.rejected) for r in results},
        "exceptions_found": session.scalar(select(func.count()).select_from(ReconException)),
        "lines_without_explanation": len(classified.unclassified_settlement_ids),
        "lines_without_bank_link": len(classified.settlement_ids_without_bank_link),
    }
