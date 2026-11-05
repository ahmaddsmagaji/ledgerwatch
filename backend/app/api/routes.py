from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.api.schemas import ActionRequest, LoadSampleRequest
from app.services.ingestion import IngestionError
from app.services.pipeline import SAMPLE_DIR, run_full_pipeline
from app.services.review import apply_action, get_detail, get_summary, list_exceptions

router = APIRouter()


@router.get("/health")
def health():
    return {"status": "ok"}


@router.get("/summary")
def summary(db: Session = Depends(get_db)):
    return get_summary(db)


@router.get("/exceptions")
def exceptions(
    exception_type: str | None = Query(None, alias="type"),
    status: str | None = None,
    search: str | None = Query(None, max_length=100),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    return list_exceptions(db, exception_type, status, search, limit, offset)


@router.get("/exceptions/{exception_id}")
def exception_detail(exception_id: int, db: Session = Depends(get_db)):
    return get_detail(db, exception_id)


@router.post("/exceptions/{exception_id}/actions")
def exception_action(exception_id: int, body: ActionRequest, db: Session = Depends(get_db)):
    return apply_action(db, exception_id, body.action, body.actor, body.note)


@router.post("/demo/load-sample")
def load_sample(body: LoadSampleRequest, db: Session = Depends(get_db)):
    """Delete ALL data (including reviewer decisions) and reload the sample dataset."""
    if not body.confirm:
        raise HTTPException(status_code=400, detail="this deletes all data; send {\"confirm\": true}")
    try:
        return run_full_pipeline(db, SAMPLE_DIR)
    except IngestionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
