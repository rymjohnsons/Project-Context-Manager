# models.py — SQLAlchemy database models (one class = one table)
#
# Each class here describes a table: its columns, their types, and how tables
# relate to each other. When the app starts, SQLAlchemy reads these classes
# and creates the actual tables in data.db if they don't already exist.
#
# There are three tables:
#   users  — one row per registered account
#   lists  — one row per URL list (belongs to a user)
#   urls   — one row per URL (belongs to a list)

from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, DateTime, ForeignKey
from sqlalchemy.orm import relationship

from database import Base


def utcnow():
    """Return the current UTC time. Avoids the deprecated datetime.utcnow()."""
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    id              = Column(Integer, primary_key=True, index=True)
    email           = Column(String, unique=True, index=True, nullable=False)
    hashed_password = Column(String, nullable=False)
    created_at      = Column(DateTime(timezone=True), default=utcnow)

    # relationship() gives us a shortcut: user.lists returns all List rows
    # owned by this user. cascade="all, delete-orphan" means if we delete a
    # user, SQLAlchemy automatically deletes all their lists too.
    lists = relationship("List", back_populates="owner", cascade="all, delete-orphan")


class List(Base):
    __tablename__ = "lists"

    id         = Column(Integer, primary_key=True, index=True)
    name       = Column(String, nullable=False)
    owner_id   = Column(Integer, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), default=utcnow)

    # back_populates keeps both sides of the relationship in sync.
    # list.owner → the User who owns this list
    # list.urls  → all Url rows that belong to this list
    owner = relationship("User", back_populates="lists")
    urls  = relationship("Url", back_populates="list", cascade="all, delete-orphan")


class Url(Base):
    __tablename__ = "urls"

    id         = Column(Integer, primary_key=True, index=True)
    url        = Column(String, nullable=False)
    list_id    = Column(Integer, ForeignKey("lists.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), default=utcnow)

    # url.list → the List this URL belongs to
    list = relationship("List", back_populates="urls")
