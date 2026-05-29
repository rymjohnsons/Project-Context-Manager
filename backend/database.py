import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase

# Read the database URL from the environment.
# • Locally:  set in backend/.env as DATABASE_URL=sqlite:///./data.db
# • Railway:  automatically injected by the PostgreSQL plugin as DATABASE_URL=postgres://...
DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///./data.db")

# Railway (and older Heroku) PostgreSQL URLs start with "postgres://" but
# SQLAlchemy 2.x only accepts "postgresql://". Fix it transparently here.
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

# check_same_thread is a SQLite-only argument. It must be omitted for PostgreSQL,
# so we only pass it when the URL tells us we're talking to SQLite.
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
