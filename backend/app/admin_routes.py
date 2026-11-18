# backend/admin_routes.py - Ledgerwatch Admin Console (Stage 1)
# SECURITY: Every route requires ADMIN_TOKEN header. Frontend hiding is NOT enough.
import os
from datetime import datetime
from fastapi import APIRouter, Depends, Header, HTTPException

try:
    from database import get_db
except ImportError:
    try:
        from backend.database import get_db
    except ImportError:
        get_db = None

router = APIRouter(prefix="/api/admin", tags=["admin"])
ADMIN_EMAIL = os.getenv("ADMIN_EMAIL", "dsahmadmagaji@gmail.com")
ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "")

def require_admin(x_admin_token: str | None = Header(default=None)):
    if not ADMIN_TOKEN:
        raise HTTPException(status_code=500, detail="ADMIN_TOKEN not configured on server")
    if x_admin_token != ADMIN_TOKEN:
        raise HTTPException(status_code=403, detail="Admin only")
    return True

@router.get("/health")
def admin_health(_: bool = Depends(require_admin)):
    return {
        "app": "Ledgerwatch",
        "env": os.getenv("ENV", "production"),
        "backend": "ok",
        "database": "connected - check via /api/health",
        "time": datetime.utcnow().isoformat(),
        "version": os.getenv("RENDER_GIT_COMMIT", "local")[:12],
    }

@router.get("/users")
def admin_users(_: bool = Depends(require_admin)):
    return {"users": [], "source": "stage1", "note": "Stage 2 wires real users table. Frontend will show local users until then."}

@router.get("/audit")
def admin_audit(_: bool = Depends(require_admin)):
    return {"audit": [], "note": "Audit table wiring is Stage 2"}
