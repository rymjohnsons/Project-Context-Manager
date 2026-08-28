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
    # ONBOARDING: work role collected after first signup — used for personalisation
    work_type       = Column(String, nullable=True)
    # DASHBOARD: cumulative count of tabs opened via Start Working
    tabs_opened     = Column(Integer, default=0, nullable=False)

    # AUTH: incremented on password change to invalidate outstanding JWTs
    token_version   = Column(Integer, default=0, nullable=False)
    # AUTH: set True after clicking the verification link sent on registration
    email_verified  = Column(Boolean, default=False, nullable=False)

    # BILLING: subscription state
    plan                   = Column(String, default="free", nullable=False)
    trial_ends_at          = Column(DateTime(timezone=True), nullable=True)
    stripe_customer_id     = Column(String, nullable=True)
    stripe_subscription_id = Column(String, nullable=True)
    comped                 = Column(Boolean, default=False, nullable=False)
    locked_price           = Column(String, nullable=True)

    lists = relationship("List", back_populates="owner", cascade="all, delete-orphan")


class List(Base):
    __tablename__ = "lists"

    id          = Column(Integer, primary_key=True, index=True)
    name        = Column(String, nullable=False)
    starred     = Column(Boolean, default=False, nullable=False)
    archived    = Column(Boolean, default=False, nullable=False)
    owner_id    = Column(Integer, ForeignKey("users.id"), nullable=False)
    created_at  = Column(DateTime(timezone=True), default=utcnow)
    # DASHBOARD: updated whenever any resource in this list is opened via Start Working
    last_opened = Column(DateTime(timezone=True), nullable=True)

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

    starred  = Column(Boolean, default=False, nullable=False)
    list     = relationship("List", back_populates="urls")
    added_by = relationship("User", foreign_keys=[added_by_id])

    @property
    def added_by_email(self):
        return self.added_by.email if self.added_by else None


class WorkspaceShare(Base):
    """Tracks email-based workspace shares — both pending (no account yet) and claimed."""
    __tablename__ = "workspace_shares"

    id              = Column(Integer, primary_key=True, index=True)
    workspace_id    = Column(Integer, ForeignKey("lists.id", ondelete="CASCADE"), nullable=False)
    shared_by_id    = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    recipient_email = Column(String, nullable=False, index=True)
    recipient_id    = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    # pending  = email stored, no Tabrador account yet
    # claimed  = recipient has an account and can see the workspace
    status          = Column(String, default="pending", nullable=False)
    # view = read-only access; edit = can add/remove/modify resources
    permission      = Column(String, default="edit", nullable=False)
    created_at      = Column(DateTime(timezone=True), default=utcnow)
    claimed_at      = Column(DateTime(timezone=True), nullable=True)

    workspace  = relationship("List",  foreign_keys=[workspace_id])
    shared_by  = relationship("User",  foreign_keys=[shared_by_id])
    recipient  = relationship("User",  foreign_keys=[recipient_id])


class PasswordResetToken(Base):
    __tablename__ = "password_reset_tokens"

    id         = Column(Integer, primary_key=True, index=True)
    user_id    = Column(Integer, ForeignKey("users.id"), nullable=False)
    token      = Column(String, unique=True, nullable=False)
    created_at = Column(DateTime(timezone=True), default=utcnow)
    used       = Column(Boolean, default=False, nullable=False)

    user = relationship("User")


class EmailVerificationToken(Base):
    __tablename__ = "email_verification_tokens"

    id         = Column(Integer, primary_key=True, index=True)
    user_id    = Column(Integer, ForeignKey("users.id"), nullable=False)
    token      = Column(String, unique=True, nullable=False)
    created_at = Column(DateTime(timezone=True), default=utcnow)
    used       = Column(Boolean, default=False, nullable=False)

    user = relationship("User")
