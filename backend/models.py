from datetime import datetime, timezone
from sqlalchemy import Boolean, Column, Integer, String, Text, DateTime, ForeignKey
from sqlalchemy.orm import relationship

from database import Base


def utcnow():
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    id              = Column(Integer, primary_key=True, index=True)
    email           = Column(String, unique=True, index=True, nullable=False)
    hashed_password = Column(String, nullable=False)
    created_at      = Column(DateTime(timezone=True), default=utcnow)

    lists = relationship("List", back_populates="owner", cascade="all, delete-orphan")


class List(Base):
    __tablename__ = "lists"

    id         = Column(Integer, primary_key=True, index=True)
    name       = Column(String, nullable=False)
    starred    = Column(Boolean, default=False, nullable=False)
    owner_id   = Column(Integer, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), default=utcnow)

    owner = relationship("User", back_populates="lists")
    urls  = relationship("Url", back_populates="list", cascade="all, delete-orphan")


class Url(Base):
    __tablename__ = "urls"

    id          = Column(Integer, primary_key=True, index=True)
    url         = Column(String, nullable=False)
    title       = Column(String, nullable=True)
    notes       = Column(Text, nullable=True)
    last_opened = Column(DateTime(timezone=True), nullable=True)
    added_by_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    list_id     = Column(Integer, ForeignKey("lists.id"), nullable=False)
    created_at  = Column(DateTime(timezone=True), default=utcnow)

    list     = relationship("List", back_populates="urls")
    added_by = relationship("User", foreign_keys=[added_by_id])

    @property
    def added_by_email(self):
        return self.added_by.email if self.added_by else None


class PasswordResetToken(Base):
    __tablename__ = "password_reset_tokens"

    id         = Column(Integer, primary_key=True, index=True)
    user_id    = Column(Integer, ForeignKey("users.id"), nullable=False)
    token      = Column(String, unique=True, nullable=False)
    created_at = Column(DateTime(timezone=True), default=utcnow)
    used       = Column(Boolean, default=False, nullable=False)

    user = relationship("User")
