# schemas.py — Pydantic models for request and response validation
#
# Pydantic models serve a different purpose than SQLAlchemy models:
#
#   SQLAlchemy models (models.py) → define the DATABASE structure
#   Pydantic models  (this file)  → define the API data shapes
#
# FastAPI uses Pydantic models to:
#   • Validate incoming request bodies (reject bad data early with clear errors)
#   • Serialize outgoing responses (control exactly what gets sent to the client)
#   • Generate the interactive API docs at http://localhost:8000/docs
#
# The naming convention used here:
#   *Create → data the client sends when creating something
#   *Update → data the client sends when modifying something
#   *Out    → data the server sends back to the client

from datetime import datetime
from pydantic import BaseModel


# ── URL schemas ────────────────────────────────────────────────────────────────

class UrlCreate(BaseModel):
    url: str  # the raw URL string the client wants to add


class UrlOut(BaseModel):
    id:  int
    url: str

    # from_attributes=True tells Pydantic it can read data directly from a
    # SQLAlchemy model object (which uses attribute access, not dict access).
    model_config = {"from_attributes": True}


# ── List schemas ───────────────────────────────────────────────────────────────

class ListCreate(BaseModel):
    name: str


class ListUpdate(BaseModel):
    name: str

class ListStar(BaseModel):
    starred: bool


class ListOut(BaseModel):
    id:       int
    name:     str
    starred:  bool = False
    owner_id: int
    urls:     list[UrlOut] = []  # include all URLs when returning a list

    model_config = {"from_attributes": True}


# ── User schemas ───────────────────────────────────────────────────────────────

class UserCreate(BaseModel):
    email:    str
    password: str


class UserOut(BaseModel):
    id:         int
    email:      str
    created_at: datetime

    model_config = {"from_attributes": True}


# ── Auth schemas ───────────────────────────────────────────────────────────────

class Token(BaseModel):
    access_token: str
    token_type:   str   # always "bearer" — this is the OAuth2 standard value


class TokenData(BaseModel):
    # Holds the data we extract from a decoded JWT.
    # None means the token was missing or couldn't be decoded.
    user_id: int | None = None
