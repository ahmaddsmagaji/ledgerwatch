"""LedgerWatch API - FIXED main. Single admin router, single health, CORS from env."""
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from app.admin_routes import router as admin_router
from app.api.routes import router as api_router
from app.core.database import Base, engine
from app.models import tables  # noqa: F401
from app.services.review import ReviewError
import os

@asynccontextmanager
async def lifespan(_app: FastAPI):
    Base.metadata.create_all(bind=engine)
    yield

def create_app() -> FastAPI:
    app = FastAPI(title="Ledgerwatch API", version="0.1.0", lifespan=lifespan)
    app.include_router(admin_router)
    app.include_router(api_router, prefix="/api")
    allowed = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:5174,http://localhost:5175,http://localhost:5176,http://127.0.0.1:5173,https://ledgerwatch-theta.vercel.app").split(",") if o.strip()]
    app.add_middleware(CORSMiddleware, allow_origins=allowed, allow_credentials=True, allow_methods=["*"], allow_headers=["*"])
    @app.get("/health")
    def health(): return {"status":"ok","service":"ledgerwatch-backend"}
    @app.get("/")
    def root(): return {"message":"Ledgerwatch API is running"}
    @app.exception_handler(ReviewError)
    async def review_error_handler(_request: Request, exc: ReviewError):
        return JSONResponse(status_code=exc.status_code, content={"detail": str(exc)})
    return app
app = create_app()
