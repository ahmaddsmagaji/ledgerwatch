from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes import router
from app.core.database import Base, engine
from app.models import tables  # noqa: F401  (importing registers the tables)
from app.services.review import ReviewError

@asynccontextmanager
async def lifespan(_app: FastAPI):
    Base.metadata.create_all(bind=engine)
    yield

def create_app() -> FastAPI:
    app = FastAPI(
        title="Ledgerwatch API",
        version="0.1.0",
        description="Payment reconciliation and exception review. Demo build: synthetic data only, no authentication.",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:5173",
            "http://localhost:5174",
            "http://localhost:5175",
            "http://localhost:5176",
            "http://127.0.0.1:5173",
            "http://127.0.0.1:5176",
        ],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    def health():
        return {"status": "ok", "service": "ledgerwatch-backend"}

    @app.get("/")
    def root():
        return {"message": "Ledgerwatch API is running"}

    @app.exception_handler(ReviewError)
    async def review_error_handler(_request: Request, exc: ReviewError):
        return JSONResponse(status_code=exc.status_code, content={"detail": str(exc)})

    app.include_router(router, prefix="/api")
    return app

app = create_app()