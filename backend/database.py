import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase

DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///./data.db")

if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

# On Railway, DATABASE_URL is injected by the PostgreSQL plugin. If it's missing
# the app would silently use SQLite — but Railway's filesystem is ephemeral and
# that file is destroyed on every redeploy, wiping all user data. Fail loudly instead.
if DATABASE_URL.startswith("sqlite") and os.environ.get("RAILWAY_ENVIRONMENT"):
    raise RuntimeError(
        "\n\nDATA LOSS RISK — DATABASE_URL is not set on Railway.\n"
        "Every redeploy wipes all user data (SQLite lives on an ephemeral filesystem).\n"
        "Fix: Railway dashboard → your service → Variables → add DATABASE_URL\n"
        "     (copy it from your PostgreSQL service's Connect tab)\n"
    )

connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, connect_args=connect_args)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    """FastAPI dependency — one database session per request, always closed after."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
