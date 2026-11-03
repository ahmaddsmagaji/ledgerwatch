from app.core.database import Base, engine
from app.models import tables  # noqa: F401  (importing registers the tables)


def init_db() -> None:
    Base.metadata.create_all(bind=engine)


if __name__ == "__main__":
    init_db()
    print("Database ready at:", engine.url)
    print("Tables:", sorted(Base.metadata.tables.keys()))